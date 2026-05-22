// Regression: hands-off cruise stays reasonably level for the first 5 s.
//
// Catches the class of failure where Cm0, pitch-trim offset, or lateral
// damping is reverted and the airframe immediately starts pitching up and
// spiraling — the bug the user reported as "after some seconds, behaves in
// a non-realistic way". Threshold is loose (real physics still has a slow
// phugoid and slight spiral mode) but tight enough to fail if the trim is
// missing or the damping coefficients regress to textbook values.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  advance,
  createInitialState,
  createNeutralControls,
  FLIGHT_MODEL,
} from '../src/physics/index.js';

const DT = 1 / 60;
const NO_GROUND = (): number => -1e6;

function airborneCruise(): ReturnType<typeof createInitialState> {
  const s = createInitialState();
  s.x_W.set(0, 1000, 0);
  s.v_W.set(50, 0, 0);
  s.q.identity();
  s.omega_B.set(0, 0, 0);
  s.onGround = false;
  s.throttle = 0.5;
  return s;
}

describe('hands-off cruise stability', () => {
  it('cruise at 50 m/s with no input: 30 s stays within ±60 m altitude', () => {
    const state = airborneCruise();
    const controls = createNeutralControls();
    controls.throttleCmd = state.throttle; // pilot isn't touching throttle
    const altStart = state.x_W.y;
    const totalSteps = Math.round(30.0 / DT);
    for (let i = 0; i < totalSteps; i++) advance(state, DT, controls, NO_GROUND);
    expect(Math.abs(state.x_W.y - altStart)).toBeLessThan(60);
  });

  it('cruise: 30 s of no-input keeps heading drift ≤ 45°', () => {
    // Threshold loose enough to allow a slow spiral mode (real Cessnas drift
    // hands-off too) but tight enough to catch a full tumble. ≥ 45° drift in
    // 30 s means the airframe is genuinely unstable.
    const state = airborneCruise();
    const controls = createNeutralControls();
    controls.throttleCmd = state.throttle;
    const totalSteps = Math.round(30.0 / DT);
    for (let i = 0; i < totalSteps; i++) advance(state, DT, controls, NO_GROUND);
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(state.q);
    const headingDeg = (Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI;
    expect(Math.abs(headingDeg - 90)).toBeLessThan(45);
  });

  it('cruise: 30 s of no-input — no axis exceeds 0.1 rad/s rate', () => {
    const state = airborneCruise();
    const controls = createNeutralControls();
    controls.throttleCmd = state.throttle;
    const totalSteps = Math.round(30.0 / DT);
    for (let i = 0; i < totalSteps; i++) advance(state, DT, controls, NO_GROUND);
    expect(Math.abs(state.omega_B.x)).toBeLessThan(0.1);
    expect(Math.abs(state.omega_B.y)).toBeLessThan(0.1);
    expect(Math.abs(state.omega_B.z)).toBeLessThan(0.1);
  });

  it('cruise: 30 s of no-input — stall flag NEVER latches', () => {
    const state = airborneCruise();
    const controls = createNeutralControls();
    controls.throttleCmd = state.throttle;
    const totalSteps = Math.round(30.0 / DT);
    let stallEverTrue = false;
    for (let i = 0; i < totalSteps; i++) {
      advance(state, DT, controls, NO_GROUND);
      if (state.stallFlag) stallEverTrue = true;
    }
    expect(stallEverTrue).toBe(false);
  });

  it('cruise: 30 s of no-input — airspeed stays within ±8 m/s', () => {
    const state = airborneCruise();
    const controls = createNeutralControls();
    controls.throttleCmd = state.throttle;
    const totalSteps = Math.round(30.0 / DT);
    for (let i = 0; i < totalSteps; i++) advance(state, DT, controls, NO_GROUND);
    expect(state.v_W.length()).toBeGreaterThan(42);
    expect(state.v_W.length()).toBeLessThan(58);
  });

  it('spawn config (alt=100 ft, throttle=0.7) stays airborne for 30 s without stalling', () => {
    const s = createInitialState();
    s.x_W.set(-700, FLIGHT_MODEL.groundY + 30.48, 0);
    s.v_W.set(50, 0, 0);
    s.q.identity();
    s.omega_B.set(0, 0, 0);
    s.onGround = false;
    s.throttle = 0.7;
    const controls = createNeutralControls();
    controls.throttleCmd = s.throttle;
    const totalSteps = Math.round(30.0 / DT);
    let stallEverTrue = false;
    for (let i = 0; i < totalSteps; i++) {
      advance(s, DT, controls, NO_GROUND);
      if (s.stallFlag) stallEverTrue = true;
    }
    expect(s.onGround).toBe(false);
    expect(s.x_W.y).toBeGreaterThan(FLIGHT_MODEL.groundY + 5);
    expect(stallEverTrue).toBe(false);
  });
});
