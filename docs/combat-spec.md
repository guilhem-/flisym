# FLISYM Combat Specification (v0.2)

**Audience:** Wave B `combat-coder`, Wave C `hud-combat`, `mp-combat`,
Wave D `test-combat-ai`.

**Scope:** weapons, projectile dynamics, hit detection, damage zones, missile
seeker, HUD touchpoints, multiplayer wire events, tunables, test
requirements.

**Non-scope:** AI pilot logic (see `docs/ai-spec.md`), mode lifecycle (see
`docs/modes/dogfight.md` & `strike-mission.md`), HUD layout/CSS (see
`hud-combat` brief).

**Hard reuse:** `state.x_W`, `state.v_W`, `state.q`, body axes
(+X forward, +Y up, +Z right), `world.getGroundHeight(x, z)`,
`createInitialState`, `THREE.Quaternion` body→world rotation,
`THREE.InstancedMesh`. **No new runtime deps.**

---

## 1. Weapons table

All numeric defaults frozen here; lifted verbatim into `COMBAT_TUNING` (§8).

| Weapon              | Class   | Mass (kg) | Drag Cd·A (m²) | Muzzle vel (m/s) | RoF (rpm/gun) | Mag capacity      | Hardpoints | Damage model | Lifetime (s) | Notes |
|---------------------|---------|----------:|----------------:|------------------:|---------------:|-------------------|------------|--------------|--------------|-------|
| M2 .50-cal (×2 wing)| Bullet  |     0.046 |          0.00015 |               890 |            600 | 400 rds/gun       | wing root  | scalar HP, falloff w/ range | 3.0 | tracer every 5th |
| AIM-9-class IR missile | Missile |     85.0 |            0.04  | boost +250 to 750 |             — | 2 rails (1 per wingtip) | wingtip | 1-hit-kill direct, prox falloff | motor 3.0 s + coast 27 s = 30 s total | seeker 30° half-cone, 4 km lock |
| Mk-82-class dumb bomb  | Bomb    |    227.0 |            0.05  | inherits aircraft vel | — | 4 bombs total     | belly      | radius-blast vs ground targets | 30 s fall cap or impact | Strike mode only; no air-to-air |
| SAM (ground→air) (NPC) | Missile |    150.0 |            0.05  | boost +400 to 900 |             — | per-site 4 reloads | SAM site   | 1-hit-kill direct, prox falloff | motor 6.0 s + coast 24 s | radar-guided (not IR); fires only after radar-lock dwell |

**Pool sizes (hard caps):**

- `BULLET_POOL = 256` — one `THREE.InstancedMesh` of 256 instances;
  non-active instances scaled to 0 each frame.
- `MISSILE_POOL = 8` — one `THREE.InstancedMesh` of 8 (bodies) +
  one `InstancedMesh` of 8 (plumes, additive, depthWrite=false).
- `BOMB_POOL = 8`, `EXPLOSION_POOL = 16`.

---

## 2. Projectile lifecycle

All projectiles are pure data records in TypedArrays (SoA). Visual instance
slot is `index` ∈ [0, poolSize). No per-projectile JS object allocations
per frame.

### 2.1 Bullet (M2)

**Spawn pose (body frame):** muzzle at `r_B_muzzle_L = (1.40, 1.05, -2.10)` m
and `r_B_muzzle_R = (1.40, 1.05, +2.10)` m.

**Spawn velocity (world frame):**
```
v_B_muzzle = (V_muzzle, 0, 0)
v_W_bullet = v_W_shooter + q · v_B_muzzle
x_W_bullet = x_W_shooter + q · r_B_muzzle
```

**Integrator:** semi-implicit Euler at render rate. Drag and gravity only:

```
F_drag = -0.5 · ρ(y) · (Cd·A) · |v| · v
a = (F_drag / m_b) + g_W
v_W += a · dt
x_W += v_W · dt
```

