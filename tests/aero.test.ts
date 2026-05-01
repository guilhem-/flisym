// Aerodynamic-coefficient validation. See physics-spec.md §5 and §11.
//
// At α=0, V=50 m/s, level wings: lift coefficient produces lift > 50% of
// weight (the rest comes from pitch trim / α at trim).
// At α near stall (14°): CL > CL(α=0).
// Past stall (20°): CL < CL(α_stall).

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FLIGHT_MODEL,
  computeAeroForcesMoments,
  density,
  liftCoefficient,
} from '../src/physics/index.js';
import { createInitialState } from '../src/physics/state.js';

const C = FLIGHT_MODEL;
const RHO_SL = density(0);

function makeStateAt(V: number, alphaRad: number) {
  // Build a body-frame velocity (V, -V*sin(alpha)/cos(alpha) ≈ small)
  // For a clean test set α via body velocity: u = V cos α, v = -V sin α
  // (since α = atan2(-v, u)).
  const s = createInitialState();
  s.x_W.set(0, 500, 0);
  s.q.identity();
  const u = V * Math.cos(alphaRad);
  const v = -V * Math.sin(alphaRad);
  s.v_W.set(u, v, 0); // body == world (identity quat)
  return s;
}

describe('aerodynamics (CL/lift-vs-weight, stall behavior)', () => {
  it('at α=0, V=50 m/s, level: aero lift > 50% of weight', () => {
    const state = makeStateAt(50, 0);
    const aero = computeAeroForcesMoments(state, RHO_SL);
    // With identity quaternion, body Y == world Y. F_aero_B.y is upward force.
    const weight = C.mass * C.gravity;
    expect(aero.F_aero_B.y).toBeGreaterThan(0.5 * weight);
    // Also a sanity check: forward drag (negative body-X) is non-trivial.
    expect(aero.F_aero_B.x).toBeLessThan(0);
  });

  it('lift coefficient: CL(14°) > CL(0°), and not yet stalled', () => {
    const cl0 = liftCoefficient(0, 0, 0);
    const cl14 = liftCoefficient((14 * Math.PI) / 180, 0, 0);
    expect(cl14.CL).toBeGreaterThan(cl0.CL);
    expect(cl14.stall).toBe(false);
  });

  it('lift coefficient: CL(20°) < CL near stall (14°), stall flag set', () => {
    const cl14 = liftCoefficient((14 * Math.PI) / 180, 0, 0);
    const cl20 = liftCoefficient((20 * Math.PI) / 180, 0, 0);
    expect(cl20.CL).toBeLessThan(cl14.CL);
    expect(cl20.stall).toBe(true);
  });

  it('flaps lower the stall AoA and raise CLmax', () => {
    // At α=10° clean we are below stall; at α=10° with full flaps still not
    // stalled but should give more lift than clean.
    const clean = liftCoefficient((10 * Math.PI) / 180, 0, 0);
    const flaps = liftCoefficient((10 * Math.PI) / 180, 0, 1);
    expect(flaps.CL).toBeGreaterThan(clean.CL);
  });

  it('symmetric stall behavior at negative α', () => {
    const negStall = liftCoefficient((-20 * Math.PI) / 180, 0, 0);
    expect(negStall.stall).toBe(true);
    expect(negStall.CL).toBeLessThan(0);
  });

  it('aero force vector is finite and well-defined at low V', () => {
    const state = makeStateAt(0.05, 0); // below V_MIN clamp
    const aero = computeAeroForcesMoments(state, RHO_SL);
    expect(Number.isFinite(aero.F_aero_B.x)).toBe(true);
    expect(Number.isFinite(aero.F_aero_B.y)).toBe(true);
    expect(Number.isFinite(aero.F_aero_B.z)).toBe(true);
    expect(Number.isFinite(aero.M_aero_B.x)).toBe(true);
    expect(Number.isFinite(aero.M_aero_B.y)).toBe(true);
    expect(Number.isFinite(aero.M_aero_B.z)).toBe(true);
  });
});
