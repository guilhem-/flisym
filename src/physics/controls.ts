// Control surface slewing. See spec §2 and §9.
//
// Surface commands rate-limit at 4.0 /s toward the commanded value. When the
// command is "released" (effectively zero), surfaces self-center at 3.0 /s.
// Throttle uses a 1st-order lag with τ=0.3s and is handled in step.ts.

import { FLIGHT_MODEL } from './flightModel.js';
import type { AircraftState, Controls } from './state.js';

const RELEASED_EPS = 1e-3;

/**
 * Slew a single surface deflection toward the command at `rate` /s, but
 * self-center at `centerRate` /s if the command magnitude is below epsilon.
 */
function slewSurface(
  current: number,
  command: number,
  dt: number,
  rate: number,
  centerRate: number,
): number {
  const released = Math.abs(command) < RELEASED_EPS;
  if (released) {
    // self-center toward 0
    const step = centerRate * dt;
    if (current > step) return current - step;
    if (current < -step) return current + step;
    return 0;
  }
  const delta = command - current;
  const step = rate * dt;
  if (delta > step) return current + step;
  if (delta < -step) return current - step;
  return command;
}

/**
 * Update the rate-limited control surface deflections in place. Throttle is
 * NOT modified here — it's lagged inside the integrator step (1st-order lag,
 * τ = 0.3s).
 */
export function updateControlSurfaces(
  state: AircraftState,
  controls: Controls,
  dt: number,
): void {
  // v0.2 combat damage: when the engine is destroyed, force throttle and the
  // throttle command to zero before the integrator's 1st-order lag step runs.
  // Gated on `state.hp` defined-check so v0.1 callers see no behavior change.
  if (state.hp && state.hp.engine <= 0) {
    state.throttle = 0;
    controls.throttleCmd = 0;
  }

  const r = FLIGHT_MODEL.controlRate;
  const cr = FLIGHT_MODEL.controlCenterRate;

  state.delta_a = clamp(
    slewSurface(state.delta_a, clamp(controls.aileronCmd, -1, 1), dt, r, cr),
    -1,
    1,
  );
  state.delta_e = clamp(
    slewSurface(state.delta_e, clamp(controls.elevatorCmd, -1, 1), dt, r, cr),
    -1,
    1,
  );
  state.delta_r = clamp(
    slewSurface(state.delta_r, clamp(controls.rudderCmd, -1, 1), dt, r, cr),
    -1,
    1,
  );

  // Flaps: slew at the same surface rate but never self-center (the command
  // is the discrete detent, not "released").
  const flapsCmd = clamp(controls.flapsCmd, 0, 1);
  const fDelta = flapsCmd - state.delta_f;
  const fStep = r * dt;
  if (fDelta > fStep) state.delta_f += fStep;
  else if (fDelta < -fStep) state.delta_f -= fStep;
  else state.delta_f = flapsCmd;
}

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
