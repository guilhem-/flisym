// Cascaded PID / proportional controllers for the AI pilot.
// See docs/ai-spec.md §3.
//
// Three cascades:
//   - altitude → pitch → elevator   (§3.1)
//   - heading  → bank  → roll-rate → aileron  (§3.2)
//   - yaw coordinator (§3.3)
//   - throttle PI (§3.4)
//
// Anti-windup: hard clamp on integrator plus output-saturation
// back-calculation per §3.5.
//
// No allocations. Caller owns the `ControllerState` struct.

import type { AI_TUNING } from './tuning.js';
import { wrapPi } from './percepts.js';

/** Per-pilot controller integrators / memories. */
export interface ControllerState {
  altInteg: number;
  throttleInteg: number;
}

export function createControllerState(): ControllerState {
  return { altInteg: 0, throttleInteg: 0 };
}

export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Outer altitude → pitch command (radians).
 *
 * `selfV_y` is the vertical world velocity used as a damping term (so we
 * don't fight altitude transients with pure I-action).
 */
export function altitudeToPitch(
  altCmd: number,
  selfAlt: number,
  selfV_y: number,
  ctrl: ControllerState,
  tuning: AI_TUNING,
  dt_ai: number,
): number {
  const altErr = altCmd - selfAlt;
  // Pre-clamp integrator candidate.
  const integCand = ctrl.altInteg + altErr * dt_ai;
  const raw =
    tuning.Kp_alt * altErr + tuning.Ki_alt * integCand - tuning.Kd_alt * selfV_y;
  const out = clamp(raw, -tuning.pitchMaxRad, tuning.pitchMaxRad);
  // Anti-windup: only accumulate if not saturating in the same direction.
  const saturating =
    (out === tuning.pitchMaxRad && altErr > 0) ||
    (out === -tuning.pitchMaxRad && altErr < 0);
  if (!saturating) {
    ctrl.altInteg = clamp(integCand, -tuning.altIntegMax, tuning.altIntegMax);
  } else {
    // Bleed back toward zero (back-calculation, light).
    ctrl.altInteg *= 0.98;
  }
  return out;
}

/**
 * Inner pitch → elevator (range [-1, +1]).
 * `selfQ` is pitch rate (omega_B.z).
 */
export function pitchToElevator(
  pitchCmdRad: number,
  selfPitchRad: number,
  selfQ: number,
  tuning: AI_TUNING,
): number {
  const pitchErr = pitchCmdRad - selfPitchRad;
  return clamp(tuning.Kp_pitch * pitchErr - tuning.Kd_pitch * selfQ, -1, 1);
}

/**
 * Outer heading → bank-angle command. Caller passes `bankCapDeg` in degrees
 * to control aggressiveness for state/intent.
 */
export function headingToBank(
  hdgCmd: number,
  selfHdg: number,
  bankCapDeg: number,
  tuning: AI_TUNING,
): number {
  const hdgErr = wrapPi(hdgCmd - selfHdg);
  const cap = (bankCapDeg * Math.PI) / 180;
  return clamp(tuning.Kp_hdg * hdgErr, -cap, cap);
}

/**
 * Middle bank → roll-rate command (rad/s).
 */
export function bankToRollRate(
  bankCmdRad: number,
  selfRollRad: number,
  tuning: AI_TUNING,
): number {
  const rollErr = bankCmdRad - selfRollRad;
  return clamp(tuning.Kp_bank * rollErr, -tuning.rollRateMax, tuning.rollRateMax);
}

/**
 * Inner roll-rate → aileron (range [-1, 1]).
 * `selfP` is roll rate (omega_B.x).
 */
export function rollRateToAileron(
  rollRateCmd: number,
  selfP: number,
  tuning: AI_TUNING,
): number {
  return clamp(tuning.Kp_p * (rollRateCmd - selfP), -1, 1);
}

/**
 * Turn coordinator → rudder. Feedforward roll-rate term assists the turn.
 */
export function yawCoordinator(
  selfBeta: number,
  selfP: number,
  tuning: AI_TUNING,
): number {
  return clamp(
    tuning.Kp_beta * (0 - selfBeta) + tuning.Kff_yawCoord * selfP,
    -1,
    1,
  );
}

/**
 * Speed PI → throttle. `combatMode` swaps throttleBase to 1.0 (§3.4 combat).
 * `pitchCmdRad` is used for the climb-feedforward boost.
 */
export function speedToThrottle(
  vCmd: number,
  selfV: number,
  pitchCmdRad: number,
  combatMode: boolean,
  ctrl: ControllerState,
  tuning: AI_TUNING,
  dt_ai: number,
): number {
  const vErr = vCmd - selfV;
  const integCand = ctrl.throttleInteg + vErr * dt_ai;
  const base = combatMode ? 1.0 : tuning.throttleBase;
  let raw = base + tuning.Kp_v * vErr + tuning.Ki_v * integCand;
  if (Math.abs(pitchCmdRad) > tuning.pitchClimbThresh && pitchCmdRad > 0) {
    raw += 0.15;
  }
  // In combat mode we PI only attenuates when above combatVMax.
  if (combatMode && selfV < tuning.combatVMax) {
    raw = Math.max(raw, 1.0);
  }
  const out = clamp(raw, tuning.throttleMin, 1.0);
  // Anti-windup: only integrate if not saturated.
  const saturating =
    (out === 1.0 && vErr > 0) || (out === tuning.throttleMin && vErr < 0);
  if (!saturating) {
    ctrl.throttleInteg = clamp(
      integCand,
      -tuning.throttleIntegMax,
      tuning.throttleIntegMax,
    );
  } else {
    ctrl.throttleInteg *= 0.98;
  }
  return out;
}

/**
 * Quantize an emitted command to the nearest `tuning.aiCmdQuantum` step.
 * Required for cross-host determinism (spec §2.5).
 */
export function quantize(x: number, q: number): number {
  if (q <= 0) return x;
  return Math.round(x / q) * q;
}

/**
 * Slew an emitted command toward target by at most `slewPerS * dt` per tick.
 */
export function slew(prev: number, target: number, slewPerS: number, dt: number): number {
  const max = slewPerS * dt;
  const d = target - prev;
  if (d > max) return prev + max;
  if (d < -max) return prev - max;
  return target;
}
