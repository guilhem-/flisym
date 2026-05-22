// Extended KeyboardInput coverage.
//
// Complements `tests/keyboard-input.test.ts` (arrows + page-keys) by covering
// the rest of the input surface that main.ts depends on:
//   - WASD / QE roll & rudder mapping
//   - Solo Shift/Control throttle (the existing suite only tests them in
//     parallel with PageUp/PageDown)
//   - Flap detent cycling (F and Shift+F), 3-detent loop, autorepeat suppression
//   - Brake toggle: edge-triggered, autorepeat suppression, multiple toggles
//   - V (camera:cycle) and G (challenge:reset) custom-event dispatch
//   - Digit time preset mapping (1→05:00 … 9→21:00, 0→23:00)
//   - Autorepeat suppression of discrete actions
//   - dispose() removes window listeners

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { KeyboardInput } from '../src/input/keyboard.js';
import {
  createNeutralControls,
  type Controls,
} from '../src/physics/state.js';

interface FakeKeyEvent {
  key: string;
  shiftKey: boolean;
  repeat: boolean;
  preventDefaultCalled: boolean;
  preventDefault(): void;
}

interface FakeCustomEvent {
  type: string;
  detail: unknown;
}

interface FakeWin {
  listeners: Map<string, ((e: unknown) => void)[]>;
  dispatched: FakeCustomEvent[];
  addEventListener(t: string, h: (e: unknown) => void): void;
  removeEventListener(t: string, h: (e: unknown) => void): void;
  dispatchEvent(t: string | FakeCustomEvent, e?: unknown): void;
}

function makeFakeWindow(): FakeWin {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const dispatched: FakeCustomEvent[] = [];
  return {
    listeners,
    dispatched,
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
    // Overload-style: when called with a CustomEvent-like object (single arg
    // with `type` field), record it for assertions and run any listeners with
    // a `type` field set. When called with (type, fakeKeyEvent), do the
    // legacy fire-listeners-with-event pattern used in keyboard-input.test.ts.
    dispatchEvent(tOrEvent, e) {
      if (typeof tOrEvent === 'string') {
        const arr = listeners.get(tOrEvent);
        if (!arr) return;
        for (const h of [...arr]) h(e);
        return;
      }
      // CustomEvent path: KeyboardInput calls window.dispatchEvent(new CustomEvent(...))
      dispatched.push(tOrEvent);
    },
  };
}

function keyDown(
  key: string,
  opts: { shiftKey?: boolean; repeat?: boolean } = {},
): FakeKeyEvent {
  return {
    key,
    shiftKey: opts.shiftKey ?? false,
    repeat: opts.repeat ?? false,
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
  };
}

let win: FakeWin;
let originalWindow: unknown;

beforeEach(() => {
  win = makeFakeWindow();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originalWindow = (globalThis as any).window;
  // The KeyboardInput.dispatchTimePreset path constructs `new CustomEvent(...)`.
  // In Node that's defined; we just need a stub so the object the constructor
  // returns is what KeyboardInput passes to window.dispatchEvent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = win;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = originalWindow;
});

function tick(input: KeyboardInput, controls: Controls, dt = 1 / 60, steps = 60): void {
  for (let i = 0; i < steps; i++) input.update(dt, controls);
}