`ρ(y)` reuses `physics/atmosphere.ts::density()`.

**Lifetime cap:** `BULLET_LIFETIME = 3.0 s`.

**Despawn conditions** (logical OR):
1. `t_alive >= BULLET_LIFETIME`.
2. `x_W.y <= world.getGroundHeight(x_W.x, x_W.z) + 0.1`.
3. Bullet AABB-sweep hits any aircraft (see §3.1).
4. Bullet hits a ground target's bounding sphere (Strike mode).
5. `|x_W - playerPos|` exceeds `CULL_RADIUS = 4000 m`.

### 2.2 Missile (AIM-9 / SAM)

**Spawn pose (body frame):** wingtip rails
`r_B_rail_L = (0.20, 1.05, -wingHalfSpan)` and
`r_B_rail_R = (0.20, 1.05, +wingHalfSpan)`.

**Spawn velocity:**
```
v_W_missile = v_W_shooter + q · (V_launch, 0, 0)   // V_launch = 50 m/s drop+ignite
```

**Integrator:** semi-implicit Euler at render rate.

```
T_motor = (t_alive < MOTOR_BURN_TIME) ? MISSILE_THRUST : 0          // along missile +X_B
F_drag  = -0.5 · ρ · (Cd·A) · |v_rel| · v_rel
F_grav  = m · g_W
F_total = q_missile · (T_motor, 0, 0) + F_drag + F_grav + F_steer    // §5
a = F_total / m
v_W += a · dt
x_W += v_W · dt
q_missile = look_along(v_W)
```

`q_missile` is recomputed each frame from velocity (`Quaternion.setFromUnitVectors`).

**Lifetime cap:** `MISSILE_LIFETIME = 30.0 s`.

**Despawn conditions:**
1. `t_alive >= MISSILE_LIFETIME`.
2. Ground impact.
3. Proximity-fuse trigger (§3.2).
4. Direct hit on target's AABB.
5. Lock lost for > 1.0 s AND `t_alive > 2.0 s` (early ditch).

### 2.3 Bomb (Mk-82)

Same integrator as bullet but `Cd·A = 0.05`, `m = 227 kg`, no thrust.
Inherits aircraft velocity. Spawned from body `r_B_bomb = (0.0, -0.7, 0)`.
Lifetime 30 s. Despawn on ground impact (triggers radius-blast damage
within `BOMB_BLAST_RADIUS`).

---

## 3. Hit detection

All hit checks run in **world frame**, once per render frame.

### 3.1 Bullet hits

**Aircraft hull AABB (body frame):**

```
HULL_HALF_EXTENTS_B = { x: 4.5, y: 1.6, z: 5.6 } m
```

Constant exposed in `combat/aabb.ts::HULL_HALF_EXTENTS_B`.

**Test:** swept ray from `x_prev` to `x_now` against the OBB defined by
`(targetPos, targetQuat, HULL_HALF_EXTENTS_B)`. Transform segment
endpoints into target's body frame via `q.invert().applyToVector3()`,
then AABB-segment intersection in body frame (slab method).

**Body-zone resolution** when hit point `p_B` is known:

| Zone           | Region (body frame) |
|----------------|--------------------|
| Engine         | `p_B.x > 2.5` (forward of firewall) |
| Control surface (rudder) | `p_B.x < -2.5 AND p_B.y > 1.0` |
| Control surface (elevator) | `p_B.x < -2.5 AND |p_B.z| > 1.0 AND p_B.y < 1.0` |
| Control surface (aileron)  | `|p_B.z| > 3.0` (wingtip half) |
| Airframe (everything else) | default |

First match wins (engine > rudder > elevator > aileron > airframe).

**Damage per bullet:** range falloff applied:
```
range = ||p_hit - origin||
damage = BULLET_DAMAGE_AT_MUZZLE · clamp(1 - range / BULLET_FALLOFF_RANGE, 0.3, 1.0)
```

