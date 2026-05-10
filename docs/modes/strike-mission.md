# Mode — Strike Mission

## 1. Pitch
Fly the brief: 3–5 waypoints, then a target area defended by a SAM and
half a dozen tanks/hangars. Pickle four Mk-82s, run for home, hope your
hull holds up to the SAM's reply.

## 2. Win / Lose conditions
- **Win**: `destroyedTargetCount >= ceil(0.8 * totalTargetCount)` AND
  player's `health.airframe > 0` AND player crosses the **egress waypoint**
  (the last waypoint, by definition placed back over the runway).
- **Lose**: `health.airframe ≤ 0` OR all 4 bombs released AND
  `destroyedTargetCount < ceil(0.5 * totalTargetCount)` (mission failed,
  insufficient damage).
- `status().score`: `targetScore + timeBonus + survivalBonus`, where
  - `targetScore = destroyedTargetCount * 100`
  - `timeBonus = max(0, 600 - elapsedSeconds) * 1`
  - `survivalBonus = round(health.airframe)` (0..100).
- `status().headline`: `"STRIKE — WP X/N · TGT K/T · BMB R/4 · HULL XXX%"`.

## 3. Spawn state
Identical to Free Flight (over-runway, 100 ft, heading east at 50 m/s,
throttle 0.7).
- `x_W = (-700, groundY + 30.48, 0)`, `v_W` body `(50, 0, 0)`,
  `throttle = 0.7`, `q = identity`.
- Loadout:
  - 4 dumb bombs (Mk-82 class) on belly stations. Body-frame mount
    points: `(0, -0.5, -0.6)`, `(0, -0.5, -0.2)`, `(0, -0.5, +0.2)`,
    `(0, -0.5, +0.6)`. Released aft-to-fore in pairs.
  - No guns, no missiles. (Cessna isn't a strike platform; we
    deliberately keep ordnance simple to avoid scope creep with the
    Dogfight loadout.)
  - 100% hull, single-zone "airframe" health.

## 4. HUD surface
Mode-owned DOM:

| `data-h` id | Position | Update | Source | Description |
|---|---|---|---|---|
| `waypoint-strip` | top-center, 320×40 px | every frame | mission module | Horizontal strip showing 5 dots; active one amber, completed grey, future outlined. Distance to active appended as `"→ WP3 · 4.2 km"`. |
| `bomb-readout` | bottom-right, 120×30 px | every frame | mission module | `"BOMBS 3/4"`. Decrements on each pickle. |
| `target-list` | right-center, 180×140 px | 5 Hz | mission module | Compact list of target callsigns + status (LIVE / HIT / DEAD). |
| `sam-warn` | screen-center, large, blinking | event-driven | mission module | `"MISSILE LAUNCH"` red banner for 3 s when the SAM fires; RWR tone accompanies. |
| `damage-banner` | reuses dogfight `damage-panel` (airframe only) | every frame | mission module | Single bar. |
| `mission-end` | full-screen overlay (reuses `finish-overlay` slot) | once on win/lose | mission module | "TARGETS 6/8 · TIME 4:12 · HULL 87 · SCORE 1287". |

## 5. Input bindings
v0.1 keys plus:
- `Space`: drop a single bomb (one bomb per keydown — edge-triggered).
- `Z`: cycle bomb pickle quantity (1 / 2 / 4 — for ripple drops). Default
  1. Visual on `bomb-readout` as `"BMB 3/4 [1x]"`.
- No guns / missiles in this mode.

## 6. World/scene additions
- **Waypoints**: N translucent green `RingGeometry(120, 130, 24)` rings
  oriented vertically. Cleared waypoints turn grey and fade. Cost: 5 × ~96
  tris = ~480 tris, 1 material shared.
- **Ground targets**: handled by `src/world/ground-targets.ts` (Wave B,
  `world-extender`). Strike Mission instantiates:
  - **1 SAM site** — radar dish + launcher + crew tent. Visual + collider
    + AI subsystem.
  - **3–5 tanks** — boxy hull + turret + barrel. Static in v0.2.
  - **2–3 hangars** — large rectangular shed. Static, highest point value.
- **Bombs**: pooled physics bodies. `CapsuleGeometry(0.25, 1.0, 6, 12)`
  ≈ 200 tris each. Max 4 live (one per hardpoint). After release,
  integrated as ballistic rigid bodies (see §7). Trail: 20 particles
  each, fade in 1 s.
- **SAM missile**: physics body (NOT a raycast). Same mesh class as
  Dogfight missile (cigar, ~24 tris) + trail. Max 1 live per SAM.
  20 s flight time, command guidance toward player's predicted position.
- **Total strike scene-add budget**: ~5000 tris, ~30 meshes, ~150
  particles. Stays under graphics-budget caps.

