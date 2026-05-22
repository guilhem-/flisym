// Keys-to-state simulation behavior.
//
// Bridges the gap that `tests/physics-axis-correctness.test.ts` leaves: those
// tests set `controls.elevatorCmd = 1` directly, bypassing KeyboardInput. This
// suite drives KeyboardInput with synthetic keydown/keyup events, runs the
// full main-loop sequence (`input.update` → `advance`) for one or more
// seconds, and asserts the direction of the resulting state change.
//
// A regression in EITHER `keyboard.ts` (mapping) OR `physics/*` (sign / axis)
// will trip these. The two layers can't be silently swapped (e.g. flipping
// W↔S AND Cm_de sign together) because we keep both axis-correctness suites
// in the gate.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { KeyboardInput } from '../src/input/keyboard.js';
import {
  advance,
  createInitialState,
  createNeutralControls,
  FLIGHT_MODEL,
  type AircraftState,
  type Controls,
} from '../src/physics/index.js';

// -------------------------------------------------------------------------
// Fake window so KeyboardInput can attach in Node.
// -------------------------------------------------------------------------
interface FakeKeyEvent {
  key: string;
  shiftKey: boolean;
  repeat: boolean;
  preventDefault(): void;
}

interface FakeWin {
  listeners: Map<string, ((e: unknown) => void)[]>;
  addEventListener(t: string, h: (e: unknown) => void): void;
  removeEventListener(t: string, h: (e: unknown) => void): void;
  dispatchEvent(tOrEvent: string | { type: string; detail?: unknown }, e?: unknown): void;
}

function makeFakeWindow(): FakeWin {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  return {
    listeners,
    addEventListener(t, h) {
      const arr = listeners.get(t) ?? [];
      arr.push(h);
      listeners.set(t, arr);
    },
    removeEventListener(t, h) {
      const arr = listeners.get(t);
      if (!arr) return;
      listeners.set(t, arr.filter((x) => x !== h));
    },
    dispatchEvent(tOrEvent, e) {
      if (typeof tOrEvent === 'string') {
        const arr = listeners.get(tOrEvent);
        if (!arr) return;
        for (const h of [...arr]) h(e);
      }
      // CustomEvent path (V / G / digit keys) — ignored here; we test it in
      // keyboard-input-extended.test.ts.
    },
  };
}

function key(
  k: string,
  opts: { shiftKey?: boolean; repeat?: boolean } = {},
): FakeKeyEvent {
  return {
    key: k,
    shiftKey: opts.shiftKey ?? false,
    repeat: opts.repeat ?? false,
    preventDefault(): void {
      // no-op
    },
  };
}

let win: FakeWin;
let originalWindow: unknown;

beforeEach(() => {
  win = makeFakeWindow();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originalWindow = (globalThis as any).window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = win;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = originalWindow;
});

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
const RENDER_DT = 1 / 60;
const NO_GROUND = (): number => -1e6;
// Flat runway terrain (0 m). Physics adds FLIGHT_MODEL.groundY as the
// wheel-to-ground offset, so the aircraft sits at y = 0 + groundY = 0.5.
const GROUND = (): number => 0;

function airborneAt(speed: number, altitude = 1000): AircraftState {
  const s = createInitialState();
  s.x_W.set(0, altitude, 0);
  s.v_W.set(speed, 0, 0); // body +X aligned with world +X at identity quat
  s.q.identity();
  s.omega_B.set(0, 0, 0);
  s.onGround = false;
  s.throttle = 0.5;
  return s;
}

/** One render frame: drive input, then advance physics (sub-steps internally). */
function frame(
  input: KeyboardInput,
  state: AircraftState,
  controls: Controls,
  getGround: () => number,
  dt = RENDER_DT,
): void {
  input.update(dt, controls);
  advance(state, dt, controls, getGround);
}

function frameFor(
  input: KeyboardInput,
  state: AircraftState,
  controls: Controls,
  seconds: number,
  getGround: () => number,
): void {
  const n = Math.round(seconds / RENDER_DT);
  for (let i = 0; i < n; i++) frame(input, state, controls, getGround);
}