`BULLET_DAMAGE_AT_MUZZLE = 6 HP`, `BULLET_FALLOFF_RANGE = 800 m`.

### 3.2 Missile hits

Each missile keeps `lockedTargetId | null`. Per frame:

1. **Direct hit:** AABB-segment test. → `MISSILE_DIRECT_HP_LOSS = 200 HP`.
2. **Proximity fuse:** sphere test, radius `MISSILE_PROX_RADIUS = 12 m`.
   Fuse arms after `MISSILE_FUSE_ARM_TIME = 0.4 s`. Trigger requires:
   - `distance < MISSILE_PROX_RADIUS`, AND
   - missile is closing (`dot(v_missile - v_target, target_pos - missile_pos) < 0`).
   On trigger:
   ```
   prox_dmg = MISSILE_DIRECT_HP_LOSS ·
              clamp(1 - dist / MISSILE_PROX_RADIUS, 0, 1)^2
   ```
   Distributed `0.7→airframe`, `0.2→engine`, `0.1→control` chosen
   deterministically from `floor(missile.tSpawn * 1000) mod 3`.
3. **Friendly-fire:** same-team missiles ignore.

### 3.3 Bomb hits (ground)

On ground impact enumerate ground targets within `BOMB_BLAST_RADIUS = 25 m`:
```
falloff = clamp(1 - dist / BOMB_BLAST_RADIUS, 0, 1)
dmg = BOMB_DAMAGE_CENTER · falloff^2
target.hp -= dmg
```
`BOMB_DAMAGE_CENTER = 800 HP`. Tanks 200 HP, SAMs 300 HP, hangars 1200 HP.
Direct-center bomb one-shots tanks/SAMs; hangars need 2.

### 3.4 Bullets vs ground / bombs vs ground

Both reuse `world.getGroundHeight`. No terrain destruction in v0.2.

---

## 4. Damage model

Three zones per aircraft. Stored in `state` as new fields (defaults
preserve v0.1 behavior):

```ts
// added to AircraftState
hp: {
  airframe: number,        // default 100
  engine: number,          // default 100
  controls: {
    aileron: number,       // default 100 each
    elevator: number,
    rudder: number,
  },
};
isAlive: boolean;          // default true
respawnAt: number | null;  // null if alive
```

### 4.1 Per-weapon damage map

| Weapon         | Airframe Δ | Engine Δ | Control Δ | Notes |
|----------------|-----------:|---------:|----------:|-------|
| Bullet (engine zone)         | 0  | 8 |  0 | range-scaled |
| Bullet (control-surface zone)| 2  | 0 |  8 | range-scaled, applied to the specific axis hit |
| Bullet (airframe zone)       | 6  | 0 |  0 | range-scaled |
| Missile direct               | 200| 60| 30 (all axes) | one-shot |
| Missile prox                 | 0.7·X | 0.2·X | 0.1·X | X = prox falloff |
| SAM direct                   | 200| 60| 30 (all axes) | |

### 4.2 Failure consequences

When `hp.airframe <= 0`:
- Set `isAlive = false`, `respawnAt = state.time + RESPAWN_DELAY`.
- Aircraft inert: physicsStep clamps throttle to 0.
- Spawn explosion event.
- On `state.time >= respawnAt`: `respawn(state, x_W, q)` resets to defaults.

When `hp.engine <= 0`:
- `controls.ts::updateControlSurfaces` clamps `state.throttle` and
  `controlsCmd.throttleCmd` to 0 before lag step. Aircraft glides.
- Propeller RPM also clamps to 0.