// -------------------------------------------------------------------------
// WASD / QE control surface mapping
// -------------------------------------------------------------------------
describe('KeyboardInput — WASD / QE mapping', () => {
  test('D drives aileronCmd toward +1 (roll right)', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', keyDown('d'));
    const controls = createNeutralControls();
    tick(input, controls);
    expect(controls.aileronCmd).toBeGreaterThan(0.9);
    input.dispose();
  });

  test('A drives aileronCmd toward -1 (roll left)', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', keyDown('a'));
    const controls = createNeutralControls();
    tick(input, controls);
    expect(controls.aileronCmd).toBeLessThan(-0.9);
    input.dispose();
  });

  test('A + D cancel out', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', keyDown('a'));
    win.dispatchEvent('keydown', keyDown('d'));
    const controls = createNeutralControls();
    tick(input, controls);
    expect(Math.abs(controls.aileronCmd)).toBeLessThan(0.05);
    input.dispose();
  });

  test('E drives rudderCmd toward +1 (yaw right)', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', keyDown('e'));
    const controls = createNeutralControls();
    tick(input, controls);
    expect(controls.rudderCmd).toBeGreaterThan(0.9);
    input.dispose();
  });

  test('Q drives rudderCmd toward -1 (yaw left)', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', keyDown('q'));
    const controls = createNeutralControls();
    tick(input, controls);
    expect(controls.rudderCmd).toBeLessThan(-0.9);
    input.dispose();
  });

  test('Q + E cancel out', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', keyDown('q'));
    win.dispatchEvent('keydown', keyDown('e'));
    const controls = createNeutralControls();
    tick(input, controls);
    expect(Math.abs(controls.rudderCmd)).toBeLessThan(0.05);
    input.dispose();
  });

  test('releasing D self-centers aileronCmd toward 0', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', keyDown('d'));
    const controls = createNeutralControls();
    tick(input, controls);
    expect(controls.aileronCmd).toBeGreaterThan(0.9);
    win.dispatchEvent('keyup', keyDown('d'));
    tick(input, controls);
    expect(Math.abs(controls.aileronCmd)).toBeLessThan(0.05);
    input.dispose();
  });

  test('simultaneous W + D drives both elevator and aileron in their directions', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', keyDown('w'));
    win.dispatchEvent('keydown', keyDown('d'));
    const controls = createNeutralControls();
    tick(input, controls);
    expect(controls.elevatorCmd).toBeLessThan(-0.9); // W = nose down
    expect(controls.aileronCmd).toBeGreaterThan(0.9); // D = roll right
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// Throttle (solo Shift / Control)
// -------------------------------------------------------------------------
describe('KeyboardInput — Shift / Control throttle solo', () => {
  test('Shift alone ramps throttle up at 0.5/s', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', keyDown('Shift'));
    tick(input, controls); // 1 s
    expect(controls.throttleCmd).toBeGreaterThan(0.45);
    expect(controls.throttleCmd).toBeLessThan(0.55);
    input.dispose();
  });

  test('Control alone ramps throttle down at 0.5/s', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    controls.throttleCmd = 1;
    win.dispatchEvent('keydown', keyDown('Control'));
    tick(input, controls);
    expect(controls.throttleCmd).toBeGreaterThan(0.45);
    expect(controls.throttleCmd).toBeLessThan(0.55);
    input.dispose();
  });

  test('Throttle does NOT self-center when neither key is held', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    controls.throttleCmd = 0.6;
    tick(input, controls);
    // Throttle has no self-centering — should still be 0.6 ± epsilon
    expect(controls.throttleCmd).toBeCloseTo(0.6, 5);
    input.dispose();
  });

  test('releasing Shift mid-ramp stops the climb (throttle holds)', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', keyDown('Shift'));
    tick(input, controls, 1 / 60, 30); // 0.5 s — throttle ~0.25
    const held = controls.throttleCmd;
    expect(held).toBeGreaterThan(0.2);
    win.dispatchEvent('keyup', keyDown('Shift'));
    tick(input, controls); // 1 s, no input
    expect(controls.throttleCmd).toBeCloseTo(held, 5);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// Flaps cycling — F and Shift+F
// -------------------------------------------------------------------------
describe('KeyboardInput — flap detent cycling', () => {
  test('F cycles flaps forward through 3 detents (0 → 0.5 → 1 → 0)', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    tick(input, controls, 1 / 60, 1);
    expect(controls.flapsCmd).toBe(0);

    win.dispatchEvent('keydown', keyDown('f'));
    tick(input, controls, 1 / 60, 1);
    expect(controls.flapsCmd).toBe(0.5);

    win.dispatchEvent('keydown', keyDown('f'));
    tick(input, controls, 1 / 60, 1);
    expect(controls.flapsCmd).toBe(1);

    win.dispatchEvent('keydown', keyDown('f'));
    tick(input, controls, 1 / 60, 1);
    expect(controls.flapsCmd).toBe(0);
    input.dispose();
  });

  test('Shift+F cycles flaps in reverse (0 → 1 → 0.5 → 0)', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();

    win.dispatchEvent('keydown', keyDown('f', { shiftKey: true }));
    tick(input, controls, 1 / 60, 1);
    expect(controls.flapsCmd).toBe(1);

    win.dispatchEvent('keydown', keyDown('f', { shiftKey: true }));
    tick(input, controls, 1 / 60, 1);
    expect(controls.flapsCmd).toBe(0.5);

    win.dispatchEvent('keydown', keyDown('f', { shiftKey: true }));
    tick(input, controls, 1 / 60, 1);
    expect(controls.flapsCmd).toBe(0);
    input.dispose();
  });

  test('autorepeat F is ignored (flap index stays put)', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', keyDown('f')); // first press → 0.5
    tick(input, controls, 1 / 60, 1);
    expect(controls.flapsCmd).toBe(0.5);
    // 10 autorepeats — none should advance the detent.
    for (let i = 0; i < 10; i++) {
      win.dispatchEvent('keydown', keyDown('f', { repeat: true }));
    }
    tick(input, controls, 1 / 60, 1);
    expect(controls.flapsCmd).toBe(0.5);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// Brake toggle
// -------------------------------------------------------------------------
describe('KeyboardInput — brake toggle', () => {
  test('B toggles brake from off → on → off', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    expect(controls.brake).toBe(false);

    win.dispatchEvent('keydown', keyDown('b'));
    tick(input, controls, 1 / 60, 1);
    expect(controls.brake).toBe(true);

    win.dispatchEvent('keydown', keyDown('b'));
    tick(input, controls, 1 / 60, 1);
    expect(controls.brake).toBe(false);
    input.dispose();
  });

  test('autorepeat B is ignored (brake stays in last toggle state)', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', keyDown('b'));
    tick(input, controls, 1 / 60, 1);
    expect(controls.brake).toBe(true);
    for (let i = 0; i < 5; i++) {
      win.dispatchEvent('keydown', keyDown('b', { repeat: true }));
    }
    tick(input, controls, 1 / 60, 1);
    expect(controls.brake).toBe(true);
    input.dispose();
  });

  test('multiple distinct B presses toggle multiple times', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    for (let i = 0; i < 4; i++) {
      win.dispatchEvent('keydown', keyDown('b'));
      tick(input, controls, 1 / 60, 1);
    }
    // 4 toggles → back to false
    expect(controls.brake).toBe(false);
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// V (camera) and G (challenge) custom events
// -------------------------------------------------------------------------
describe('KeyboardInput — V and G dispatch custom events', () => {
  test('V dispatches a camera:cycle event', () => {
    const input = new KeyboardInput();
    win.dispatched.length = 0;
    win.dispatchEvent('keydown', keyDown('v'));
    const types = win.dispatched.map((e) => e.type);
    expect(types).toContain('camera:cycle');
    input.dispose();
  });

  test('autorepeat V does NOT spam camera:cycle', () => {
    const input = new KeyboardInput();
    win.dispatched.length = 0;
    win.dispatchEvent('keydown', keyDown('v'));
    for (let i = 0; i < 10; i++) {
      win.dispatchEvent('keydown', keyDown('v', { repeat: true }));
    }
    const cycles = win.dispatched.filter((e) => e.type === 'camera:cycle');
    expect(cycles.length).toBe(1);
    input.dispose();
  });

  test('G dispatches a challenge:reset event', () => {
    const input = new KeyboardInput();
    win.dispatched.length = 0;
    win.dispatchEvent('keydown', keyDown('g'));
    expect(win.dispatched.map((e) => e.type)).toContain('challenge:reset');
    input.dispose();
  });
});

// -------------------------------------------------------------------------
// Digit time presets — 5/6/7/8/9 + 0 only; 1-4 reserved for mode hotkeys.
// -------------------------------------------------------------------------
describe('KeyboardInput — digit time presets', () => {
  // 5 → 13:00, 6 → 15:00, 7 → 17:00, 8 → 19:00, 9 → 21:00, 0 → 23:00
  const cases: Array<[string, number]> = [
    ['5', 13],
    ['6', 15],
    ['7', 17],
    ['8', 19],
    ['9', 21],
    ['0', 23],
  ];

  for (const [digit, expectedHour] of cases) {
    test(`pressing '${digit}' dispatches time:set with hour ${expectedHour}`, () => {
      const input = new KeyboardInput();
      win.dispatched.length = 0;
      win.dispatchEvent('keydown', keyDown(digit));
      const timeEvents = win.dispatched.filter((e) => e.type === 'time:set');
      expect(timeEvents.length).toBe(1);
      expect(timeEvents[0]?.detail).toBe(expectedHour);
      input.dispose();
    });
  }

  test('autorepeat digit does NOT spam time:set', () => {
    const input = new KeyboardInput();
    win.dispatched.length = 0;
    win.dispatchEvent('keydown', keyDown('7'));
    for (let i = 0; i < 5; i++) {
      win.dispatchEvent('keydown', keyDown('7', { repeat: true }));
    }
    const timeEvents = win.dispatched.filter((e) => e.type === 'time:set');
    expect(timeEvents.length).toBe(1);
    input.dispose();
  });

  // Mode-hotkey digits (1-4) MUST NOT dispatch time:set — that was a UX
  // conflict where pressing '1' both switched mode AND changed time-of-day.
  for (const digit of ['1', '2', '3', '4']) {
    test(`mode-hotkey digit '${digit}' does NOT dispatch time:set`, () => {
      const input = new KeyboardInput();
      win.dispatched.length = 0;
      win.dispatchEvent('keydown', keyDown(digit));
      const timeEvents = win.dispatched.filter((e) => e.type === 'time:set');
      expect(timeEvents.length).toBe(0);
      input.dispose();
    });
  }
});

// -------------------------------------------------------------------------
// dispose()
// -------------------------------------------------------------------------
describe('KeyboardInput — dispose', () => {
  test('after dispose, key events no longer drive controls', () => {
    const input = new KeyboardInput();
    input.dispose();
    win.dispatchEvent('keydown', keyDown('d'));
    const controls = createNeutralControls();
    tick(input, controls);
    expect(controls.aileronCmd).toBe(0);
  });

  test('after dispose, V no longer dispatches camera:cycle', () => {
    const input = new KeyboardInput();
    input.dispose();
    win.dispatched.length = 0;
    win.dispatchEvent('keydown', keyDown('v'));
    expect(win.dispatched.filter((e) => e.type === 'camera:cycle').length).toBe(0);
  });

  test('after dispose, window listener count drops to 0', () => {
    const input = new KeyboardInput();
    const downBefore = (win.listeners.get('keydown') ?? []).length;
    const upBefore = (win.listeners.get('keyup') ?? []).length;
    expect(downBefore).toBeGreaterThan(0);
    expect(upBefore).toBeGreaterThan(0);
    input.dispose();
    const downAfter = (win.listeners.get('keydown') ?? []).length;
    const upAfter = (win.listeners.get('keyup') ?? []).length;
    expect(downAfter).toBe(downBefore - 1);
    expect(upAfter).toBe(upBefore - 1);
  });

  test('calling dispose twice does not throw and does not over-remove', () => {
    const input = new KeyboardInput();
    input.dispose();
    expect(() => input.dispose()).not.toThrow();
    // After 2 disposes, listener count should still be at most baseline (0 here).
    expect((win.listeners.get('keydown') ?? []).length).toBe(0);
    expect((win.listeners.get('keyup') ?? []).length).toBe(0);
  });
});

// (The previous digit/mode-hotkey overlap is now resolved — digits 1-4
//  fire only the mode hotkey, digits 5-9 + 0 fire only time:set. See the
//  "mode-hotkey digit '…' does NOT dispatch time:set" cases above.)