The gate course mesh from v0.1 is hidden.

## 7. State shape
```ts
interface StrikeMissionState {
  mission: {
    waypoints: ReadonlyArray<{ x: number; y: number; z: number; r: number }>;
    targets: ReadonlyArray<{
      id: string;
      kind: 'sam' | 'tank' | 'hangar';
      pos: [number, number, number];
      value: number;
      health: number;
      destroyed: boolean;
    }>;
    egressIndex: number;
  };
  currentWaypoint: number;
  bombsRemaining: number;
  pickleQty: 1 | 2 | 4;
  liveOrdnance: Array<{
    id: string;
    kind: 'bomb' | 'sam-missile';
    x_W: THREE.Vector3;
    v_W: THREE.Vector3;
    age: number;
    parent: 'player' | string;
  }>;
  destroyedTargetCount: number;
  totalTargetCount: number;
  elapsedSeconds: number;
  playerHealth: { airframe: number };
  endTriggered: boolean;
}
```

**Bomb physics — physics body, not raycast.** Each bomb is integrated
with semi-implicit Euler at the same physics tick rate as the aircraft:

```
F_W = (0, -9.80665, 0) * m_bomb + drag
drag = -0.5 * rho(altitude) * |v_W| * v_W * Cd * A
v_W += F_W/m_bomb * dt
x_W += v_W * dt
```

Initial release: `bomb.x_W = aircraft.x_W + q.rotate(mount)`. Initial
velocity: `bomb.v_W = aircraft.v_W + q.rotate((0, -2, 0))` (2 m/s
straight down in body frame). Bomb inherits banking — critical for the
axis-correctness test (release while inverted should send the bomb
upward in world frame).

Hit test: per-frame AABB overlap with each ground target's collision
box. On hit: bomb destroyed, target health -= 100 (single-shot kill for
tanks; hangars need 2). SAM missile uses 5 m proximity-fuse sphere
against player AABB.

## 8. Telemetry events
- `mode_started`
- `waypoint_reached { index, t }`
- `shot_fired { weapon: 'bomb', t }` — on each release
- `hit { target: tgtId, weapon: 'bomb', t }`
- `kill { target: tgtId, weapon: 'bomb', t }` — when target.destroyed → true
- `lock_acquired { target: 'player', t }` — emitted by SAM when it
  acquires the player
- `damage_taken { zone: 'airframe', amount, t }` — from SAM hits
- `destroyed { t }` — player dead
- `mode_ended { won, score, t }`

## 9. AI involvement
- **1 SAM** active per mission. Behavior spec'd in `docs/ai-spec.md`
  (radar-lock cone, salvo rules, lead computation). The SAM is a bot
  participant from the mode's POV — same `update(dt, ctx)` shape — but
  it doesn't fly; it sits at a fixed `x_W` and emits missile physics
  bodies.
- Tanks: passive (no AI in v0.2 — they don't shoot back).
- Hangars: do nothing.

## 10. Multiplayer involvement
**Solo only for v0.2.** Co-op (multiple players sharing one mission) is
out of scope. The WebSocket relay is allowed to be connected for
presence (other players visible as Cessnas) but their bombs do not
affect your mission and vice versa.

## 11. Test hooks
- After `init`, `mission.waypoints.length` ∈ [3, 5] and
  `mission.targets.length` ∈ [5, 10].
- After 60 s with neutral controls (player flies straight east), the
  first waypoint is reached if it is placed within the player's
  trajectory; otherwise `currentWaypoint === 0`. The mission generator
  must guarantee waypoint 0 is reachable within 60 s of the spawn
  trajectory at default cruise.
- Dropping a bomb while inverted (player rolled 180°) results in the
  bomb's initial world-frame velocity having `v_W.y > 0` for at least
  one frame (axis-correctness regression test).
- A SAM missile launched with `parent='sam:01'` and integrated for 20 s
  with the player flying neutrally always either hits the player or
  self-destructs at 20 s. No infinite-flight projectiles.
- After all 4 bombs released and `destroyedTargetCount === 0`, the lose
  condition triggers exactly once.
- `liveOrdnance` is empty after `dispose()`.

## 12. Open questions
- Target placement procedural per `ctx.seed`, or fixed per "mission
  template"? **Decision (mode-designer):** procedural from seed, with
  the seed defaulting to `Date.now() & 0xFFFF`; reproducible via
  `?seed=…`.
- 4 bombs total or 2 hardpoints × 2 stations? **Decision:** 4
  single-station drops, no MERs in v0.2.
- Egress waypoint require landing, or just crossing? **For v0.2:
  crossing is sufficient.**
- SAM countermeasures (chaff): not modeled in v0.2.
