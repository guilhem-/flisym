// Smoke test: throttle 0.5, controls neutral, on runway, after 30s of stepping
// the aircraft must have airspeed > 30 m/s (per FlightCoder brief).

import { describe, expect, it } from 'vitest';
import {
  FLIGHT_MODEL,
  advance,
  createInitialState,
  createNeutralControls,
} from '../src/physics/index.js';

describe('physics smoke', () => {
  it('reaches >30 m/s after 30s with throttle 0.5 from runway', () => {
    const state = createInitialState();
    const controls = createNeutralControls();
    controls.throttleCmd = 0.5;

    const getGround = (): number => FLIGHT_MODEL.groundY;

    // Run 30 seconds at 60 Hz render rate.
    const renderDt = 1 / 60;
    const totalSteps = 30 * 60;
    for (let i = 0; i < totalSteps; i += 1) {
      advance(state, renderDt, controls, getGround);
    }

    const V = Math.sqrt(
      state.v_W.x ** 2 + state.v_W.y ** 2 + state.v_W.z ** 2,
    );
    expect(V).toBeGreaterThan(30);
  });
});
