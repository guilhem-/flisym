// Keyboard input wiring tests.
//
// Asserts:
//   1. Arrow keys map to pitch (↑/↓) and roll (←/→) using the STICK
//      convention so both bindings agree: ↑ = push forward = nose down,
//      ↓ = pull back = nose up. (W aligns with ↑, S aligns with ↓.)
//   2. Arrow keydown/keyup calls preventDefault — without this the browser
//      scrolls the page on every arrow press and the held-state never gets
//      a chance to drive controls. This is the bug a previous session hit.
//   3. WASD still works alongside arrows (both bindings active).

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { KeyboardInput } from '../src/input/keyboard.js';
import {
  createNeutralControls,
  type Controls,
} from '../src/physics/state.js';

// Vitest's default Node env doesn't have window/document/KeyboardEvent.
// Synthesize the minimum we need.

interface FakeWin {
  listeners: Map<string, ((e: unknown) => void)[]>;
  addEventListener(t: string, h: (e: unknown) => void): void;
  removeEventListener(t: string, h: (e: unknown) => void): void;
  dispatchEvent(t: string, e: unknown): void;
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
      listeners.set(
        t,
        arr.filter((x) => x !== h),
      );
    },
    dispatchEvent(t, e) {
      const arr = listeners.get(t);
      if (!arr) return;
      for (const h of [...arr]) h(e);
    },
  };
}

interface FakeKeyEvent {
  key: string;
  shiftKey?: boolean;
  repeat?: boolean;
  preventDefaultCalled: boolean;
  preventDefault(): void;
}

function makeKeyEvent(
  key: string,
  opts: { shiftKey?: boolean; repeat?: boolean } = {},
): FakeKeyEvent {
  const ev: FakeKeyEvent = {
    key,
    shiftKey: opts.shiftKey ?? false,
    repeat: opts.repeat ?? false,
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
  };
  return ev;
}

let win: FakeWin;
let originalWindow: unknown;

beforeEach(() => {
  win = makeFakeWindow();
  // Patch the global `window` so KeyboardInput's window.addEventListener calls
  // hit our fake.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originalWindow = (globalThis as any).window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = win;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = originalWindow;
});

function tickInput(
  input: KeyboardInput,
  controls: Controls,
  dtSeconds: number,
  steps = 1,
): void {
  // Step in small increments so the approach() ramp can complete.
  const step = dtSeconds / steps;
  for (let i = 0; i < steps; i++) input.update(step, controls);
}

describe('KeyboardInput — arrow-key pitch/roll', () => {
  test('ArrowUp drives elevatorCmd toward -1 (nose down, stick-forward)', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', makeKeyEvent('ArrowUp'));
    const controls = createNeutralControls();
    tickInput(input, controls, 1.0, 20); // 1 second @ 20Hz, ramp = 4/s
    expect(controls.elevatorCmd).toBeLessThan(-0.9);
    input.dispose();
  });

  test('ArrowDown drives elevatorCmd toward +1 (nose up, stick-back)', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', makeKeyEvent('ArrowDown'));
    const controls = createNeutralControls();
    tickInput(input, controls, 1.0, 20);
    expect(controls.elevatorCmd).toBeGreaterThan(0.9);
    input.dispose();
  });

  test('ArrowLeft drives aileronCmd toward -1 (roll left)', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', makeKeyEvent('ArrowLeft'));
    const controls = createNeutralControls();
    tickInput(input, controls, 1.0, 20);
    expect(controls.aileronCmd).toBeLessThan(-0.9);
    input.dispose();
  });

  test('ArrowRight drives aileronCmd toward +1 (roll right)', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', makeKeyEvent('ArrowRight'));
    const controls = createNeutralControls();
    tickInput(input, controls, 1.0, 20);
    expect(controls.aileronCmd).toBeGreaterThan(0.9);
    input.dispose();
  });

  test('ArrowUp + ArrowDown cancel out (target = 0)', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', makeKeyEvent('ArrowUp'));
    win.dispatchEvent('keydown', makeKeyEvent('ArrowDown'));
    const controls = createNeutralControls();
    tickInput(input, controls, 1.0, 20);
    expect(Math.abs(controls.elevatorCmd)).toBeLessThan(0.05);
    input.dispose();
  });

  test('releasing ArrowUp self-centers elevator toward 0', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', makeKeyEvent('ArrowUp'));
    const controls = createNeutralControls();
    tickInput(input, controls, 1.0, 20); // ramps to ~-1 (nose down)
    expect(controls.elevatorCmd).toBeLessThan(-0.9);
    win.dispatchEvent('keyup', makeKeyEvent('ArrowUp'));
    tickInput(input, controls, 1.0, 20); // self-centers at 3/s
    expect(Math.abs(controls.elevatorCmd)).toBeLessThan(0.05);
    input.dispose();
  });

  test('WASD remains wired in parallel (W = nose down)', () => {
    const input = new KeyboardInput();
    win.dispatchEvent('keydown', makeKeyEvent('w'));
    const controls = createNeutralControls();
    tickInput(input, controls, 1.0, 20);
    expect(controls.elevatorCmd).toBeLessThan(-0.9);
    input.dispose();
  });
});