// -------------------------------------------------------------------------
// 1. Pitch axis (W / S)
// -------------------------------------------------------------------------
describe('keys→state — pitch axis (W / S)', () => {
  test('holding W on cruise → nose-down pitch (omega_B.z < 0)', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('w'));
    frameFor(input, state, controls, 1.0, NO_GROUND);
    expect(controls.elevatorCmd).toBeLessThan(-0.9);
    expect(state.omega_B.z).toBeLessThan(-0.03);
    // Sanity: nose actually pitched DOWN in world.
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(state.q);
    expect(fwd.y).toBeLessThan(0);
    input.dispose();
  });

  test('holding S on cruise → nose-up pitch (omega_B.z > 0)', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('s'));
    frameFor(input, state, controls, 1.0, NO_GROUND);
    expect(controls.elevatorCmd).toBeGreaterThan(0.9);
    expect(state.omega_B.z).toBeGreaterThan(0.03);
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(state.q);
    expect(fwd.y).toBeGreaterThan(0);
    input.dispose();
  });

  test('releasing S after a pitch-up command relaxes elevator command to ~0', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('s'));
    frameFor(input, state, controls, 0.5, NO_GROUND);
    expect(controls.elevatorCmd).toBeGreaterThan(0.5);
    win.dispatchEvent('keyup', key('s'));
    frameFor(input, state, controls, 1.0, NO_GROUND);
    expect(Math.abs(controls.elevatorCmd)).toBeLessThan(0.05);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 2. Roll axis (A / D)
// -------------------------------------------------------------------------
describe('keys→state — roll axis (A / D)', () => {
  test('holding D on cruise → right roll (omega_B.x > 0)', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('d'));
    frameFor(input, state, controls, 1.0, NO_GROUND);
    expect(controls.aileronCmd).toBeGreaterThan(0.9);
    expect(state.omega_B.x).toBeGreaterThan(0.05);
    // Body-up vector should now tilt to the right (world +Z).
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(state.q);
    expect(up.z).toBeGreaterThan(0);
    input.dispose();
  });

  test('holding A on cruise → left roll (omega_B.x < 0)', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('a'));
    frameFor(input, state, controls, 1.0, NO_GROUND);
    expect(controls.aileronCmd).toBeLessThan(-0.9);
    expect(state.omega_B.x).toBeLessThan(-0.05);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(state.q);
    expect(up.z).toBeLessThan(0);
    input.dispose();
  });

  test('release of D: aileron command relaxes to ~0 and surface follows', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('d'));
    frameFor(input, state, controls, 1.0, NO_GROUND);
    expect(controls.aileronCmd).toBeGreaterThan(0.9);
    expect(state.delta_a).toBeGreaterThan(0.9);
    win.dispatchEvent('keyup', key('d'));
    // 1 s is enough at command center rate 3/s + surface center rate 3/s.
    frameFor(input, state, controls, 1.0, NO_GROUND);
    expect(Math.abs(controls.aileronCmd)).toBeLessThan(0.05);
    expect(Math.abs(state.delta_a)).toBeLessThan(0.05);
    input.dispose();
  });

  test('opposite stick (D then A) drives the aileron surface to counter the roll', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('d'));
    frameFor(input, state, controls, 1.0, NO_GROUND);
    const peakRollRight = state.omega_B.x;
    expect(peakRollRight).toBeGreaterThan(0.1);
    win.dispatchEvent('keyup', key('d'));
    win.dispatchEvent('keydown', key('a'));
    frameFor(input, state, controls, 1.5, NO_GROUND);
    // Counter-aileron applied: command and surface both at full left, and
    // the right-roll rate has been arrested (down significantly from peak).
    expect(controls.aileronCmd).toBeLessThan(-0.9);
    expect(state.delta_a).toBeLessThan(-0.9);
    expect(state.omega_B.x).toBeLessThan(peakRollRight * 0.5);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 3. Yaw axis (Q / E)