When `hp.controls.aileron <= 0` (analogous for elevator/rudder):
- Multiply `Cl_δa` / `Cm_δe` / `Cn_δr` term by **0.4** in `aero.ts` only
  when `state.hp` exists and the value is ≤ 0. (Spec says "reduce by
  60 %" so surviving authority is 40 %.) Gated by `state.hp` defined-check
  to keep v0.1 tests untouched.

### 4.3 Determinism

No `Math.random()` in damage application. Prox-fuse zone distribution
uses `floor(missile.tSpawn * 1000) mod 3`. Replay from `(state0,
controlLog, combatLog)` is bit-identical.

### 4.4 Serialisation

`hp` and `isAlive` are plain numbers/booleans → JSON-safe. Add to the WS
`peer-full` payload (§7).

---

## 5. Missile seeker logic

```
seekerStep(missile, world, dt):
  if missile.lockedTargetId is null:
    return                              # dumb (no-lock launch)

  target = world.targets[missile.lockedTargetId]
  if target is null or target.isAlive is false:
    missile.lockedTargetId = null
    return

  los = target.x_W - missile.x_W
  range = ||los||
  losDir = los / range
  fwd = q_missile · (1,0,0)
  cosAng = fwd · losDir
  ang = acos(clamp(cosAng, -1, 1))

  # FoV check
  if ang > SEEKER_HALF_FOV:                    # 0.524 rad (30°)
    missile.lostLockSince += dt
    if missile.lostLockSince > LOCK_DROP_TIME: # 1.0 s
      missile.lockedTargetId = null
    return
  missile.lostLockSince = 0

  # IR ECM check
  if missile.kind == 'ir' and target.throttle < SEEKER_HOT_THROTTLE:  # 0.2
    missile.lostLockSince += dt
    if missile.lostLockSince > LOCK_DROP_TIME:
      missile.lockedTargetId = null
    return

  # Steering: rotate velocity vector toward LoS, capped at MAX_TURN_RATE
  cross = fwd × losDir
  axisLen = ||cross||
  if axisLen < 1e-4:
    return
  axis = cross / axisLen
  turnRate = min(ang / dt, MAX_TURN_RATE)
  rotateInPlace(missile.v_W, axis, turnRate * dt)
```

**Constants** (also in `COMBAT_TUNING`):

| Constant            | Value | Units | Rationale |
|---------------------|------:|-------|-----------|
| `SEEKER_HALF_FOV`   | 0.524 | rad (30°) | Sidewinder-class wide cone |
| `SEEKER_LOCK_RANGE` |  4000 | m     | acquire range |
| `MISSILE_MAX_TURN_RATE` | 1.40 | rad/s (~80°/s) | AIM-9 ballpark |
| `LOCK_DROP_TIME`    |   1.0 | s     |   |
| `SEEKER_HOT_THROTTLE` | 0.2 | —     | IR seeker minimum target emission |
| `MISSILE_THRUST`    | 17000 | N     | Δv ~600 m/s over 3 s motor at 85 kg |
| `MOTOR_BURN_TIME`   |   3.0 | s     |   |
| `MISSILE_FUSE_ARM_TIME` | 0.4 | s   | prevents own-aircraft fragging |
| `MISSILE_PROX_RADIUS`   | 12 | m     |   |

**Lock acquisition (player UX):**

- Press `L` (or hold trigger): scan aircraft within `SEEKER_LOCK_RANGE`
  AND within `SEEKER_HALF_FOV` of body +X; pick closest. Latch
  `lockedTargetId`. HUD displays caret + lock tone.
- Locks persist across frames as long as geometric/throttle condition
  holds.
- `M` fires next available rail. No-lock fires unlocked (no-guidance).

---

## 6. HUD touchpoints (delegated to `hud-combat`)

| Combat state                | HUD element                          | Update trigger |
|-----------------------------|--------------------------------------|----------------|
| Bullet count remaining      | `[data-h="gun-rounds"]`              | every shot |
| Gun pipper position         | `[data-h="gun-pipper"]`              | per frame, when target locked |
| Missile rail status         | `[data-h="missile-rails"]`           | on launch |
| Lock state                  | `[data-h="lock-caret"]`              | per frame when locked |
| Lock tone                   | audio cue (delegated to `audio/`)    | on state change |
| Damage panel — airframe HP  | `[data-h="dmg-airframe"]` bar        | on hp change |
| Damage panel — engine HP    | `[data-h="dmg-engine"]` bar          | on hp change |
| Damage panel — aileron HP   | `[data-h="dmg-aileron"]` bar         | on hp change |
| Damage panel — elevator HP  | `[data-h="dmg-elevator"]` bar        | on hp change |
| Damage panel — rudder HP    | `[data-h="dmg-rudder"]` bar          | on hp change |
| Kill feed line              | `[data-h="kill-feed"]` (appendChild) | on `kill` event |
| Radar contacts              | `[data-h="radar"]` SVG               | per frame |
| Target box                  | `[data-h="target-box"]`              | per frame |
| Score K/D                   | `[data-h="score"]`                   | on kill/death |
| Death overlay               | `[data-h="death-overlay"]`           | on state change |

`HUD.update(state)` becomes `(state, combatState)` where `combatState`
is an opaque snapshot from `combat/index.ts::snapshot()`.

---

## 7. Multiplayer wire events

### 7.1 Authority model

**Client-side hit detection, server-relayed events. No anti-cheat.**

Each client computes its own bullet/missile flight and hit checks
against peers it sees. Shooter emits `hit`; server (today only relays)
re-broadcasts; receiving client applies HP loss locally.

**Rationale:**
1. Pool sizes (256 bullets × 4 players ≈ 1k updates/frame) make
   server-authoritative simulation unaffordable within 8h.
2. Latency: client-side detection gives near-zero perceived hit latency
   for shooter. Victims may see delayed HP drop (~RTT).
3. v0.2 explicitly ships without anti-cheat.

**Where anti-cheat would slot in (v0.3+):** move bullet/missile state to
server, run §2 integrator there at 30 Hz, do hit detection server-side
with lag-compensation rewind. Wire schemas designed forward-compatible.

### 7.2 New wire message schemas

```ts
// Client → Server
interface ShootMsg {
  type: 'shoot';
  weapon: 'gun' | 'missile' | 'bomb';
  originPos: [number, number, number];
  originVel: [number, number, number];
  originQ:   [number, number, number, number];
  t: number;
  targetId?: string;
}

// Server re-broadcasts as 'peer-shoot' with shooterId attached.

// Client → Server when shooter detects a hit
interface HitMsg {
  type: 'hit';
  shooterId: string;
  targetId: string;
  weapon: 'gun' | 'missile' | 'bomb' | 'sam';
  zone: 'airframe' | 'engine' | 'aileron' | 'elevator' | 'rudder';
  hpLoss: number;
  t: number;
}

// Server re-broadcasts as 'peer-hit' to all peers except shooter.

// Client → Server when own airframe HP reaches 0
interface KillMsg {
  type: 'kill';
  shooterId: string;       // last attacker
  victimId: string;
  weapon: 'gun' | 'missile' | 'bomb' | 'sam';
  t: number;
}

// Client → Server when respawning
interface RespawnMsg {
  type: 'respawn';
  x: [number, number, number];
  q: [number, number, number, number];
  t: number;
}

// EXTENDED PRESENCE PAYLOAD (v0.1 state msg + OPTIONAL fields)
interface StateMsg {
  type: 'state';
  x: [number, number, number];
  q: [number, number, number, number];
  // NEW optional v0.2 fields:
  hp?: { airframe: number; engine: number; a: number; e: number; r: number };
  thr?: number;
  alive?: boolean;
}
```

**Backward-compat:** v0.1 `state` schema preserved byte-for-byte; v0.2
adds only optional fields. v0.1 client connecting to v0.2 server still
works.

### 7.3 Server changes (`server/index.ts`)

Add to relay whitelist: `'state' | 'shoot' | 'hit' | 'kill' | 'respawn'`.
For each non-state type, re-broadcast as `peer-<type>` with sender's id
attached. ~30 LoC delta.

### 7.4 Client changes (`src/net/client.ts`)

Add a typed mini-emitter (20 LoC, no deps) so `combat/index.ts` can
subscribe to `peer-shoot`, `peer-hit`, `peer-kill`, `peer-respawn`.

---

## 8. `COMBAT_TUNING` table (all numeric defaults)

```ts
export const COMBAT_TUNING = {
  // pools (graphics-budget-load-bearing)
  bulletPool: 256,
  missilePool: 8,
  bombPool: 8,
  explosionPool: 16,

  // M2 .50-cal bullet
  bulletMass: 0.046,
  bulletCdA: 0.00015,
  bulletMuzzleVel: 890,
  bulletRoFPerGun: 600,
  bulletMagPerGun: 400,
  bulletLifetime: 3.0,
  bulletDamageAtMuzzle: 6,
  bulletDamageEngine: 8,
  bulletDamageControl: 8,
  bulletFalloffRange: 800,
  bulletFalloffFloor: 0.3,
  bulletTracerStride: 5,
  bulletCullRadius: 4000,

  // AIM-9-class missile
  missileMass: 85.0,
  missileCdA: 0.04,
  missileLaunchVel: 50,
  missileThrust: 17000,
  missileMotorBurnTime: 3.0,
  missileLifetime: 30.0,
  missileMaxTurnRate: 1.40,
  missileFuseArmTime: 0.4,
  missileProxRadius: 12,
  missileDirectHpLoss: 200,
  missileSeekerHalfFov: 0.524,
  missileLockRange: 4000,
  missileLockDropTime: 1.0,
  missileSeekerHotThrottle: 0.2,
  missileRailsPerAircraft: 2,

  // Mk-82 bomb
  bombMass: 227.0,
  bombCdA: 0.05,
  bombLifetime: 30.0,
  bombBlastRadius: 25,
  bombDamageCenter: 800,
  bombPerAircraft: 4,

  // damage
  airframeHpMax: 100,
  engineHpMax: 100,
  controlHpMax: 100,
  damagedAuthorityScale: 0.4,
  respawnDelay: 5.0,

  // hull AABB (body frame)
  hullHalfExtents: { x: 4.5, y: 1.6, z: 5.6 } as const,

  // HUD / scoring
  killFeedMaxLines: 6,
  killFeedLineLifetime: 6.0,
  radarRangeM: 20000,
  radarTickHz: 10,
} as const;

export type CombatTuning = typeof COMBAT_TUNING;
```

---

## 9. Tests this design enables

### 9.1 Axis-correctness suite additions (`tests/physics-axis-correctness.test.ts`)

1. **`bullet_inheritance_test`**: aircraft at (0,500,0), v_W=(50,0,0),
   q=identity. Fire gun once. Assert bullet `v_W.x ≈ 50 + 890`, `v_W.y,
   v_W.z ≈ 0`.
2. **`bullet_drop_sign_test`**: bullet at (0,1000,0), v_W=(890,0,0),
   integrate 1 s. Assert `v_W.y < 0` and `x_W.y < 1000`.
3. **`missile_thrust_axis_test`**: missile at rest, q=identity, 0.5 s.
   Assert `v_W.x > 0`, `v_W.y, v_W.z` small.
4. **`missile_seeker_sign_test`**: missile at (0,500,0) facing +X with
   v=(100,0,0), target at (1000,500,200). Step seeker 0.1 s. Assert
   `v_W.z > 0` (steering toward +Z target).
5. **`damaged_aileron_authority_test`**: integrate full-right-aileron at
   V=50 for 1 s with `hp.controls.aileron = 0`. Assert roll rate ≤ 40 %
   of undamaged.

### 9.2 Combat-AI suite (`tests/combat-ai.test.ts`)

1. `bullet_pool_no_alloc` — 1000 rounds across 600 frames; active ≤ 256;
   no steady-state allocations.
2. `missile_pool_cap` — 20 missiles back-to-back; only 8 active.
3. `bullet_aabb_hit_engine_zone` — target at origin, bullet at (10,1,0)
   heading (-1,0,0). Assert `zone == 'engine'`.
4. `bullet_aabb_hit_aileron_zone` — bullet at (0,1,+4) toward origin.
   Assert `zone == 'aileron'`.
5. `bullet_aabb_hit_rudder_zone` — bullet at (-4,2,0) heading (+1,0,0).
   Assert `zone == 'rudder'`.
6. `damage_engine_clamps_throttle` — set `hp.engine = 0`, call
   `updateControlSurfaces` with `throttleCmd=1`. Assert `state.throttle
   == 0`.
7. `proximity_fuse_closure_gate` — passing at 8 m closing → trigger;
   8 m separating → no trigger.
8. `seeker_lock_drop_on_fov_exit` — outside FoV > LOCK_DROP_TIME. Assert
   `lockedTargetId == null`.
9. `seeker_cold_target_ignored` — inside FoV, throttle=0.1. Assert no
   lock; existing lock drops after LOCK_DROP_TIME.
10. `damage_deterministic` — replay identical shot twice. Assert `hp`
    bit-equal.
11. `respawn_resets_hp` — kill, advance past respawnDelay. Assert
    `hp.airframe == 100`, `isAlive == true`.
12. `ws_payload_roundtrip` — serialize ShootMsg/HitMsg/KillMsg/RespawnMsg
    via JSON. Assert structural equality.
13. `bullet_falloff_floor` — shoot from 5 km. Assert damage equals
    `bulletDamageAtMuzzle * bulletFalloffFloor`.

### 9.3 Graphics-budget suite (`tests/graphics-budget.test.ts`)

Worst-case combat frame: World + Player + 3 AI aircraft + 8 ground
targets + 256 bullets + 8 missiles + 16 explosions.

Assert:
- Triangle count ≤ 250k.
- Mesh count ≤ 500. (Bullet pool = 1 InstancedMesh, missile pool = 2.)
- Estimated draw calls ≤ 200.
- Particles ≤ 2k.

Test `combat_pools_are_instanced` walks `combat.getRoot()` and asserts ≤ 4
`THREE.InstancedMesh` and 0 per-projectile `THREE.Mesh`.

### 9.4 E2E suite (`tests/e2e/dogfight.spec.ts`)

- Boot dogfight, press M, wait 500 ms, assert `[data-h="missile-rails"]`
  shows "×1".
- Boot dogfight vs stationary AI, wait for kill, assert kill feed has
  1 entry.

---

## 10. File layout (Wave B reference)

```
src/combat/
  index.ts        (~30 LoC)  — public API: CombatSystem class, snapshot()
  tuning.ts       (~50 LoC)  — COMBAT_TUNING (§8 verbatim)
  weapons.ts      (~150 LoC) — fire(), RoF gate
  projectiles.ts  (~200 LoC) — bullet+missile+bomb SoA pools, integrators
  damage.ts       (~120 LoC) — zone resolution, hp mutators, respawn
  seeker.ts       (~80 LoC)  — §5 missile seeker
  aabb.ts         (~60 LoC)  — swept-segment vs body-OBB
  explosion.ts    (~60 LoC)  — visual-only InstancedMesh pool

server/index.ts            — extended (§7.3)
src/net/client.ts          — extended (§7.4)
src/physics/state.ts       — add `hp`, `isAlive`, `respawnAt`
src/physics/controls.ts    — clamp throttle when hp.engine ≤ 0
src/physics/aero.ts        — scale Cl_δa/Cm_δe/Cn_δr when hp.controls.* ≤ 0
```

Estimated total combat LoC: ~750.
