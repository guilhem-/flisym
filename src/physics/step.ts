// Semi-implicit Euler integrator for the 6-DOF flight model.
// See physics-spec.md §7–§8.
//
// CRITICAL CONVENTIONS:
//   Body frame:    +X_B forward, +Y_B up, +Z_B right (Three.js-friendly).
//   ω_B packing:   .x = p (roll, +X_B)
//                  .y = r (yaw,  +Y_B)
//                  .z = q (pitch, +Z_B)
//   Inertia:       I_B = diag(Ixx, Izz, Iyy) to match the (p, r, q) packing.
//   Quaternion:    body→world; integrated via dq = Quat(ω_W*0.5*dt, 0)·q,
//                  added to q, then renormalized.
//   Sign flips:    Cm_δe and Cn_δr already encoded with the +Y-up convention
//                  (see flightModel.ts).

import * as THREE from 'three';
import { FLIGHT_MODEL } from './flightModel.js';
import { density } from './atmosphere.js';
import { computeAeroForcesMoments } from './aero.js';
import { thrust as propThrust } from './propulsion.js';
import { updateControlSurfaces } from './controls.js';
import type { AircraftState, Controls } from './state.js';

const C = FLIGHT_MODEL;

/** Scratch vectors / quaternion to avoid per-step allocations. */
const _F_B = new THREE.Vector3();
const _F_W = new THREE.Vector3();
const _M_B = new THREE.Vector3();
const _omega_W = new THREE.Vector3();
const _dqVec = new THREE.Quaternion();
const _qOut = new THREE.Quaternion();
const _vWSaved = new THREE.Vector3();

/**
 * Optional ambient wind sampler (inertial frame, m/s). Set by the host (e.g.
 * main.ts) so physics can compute relative airspeed without baking wind into
 * `state.v_W` (which would corrupt position integration). Default: zero wind.
 */
export type WindFn = (altitude: number, time: number) => THREE.Vector3;
let _windFn: WindFn | null = null;
export function setWindFn(fn: WindFn | null): void {
  _windFn = fn;
}

/** Function the integrator calls to query terrain height at (x, z). */
export type GroundHeightFn = (x: number, z: number) => number;

/**
 * Run one fixed-step physics tick. Mutates `state` in place.
 *
 * @param state          aircraft state, mutated
 * @param dt             physics timestep (seconds), expected ≈ 1/240
 * @param controlsCmd    commanded controls (slewed inside)
 * @param getGroundHeight callback returning ground Y at world (x, z); if it
 *                       returns ≤ 0 we fall back to FLIGHT_MODEL.groundY = 0.5
 */
