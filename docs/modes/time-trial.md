# Mode — Time Trial

## 1. Pitch
Rip the v0.1 gate course as fast as possible. A translucent ghost of your
personal best flies alongside you so you can see where you're losing
tenths. Hit `G` to restart instantly.

## 2. Win / Lose conditions
- **Win**: `gateCourse.state.finished === true` AND `gateCourse.state
  .missed === 0`. (Clean run — every gate cleared.)
- **Lose**: `gateCourse.state.finished === true` AND `gateCourse.state
  .missed > 0`. (Course completed but dirty — score still posted, just
  not eligible to overwrite personal best.)
- `status().score`: seconds to finish (lower = better). `Infinity` until
  finished.
- `status().headline`: live `"Gate X/12 · Time m:ss.cc · Missed N · PB m:ss.cc"`.

## 3. Spawn state
Same as Free Flight (v0.1 baseline), with one addition:
- `x_W = (-700, groundY + 30.48, 0)`, `v_W = (50, 0, 0)` m/s body-forward.
- `throttle = 0.7`. `q = identity`. Body +X = world +X at spawn.
- Loadout: bare Cessna. No external stores.
- Course timer starts on first plane-crossing of gate 0 (per `src/
  challenge/gates.ts`), NOT on mode init.

## 4. HUD surface
Reuses v0.1 challenge panel (`<div data-h="challenge">`) for live stats.
Adds these new DOM elements (mode-owned, removed in `dispose`):
- `<div data-h="pb-panel">` (top-center, below challenge panel) — shows
  personal best as `PB m:ss.cc` or `PB —`. Source: localStorage key
  `flisym.timeTrial.pb` (number, seconds, may be `null`). Update on
  mode init and after every successful finish.
- `<div data-h="ghost-distance">` (bottom-left, optional) — shows the
  signed delta between player aircraft world-X position and ghost
  aircraft world-X position. Source: `ghost.x_W.x − state.x_W.x`,
  formatted `"GHOST +12.3 m"` (ghost ahead) or `"GHOST −4.1 m"` (player
  ahead). Update cadence: every frame.
- Reuses v0.1 finish overlay (`data-h="finish-overlay"`). On a new
  personal best, the overlay headline reads "NEW PERSONAL BEST" instead
  of "COURSE COMPLETE".

## 5. Input bindings
v0.1 keys plus:
- `G`: already fires `challenge:reset` in v0.1. In this mode `G` also
  resets the ghost playback to frame 0 and the run timer to 0.
- `H` (new): toggle ghost visibility on/off. Default: visible if a PB
  exists, hidden otherwise.

No other new keys.

## 6. World/scene additions
- The 12 gates are already in the v0.1 scene (`course.mesh`) — Time
  Trial mode does NOT add them; it just renders the existing course.
  This means in Free Flight the gates are also visible. **Decision:**
  the gate `course.mesh` parent group's `visible` flag is set to `true`
  ONLY when the active mode is Time Trial. Free Flight, Dogfight, and
  Strike Mission set it to `false` in their `init`.
- **Ghost aircraft**: one translucent `buildCessna()` group (1432 tris,
  same as the player aircraft). Material override: every `Mesh`'s
  material is set to `transparent=true, opacity=0.35, depthWrite=false`.
  Added to the scene in `init`, removed in `dispose`.
- Graphics-budget delta: +1 mesh-group (~14 child meshes inside the
  Cessna), +1432 tris, +0 draw calls if material-grouping holds.
- No new lights, no particles, no transparency-sorting layers.

## 7. State shape
```ts
interface TimeTrialState {
  /** Reference to the existing v0.1 gate course. */
  course: GateCourse;
  /** Persistent best time in seconds, or null if none. From localStorage. */
  personalBest: number | null;
  /** Recorded poses for the current run (one entry per physics tick). */
  recording: Array<{ t: number; x: [number, number, number]; q: [number, number, number, number] }>;
  /** Frozen recording from the previous-best run (the ghost). Null if no PB. */
  ghostFrames: ReadonlyArray<{ t: number; x: [number, number, number]; q: [number, number, number, number] }> | null;
  /** Ghost playback cursor in seconds since gate-0 crossing. */
  ghostT: number;
  /** Three.js group for the ghost mesh. Null if no PB. */
  ghostMesh: THREE.Group | null;
  /** Ghost visible toggle (H key). */
  ghostVisible: boolean;
  /** True after gate-0 has been crossed this run. */
  runActive: boolean;
}
```

Recording cadence: append a frame every `1/30 s` (decoupled from the
240 Hz physics step — we sample at 30 Hz to keep `localStorage` size
small; a 90-second run = 2700 frames × 32 bytes ≈ 86 KB).

Ghost playback: linear interpolate position, slerp quaternion between
the two bracketing frames at the current `ghostT`. Body axes match the
player's; body +X stays forward on the ghost.

## 8. Telemetry events
- `mode_started` on init.
- `gate_passed { index, cleared, t }` — emitted from the existing gate
  course's plane-crossing detection. Bridge: subscribe to a new
  `'challenge:gate'` `CustomEvent` that the gate course must dispatch
  (Wave B coder change — small one-line addition to gates.ts).
- `mode_ended { won, score, t }` on finish (and on `dispose` if the run
  was abandoned, with `won=false` and `score=NaN`).

No combat events. No multiplayer events.

## 9. AI involvement
None. The ghost is a deterministic replay, not an AI pilot.

## 10. Multiplayer involvement
**Solo only for v0.2.** Ghost is local-only. Future enhancement
(post-v0.2): broadcast ghost frames over WS so multiple pilots can race
the same course simultaneously — out of scope for v0.2.

## 11. Test hooks
- After `course.reset()` + 1 simulated frame, `recording.length === 0`
  and `runActive === false`.
- After the player aircraft crosses gate 0, `runActive === true` and
  the next physics tick appends to `recording`.
- After a clean finish faster than the stored PB, `personalBest` equals
  the new run's `courseTime` and `localStorage.getItem('flisym.timeTrial
  .pb')` returns the same number stringified.
- After a dirty finish (`missed > 0`), `personalBest` is unchanged.
- Loading the mode with a pre-populated `localStorage` PB constructs the
  ghost mesh and starts its playback at `ghostT = 0` on gate-0 crossing.
- With neutral controls for 60 s from spawn, the player never crosses
  gate 0, so `runActive === false` and `score === Infinity`.

## 12. Open questions
- Should we keep separate PBs per course (only one course exists today,
  but if we add more)? Producer-call: store as
  `flisym.timeTrial.<courseId>.pb` to be future-proof.
- Should we save the ghost recording itself across sessions, or just the
  time? **Decision:** save both (one full ghost) — 86 KB fits well under
  the 5 MB localStorage budget. Use a versioned key so we can invalidate
  on course changes.
- What happens on missed gates mid-run? Today the v0.1 gates code
  increments `missed` and advances `activeIndex` regardless. Time Trial
  inherits this behavior — no rewind, no time penalty other than the
  natural cost of flying off-line.
