// `installModeHotkeys` wiring tests.
//
// Behavior under test (extracted from main.ts):
//   - Keys '1'..'4' map to the four canonical modes.
//   - When the requested mode is already active, no dispose+re-init.
//   - When the event target is <input>/<textarea>, ignore (player is typing).
//   - Successful switches also push to HUD.setMode.
//   - Returned dispose function removes the listener.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installModeHotkeys,
  MODE_HOTKEYS,
  type Mode,
  type ModeId,
  type ModeMeta,
  type ModeStatus,
} from '../src/modes/index.js';
import type { ModeSwitcher } from '../src/modes/index.js';

// ----- Fake window (records listeners, dispatches events) -----------------
interface FakeKeyEvent {
  key: string;
  target?: unknown;
}

interface FakeWin {
  listeners: Map<string, EventListener[]>;
  addEventListener(t: string, h: EventListener): void;
  removeEventListener(t: string, h: EventListener): void;
  dispatchEvent(t: string, e: FakeKeyEvent): void;
}

function makeFakeWin(): FakeWin {
  const listeners = new Map<string, EventListener[]>();
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
    dispatchEvent(t, e) {
      const arr = listeners.get(t);
      if (!arr) return;
      for (const h of [...arr]) h(e as unknown as Event);
    },
  };
}

// ----- Fake ModeSwitcher & HUD (interfaces only — unit test) -------------
// installModeHotkeys depends on ModeSwitcher's public surface (getCurrent /
// setMode / status) and HUD.setMode. We don't need real modes.

function makeFakeMode(id: ModeMeta['id']): Mode {
  const meta: ModeMeta = {
    id,
    displayName: `Fake ${id}`,
    description: 'fake',
  };
  const status: ModeStatus = {
    id,
    won: false,
    lost: false,
    score: 0,
    headline: `Fake ${id}`,
  };
  return {
    meta,
    init: vi.fn(),
    update: vi.fn(),
    status: () => status,
    dispose: vi.fn(),
  };
}

interface FakeSwitcher {
  current: Mode | null;
  setMode: ReturnType<typeof vi.fn>;
  getCurrent(): Mode | null;
  status(): ModeStatus;
  dispose(): void;
}

function makeFakeSwitcher(initialId: ModeMeta['id'] = 'free-flight'): FakeSwitcher {
  const sw: FakeSwitcher = {
    current: makeFakeMode(initialId),
    setMode: vi.fn(),
    getCurrent() {
      return this.current;
    },
    status() {
      const c = this.current;
      if (!c) throw new Error('FakeSwitcher: status() before setMode()');
      return c.status();
    },
    dispose() {
      this.current = null;
    },
  };
  // Mock impl: actually change current on call.
  sw.setMode.mockImplementation((id: ModeId) => {
    sw.current = makeFakeMode(id);
  });
  return sw;
}

interface FakeHud {
  setMode: ReturnType<typeof vi.fn>;
}
function makeFakeHud(): FakeHud {
  return { setMode: vi.fn() };
}

