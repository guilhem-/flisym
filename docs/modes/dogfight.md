# Mode — Dogfight

## 1. Pitch
You vs. an AI bandit (or human peer) at 2000 ft over the bay. Guns at
600 rpm, two Sidewinders, three damage zones. Get the kill before they
get the lock tone in your ears.

## 2. Win / Lose conditions
- **Win**: every enemy aircraft (AI bot OR remote human) has
  `health.airframe ≤ 0` (destroyed). For PvE default this is "the bot is
  dead"; for PvP this is "all peers in dogfight room are dead".
- **Lose**: player's `health.airframe ≤ 0` OR player's `x_W.y` clamps to
  ground while `health.airframe > 0` and `|v_W|·cos(θ_pitch) > 15 m/s`
  (uncontrolled ground impact).
- `status().score`: `(kills * 100) - (deaths * 50)`. Persists across
  rounds within a session, not across sessions.
- `status().headline`: `"DOGFIGHT — K:D N/N · GUNS XXX · MSL N/2 · HULL XXX%"`.

## 3. Spawn state
- Player: world position `x_W = (0, 600, -2000)` — 2 km north of the
  runway, 600 m AGL. Heading 180° (south, body +X = world −Z).
  Therefore `q` is the quaternion that rotates body +X onto world −Z:
  axis = +Y, angle = +π. `v_W` rotated to body frame: body
  `(70, 0, 0)` m/s (≈ 136 kt cruise). `throttle = 0.85`. `delta_f = 0`.
- Enemy (default PvE): world `x_W = (0, 700, +2000)` — 4 km south of
  player, head-on. Heading 000° (north). The two aircraft are merging
  head-on at ~140 m/s closure. Spawn `v_W` body `(70, 0, 0)`,
  `throttle = 0.85`.
- Loadout (each aircraft):
  - 2 hardpoints with Sidewinder-class IR missiles. Body-frame mount
    points: `(0, -0.3, -1.4)` (left under-wing) and `(0, -0.3, +1.4)`
    (right under-wing).
  - 2 gun barrels firing forward. Body-frame muzzle: `(2.4, -0.1, ±0.6)`.
    Combat-designer owns the exact figures.
  - 100% hull integrity in all three zones.

## 4. HUD surface
Mode-owned DOM nodes (added in `init`, removed in `dispose`):

| `data-h` id | Position | Update | Source | Description |
|---|---|---|---|---|
| `radar` | top-right, 240×240 px | 10 Hz | combat module | Top-down 20 km radar; player center, enemy as red triangle, peers as blue triangles. Range rings every 5 km. |
| `target-box` | overlay on canvas, follows projected position | every frame | combat module | Square brackets around the locked target's screen-projected position; clips to viewport edges with an arrow when off-screen. |
| `gun-pipper` | screen-center, 24 px reticle | every frame | combat module | Lead-computing pipper: world position = player position + lead vector. When inside `target-box`, pipper turns red. |
| `lock-tone-led` | inside `target-box`, top-right corner | 4 Hz blink during seeking, solid during locked | combat module | Off / amber-blinking ("seeking") / red-solid ("LOCKED"). Audio: 1-kHz sine pulse at the same cadence — combat module owns the tone. |
| `damage-panel` | bottom-right, 200×80 px | every frame | combat module | Three horizontal bars: AIRFRAME, ENGINE, CONTROL — each 0..100%. Color: green > 60, amber 30..60, red < 30. |
| `kill-feed` | top-left, max 4 rows, 5-second TTL | event-driven | combat module | `"PLAYER ⨂ BANDIT-01 [Sidewinder]"` style rows; oldest fades out. |
| `ammo-readout` | bottom-right, above damage-panel, 160×40 px | every frame | combat module | `"GUN 1480 · MSL 2/2"`. Bullet count decrements visually only every 10 rounds so it doesn't flicker. |

Cadence: `radar` and `kill-feed` updates are throttled by the mode
itself (10 Hz / event-driven), but every other element ticks at the
render frame rate.

## 5. Input bindings
v0.1 keys plus:
- `Space`: fire guns (hold to keep firing; 600 rpm = 1 bullet per 100 ms
  per barrel × 2 barrels). Combat module owns the rate limiter.
- `X`: fire/launch selected missile. Edge-triggered (one launch per
  keydown). Requires a lock; without a lock, fires "boresight" (no
  guidance) — combat-designer's call on whether to allow this.
- `T`: cycle target (next enemy in radar list).
- `R`: respawn (only legal while `lost === true`). 3-second cool-down.

These bindings are wired by the mode via `KeyboardInput` event listeners
on the existing window event surface; the `keyboard.ts` module itself
does NOT need to grow new global handlers (the mode owns them, removes
them in `dispose`).

