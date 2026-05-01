// Integrator validation. See physics-spec.md §7–§8.
//
// Drop test: at h=2000m, V=0, no thrust; with the ground clamp disabled
// (getGroundHeight = -1e6), after 1s vertical velocity ≈ -9.8 m/s within 5%.
// Aero contribution at V=0 is zero (clamped at V_MIN=0.1) so this isolates
// gravity + integrator.
//
// Also a low-V free-fall sanity check that horizontal motion stays put.

import { describe, expect, it } from 'vitest';
import {
  advance,
  createInitialState,
  createNeutralControls,
  physicsStep,
} from '../src/physics/index.js';

describe('integrator (drop test, no ground clamp)', () => {
  it('free-fall ≈ -9.8 m/s after 1s within 5%', () => {
    const state = createInitialState();
    state.x_W.set(0, 2000, 0);
    state.v_W.set(0, 0, 0);
    state.onGround = false;
    state.q.identity();

    const controls = createNeutralControls();
    // No thrust, no inputs.
    const noGround = (): number => -1e6;

    // 1 s at 1/240 dt.
    const dt = 1 / 240;
    for (let i = 0; i < 240; i += 1) {
      physicsStep(state, dt, controls, noGround);
    }

    expect(state.v_W.y).toBeLessThan(-9.8 * 0.95);
    expect(state.v_W.y).toBeGreaterThan(-9.8 * 1.05);
  });

  it('drop with no aero produces predictable fall distance ≈ ½ g t²', () => {
    const state = createInitialState();
    state.x_W.set(0, 2000, 0);
    state.v_W.set(0, 0, 0);
    state.onGround = false;
    state.q.identity();

    const controls = createNeutralControls();
    const noGround = (): number => -1e6;
    const dt = 1 / 240;
    const T = 1.0;
    for (let i = 0; i < T * 240; i += 1) {
      physicsStep(state, dt, controls, noGround);
    }
    // Δh ≈ -0.5 * 9.80665 * 1² = -4.903 m. Allow 10% slack for semi-implicit
    // Euler bias (it accumulates a tiny extra dt in the position update).
    const dh = state.x_W.y - 2000;
    expect(dh).toBeLessThan(-4.4);
    expect(dh).toBeGreaterThan(-5.5);
  });

  it('no horizontal drift from gravity-only fall', () => {
    const state = createInitialState();
    state.x_W.set(0, 2000, 0);
    state.v_W.set(0, 0, 0);
    state.onGround = false;
    state.q.identity();

    const controls = createNeutralControls();
    const noGround = (): number => -1e6;
    const dt = 1 / 240;
    for (let i = 0; i < 240; i += 1) {
      physicsStep(state, dt, controls, noGround);
    }
    expect(Math.abs(state.x_W.x)).toBeLessThan(0.01);
    expect(Math.abs(state.x_W.z)).toBeLessThan(0.01);
  });

  it('advance() drives many physics ticks per render frame', () => {
    const state = createInitialState();
    state.x_W.set(0, 2000, 0);
    state.onGround = false;
    const controls = createNeutralControls();
    const noGround = (): number => -1e6;

    // 1 second of render time at 60Hz → ~240 physics ticks.
    for (let i = 0; i < 60; i += 1) {
      advance(state, 1 / 60, controls, noGround);
    }
    expect(state.v_W.y).toBeLessThan(-9.0);
    expect(state.v_W.y).toBeGreaterThan(-10.5);
  });
});
