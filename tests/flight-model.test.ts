// Full flight-model integration tests. Validates spec §11 V2 (stall) and the
// takeoff smoke envelope. Stall flag must latch within 5 s when held in deep
// AoA from a low-speed gliding initial condition.

import { describe, expect, it } from 'vitest';
import {
  FLIGHT_MODEL,
  advance,
  createInitialState,
  createNeutralControls,
} from '../src/physics/index.js';

const groundY = (): number => FLIGHT_MODEL.groundY;

describe('flight-model: full-throttle takeoff', () => {
  it('after 30 s on runway, throttle 1.0, neutral stick → V > 30 m/s', () => {
    // Matches the existing smoke-test envelope but at full throttle. The
    // aircraft remains on the runway (no rotation) and accelerates by ground
    // roll only — by 30 s it should easily exceed 30 m/s with full power.
    const state = createInitialState();
    const controls = createNeutralControls();
    controls.throttleCmd = 1.0;

    const renderDt = 1 / 60;
    for (let i = 0; i < 30 * 60; i += 1) {
      advance(state, renderDt, controls, groundY);
    }

    const V = Math.hypot(state.v_W.x, state.v_W.y, state.v_W.z);
    expect(V).toBeGreaterThan(30);
  });

  it('full back stick after 15 s ground roll lifts off the runway', () => {
    // The on-ground attitude constraint (kinematic gear stand-in, see
    // FlightCoder report §2) holds the deck level until aerodynamic forces
    // overcome it. With full power and full back stick this happens around
    // V ≈ 40 m/s — verify the aircraft eventually leaves the ground.
    const state = createInitialState();
    const controls = createNeutralControls();
    controls.throttleCmd = 1.0;
    const renderDt = 1 / 60;
    for (let i = 0; i < 15 * 60; i += 1) {
      advance(state, renderDt, controls, groundY);
    }
    controls.elevatorCmd = 0.5;
    for (let i = 0; i < 10 * 60; i += 1) {
      advance(state, renderDt, controls, groundY);
    }
    expect(state.x_W.y).toBeGreaterThan(FLIGHT_MODEL.groundY + 1.0);
    expect(state.onGround).toBe(false);
  });
});

describe('flight-model: stall flag latches', () => {
  it('V=22 m/s, full back stick, no thrust → stallFlag within 5 s', () => {
    const state = createInitialState();
    state.x_W.set(0, 1000, 0);
    state.v_W.set(22, 0, 0); // forward (body == world at identity)
    state.onGround = false;
    state.q.identity();

    const controls = createNeutralControls();
    controls.throttleCmd = 0;
    controls.elevatorCmd = 1.0; // full nose-up

    // Far-below-aircraft ground so we don't clamp.
    const noGround = (): number => -1e6;

    const renderDt = 1 / 60;
    let latchedAt = -1;
    for (let i = 0; i < 5 * 60; i += 1) {
      advance(state, renderDt, controls, noGround);
      if (state.stallFlag && latchedAt < 0) {
        latchedAt = i / 60;
      }
    }
    expect(state.stallFlag).toBe(true);
    expect(latchedAt).toBeGreaterThanOrEqual(0);
    expect(latchedAt).toBeLessThan(5);
  });

  it('clean stall: V=26, full back stick, no thrust latches stallFlag', () => {
    const state = createInitialState();
    state.x_W.set(0, 1000, 0);
    state.v_W.set(26, 0, 0);
    state.onGround = false;
    state.q.identity();

    const controls = createNeutralControls();
    controls.elevatorCmd = 1.0;

    const noGround = (): number => -1e6;
    const renderDt = 1 / 60;
    for (let i = 0; i < 5 * 60; i += 1) {
      advance(state, renderDt, controls, noGround);
    }
    expect(state.stallFlag).toBe(true);
  });
});