## 6. World/scene additions
- 1 enemy Cessna mesh (PvE default) — `buildCessna()`. ~1432 tris.
- N bullets — pooled `THREE.InstancedMesh`, `pool.maxLiveBullets = 200`.
  Combat-spec budget: 256 bullets max, ~12 tris each.
- N missiles — pooled, max 4 live at any moment (2 per side).
- Muzzle-flash particle system (8 particles max, additive blending).
- Optional ground impact debris emitter (one-shot, ≤ 30 particles).
- **Total dogfight scene-add budget: ~4500 tris, ~10 meshes, ≤ 1k
  particles, ≤ 10 extra materials.** Well under the 250k/500/200/2k caps.

The gate course mesh from v0.1 is hidden (`course.mesh.visible = false`)
during this mode.

## 7. State shape
```ts
interface DogfightState {
  /** Player health (mutated by combat module on hits). */
  playerHealth: { airframe: number; engine: number; control: number };
  /** Player ammo state. */
  playerAmmo: { gunRounds: number; missiles: number };
  /** All combat aircraft on the field, player included as participants[0]. */
  participants: ReadonlyArray<{
    id: string;
    isPlayer: boolean;
    state: AircraftState;
    health: { airframe: number; engine: number; control: number };
    ammo: { gunRounds: number; missiles: number };
    mesh: THREE.Group;
  }>;
  /** Index into participants[] of the currently locked target, or -1. */
  targetIndex: number;
  /** Lock state of the currently selected target. */
  lock: { state: 'none' | 'seeking' | 'locked'; tBegan: number };
  /** Score this session. */
  kills: number;
  deaths: number;
  /** Edge-trigger for win/lose. */
  endTriggered: boolean;
}
```

## 8. Telemetry events
- `mode_started` on init.
- `shot_fired { weapon: 'gun', t }` — at most one event per 100 ms per
  barrel.
- `shot_fired { weapon: 'missile', t }` — on each missile launch.
- `hit { target, weapon, t }` — every time a projectile collides.
- `kill { target, weapon, t }` — when target's `airframe ≤ 0` crosses.
- `damage_taken { zone, amount, t }` — player took damage.
- `lock_acquired { target, t }` / `lock_lost { target, t }`.
- `destroyed { t }` — player's airframe reached 0.
- `mode_ended { won, score, t }` on `endTriggered` resolution.

## 9. AI involvement
**Default: 1 bot.** Difficulty `'Veteran'` (per `docs/ai-spec.md`).
Bot pilots one full Cessna with the same weapons loadout. AI takes over
the bot's `Controls` struct and calls into the same `advance()` physics
function the player uses — guarantees axis-correctness tests cover bots.

PvP override: if `?mp=1` is set in the URL OR `M` is pressed and the
relay reports peers in the dogfight room, the bot is despawned and peers
take its place. Maximum 4 active peers in v0.2. Bots are re-added if
peer count drops to 0.

## 10. Multiplayer involvement
PvP via the v0.1 WebSocket relay, extended by `mp-combat` (Wave C):
- Existing `peer` messages already carry `x` + `q`. Mode subscribes.
- New message types `shoot`, `hit`, `kill`, `damage` added by `mp-combat`;
  the mode subscribes and reflects state. Mode is authority only on
  outgoing events; incoming events for peers are trusted (no anti-cheat
  in v0.2).

## 11. Test hooks
- After 60 s with neutral controls and the bot disabled, `kills === 0`,
  `deaths === 0`, `playerHealth.airframe === 100`.
- After a single bullet collides with the bot (forced via unit test hook
  on the combat module), `kills` increments by 0 or 1 depending on
  whether airframe crossed 0.
- `playerAmmo.gunRounds` decrements monotonically when Space is held;
  rate-limited to 600 rpm × 2 barrels = 20 rounds / second.
- A missile with `t > 30` seconds-of-flight self-destructs (no infinite
  homing).
- Body-axis sanity: a bot spawned head-on at +X distance, with neutral
  controls, drifts in world +Z=0 plane (no lateral phantom acceleration).
- Damaged control surfaces reduce `Controls.aileronCmd` effective gain
  by a factor mode reads from `playerHealth.control`.

## 12. Open questions
- Boresight missile launches without lock — allowed? **Decision pending
  combat-designer**; default to NO.
- Friendly fire in PvP — on or off? **Decision: ON.**
- Should the bot's spawn position be randomized within a corridor each
  round? Default for v0.2: fixed head-on spawn for testability.
- Radar slant-range floor? **Decision: no, pure 3D distance.**