export function physicsStep(
  state: AircraftState,
  dt: number,
  controlsCmd: Controls,
  getGroundHeight: GroundHeightFn,
): void {
  // 1) Slew control surfaces toward commanded values.
  updateControlSurfaces(state, controlsCmd, dt);

  // 2) Throttle 1st-order lag.
  const throttleCmd = clamp01(controlsCmd.throttleCmd);
  const lag = 1 - Math.exp(-dt / C.throttleTau);
  state.throttle += (throttleCmd - state.throttle) * lag;
  state.throttle = clamp01(state.throttle);

  // 3) Compute aero + thrust in body frame.
  const altitude = state.x_W.y;
  const rho = density(altitude);
  const sigma = rho / C.rho0;

  // If a wind sampler is registered, transiently swap state.v_W for the
  // air-relative velocity (v_W − wind) while computing aero forces, then
  // restore. This keeps aero seeing relative airspeed while leaving the
  // inertial v_W untouched for the position integrator below.
  let aero;
  if (_windFn) {
    const wind = _windFn(state.x_W.y, state.time);
    _vWSaved.copy(state.v_W);
    state.v_W.sub(wind);
    aero = computeAeroForcesMoments(state, rho);
    state.v_W.copy(_vWSaved);
  } else {
    aero = computeAeroForcesMoments(state, rho);
  }
  if (aero.stall) state.stallFlag = true;

  const v_B_x = bodyVelocityForwardComponent(state);
  const V_for_thrust = Math.max(0, v_B_x);
  const T = propThrust(state.throttle, V_for_thrust, sigma);

  // Total body force = aero + thrust (along +X_B).
  _F_B.copy(aero.F_aero_B);
  _F_B.x += T;

  // Total body moment = aero + propeller torque reaction.
  _M_B.copy(aero.M_aero_B);
  // Optional prop torque: rolls left under power. M_B.x is roll axis.
  _M_B.x += -0.05 * T;

  // 4) Transform body force to world, add gravity.
  _F_W.copy(_F_B).applyQuaternion(state.q);
  _F_W.y -= C.mass * C.gravity;

  // 5) Linear acceleration (world).
  const aWx = _F_W.x / C.mass;
  const aWy = _F_W.y / C.mass;
  const aWz = _F_W.z / C.mass;

  // 6) Angular acceleration in body frame (Euler's equations, with the
  //    inertia remap diag(Ixx, Izz, Iyy) matching (p, r, q) packing).
  const p = state.omega_B.x;
  const r = state.omega_B.y;
  const q = state.omega_B.z;
  const dot_p = (_M_B.x - (C.Iyy - C.Izz) * r * q) / C.Ixx;
  const dot_r = (_M_B.y - (C.Ixx - C.Iyy) * p * q) / C.Izz;
  const dot_q = (_M_B.z - (C.Izz - C.Ixx) * p * r) / C.Iyy;

  // 7) Semi-implicit Euler: integrate velocities, then positions.
  state.v_W.x += aWx * dt;
  state.v_W.y += aWy * dt;
  state.v_W.z += aWz * dt;
  state.omega_B.x += dot_p * dt;
  state.omega_B.y += dot_r * dt;
  state.omega_B.z += dot_q * dt;

  state.x_W.x += state.v_W.x * dt;
  state.x_W.y += state.v_W.y * dt;
  state.x_W.z += state.v_W.z * dt;

  // 8) Quaternion integration. Map body rates (p, r, q) → world ω vector.
  //    The packing means body-axis components are (p along bX, r along bY,
  //    q along bZ); applying the rotation gives world ω directly.
  _omega_W.copy(state.omega_B).applyQuaternion(state.q);
  _dqVec.set(
    _omega_W.x * 0.5 * dt,
    _omega_W.y * 0.5 * dt,
    _omega_W.z * 0.5 * dt,
    0,
  );
  // dq = (ω_W*0.5*dt, 0) * q
  _qOut.copy(_dqVec).multiply(state.q);
  state.q.set(
    state.q.x + _qOut.x,
    state.q.y + _qOut.y,
    state.q.z + _qOut.z,
    state.q.w + _qOut.w,
  );
  state.q.normalize();

  // 9) Ground clamp.
  let groundY = getGroundHeight(state.x_W.x, state.x_W.z);
  if (!Number.isFinite(groundY) || groundY <= 0) groundY = C.groundY;

  if (state.x_W.y <= groundY + 1e-4) {
    state.x_W.y = groundY;
    if (state.v_W.y < 0) state.v_W.y = 0;
    state.onGround = true;

    // Rolling friction: spec's "rolling friction -0.02 * v_W_horizontal".
    // We use a Coulomb friction model (μ = rollingFriction, friction accel =
    // μ*g) scaled by weight-on-wheels (weight minus current lift), and we
    // additionally fade it out as horizontal speed exceeds rotation speed —
    // wheel rolling drag is negligible in the takeoff roll. Brake adds a
    // constant 5 m/s² on top regardless of weight-on-wheels.
    {
      const speedH = Math.sqrt(
        state.v_W.x * state.v_W.x + state.v_W.z * state.v_W.z,
      );
      if (speedH > 1e-3) {
        const Vsq = speedH * speedH;
        const liftEstimate = 0.5 * 1.225 * Vsq * C.wingArea * C.CL0;
        const weight = C.mass * C.gravity;
        const wow = Math.max(0, Math.min(1, (weight - liftEstimate) / weight));
        // Fade rolling component: full at rest, zero above 15 m/s.
        const speedFade = Math.max(0, Math.min(1, 1 - speedH / 15));
        let totalAccel = C.rollingFriction * C.gravity * wow * speedFade;
        if (controlsCmd.brake) totalAccel += 5.0;
        if (totalAccel > 0) {
          const decel = Math.min(totalAccel * dt, speedH);
          state.v_W.x -= (state.v_W.x / speedH) * decel;
          state.v_W.z -= (state.v_W.z / speedH) * decel;
        }
      }
    }

    // Tricycle-gear constraint: aggressively damp roll, pitch, and yaw rates
    // while wheels are down. The gear physically resists roll/pitch outright,
    // and tire scrub provides strong yaw damping until the aircraft can steer
    // aerodynamically.
    const rollPitchDamp = 1 - Math.min(1, 12.0 * dt);
    const yawDamp = 1 - Math.min(1, 6.0 * dt);
    state.omega_B.x *= rollPitchDamp;
    state.omega_B.z *= rollPitchDamp;
    state.omega_B.y *= yawDamp;

    // Also drag the body orientation back toward level (zero roll/pitch in
    // world). Implementation: extract current body-up vector and slerp toward
    // a level orientation that preserves yaw.
    levelOnGround(state, dt);

    // Kill rates entirely when groundspeed below threshold (per spec §8).
    const groundSpeed = Math.sqrt(
      state.v_W.x * state.v_W.x + state.v_W.z * state.v_W.z,
    );
    if (groundSpeed < 0.5) {
      state.omega_B.set(0, 0, 0);
    }
  } else {
    state.onGround = false;
  }

  // 10) Advance sim time.
  state.time += dt;
}

