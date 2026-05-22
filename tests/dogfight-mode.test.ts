// Dogfight Mode tests — Wave C mission-coder deliverable.
//
// Four required cases per `AGENTS/mission-coder.md`:
//   1. `init` spawns 1 bot at the expected world position.
//   2. After 60 s of simulated time with neutral player controls, the bot
//      has acquired the player as target (AI Engage state).
//   3. Player-fires-gun call decrements playerAmmo.gunRounds.
//   4. Setting `playerHealth.airframe = 0` triggers `status().lost === true`
//      exactly once.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { DogfightMode, type ModeContext } from '../src/modes/index.js';
import {
  advance,
  createInitialState,
  createNeutralControls,
  FLIGHT_MODEL,
} from '../src/physics/index.js';
import { COMBAT_TUNING } from '../src/combat/index.js';

// ── Browser globals stubs ──────────────────────────────────────────────────
interface FakeWindow {
  listeners: Map<string, Array<(e: unknown) => void>>;
  addEventListener(t: string, h: (e: unknown) => void): void;
  removeEventListener(t: string, h: (e: unknown) => void): void;
  dispatchEvent(evt: { type: string }): boolean;
  location: { search: string; href: string };
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
    location: { search, href: `http://localhost/${search}` },
  };
}

function makeCtx(seed = 1): {
  ctx: ModeContext;
  emitted: Array<{ type: string } & Record<string, unknown>>;
} {
  const scene = new THREE.Scene();
  const emitted: Array<{ type: string } & Record<string, unknown>> = [];
  const state = createInitialState();
  const controls = createNeutralControls();

  const hudStub = {
    setChallenge: vi.fn(),
    hideFinishOverlay: vi.fn(),
    showFinishOverlay: vi.fn(),
    setCombat: vi.fn(),
    setMission: vi.fn(),
    setTimeTrial: vi.fn(),
  };

  const netStub = {
    on: vi.fn().mockReturnValue(() => {}),
    send: vi.fn(),
    getPeers: vi.fn().mockReturnValue(new Map()),
    update: vi.fn(),
  };

  const world = {
    getGroundHeight: (_x: number, _z: number): number => FLIGHT_MODEL.groundY,
  };

  const ctx: ModeContext = {
    scene,
    world: world as unknown as ModeContext['world'],
    hud: hudStub as unknown as ModeContext['hud'],
    cameraRig: {} as ModeContext['cameraRig'],
    input: {} as ModeContext['input'],
    playerState: state,
    playerControls: controls,
    net: netStub as unknown as ModeContext['net'],
    seed,
    emit: (event) => emitted.push(event as { type: string } & Record<string, unknown>),
  };
  return { ctx, emitted };
}

let fakeWin: FakeWindow;
const originalWindow: unknown = (globalThis as { window?: unknown }).window;
beforeEach(() => {
  fakeWin = makeFakeWindow();
  (globalThis as { window?: unknown }).window = fakeWin;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe('DogfightMode', () => {
  test('init spawns 1 bot at world (0, 700, +2000)', () => {
    const { ctx } = makeCtx();
    const mode = new DogfightMode();
    mode.init(ctx);
    const bot = mode.bot;
    expect(bot).not.toBeNull();
    expect(bot!.id).toBe('bandit-01');
    expect(bot!.state.x_W.x).toBeCloseTo(0, 5);
    expect(bot!.state.x_W.y).toBeCloseTo(700, 5);
    expect(bot!.state.x_W.z).toBeCloseTo(2000, 5);
    mode.dispose();
  });

  test('init does NOT leave player at zero velocity / instant-stall', () => {
    // Regression for "press 3 → STALL appears instantly". `combatRespawn`
    // unconditionally zeroes v_W and throttle (damage.ts respawn()); if the
    // mode init calls it AFTER setting the spawn velocity, the next physics
    // step computes alpha from (u=0, v=−g·dt) → ~90° and the STALL flag
    // latches on frame 1. Order must be: respawn first, spawn pose second.
    const { ctx } = makeCtx();
    const mode = new DogfightMode();
    mode.init(ctx);
    // Player should have the dogfight spawn velocity and throttle, not zero.
    expect(ctx.playerState.v_W.length()).toBeGreaterThan(60);
    expect(ctx.playerState.throttle).toBeGreaterThan(0.5);
    expect(ctx.playerState.stallFlag).toBe(false);
    mode.dispose();
  });

  test('after 60 s of simulated time, bot has acquired player as target', () => {
    const { ctx } = makeCtx();
    const mode = new DogfightMode();
    mode.init(ctx);

    const renderDt = 1 / 60;
    const getGround = (): number => FLIGHT_MODEL.groundY;
    // Player flies straight; bot AI tracks the player.
    for (let i = 0; i < 60 * 60; i += 1) {
      advance(ctx.playerState, renderDt, ctx.playerControls, getGround);
      mode.update(renderDt, ctx);
      // Early-exit if bot has already engaged.
      const goal = mode.bot?.pilot.getState().lastGoal;
      if (goal && (goal.state === 'Engage' || goal.targetId === 'player')) break;
    }
    const goal = mode.bot?.pilot.getState();
    expect(goal).toBeDefined();
    // Either the FSM transitioned to Engage, or the percepts caught the
    // player as primary target. Both are valid signs of acquisition.
    const acquired =
      goal!.lastGoal.state === 'Engage' || goal!.lastGoal.targetId === 'player';
    expect(acquired).toBe(true);
    mode.dispose();
  });

  test('firePlayerGun decrements gunRounds', () => {
    const { ctx } = makeCtx();
    const mode = new DogfightMode();
    mode.init(ctx);
    const w = mode.playerWeapons;
    expect(w).not.toBeNull();
    const before = w!.gunRoundsL + w!.gunRoundsR;
    const fired = mode.firePlayerGun();
    expect(fired).toBeGreaterThan(0);
    const after = w!.gunRoundsL + w!.gunRoundsR;
    expect(after).toBe(before - fired);
    mode.dispose();
  });

  test('setting playerHealth.airframe = 0 triggers status().lost exactly once', () => {
    const { ctx } = makeCtx();
    const mode = new DogfightMode();
    mode.init(ctx);
    // Run one update first so we're past the init frame.
    mode.update(1 / 60, ctx);
    // Now kill the player.
    ctx.playerState.hp!.airframe = 0;
    ctx.playerState.isAlive = false;
    // Tick once to latch the lose condition.
    mode.update(1 / 60, ctx);

    const s1 = mode.status();
    expect(s1.lost).toBe(true);
    // Subsequent status() calls should NOT report lost === true again per
    // edge-trigger semantics.
    const s2 = mode.status();
    expect(s2.lost).toBe(false);
    mode.dispose();
  });

  test('headline reflects K/D, ammo, hull', () => {
    const { ctx } = makeCtx();
    const mode = new DogfightMode();
    mode.init(ctx);
    const s = mode.status();
    expect(s.headline).toMatch(/^DOGFIGHT — K:D 0\/0 · GUNS \d+ · MSL \d+\/2 · HULL 100%$/);
    expect(s.id).toBe('dogfight');
    mode.dispose();
  });
});

// Reference COMBAT_TUNING to ensure it's the canonical source for missile rails.
test('COMBAT_TUNING exposes missileRailsPerAircraft = 2', () => {
  expect(COMBAT_TUNING.missileRailsPerAircraft).toBe(2);
});