describe('KeyboardInput — throttle on PageUp / PageDown', () => {
  test('PageUp ramps throttle up at 0.5/s', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    expect(controls.throttleCmd).toBe(0);
    win.dispatchEvent('keydown', makeKeyEvent('PageUp'));
    tickInput(input, controls, 1.0, 20); // 1 s @ 0.5/s → ~0.5
    expect(controls.throttleCmd).toBeGreaterThan(0.45);
    expect(controls.throttleCmd).toBeLessThan(0.55);
    input.dispose();
  });

  test('PageDown ramps throttle down at 0.5/s', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    controls.throttleCmd = 1;
    win.dispatchEvent('keydown', makeKeyEvent('PageDown'));
    tickInput(input, controls, 1.0, 20);
    expect(controls.throttleCmd).toBeGreaterThan(0.45);
    expect(controls.throttleCmd).toBeLessThan(0.55);
    input.dispose();
  });

  test('PageUp clamps throttle at 1', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', makeKeyEvent('PageUp'));
    tickInput(input, controls, 10.0, 100); // 10 s — way past full throttle
    expect(controls.throttleCmd).toBe(1);
    input.dispose();
  });

  test('PageDown clamps throttle at 0', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    controls.throttleCmd = 0.5;
    win.dispatchEvent('keydown', makeKeyEvent('PageDown'));
    tickInput(input, controls, 10.0, 100);
    expect(controls.throttleCmd).toBe(0);
    input.dispose();
  });

  test('Shift / Control bindings still work alongside PageUp / PageDown', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    win.dispatchEvent('keydown', makeKeyEvent('Shift'));
    tickInput(input, controls, 1.0, 20);
    expect(controls.throttleCmd).toBeGreaterThan(0.45);
    win.dispatchEvent('keyup', makeKeyEvent('Shift'));

    const before = controls.throttleCmd;
    win.dispatchEvent('keydown', makeKeyEvent('Control'));
    tickInput(input, controls, 0.5, 10);
    expect(controls.throttleCmd).toBeLessThan(before);
    input.dispose();
  });

  test('PageUp + PageDown together cancel out (net zero throttle change)', () => {
    const input = new KeyboardInput();
    const controls = createNeutralControls();
    controls.throttleCmd = 0.5;
    win.dispatchEvent('keydown', makeKeyEvent('PageUp'));
    win.dispatchEvent('keydown', makeKeyEvent('PageDown'));
    tickInput(input, controls, 1.0, 20);
    expect(controls.throttleCmd).toBeCloseTo(0.5, 5);
    input.dispose();
  });
});

describe('KeyboardInput — preventDefault on game keys', () => {
  test('arrow keydown calls preventDefault (so the browser does not scroll)', () => {
    const input = new KeyboardInput();
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      const ev = makeKeyEvent(k);
      win.dispatchEvent('keydown', ev);
      expect(ev.preventDefaultCalled, `${k} keydown preventDefault`).toBe(true);
    }
    input.dispose();
  });

  test('arrow keyup also calls preventDefault', () => {
    const input = new KeyboardInput();
    const ev = makeKeyEvent('ArrowUp');
    win.dispatchEvent('keyup', ev);
    expect(ev.preventDefaultCalled).toBe(true);
    input.dispose();
  });

  test('non-game keys do NOT have preventDefault called', () => {
    const input = new KeyboardInput();
    for (const k of ['w', 'a', 's', 'd', 'q', 'e', 'f', 'b']) {
      const ev = makeKeyEvent(k);
      win.dispatchEvent('keydown', ev);
      expect(ev.preventDefaultCalled, `${k} should pass through`).toBe(false);
    }
    input.dispose();
  });

  test('space and PageUp/PageDown also have preventDefault called', () => {
    const input = new KeyboardInput();
    for (const k of [' ', 'PageUp', 'PageDown']) {
      const ev = makeKeyEvent(k);
      win.dispatchEvent('keydown', ev);
      expect(ev.preventDefaultCalled, `${k} should be suppressed`).toBe(true);
    }
    input.dispose();
  });
});

// Suppress the unused-import warning for `vi` (kept for future expansion
// where we might mock dispatchEvent etc.).
void vi;
