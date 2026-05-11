// Mode registry + ModeSwitcher + Free Flight + Time Trial unit tests.
//
// These tests run in vitest's default node environment, so we stub the
// browser globals the modes touch (window, localStorage). We never spin up
// a renderer — meshes are added to a plain `new THREE.Scene()`.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  MODE_REGISTRY,
  getDefaultModeId,
  FreeFlightMode,
  TimeTrialMode,
  ModeSwitcher,
  type Mode,
  type ModeContext,
} from '../src/modes/index.js';
import {
  advance,
  createInitialState,
  createNeutralControls,
  FLIGHT_MODEL,
} from '../src/physics/index.js';

// ── Browser globals stubs ──────────────────────────────────────────────────
//
// The modes attach `window.addEventListener('keydown', ...)` and
// `window.addEventListener('challenge:gate', ...)`, and Time Trial reads /
// writes `localStorage.{getItem,setItem}`. Stub both before each test so
// state never leaks between cases.

interface FakeWindow {
  listeners: Map<string, Array<(e: unknown) => void>>;
  addEventListener(type: string, h: (e: unknown) => void): void;
  removeEventListener(type: string, h: (e: unknown) => void): void;
  dispatchEvent(evt: { type: string }): boolean;
  location: { search: string };
}

function makeFakeWindow(search = ''): FakeWindow {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
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
    dispatchEvent(evt) {
      const arr = listeners.get(evt.type);
      if (!arr) return true;
      for (const h of [...arr]) h(evt);
      return true;
    },
    location: { search },
  };
}

