# Mode interface (shared) — FLISYM v0.2

All four playable modes implement a single minimal interface so the
top-level `src/main.ts` can swap modes without each mode reaching into
the integration loop. **Keep this surface small.** Anything mode-specific
lives inside the mode implementation, not on this interface.

## Frame conventions (apply to every mode)

- **World frame**: +X east, +Y up, +Z south. Heading 000° = −Z (north),
  090° = +X (east). Source: `docs/physics-spec.md` §1.1.
- **Body frame**: +X forward (out of the spinner), +Y up (out of the
  cabin), +Z right (out of the right wingtip). Source: `physics-spec.md`
  §1.2.
- All spawn positions, waypoint coordinates, gate centers, and target
  positions in mode docs are expressed in **world frame**.
- All weapon mounts, thrust vectors, and ordnance release velocities in
  mode docs are expressed in **body frame** (then rotated by `state.q`
  to world frame at spawn time).

## TypeScript interface (canonical)

The interface itself is implemented in `src/modes/types.ts` (Wave B).
This document is the contract. The interface body MUST NOT grow without
producer approval — mode-specific extensions go inside the implementing
class.

```ts
import type * as THREE from 'three';
import type { AircraftState, Controls } from '../physics/index.js';
import type { World } from '../world/index.js';
import type { HUD } from '../hud/index.js';
import type { CameraRig } from '../camera/index.js';
import type { NetClient } from '../net/index.js';
import type { KeyboardInput } from '../input/index.js';

/** Static metadata. Used by the registry + the mode-selector UI. */
export interface ModeMeta {
  /** Stable id — used in URLs, telemetry, save data. */
  readonly id: 'free-flight' | 'time-trial' | 'dogfight' | 'strike-mission';
  /** Player-facing name for HUD / mode-select. */
  readonly displayName: string;
  /** ≤ 90 char description for mode-select UI. */
  readonly description: string;
}

/** Constructor-time dependencies handed to every mode by main.ts. */
export interface ModeContext {
  readonly scene: THREE.Scene;
  readonly world: World;
  readonly hud: HUD;
  readonly cameraRig: CameraRig;
  readonly input: KeyboardInput;
  /** Player aircraft state (the same instance threaded through physics). */
  readonly playerState: AircraftState;
  /** Player control struct — mode may push commands (AI assist, autoland). */
  readonly playerControls: Controls;
  /** Multiplayer client. Modes may opt in or ignore. */
  readonly net: NetClient;
  /** Random-source: deterministic seed for replays / mission gen. */
  readonly seed: number;
  /** Emit a telemetry event (see each mode's event list). */
  readonly emit: (event: ModeTelemetryEvent) => void;
}

/** Per-frame state surfaced to HUD + tests. Snapshot copy, not a live ref. */
export interface ModeStatus {
  readonly id: ModeMeta['id'];
  /** Win condition reached this frame. False on every frame after the first. */
  readonly won: boolean;
  /** Lose condition reached this frame. Same edge-trigger semantics. */
  readonly lost: boolean;
  /** Numeric score the mode chooses to expose; mode-specific meaning. */
  readonly score: number;
  /** Mode-defined string for HUD ("Gate 4/12", "Targets 3/8", "Health 78%"). */
  readonly headline: string;
}

/** The interface itself. Lifecycle + status. Nothing else. */
export interface Mode {
  readonly meta: ModeMeta;

  /** Build meshes, register listeners, set initial state. Called once. */
  init(ctx: ModeContext): void;

  /**
   * Per-frame tick. Called AFTER physics advance, BEFORE renderer.render.
   * Modes that mutate the aircraft (e.g. dogfight damage reducing control
   * authority) MUST do so via `ctx.playerControls`, not by mutating
   * `ctx.playerState` directly (one exception: `respawn`-style resets).
   */
  update(dt: number, ctx: ModeContext): void;

  /** Read-only snapshot for HUD + tests. Called per frame. */
  status(): ModeStatus;

  /** Tear down meshes + listeners. Idempotent. */
  dispose(): void;
}

/** Telemetry event sum-type. Each mode doc enumerates which it emits. */
export type ModeTelemetryEvent =
  | { type: 'mode_started'; mode: ModeMeta['id']; t: number }
  | { type: 'mode_ended'; mode: ModeMeta['id']; t: number; won: boolean; score: number }
  | { type: 'gate_passed'; index: number; cleared: boolean; t: number }
  | { type: 'waypoint_reached'; index: number; t: number }
  | { type: 'shot_fired'; weapon: 'gun' | 'missile' | 'bomb'; t: number }
  | { type: 'hit'; target: string; weapon: 'gun' | 'missile' | 'bomb'; t: number }
  | { type: 'kill'; target: string; weapon: 'gun' | 'missile' | 'bomb'; t: number }
  | { type: 'damage_taken'; zone: 'airframe' | 'engine' | 'control'; amount: number; t: number }
  | { type: 'destroyed'; t: number }
  | { type: 'lock_acquired'; target: string; t: number }
  | { type: 'lock_lost'; target: string; t: number };
```

## Lifecycle ordering inside `main.ts`

Per frame, in order:

1. `input.update(dt, controls)`
2. `mode.update(dt, ctx)`  ← may override `controls` before physics
3. `advance(state, dt, controls, getGroundHeight)`
4. `hud.update(state)` then `hud.setMode(mode.status())`
5. `world.update(dt)` / `cameraRig.update(dt, …)` / `net.update(state, dt)`
6. `renderer.render(scene, camera)`

`mode.update` is intentionally placed **before** physics so a mode can
take over controls (AI assist, autoland, scripted intro). `mode.status()`
must be cheap — it is called after `update` every frame.

## Mode registry

`src/modes/registry.ts` (Wave B) exports a `Map<id, () => Mode>` factory
table. Default boot mode is `'free-flight'` unless `?mode=…` query string
selects another. Mode swap is done by `disposeCurrent → registry.get(id)
→ init`. There is no live mode hot-swap mid-frame.

## What is NOT on this interface (on purpose)

- No `save()` / `load()` — persistence is mode-internal (Time Trial uses
  `localStorage`; others have nothing to persist).
- No network message routing — `net` is in `ctx`; each mode subscribes
  to what it needs.
- No `pause()` / `resume()` — the harness uses dt=0 if needed.
- No nested sub-states — Strike Mission's mission/scoring state is
  internal, not part of the interface.

## Open questions

- Should `init` be allowed to be async (for assets we don't have)? Today
  every asset is procedural, so the answer is **no — keep it sync**.
- Do we need a `serializeForReplay()` hook? Time Trial's ghost is
  recorded via a separate `Replayer` helper (see time-trial.md), not via
  the Mode interface. If two modes ever need replay, revisit.
