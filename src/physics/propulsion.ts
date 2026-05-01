// Propulsion model. See spec §6.
// Thrust along +X_B at CG. Throttle 1st-order lag is applied in step.ts.

import { FLIGHT_MODEL } from './flightModel.js';

/**
 * Compute propeller thrust in Newtons.
 * @param throttle actual (lagged) throttle position, [0..1]
 * @param V        airspeed magnitude, m/s
 * @param sigma    density ratio ρ/ρ0
 */
export function thrust(throttle: number, V: number, sigma: number): number {
  const tStatic = FLIGHT_MODEL.thrustStaticSL * sigma;
  const vFactor = Math.max(0, 1 - V / FLIGHT_MODEL.vMaxThrustZero);
  return tStatic * throttle * (0.75 + 0.25 * vFactor);
}