function makeFakeLocalStorage(): Storage {
  const map = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index) {
      const keys = [...map.keys()];
      return keys[index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
  return fake;
}

// ── Context factory ────────────────────────────────────────────────────────

interface Captured {
  emitted: Array<{ type: string } & Record<string, unknown>>;
  ctx: ModeContext;
}

function makeCtx(): Captured {
  const scene = new THREE.Scene();
  const emitted: Captured['emitted'] = [];
  const state = createInitialState();
  // Free-flight spawn pose (matches main.ts): airborne, +X heading.
  state.x_W.set(-700, FLIGHT_MODEL.groundY + 30.48, 0);
  state.v_W.set(50, 0, 0);
  state.onGround = false;
  state.throttle = 0.7;

  const controls = createNeutralControls();
  controls.throttleCmd = 0.7;

  // Minimal HUD stub — modes call setChallenge / hideFinishOverlay /
  // showFinishOverlay. We just record the calls for assertions.
  const hudStub = {
    setChallenge: vi.fn(),
    hideFinishOverlay: vi.fn(),
    showFinishOverlay: vi.fn(),
  };

  // CameraRig + KeyboardInput + NetClient + World aren't touched by the
  // Wave B modes; cast empty objects through `unknown` to satisfy the
  // structural ModeContext type.
  const ctx: ModeContext = {
    scene,
    world: {} as ModeContext['world'],
    hud: hudStub as unknown as ModeContext['hud'],
    cameraRig: {} as ModeContext['cameraRig'],
    input: {} as ModeContext['input'],
    playerState: state,
    playerControls: controls,
    net: {} as ModeContext['net'],
    seed: 1,
    emit: (event) => {
      emitted.push(event as { type: string } & Record<string, unknown>);
    },
  };
  return { emitted, ctx };
}

// ── Global stubs (per-test) ────────────────────────────────────────────────

let fakeWin: FakeWindow;
let fakeLS: Storage;
const originalWindow: unknown = (globalThis as { window?: unknown }).window;
const originalLS: unknown = (globalThis as { localStorage?: unknown }).localStorage;

beforeEach(() => {
  fakeWin = makeFakeWindow();
  fakeLS = makeFakeLocalStorage();
  (globalThis as { window?: unknown }).window = fakeWin;
  (globalThis as { localStorage?: unknown }).localStorage = fakeLS;
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  (globalThis as { localStorage?: unknown }).localStorage = originalLS;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MODE_REGISTRY', () => {
  test('exposes exactly the four canonical ids', () => {
    const ids = [...MODE_REGISTRY.keys()].sort();
    expect(ids).toEqual(['dogfight', 'free-flight', 'strike-mission', 'time-trial']);
  });

  test('free-flight + time-trial factories construct, dogfight + strike throw', () => {
    const ff = MODE_REGISTRY.get('free-flight');
    const tt = MODE_REGISTRY.get('time-trial');
    const df = MODE_REGISTRY.get('dogfight');
    const sm = MODE_REGISTRY.get('strike-mission');
    expect(ff?.()).toBeInstanceOf(FreeFlightMode);
    expect(tt?.()).toBeInstanceOf(TimeTrialMode);
    expect(() => df?.()).toThrow(/dogfight not implemented/);
    expect(() => sm?.()).toThrow(/strike-mission not implemented/);
  });

  test('getDefaultModeId reads ?mode= and falls back to free-flight', () => {
    expect(getDefaultModeId()).toBe('free-flight');
    fakeWin.location.search = '?mode=time-trial';
    expect(getDefaultModeId()).toBe('time-trial');
    fakeWin.location.search = '?mode=nonsense';
    expect(getDefaultModeId()).toBe('free-flight');
    fakeWin.location.search = '?mode=dogfight';
    expect(getDefaultModeId()).toBe('dogfight');
  });
});

describe('FreeFlightMode', () => {
  test('init + 60 simulated frames → score >= 0 and won === false', () => {
    const { ctx, emitted } = makeCtx();
    const mode = new FreeFlightMode();
    mode.init(ctx);

    const renderDt = 1 / 60;
    const getGround = (): number => FLIGHT_MODEL.groundY;
    for (let i = 0; i < 60; i += 1) {
      advance(ctx.playerState, renderDt, ctx.playerControls, getGround);
      mode.update(renderDt, ctx);
    }

    const s = mode.status();
    expect(s.id).toBe('free-flight');
    expect(s.won).toBe(false);
    expect(s.lost).toBe(false);
    expect(s.score).toBeGreaterThanOrEqual(0);
    // After ~1 s of airborne flight from the cruise spawn we should have
    // accumulated at least 1 integer second of airborne time.
    expect(s.score).toBeGreaterThanOrEqual(1);
    expect(s.headline).toMatch(/^FREE FLIGHT — /);
    expect(emitted[0]?.type).toBe('mode_started');
  });

  test('headline is "on ground" when onGround', () => {
    const { ctx } = makeCtx();
    ctx.playerState.onGround = true;
    const mode = new FreeFlightMode();
    mode.init(ctx);
    expect(mode.status().headline).toBe('FREE FLIGHT — on ground');
  });

  test('dispose emits mode_ended and re-init resets score', () => {
    const { ctx, emitted } = makeCtx();
    const mode = new FreeFlightMode();
    mode.init(ctx);
    mode.update(5, ctx); // 5 simulated seconds airborne (state.onGround=false)
    expect(mode.status().score).toBeGreaterThanOrEqual(5);

    mode.dispose();
    const ended = emitted.find((e) => e.type === 'mode_ended');
    expect(ended).toBeDefined();
    expect(ended?.['won']).toBe(false);

    // Re-init resets the airborne counter.
    mode.init(ctx);
    expect(mode.status().score).toBe(0);
  });
});

describe('TimeTrialMode', () => {
  test('with empty localStorage: personalBest === null and no ghost mesh added', () => {
    const { ctx } = makeCtx();
    const mode = new TimeTrialMode();
    const sceneChildrenBefore = ctx.scene.children.length;

    mode.init(ctx);

    expect(mode.getPersonalBest()).toBeNull();
    expect(mode.getGhostMesh()).toBeNull();
    // Course mesh is added; ghost mesh is NOT.
    const ghostInScene = ctx.scene.children.some(
      (c) => c.name === 'TimeTrialGhost',
    );
    expect(ghostInScene).toBe(false);
    // Course mesh added: +1.
    expect(ctx.scene.children.length).toBe(sceneChildrenBefore + 1);
  });

  test('with stored PB 45.0: personalBest === 45.0 on init', () => {
    fakeLS.setItem('flisym.timeTrial.pb', '45.0');
    const { ctx } = makeCtx();
    const mode = new TimeTrialMode();
    mode.init(ctx);
    expect(mode.getPersonalBest()).toBe(45.0);
  });

  test('with stored PB + ghost frames: ghost mesh attached to scene', () => {
    const frames = [
      { t: 0, x: [0, 100, 0], q: [0, 0, 0, 1] },
      { t: 1, x: [50, 100, 0], q: [0, 0, 0, 1] },
      { t: 2, x: [100, 100, 0], q: [0, 0, 0, 1] },
    ];
    fakeLS.setItem('flisym.timeTrial.pb', '45.0');
    fakeLS.setItem('flisym.timeTrial.ghost.v1', JSON.stringify(frames));

    const { ctx } = makeCtx();
    const mode = new TimeTrialMode();
    mode.init(ctx);

    expect(mode.getGhostMesh()).not.toBeNull();
    const ghostInScene = ctx.scene.children.some(
      (c) => c.name === 'TimeTrialGhost',
    );
    expect(ghostInScene).toBe(true);

    mode.dispose();
    const ghostAfter = ctx.scene.children.some(
      (c) => c.name === 'TimeTrialGhost',
    );
    expect(ghostAfter).toBe(false);
  });

  test('init emits mode_started; dispose emits mode_ended', () => {
    const { ctx, emitted } = makeCtx();
    const mode = new TimeTrialMode();
    mode.init(ctx);
    expect(emitted.some((e) => e.type === 'mode_started')).toBe(true);

    mode.dispose();
    expect(emitted.some((e) => e.type === 'mode_ended')).toBe(true);
  });

  test('runActive stays false with neutral controls (gate 0 never crossed)', () => {
    const { ctx } = makeCtx();
    const mode = new TimeTrialMode();
    mode.init(ctx);
    for (let i = 0; i < 30; i += 1) {
      mode.update(1 / 60, ctx);
    }
    expect(mode.isRunActive()).toBe(false);
    expect(mode.status().score).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('ModeSwitcher', () => {
  test('setMode disposes the old mode and inits the new one (spy call counts)', () => {
    const { ctx } = makeCtx();
    const switcher = new ModeSwitcher(ctx);

    // Install the first mode and spy on its dispose.
    switcher.setMode('free-flight');
    const first = switcher.getCurrent();
    expect(first).not.toBeNull();
    const firstDispose = vi.spyOn(first as Mode, 'dispose');

    // Switching to a new mode must dispose the previous one once and init
    // the next one once. We spy on TimeTrialMode.prototype.init so we catch
    // the init call even though the next instance hasn't been created yet.
    const initSpy = vi.spyOn(TimeTrialMode.prototype, 'init');

    switcher.setMode('time-trial');

    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(switcher.getCurrent()?.meta.id).toBe('time-trial');

    initSpy.mockRestore();
    switcher.dispose();
  });

  test('setMode through the real registry: dispose old + init new', () => {
    const { ctx, emitted } = makeCtx();
    const switcher = new ModeSwitcher(ctx);
    switcher.setMode('free-flight');
    expect(switcher.getCurrent()?.meta.id).toBe('free-flight');

    switcher.setMode('time-trial');
    expect(switcher.getCurrent()?.meta.id).toBe('time-trial');

    // The free-flight mode_ended event should have fired during the switch.
    expect(emitted.find((e) => e.type === 'mode_ended' && e['mode'] === 'free-flight')).toBeDefined();
    // And time-trial mode_started should be present.
    expect(emitted.find((e) => e.type === 'mode_started' && e['mode'] === 'time-trial')).toBeDefined();

    switcher.dispose();
    expect(switcher.getCurrent()).toBeNull();
  });
});
