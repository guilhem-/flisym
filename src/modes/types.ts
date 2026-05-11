// Canonical Mode interface and supporting types.
//
// This file is the source of truth for the v0.2 mode contract documented in
// `docs/modes/_mode-interface.md`. Modes implement `Mode` and are registered
// in `src/modes/registry.ts`. `ModeSwitcher` (src/modes/switcher.ts) holds
// the active mode and drives its lifecycle.
//
// The interface is intentionally tiny — extensions belong inside an
// implementing class, not on this surface.

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