/**
 * Render-rate driver. Accumulates render dt into `state.accumulator` and runs
 * up to `maxSubsteps` fixed physics ticks. Frees frames from spiral-of-death.
 */
export function advance(
  state: AircraftState,
  dtRender: number,
  controlsCmd: Controls,
  getGroundHeight: GroundHeightFn,
): void {
  const PHYS_DT = C.physicsDt;
  state.accumulator += Math.min(dtRender, 0.1);
  let steps = 0;
  while (state.accumulator >= PHYS_DT && steps < C.maxSubsteps) {
    physicsStep(state, PHYS_DT, controlsCmd, getGroundHeight);
    state.accumulator -= PHYS_DT;
    steps += 1;
  }
  // If we hit maxSubsteps and still have backlog, drop the rest to avoid
  // cascading into a stall on slow frames.
  if (state.accumulator > PHYS_DT * C.maxSubsteps) {
    state.accumulator = 0;
  }
}

const _bodyVelScratch = new THREE.Vector3();
const _invQScratch = new THREE.Quaternion();
function bodyVelocityForwardComponent(state: AircraftState): number {
  _invQScratch.copy(state.q).invert();
  _bodyVelScratch.copy(state.v_W).applyQuaternion(_invQScratch);
  return _bodyVelScratch.x;
}

// Scratch quaternions / vectors for ground-leveling.
const _qLevel = new THREE.Quaternion();
const _qSlerpTarget = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YZX');

/**
 * Drag the orientation toward "wings level, nose level" while preserving the
 * current heading. Models the kinematic effect of three wheels on the ground
 * without a full constraint solver.
 */
function levelOnGround(state: AircraftState, dt: number): void {
  // Decompose into Euler YZX so the components are (yaw_y, pitch_z, roll_x)
  // for our body convention (X-fwd, Y-up, Z-right). Keep yaw, zero pitch and
  // roll, then slerp toward that target.
  _euler.setFromQuaternion(state.q, 'YZX');
  _qLevel.setFromEuler(new THREE.Euler(0, _euler.y, 0, 'YZX'));
  // Slerp by a fraction proportional to dt; 8/s gives a ~0.125s time-constant.
  const t = Math.min(1, 8.0 * dt);
  _qSlerpTarget.copy(state.q).slerp(_qLevel, t);
  state.q.copy(_qSlerpTarget);
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