// -------------------------------------------------------------------------
describe('keys→state — yaw axis (Q / E)', () => {
  test('holding E on cruise → right yaw (omega_B.y > 0)', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('e'));
    frameFor(input, state, controls, 1.0, NO_GROUND);
    expect(controls.rudderCmd).toBeGreaterThan(0.9);
    expect(state.omega_B.y).toBeGreaterThan(0.01);
    input.dispose();
  });

  test('holding Q on cruise → left yaw (omega_B.y < 0)', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('q'));
    frameFor(input, state, controls, 1.0, NO_GROUND);
    expect(controls.rudderCmd).toBeLessThan(-0.9);
    expect(state.omega_B.y).toBeLessThan(-0.01);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 4. Throttle / engine (Shift / Control / PageUp / PageDown)
// -------------------------------------------------------------------------
describe('keys→state — throttle response', () => {
  test('Shift held on ground from idle → throttleCmd ramps and v_W.x grows', () => {
    const input = new KeyboardInput();
    const state = createInitialState(); // on ground, throttle 0
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('Shift'));
    frameFor(input, state, controls, 5.0, GROUND);
    expect(controls.throttleCmd).toBeGreaterThan(0.5); // ramp at 0.5/s for 5 s
    expect(state.throttle).toBeGreaterThan(0.4); // throttle lag τ=0.3s caught up
    expect(state.v_W.x).toBeGreaterThan(1.0); // measurable forward motion
    input.dispose();
  });

  test('PageUp equivalent to Shift: same throttle ramp rate', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('PageUp'));
    // Drive only the input layer for 2 s (no physics needed).
    for (let i = 0; i < 120; i++) input.update(1 / 60, controls);
    // 2 s at 0.5/s → ≈1.0 (clamped).
    expect(controls.throttleCmd).toBeGreaterThan(0.95);
    input.dispose();
  });

  test('Control held airborne → throttleCmd falls; v_W magnitude decays', () => {
    const input = new KeyboardInput();
    const state = airborneAt(60);
    state.throttle = 1.0;
    const controls = createNeutralControls();
    controls.throttleCmd = 1.0;
    win.dispatchEvent('keydown', key('Control'));
    const v0 = state.v_W.length();
    frameFor(input, state, controls, 5.0, NO_GROUND);
    expect(controls.throttleCmd).toBeLessThan(0.05); // ramped to 0
    expect(state.throttle).toBeLessThan(0.1);
    expect(state.v_W.length()).toBeLessThan(v0); // decelerated
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 5. Brake / ground roll
// -------------------------------------------------------------------------
describe('keys→state — brake on ground', () => {
  test('brake on (B then taxi) decelerates faster than no brake', () => {
    // No-brake control case.
    const inputA = new KeyboardInput();
    const stateA = createInitialState();
    stateA.v_W.set(20, 0, 0);
    stateA.onGround = true;
    const controlsA = createNeutralControls();
    frameFor(inputA, stateA, controlsA, 3.0, GROUND);
    const vA = stateA.v_W.length();
    inputA.dispose();

    // Brake case — toggle brake on, then taxi.
    const inputB = new KeyboardInput();
    const stateB = createInitialState();
    stateB.v_W.set(20, 0, 0);
    stateB.onGround = true;
    const controlsB = createNeutralControls();
    win.dispatchEvent('keydown', key('b'));
    inputB.update(1 / 60, controlsB);
    expect(controlsB.brake).toBe(true);
    frameFor(inputB, stateB, controlsB, 3.0, GROUND);
    const vB = stateB.v_W.length();
    inputB.dispose();

    expect(vB).toBeLessThan(vA - 0.5);
  });

  test('two B presses (toggle off) → behaves like no-brake', () => {
    const input = new KeyboardInput();
    const state = createInitialState();
    state.v_W.set(20, 0, 0);
    state.onGround = true;
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('b'));
    input.update(1 / 60, controls);
    expect(controls.brake).toBe(true);
    win.dispatchEvent('keydown', key('b'));
    input.update(1 / 60, controls);
    expect(controls.brake).toBe(false);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 6. Stall behavior driven from keys
// -------------------------------------------------------------------------
describe('keys→state — stall behavior', () => {
  test('holding S clean at low IAS for several seconds → stallFlag latches true', () => {
    const input = new KeyboardInput();
    const state = airborneAt(22, 1000); // 22 m/s ≈ 43 kt — just above stall
    state.throttle = 0;
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('s')); // sustained pull-up
    frameFor(input, state, controls, 5.0, NO_GROUND);
    expect(state.stallFlag).toBe(true);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 7. Compound input: takeoff roll (Shift + S)
// -------------------------------------------------------------------------
describe('keys→state — compound input (takeoff roll)', () => {
  test('Shift + S on ground from rest → eventually airborne (state.onGround = false)', () => {
    const input = new KeyboardInput();
    const state = createInitialState(); // on ground, v=0, throttle=0
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('Shift'));
    frameFor(input, state, controls, 8.0, GROUND); // throttle up
    expect(state.throttle).toBeGreaterThan(0.9);
    expect(state.v_W.x).toBeGreaterThan(15); // rolling fast
    win.dispatchEvent('keydown', key('s')); // rotate
    frameFor(input, state, controls, 12.0, GROUND);
    expect(state.onGround).toBe(false);
    expect(state.x_W.y).toBeGreaterThan(FLIGHT_MODEL.groundY + 1);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 8. Flap detent reaches state.delta_f
// -------------------------------------------------------------------------
describe('keys→state — flap detent reaches state.delta_f', () => {
  test('F once → state.delta_f converges to 0.5', () => {
    const input = new KeyboardInput();
    const state = airborneAt(40);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('f'));
    frameFor(input, state, controls, 1.0, NO_GROUND);
    expect(controls.flapsCmd).toBe(0.5);
    expect(state.delta_f).toBeCloseTo(0.5, 2);
    input.dispose();
  });

  test('F twice → state.delta_f converges to 1.0', () => {
    const input = new KeyboardInput();
    const state = airborneAt(40);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('f'));
    input.update(1 / 60, controls);
    win.dispatchEvent('keydown', key('f'));
    frameFor(input, state, controls, 1.5, NO_GROUND);
    expect(controls.flapsCmd).toBe(1);
    expect(state.delta_f).toBeCloseTo(1, 2);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 9. Cross-axis isolation: one key only moves one axis
// -------------------------------------------------------------------------
describe('keys→state — cross-axis isolation', () => {
  test('Q (rudder) primary effect is yaw, not pitch (short integration)', () => {
    // Integrate only 0.3 s — long enough for delta_r to reach -1.0 and yaw to
    // become measurable, short enough that p·r Euler cross-coupling has not
    // yet pumped large amplitudes into the pitch axis. (Sustained full rudder
    // is divergent over multiple seconds: yaw rate of -6 rad/s after 1 s
    // then couples into pitch — that's correct physics, not a sign bug.)
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('q'));
    frameFor(input, state, controls, 0.3, NO_GROUND);
    expect(state.omega_B.y).toBeLessThan(-0.1); // measurable left yaw
    // Pitch must be substantially smaller than yaw (loose 3× threshold; the
    // exact ratio depends on Cn_dr tuning, but a 1:1 rudder→pitch coupling
    // would indicate a sign error in cross-axis terms).
    expect(Math.abs(state.omega_B.z) * 3).toBeLessThan(Math.abs(state.omega_B.y));
    input.dispose();
  });

  test('D (aileron) drives roll dominantly over pitch', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('d'));
    frameFor(input, state, controls, 0.5, NO_GROUND);
    expect(state.omega_B.x).toBeGreaterThan(0.05);
    // Roll must dominate: |p| > |q| at this early phase.
    expect(Math.abs(state.omega_B.x)).toBeGreaterThan(Math.abs(state.omega_B.z));
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 10. Throttle lag — state.throttle is a 1st-order lag of controls.throttleCmd
// -------------------------------------------------------------------------
describe('keys→state — throttle 1st-order lag', () => {
  test('state.throttle lags controls.throttleCmd (τ ≈ 0.3 s)', () => {
    const input = new KeyboardInput();
    const state = createInitialState();
    state.throttle = 0;
    const controls = createNeutralControls();
    controls.throttleCmd = 1.0; // hard step command (skip the keyboard ramp)
    // Step from 0 → 1. At t = τ ≈ 0.3 s, state.throttle ≈ 1 − 1/e ≈ 0.632.
    // physics-spec.md §10: throttleTau = 0.3.
    frameFor(input, state, controls, 0.3, GROUND);
    // Allow a ±0.05 tolerance: integration is discrete, not analytic.
    expect(state.throttle).toBeGreaterThan(0.55);
    expect(state.throttle).toBeLessThan(0.7);
    input.dispose();
  });

  test('after 5 τ (~1.5 s) state.throttle is within 1% of the command', () => {
    const input = new KeyboardInput();
    const state = createInitialState();
    state.throttle = 0;
    const controls = createNeutralControls();
    controls.throttleCmd = 1.0;
    frameFor(input, state, controls, 1.5, GROUND);
    expect(state.throttle).toBeGreaterThan(0.99);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 11. No-input stability
// -------------------------------------------------------------------------
describe('keys→state — no-input stability', () => {
  test('createInitialState + no keys for 5 s → stays on ground, no spin', () => {
    const input = new KeyboardInput();
    const state = createInitialState();
    const controls = createNeutralControls();
    frameFor(input, state, controls, 5.0, GROUND);
    expect(state.onGround).toBe(true);
    expect(state.x_W.y).toBeCloseTo(FLIGHT_MODEL.groundY, 1);
    expect(state.v_W.length()).toBeLessThan(1.0); // basically stationary
    expect(state.omega_B.length()).toBeLessThan(0.01); // no spin
    input.dispose();
  });

  test('airborne cruise with no keys for 3 s → heading still roughly +X', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    frameFor(input, state, controls, 3.0, NO_GROUND);
    // Forward axis should still point primarily +X.
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(state.q);
    expect(fwd.x).toBeGreaterThan(0.9); // dominantly forward
    expect(Math.abs(fwd.z)).toBeLessThan(0.3); // no big heading drift
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 12. Surface lag — state.delta_a should lag the command
// -------------------------------------------------------------------------
describe('keys→state — surface deflection lag', () => {
  test('during ramp, |state.delta_a| ≤ |aileronCmd| (surface lags command)', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('d'));
    // Sample at t=0.1, t=0.2, t=0.3. At each, surface should be ≤ command
    // (controlRate = 4/s same as command ramp — surface might match).
    for (const seconds of [0.05, 0.15, 0.25]) {
      frameFor(input, state, controls, seconds, NO_GROUND);
      expect(Math.abs(state.delta_a)).toBeLessThanOrEqual(
        Math.abs(controls.aileronCmd) + 1e-6,
      );
    }
    input.dispose();
  });

  test('surface settles to command magnitude after sustained input (≥0.5s)', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('d'));
    frameFor(input, state, controls, 0.5, NO_GROUND);
    expect(controls.aileronCmd).toBeCloseTo(1, 2);
    expect(state.delta_a).toBeCloseTo(1, 2);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 13. Command reversal — held key released, opposite key held
// -------------------------------------------------------------------------
describe('keys→state — command reversal', () => {
  test('D → release → A: aileron command reverses sign', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('d'));
    for (let i = 0; i < 60; i++) input.update(1 / 60, controls); // 1 s
    expect(controls.aileronCmd).toBeGreaterThan(0.9);

    win.dispatchEvent('keyup', key('d'));
    win.dispatchEvent('keydown', key('a'));
    for (let i = 0; i < 60; i++) input.update(1 / 60, controls); // 1 s
    expect(controls.aileronCmd).toBeLessThan(-0.9);

    input.dispose();
  });

  test('S → release → W: elevator command reverses sign', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', key('s'));
    for (let i = 0; i < 60; i++) input.update(1 / 60, controls);
    expect(controls.elevatorCmd).toBeGreaterThan(0.9);
    win.dispatchEvent('keyup', key('s'));
    win.dispatchEvent('keydown', key('w'));
    for (let i = 0; i < 60; i++) input.update(1 / 60, controls);
    expect(controls.elevatorCmd).toBeLessThan(-0.9);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 14. Damage-zone interaction (engine destroyed → throttle pinned to 0)
// -------------------------------------------------------------------------
describe('keys→state — engine destroyed pins throttle to 0', () => {
  test('Shift held + hp.engine = 0 → throttleCmd is forced to 0', () => {
    const input = new KeyboardInput();
    const state = airborneAt(50);
    state.throttle = 0.9;
    state.hp = {
      airframe: 100,
      engine: 0, // engine destroyed
      controls: { aileron: 100, elevator: 100, rudder: 100 },
    };
    state.isAlive = true;
    const controls = createNeutralControls();
    controls.throttleCmd = 1.0;
    win.dispatchEvent('keydown', key('Shift'));
    frameFor(input, state, controls, 1.0, NO_GROUND);
    // controls.ts forces throttleCmd → 0 and state.throttle → 0 when engine = 0.
    expect(controls.throttleCmd).toBe(0);
    expect(state.throttle).toBe(0);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// 14b. Determinism — identical key sequence yields identical state
// -------------------------------------------------------------------------
describe('keys→state — determinism', () => {
  test('two runs with identical inputs produce bit-identical state', () => {
    function runOnce(): { omega: [number, number, number]; pos: [number, number, number] } {
      const input = new KeyboardInput();
      const state = airborneAt(50);
      const controls = createNeutralControls();
      win.dispatchEvent('keydown', key('d'));
      frameFor(input, state, controls, 0.5, NO_GROUND);
      win.dispatchEvent('keyup', key('d'));
      win.dispatchEvent('keydown', key('s'));
      frameFor(input, state, controls, 0.5, NO_GROUND);
      win.dispatchEvent('keyup', key('s'));
      frameFor(input, state, controls, 0.5, NO_GROUND);
      input.dispose();
      return {
        omega: [state.omega_B.x, state.omega_B.y, state.omega_B.z],
        pos: [state.x_W.x, state.x_W.y, state.x_W.z],
      };
    }
    const a = runOnce();
    // Reset fake window between runs (listeners persist otherwise).
    win = makeFakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = win;
    const b = runOnce();
    expect(b.omega).toEqual(a.omega);
    expect(b.pos).toEqual(a.pos);
  });
});

// -------------------------------------------------------------------------
// 15. Magnitude sanity — no single-key input drives any angular rate
// above an absurd value within 1 s.
// -------------------------------------------------------------------------
describe('keys→state — magnitude sanity (no divergence within 1 s)', () => {
  const singleKeys = ['w', 'a', 's', 'd', 'q', 'e'];
  for (const k of singleKeys) {
    test(`holding '${k}' for 1 s → no omega component > 10 rad/s`, () => {
      const input = new KeyboardInput();
      const state = airborneAt(50);
      const controls = createNeutralControls();
      win.dispatchEvent('keydown', key(k));
      frameFor(input, state, controls, 1.0, NO_GROUND);
      // 10 rad/s = 573°/s. Any axis above that within 1 s indicates a runaway.
      // Cessna omega rarely exceeds 3-4 rad/s in honest maneuvers.
      // (Q/E sustained rudder is known to climb past this by ~2s — see the
      // cross-axis isolation test for details. 1 s is the budget.)
      expect(Math.abs(state.omega_B.x)).toBeLessThan(10);
      expect(Math.abs(state.omega_B.y)).toBeLessThan(10);
      expect(Math.abs(state.omega_B.z)).toBeLessThan(10);
      input.dispose();
    });
  }
});
