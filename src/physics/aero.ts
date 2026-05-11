// Aerodynamic coefficients, forces, and moments. See spec §5.
//
// Body frame convention (deviates from textbook):
//   +X_B forward, +Y_B up, +Z_B right.
// ω_B packing:
//   .x = p (roll rate, +X_B), positive = right wing down
//   .y = r (yaw rate,  +Y_B), positive = nose right
//   .z = q (pitch rate, +Z_B), positive = nose up
// Moment vector body frame packing matches angular-rate packing:
//   M_B.x = L_roll, M_B.y = N_yaw, M_B.z = M_pitch.

import * as THREE from 'three';
import { FLIGHT_MODEL } from './flightModel.js';
import type { AircraftState } from './state.js';

const C = FLIGHT_MODEL;

const V_MIN = 0.1;
const V_MIN_RATES = 5.0;

export interface AeroResult {
  F_aero_B: THREE.Vector3;
  M_aero_B: THREE.Vector3;
  /** True if currently past stall AoA. Caller latches stallFlag. */
  stall: boolean;
}

/** Lift coefficient with linear → flat-plate stall blend (spec §5.1). */
export function liftCoefficient(
  alpha: number,
  delta_e: number,
  delta_f: number,
): { CL: number; stall: boolean } {
  const alphaStall = C.alphaStallClean + C.alphaStallFlapsDelta * delta_f;
  const CLmax = C.CLmaxClean + C.CLmaxFlapsBonus * delta_f;
  const dCL_flaps = C.CLflaps * delta_f;
  const CL_linear =
    C.CL0 + C.CLalpha * alpha + C.CLde * delta_e + dCL_flaps;

  const a = Math.abs(alpha);
  if (a <= alphaStall) {
    return { CL: CL_linear, stall: false };
  }
  const sgn = Math.sign(alpha) || 1;
  if (a - alphaStall < 0.262) {
    // Smooth post-stall drop-off, not yet flat-plate
    return { CL: sgn * (CLmax - 2.0 * (a - alphaStall)), stall: true };
  }
  // Deep stall: flat-plate behavior
  return { CL: sgn * 0.9 * Math.sin(2 * alpha), stall: true };
}

/** Drag coefficient (spec §5.2). */
export function dragCoefficient(
  CL: number,
  beta: number,
  delta_f: number,
): number {
  const CD_induced = (CL * CL) / (Math.PI * C.aspectRatio * C.oswald);
  return (
    C.CD0 +
    C.CDgear +
    C.CDflaps * delta_f +
    CD_induced +
    C.CDsideslip * Math.abs(beta)
  );
}

/** Side force coefficient (spec §5.3). */
export function sideForceCoefficient(beta: number, delta_r: number): number {
  return C.CYbeta * beta + C.CYdr * delta_r;
}

/** Roll-moment coefficient Cl (spec §5.5). */
export function rollMomentCoefficient(
  beta: number,
  pHat: number,
  rHat: number,
  delta_a: number,
  delta_r: number,
  aileronAuthority: number = 1,
): number {
  return (
    C.Clbeta * beta +
    C.Clp * pHat +
    C.Clr * rHat +
    C.Clda * aileronAuthority * delta_a +
    C.Cldr * delta_r
  );
}

/** Pitch-moment coefficient Cm (spec §5.5). */
export function pitchMomentCoefficient(
  alpha: number,
  qHat: number,
  delta_e: number,
  delta_f: number,
  elevatorAuthority: number = 1,
): number {
  return (
    C.Cm0 +
    C.Cmalpha * alpha +
    C.Cmq * qHat +
    C.Cmde * elevatorAuthority * delta_e +
    C.Cmflaps * delta_f
  );
}

/** Yaw-moment coefficient Cn (spec §5.5). */
export function yawMomentCoefficient(
  beta: number,
  pHat: number,
  rHat: number,
  delta_a: number,
  delta_r: number,
  rudderAuthority: number = 1,
): number {
  return (
    C.Cnbeta * beta +
    C.Cnp * pHat +
    C.Cnr * rHat +
    C.Cnda * delta_a +
    C.Cndr * rudderAuthority * delta_r
  );
}

