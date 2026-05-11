// Shared HUD types for combat / mission / time-trial overlays.
//
// `hud-combat` Wave C agent: these are the structural types that the mode
// implementations pass to `HUD.setCombat(...)`, `HUD.setMission(...)` and
// `HUD.setTimeTrial(...)`. They intentionally mirror the relevant fields
// of `CombatSystem.snapshot()` etc. — duplicated to keep `src/hud/` from
// importing `src/combat/` (one-way dependency: combat is HUD-agnostic).

/** Per-participant HP and weapon state surfaced to the HUD. */
export interface HudParticipant {
  readonly id: string;
  readonly isAlive: boolean;
  readonly hp: {
    readonly airframe: number;
    readonly engine: number;
    readonly aileron: number;
    readonly elevator: number;
    readonly rudder: number;
  };
  readonly gunRoundsL: number;
  readonly gunRoundsR: number;
  readonly missileRailsRemaining: number;
  readonly bombsRemaining: number;
}

/** Lock state for the dogfight HUD lock-tone LED + target box. */
export type LockState = 'off' | 'seeking' | 'locked';

/** Screen-space target box (px) — mode supplies projected coordinates. */
export interface TargetBoxScreen {
  /** Center x (CSS pixels from viewport left). */
  readonly cx: number;
  /** Center y (CSS pixels from viewport top). */
  readonly cy: number;
  /** Whether the target is currently on-screen. Off-screen → arrow. */
  readonly onScreen: boolean;
  /** Square size in px. */
  readonly size: number;
}

/** Snapshot the dogfight mode passes to HUD.setCombat each frame. */
export interface CombatSnapshot {
  /** Player participant — HP, ammo, alive. */
  readonly self: HudParticipant;
  /** K/D score (mode tracks across respawns). */
  readonly score: { readonly kills: number; readonly deaths: number };
  /** Lock state for current target. */
  readonly lockState: LockState;
  /** Target-box overlay position; null when no target selected. */
  readonly targetBox: TargetBoxScreen | null;
  /**
   * Radar contacts in body-frame meters relative to player.
   * +X forward, +Z right (matches docs/physics-spec.md axes).
   * `hostile` controls colour (red vs blue triangle).
   */
  readonly radarContacts: ReadonlyArray<{
    readonly id: string;
    readonly relX: number;
    readonly relZ: number;
    readonly hostile: boolean;
  }>;
}

/** Strike-mission HUD state. */
export interface MissionHudState {
  /** Waypoint set. Active = `currentWaypoint`; earlier = completed. */
  readonly waypoints: ReadonlyArray<{
    /** Distance in km from the player to this waypoint. */
    readonly distanceKm: number;
  }>;
  /** Index into `waypoints` of the currently active one. */
  readonly currentWaypoint: number;
  /** Bombs remaining. */
  readonly bombsRemaining: number;
  /** Bombs originally loaded (for the "N/M" readout). */
  readonly bombsTotal: number;
  /** Ground-target rollup. */
  readonly targets: ReadonlyArray<{
    readonly id: string;
    readonly status: 'LIVE' | 'HIT' | 'DEAD';
  }>;
}

/** Time-trial HUD state (PB panel + ghost distance). */
export interface TimeTrialHudState {
  /** Personal best in seconds, or null if none. */
  readonly personalBest: number | null;
  /** Signed metres: ghostX − playerX. Positive ⇒ ghost ahead. */
  readonly ghostDeltaMeters: number | null;
}