let fakeWin: FakeWin;
beforeEach(() => {
  fakeWin = makeFakeWin();
});
afterEach(() => {
  // Clean up any HTMLInputElement we may have stubbed.
  (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement = undefined;
});

// -------------------------------------------------------------------------
// MODE_HOTKEYS constant
// -------------------------------------------------------------------------
describe('MODE_HOTKEYS', () => {
  test('maps exactly 1/2/3/4 to the four canonical mode ids', () => {
    expect(Object.keys(MODE_HOTKEYS).sort()).toEqual(['1', '2', '3', '4']);
    expect(MODE_HOTKEYS['1']).toBe<ModeId>('free-flight');
    expect(MODE_HOTKEYS['2']).toBe<ModeId>('time-trial');
    expect(MODE_HOTKEYS['3']).toBe<ModeId>('dogfight');
    expect(MODE_HOTKEYS['4']).toBe<ModeId>('strike-mission');
  });
});

// -------------------------------------------------------------------------
// installModeHotkeys behavior
// -------------------------------------------------------------------------
describe('installModeHotkeys — switching', () => {
  test("pressing '2' switches from free-flight to time-trial and pushes to HUD", () => {
    const switcher = makeFakeSwitcher('free-flight');
    const hud = makeFakeHud();
    installModeHotkeys(
      switcher as unknown as ModeSwitcher,
      hud as unknown as Parameters<typeof installModeHotkeys>[1],
      fakeWin as unknown as Window,
    );
    fakeWin.dispatchEvent('keydown', { key: '2' });
    expect(switcher.setMode).toHaveBeenCalledTimes(1);
    expect(switcher.setMode).toHaveBeenCalledWith('time-trial');
    expect(switcher.getCurrent()?.meta.id).toBe('time-trial');
    expect(hud.setMode).toHaveBeenCalledTimes(1);
  });

  test("pressing '1' while already on free-flight is a no-op (no re-init)", () => {
    const switcher = makeFakeSwitcher('free-flight');
    const hud = makeFakeHud();
    const beforeMode = switcher.getCurrent();
    installModeHotkeys(
      switcher as unknown as ModeSwitcher,
      hud as unknown as Parameters<typeof installModeHotkeys>[1],
      fakeWin as unknown as Window,
    );
    fakeWin.dispatchEvent('keydown', { key: '1' });
    expect(switcher.getCurrent()).toBe(beforeMode);
    expect(switcher.setMode).not.toHaveBeenCalled();
    expect(hud.setMode).not.toHaveBeenCalled();
  });

  test("unmapped keys ('5', '0', 'x') are no-ops", () => {
    const switcher = makeFakeSwitcher('free-flight');
    const hud = makeFakeHud();
    installModeHotkeys(
      switcher as unknown as ModeSwitcher,
      hud as unknown as Parameters<typeof installModeHotkeys>[1],
      fakeWin as unknown as Window,
    );
    fakeWin.dispatchEvent('keydown', { key: '5' });
    fakeWin.dispatchEvent('keydown', { key: '0' });
    fakeWin.dispatchEvent('keydown', { key: 'x' });
    expect(switcher.setMode).not.toHaveBeenCalled();
  });

  test('all four hotkeys reachable in sequence (1→2→3→4)', () => {
    const switcher = makeFakeSwitcher('free-flight');
    const hud = makeFakeHud();
    installModeHotkeys(
      switcher as unknown as ModeSwitcher,
      hud as unknown as Parameters<typeof installModeHotkeys>[1],
      fakeWin as unknown as Window,
    );
    fakeWin.dispatchEvent('keydown', { key: '2' });
    expect(switcher.getCurrent()?.meta.id).toBe('time-trial');
    fakeWin.dispatchEvent('keydown', { key: '3' });
    expect(switcher.getCurrent()?.meta.id).toBe('dogfight');
    fakeWin.dispatchEvent('keydown', { key: '4' });
    expect(switcher.getCurrent()?.meta.id).toBe('strike-mission');
    fakeWin.dispatchEvent('keydown', { key: '1' });
    expect(switcher.getCurrent()?.meta.id).toBe('free-flight');
    expect(hud.setMode).toHaveBeenCalledTimes(4);
  });

  test('event with target = HTMLInputElement is ignored (player typing in a UI)', () => {
    const switcher = makeFakeSwitcher('free-flight');
    const hud = makeFakeHud();
    class FakeInput {}
    (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement = FakeInput;
    installModeHotkeys(
      switcher as unknown as ModeSwitcher,
      hud as unknown as Parameters<typeof installModeHotkeys>[1],
      fakeWin as unknown as Window,
    );
    fakeWin.dispatchEvent('keydown', { key: '2', target: new FakeInput() });
    expect(switcher.setMode).not.toHaveBeenCalled();
  });

  test('event with target = HTMLTextAreaElement is ignored', () => {
    const switcher = makeFakeSwitcher('free-flight');
    const hud = makeFakeHud();
    class FakeTA {}
    (globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement = FakeTA;
    installModeHotkeys(
      switcher as unknown as ModeSwitcher,
      hud as unknown as Parameters<typeof installModeHotkeys>[1],
      fakeWin as unknown as Window,
    );
    fakeWin.dispatchEvent('keydown', { key: '3', target: new FakeTA() });
    expect(switcher.setMode).not.toHaveBeenCalled();
    (globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement = undefined;
  });

  test('event with a non-input target proceeds normally (no false ignore)', () => {
    const switcher = makeFakeSwitcher('free-flight');
    const hud = makeFakeHud();
    class FakeInput {}
    (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement = FakeInput;
    installModeHotkeys(
      switcher as unknown as ModeSwitcher,
      hud as unknown as Parameters<typeof installModeHotkeys>[1],
      fakeWin as unknown as Window,
    );
    fakeWin.dispatchEvent('keydown', { key: '2', target: { tagName: 'CANVAS' } });
    expect(switcher.setMode).toHaveBeenCalledWith('time-trial');
  });
});

describe('installModeHotkeys — dispose', () => {
  test('returned dispose removes the listener (subsequent keydowns are no-ops)', () => {
    const switcher = makeFakeSwitcher('free-flight');
    const hud = makeFakeHud();
    const dispose = installModeHotkeys(
      switcher as unknown as ModeSwitcher,
      hud as unknown as Parameters<typeof installModeHotkeys>[1],
      fakeWin as unknown as Window,
    );
    expect((fakeWin.listeners.get('keydown') ?? []).length).toBe(1);
    dispose();
    expect((fakeWin.listeners.get('keydown') ?? []).length).toBe(0);
    fakeWin.dispatchEvent('keydown', { key: '2' });
    expect(switcher.setMode).not.toHaveBeenCalled();
  });

  test('dispose is idempotent', () => {
    const switcher = makeFakeSwitcher('free-flight');
    const hud = makeFakeHud();
    const dispose = installModeHotkeys(
      switcher as unknown as ModeSwitcher,
      hud as unknown as Parameters<typeof installModeHotkeys>[1],
      fakeWin as unknown as Window,
    );
    dispose();
    expect(() => dispose()).not.toThrow();
  });
});

describe('installModeHotkeys — error handling', () => {
  test('a throwing setMode is caught and logged (does not poison listener)', () => {
    const switcher = makeFakeSwitcher('free-flight');
    const hud = makeFakeHud();
    switcher.setMode.mockImplementationOnce(() => {
      throw new Error('synthetic');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installModeHotkeys(
      switcher as unknown as ModeSwitcher,
      hud as unknown as Parameters<typeof installModeHotkeys>[1],
      fakeWin as unknown as Window,
    );
    fakeWin.dispatchEvent('keydown', { key: '2' });
    expect(errSpy).toHaveBeenCalledOnce();
    expect(hud.setMode).not.toHaveBeenCalled();
    // Listener must still be wired for subsequent presses.
    fakeWin.dispatchEvent('keydown', { key: '3' });
    expect(switcher.setMode).toHaveBeenCalledWith('dogfight');
    expect(hud.setMode).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