const _bodyWind = new THREE.Vector3();
const _invQ = new THREE.Quaternion();

/**
 * Compute body-frame aerodynamic forces and moments for the given state and
 * air density. Pure function — does not mutate `state`.
 */
export function computeAeroForcesMoments(
  state: AircraftState,
  rho: number,
): AeroResult {
  // Velocity in body frame: v_B = q^-1 * v_W
  _invQ.copy(state.q).invert();
  _bodyWind.copy(state.v_W).applyQuaternion(_invQ);
  const u = _bodyWind.x;
  const v = _bodyWind.y;
  const w_b = _bodyWind.z;

  let V = Math.sqrt(u * u + v * v + w_b * w_b);
  if (V < V_MIN) V = V_MIN;

  const alpha = Math.atan2(-v, u);
  const beta = Math.asin(Math.max(-1, Math.min(1, w_b / V)));

  const qbar = 0.5 * rho * V * V;

  const { CL, stall } = liftCoefficient(alpha, state.delta_e, state.delta_f);
  const CD = dragCoefficient(CL, beta, state.delta_f);
  const CY = sideForceCoefficient(beta, state.delta_r);

  const L = qbar * C.wingArea * CL;
  const D = qbar * C.wingArea * CD;
  const Y = qbar * C.wingArea * CY;

  const cosA = Math.cos(alpha);
  const sinA = Math.sin(alpha);

  // Force assembly wind→body (spec §5.4)
  const Fx = -D * cosA + L * sinA;
  const Fy = L * cosA + D * sinA;
  const Fz = Y;

  // Non-dimensional rates (clamp V > 5 for the rate normalization only)
  const Vrate = Math.max(V, V_MIN_RATES);
  const p = state.omega_B.x;
  const r = state.omega_B.y;
  const q = state.omega_B.z;
  const pHat = (p * C.span) / (2 * Vrate);
  const qHat = (q * C.mac) / (2 * Vrate);
  const rHat = (r * C.span) / (2 * Vrate);

  // v0.2 damaged-surface authority scaling. When `state.hp` is defined and a
  // control surface zone is at 0 HP, that surface's input coefficient is
  // multiplied by 0.4 (i.e. 60 % loss of authority, per spec §4.2).
  // Gated on the `state.hp` defined-check so v0.1 callers see no change.
  let aileronAuth = 1;
  let elevatorAuth = 1;
  let rudderAuth = 1;
  if (state.hp) {
    if (state.hp.controls.aileron <= 0) aileronAuth = 0.4;
    if (state.hp.controls.elevator <= 0) elevatorAuth = 0.4;
    if (state.hp.controls.rudder <= 0) rudderAuth = 0.4;
  }

  const Cl = rollMomentCoefficient(
    beta, pHat, rHat, state.delta_a, state.delta_r, aileronAuth,
  );
  const Cm = pitchMomentCoefficient(
    alpha, qHat, state.delta_e, state.delta_f, elevatorAuth,
  );
  const Cn = yawMomentCoefficient(
    beta, pHat, rHat, state.delta_a, state.delta_r, rudderAuth,
  );

  const L_roll = qbar * C.wingArea * C.span * Cl;
  let M_pitch = qbar * C.wingArea * C.mac * Cm;
  const N_yaw = qbar * C.wingArea * C.span * Cn;

  // Stall buffet (cosmetic; spec §5.6)
  if (stall) {
    const alphaStall =
      C.alphaStallClean + C.alphaStallFlapsDelta * state.delta_f;
    const excess = (Math.abs(alpha) - alphaStall) / 0.1;
    M_pitch += 0.6 * Math.sin(state.time * 18) * excess;
  }

  return {
    F_aero_B: new THREE.Vector3(Fx, Fy, Fz),
    M_aero_B: new THREE.Vector3(L_roll, N_yaw, M_pitch),
    stall,
  };
}
