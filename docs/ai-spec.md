# FLISYM v0.2 — AI Pilot Specification

**Audience**: `ai-coder` (Wave B) and `test-combat-ai` (Wave D).
**Scope**: classical-control AI bot pilot for Dogfight (default opponent
when no human peer connects) and Strike Mission ambient opposition.
**Hard contract**: the AI emits the exact same `Controls` struct
(`src/physics/state.ts`) the keyboard pilot emits. Physics is shared.
No back-door dynamics.

---

## 1. Architecture overview

### 1.1 Decision: **Finite State Machine (FSM)**, not Behaviour Tree.

Rationale:
- Pilot decisions are mode-dominant ("I'm engaging" vs "I'm bugging
  out"), not deeply nested goal trees. Five states cover 95% of fighter-
  AI literature (`Patrol`, `Engage`, `Evade`, `RTB`, `Crashed`).
- FSMs are trivially deterministic to dump as a state-id integer per
  tick — crucial for combat-ai tests that need to snapshot/replay.
- BTs require a tick traversal cost we don't want to spend on N=8 bots
  @ 30 Hz. FSM tick = O(1) guard checks.
- A future Strike-Mission defender (SAM/AAA) reuses the same FSM
  scaffold with a different state alphabet (§5.2).

### 1.2 States and primary transitions

| State | Purpose | Entry | Primary exit |
|---|---|---|---|
| `Patrol` | wander a region, fuel-efficient cruise | spawn or no target | enemy enters `detectRange` → `Engage` |
| `Engage` | pursue target, gun or missile range | target acquired, hp ≥ engageHpFloor | target lost > `loseTargetT` → `Patrol`; hp < disengageHp → `RTB`; incoming missile → `Evade` |
| `Evade` | break-turn, optional chaff/flare (post-v0.2) | missile-warning OR taking gun hits | threat cleared > `evadeClearT` → previous state |
| `RTB` | low HP, fly toward friendly spawn at high throttle, low altitude | hp < disengageHp | despawn timer hits |
| `Crashed` | aircraft destroyed; freeze controls, schedule respawn | hp ≤ 0 OR ground impact | respawn timer expires (15 s) → `Patrol` at spawn |

### 1.3 State stack for `Evade`

`Evade` pushes the prior state onto a 1-deep stack so a Veteran returns
to `Engage` after a successful break-turn rather than dropping all the
way to `Patrol`. Depth stays at 1.

### 1.4 Module shape (Wave B implements)

```
src/ai/
  pilot.ts        — createAIPilot(seed, tuning) → { tick(percepts) → Controls }
  tuning.ts       — AI_TUNING constants + presets
  prng.ts         — mulberry32(seed) (≤20 LoC)
  fsm.ts          — pure FSM transition table
  controllers.ts  — PID + banked-turn primitives
  percepts.ts     — observe(world, self, enemies, projectiles) → Percepts
  targeting.ts    — threat ranking + lead-pursuit solver
```

---

## 2. Pilot AI loop

```
each AI-tick (Δt_ai = 1/30 s):
  1. observe → Percepts
  2. decide  → Goal (FSM transitions, state-specific intent)
  3. plan    → DesiredPose { hdgCmd, altCmd, vCmd, bankCapDeg }
  4. control → ControlsRaw (PID outputs, unclamped)
  5. clamp+slew → Controls
  6. emit    → store last Controls; physics consumes it at 240 Hz
```

### 2.1 `observe` → `Percepts`

```
Percepts = {
  selfHdgRad, selfPitchRad, selfRollRad,
  selfAlt, selfV, selfAlpha, selfBeta, selfHp,
  selfOnGround, selfStall,
  primaryTargetId | null,
  targetRangeM, targetBearingRad, targetElevRad,
  targetClosingMs,
  targetAspectRad,
  incomingMissile: { range, ttiSec } | null,
  inFrontQuadrant: boolean,
  inGunCone: boolean,
  hasMissileLock: boolean,
  threatLevel: 0..1,
  tickIndex: integer,
}
```

Cost ≤ 0.03 ms per call; pure function; no allocations after warm-up.

### 2.2 `decide` → `Goal`

Pure FSM transition.

```
Goal = {
  state: 'Patrol'|'Engage'|'Evade'|'RTB'|'Crashed',
  intent: 'cruise'|'pursue'|'gun-attack'|'missile-attack'|'break-left'|'break-right'|'rtb-cruise'|'idle',
  targetId: string | null,
}
```

Reaction lag: a Veteran reads `Percepts` from `tickIndex - reactionDelayTicks`.
4-element ring buffer covers Rookie's 0.13 s lag at 30 Hz.

### 2.3 `plan` → `DesiredPose`

| State / intent | hdgCmd | altCmd | vCmd | bankCapDeg |
|---|---|---|---|---|
| Patrol/cruise | wander seed: hdg += `wanderAmp * mulberry32()` every `wanderPeriodS` | `patrolAltM` (500) | `cruiseV` (42) | 30 |
| Engage/pursue | lead-pursuit (`targeting.leadSolve`) | `clamp(targetAlt + altOffset, altMin, altMax)` | `combatV` (55) | 60 |
| Engage/gun-attack | lead-pursuit + bias toward `inGunCone` | `targetAlt` | `combatV` | 70 |
| Engage/missile-attack | turn-to-target until `hasMissileLock`, launch & hold | `targetAlt` | `combatV` | 50 |
| Evade/break-left | self-hdg + sign(missileBearing<0?+90°:-90°) | `selfAlt - 50` | full throttle V≈70 | 80 |
| Evade/break-right | mirror | — | — | 80 |
| RTB/rtb-cruise | bearing toward `spawnPos` | 200 m | `cruiseV` | 25 |
| Crashed/idle | NaN-safe pass-through (all controls 0) | — | — | 0 |

### 2.4 `control` → `ControlsRaw`

See §3. Roll uses banked-turn cascade. Pitch uses altitude→pitch→elevator
cascade. Yaw uses turn coordinator. Throttle uses speed PI.

### 2.5 `clamp + slew`

- Hard clamp `[-1,1]` for control surfaces, `[0,1]` for throttle/flaps.
- AI command slew at `aiCommandSlewPerS` (4.0/s default).
- Quantize to `aiCmdQuantum` (0.05) for cross-host reproducibility.

### 2.6 Tick rate vs physics rate

- AI tick: 30 Hz (every 8 physics steps at 240 Hz).
- Between AI ticks the same `Controls` held — physics' 4.0/s surface
  slew filters out staleness.
- AI ticks scheduled by simulated `state.time`, not wall clock →
  deterministic.

---

## 3. PID / proportional controllers

### 3.1 Pitch-to-altitude (cascade)

Outer: altitude error → pitch command.
```
altErr = altCmd - selfAlt
pitchCmdRad = clamp(Kp_alt * altErr + Ki_alt * altInteg - Kd_alt * vVertical,
                    -pitchMaxRad, +pitchMaxRad)
altInteg += altErr * dt_ai          # anti-windup §3.5
```

Inner: pitch error → elevator command.
```
pitchErr = pitchCmdRad - selfPitchRad
elevatorCmd = clamp(Kp_pitch * pitchErr + Kd_pitch * (-selfQ),
                    -1, +1)
```

`selfQ = state.omega_B.z` (pitch rate per physics-spec packing).
`+pitchCmd ⇒ +elevatorCmd ⇒ pitch up`.

### 3.2 Roll-to-heading via banked turn

Outer: heading error → bank-angle command.
```
hdgErr = wrapPi(hdgCmd - selfHdg)
bankCmdRad = clamp(Kp_hdg * hdgErr,
                   -deg2rad(bankCapDeg), +deg2rad(bankCapDeg))
```

Middle: bank error → roll-rate command.
```
rollErr = bankCmdRad - selfRollRad
rollRateCmd = clamp(Kp_bank * rollErr, -rollRateMax, +rollRateMax)
```

Inner: roll-rate error → aileron.
```
aileronCmd = clamp(Kp_p * (rollRateCmd - selfP), -1, +1)
```

`selfP = state.omega_B.x` (roll rate).

### 3.3 Yaw coordination (turn coordinator)

Proportional rudder + feedforward yaw-into-turn:
```
rudderCmd = clamp(Kp_beta * (0 - selfBeta) + Kff_yawCoord * selfP, -1, +1)
```

### 3.4 Throttle to airspeed

Cruise:
```
vErr = vCmd - selfV
throttleInteg += vErr * dt_ai
throttleCmd = clamp(throttleBase + Kp_v * vErr + Ki_v * throttleInteg,
                    throttleMin, 1.0)
```

Decoupling: when `|pitchCmdRad| > pitchClimbThresh` add `+0.15`
throttle feedforward.

Combat (`state==Engage`): `throttleBase = 1.0` (PI only attenuates if
`selfV > combatVMax`).

### 3.5 Anti-windup

Back-calculation when output saturates + hard integrator clamps
(`|integ| ≤ integMax`).

### 3.6 AI_TUNING (Veteran preset is canonical default)

```ts
export const AI_TUNING_VETERAN = {
  // tick & timing
  tickHz: 30,
  reactionDelayTicks: 2,            // 0.067 s
  aiCommandSlewPerS: 4.0,
  aiCmdQuantum: 0.05,

  // altitude / pitch cascade
  Kp_alt: 0.015,
  Ki_alt: 0.001,
  Kd_alt: 0.05,
  pitchMaxRad: 0.349,               // 20°
  altIntegMax: 200,

  Kp_pitch: 2.5,
  Kd_pitch: 0.6,

  // heading / bank cascade
  Kp_hdg: 1.2,
  Kp_bank: 2.5,
  rollRateMax: 1.75,                // rad/s (~100°/s)
  Kp_p: 0.45,

  // yaw coordinator
  Kp_beta: 1.8,
  Kff_yawCoord: 0.20,

  // throttle / airspeed
  Kp_v: 0.04,
  Ki_v: 0.005,
  throttleBase: 0.65,
  throttleMin: 0.15,
  throttleIntegMax: 40,
  pitchClimbThresh: 0.087,          // 5°
  combatVMax: 70,

  // envelope clamps
  altMin: 80,
  altMax: 3500,
  patrolAltM: 500,
  cruiseV: 42,
  combatV: 55,
  evadeV: 70,

  // targeting / engagement
  detectRangeM: 3500,
  loseTargetT: 6.0,
  engageHpFloor: 0.20,
  disengageHp: 0.25,
  gunRangeM: 350,
  gunConeRad: 0.087,                // ±5°
  missileRangeMaxM: 4000,
  missileRangeMinM: 400,
  lockConeRad: 0.349,               // ±20°
  lockHoldT: 1.5,
  fireRateMinIntervalS: 0.10,
  missileCooldownS: 6.0,

  // gunnery dispersion (deterministic per seed)
  gunnerySigmaRad: 0.005,           // 0.29° — Veteran tight
  gunneryBiasRad: 0.0,

  // evade
  evadeClearT: 3.0,
  evadeBankDeg: 75,
  evadeAltDropM: 50,

  // patrol wander
  wanderAmpRad: 0.524,              // ±30°
  wanderPeriodS: 12.0,

  // crash / RTB
  respawnDelayS: 15.0,
  rtbAltM: 200,
  rtbV: 50,
} as const;

export type AI_TUNING = typeof AI_TUNING_VETERAN;
```

**Gain derivation:**
- `Kp_alt = 0.015`: 100 m altitude error → 1.5 rad pitch, clipped at 20°.
- `Kp_bank = 2.5`: 45°-bank rise time ≈ 0.4 s with `Cl_δa = 0.04`.
- `Kp_p = 0.45`: stable inner loop given 4.0/s physics surface slew.
- `Kp_v = 0.04`: 10 m/s error → ~0.4 throttle delta, settles in ~10 s.

---

## 4. Difficulty levels

### 4.1 `AI_TUNING_ROOKIE` (deltas vs Veteran)

```ts
export const AI_TUNING_ROOKIE: AI_TUNING = {
  ...AI_TUNING_VETERAN,
  reactionDelayTicks: 8,            // 0.267 s
  Kp_hdg: 0.7,
  Kp_bank: 1.5,
  Kp_alt: 0.008,
  Ki_alt: 0.0003,
  detectRangeM: 2200,
  gunRangeM: 250,
  gunneryBiasRad: 0.020,            // 1.15°
  gunnerySigmaRad: 0.025,           // 1.43° (5× Veteran)
  missileCooldownS: 10.0,
  lockHoldT: 2.5,
  evadeClearT: 5.0,
  wanderAmpRad: 0.873,              // ±50°
  engageHpFloor: 0.35,
  disengageHp: 0.40,
};
```

### 4.2 `AI_TUNING_VETERAN`

Defaults in §3.6.

### 4.3 `AI_TUNING_ACE` (deltas vs Veteran)

```ts
export const AI_TUNING_ACE: AI_TUNING = {
  ...AI_TUNING_VETERAN,
  reactionDelayTicks: 0,
  Kp_hdg: 1.6,
  Kp_bank: 3.2,
  Kp_alt: 0.020,
  Kd_alt: 0.07,
  detectRangeM: 5000,
  gunRangeM: 500,
  gunConeRad: 0.122,                // ±7°
  gunneryBiasRad: 0.0,
  gunnerySigmaRad: 0.002,           // 0.11°
  missileCooldownS: 4.0,
  lockHoldT: 0.8,
  evadeClearT: 2.0,
  wanderAmpRad: 0.262,              // ±15°
  engageHpFloor: 0.10,
  disengageHp: 0.15,
  combatVMax: 80,
};
```

### 4.4 Expected behavioural deltas

| Metric | Rookie | Veteran | Ace |
|---|---|---|---|
| Time-to-acquire vs equal target | 6–10 s | 3–5 s | 1–3 s |
| Altitude RMS hold error (calm) | ±20 m | ±5 m | ±2 m |
| First-pass gun hit probability | 5–15 % | 25–40 % | 55–75 % |
| Win-rate vs Veteran (50 trials) | ≤ 30 % | 50 % | ≥ 70 % |

---

## 5. Targeting + threat ranking

### 5.1 Dogfight (`Engage` state)

```
candidates = enemies.filter(e => e.hp > 0 AND distance(e, self) < detectRangeM)
score(e) = (inFrontQuadrant(e) ? 1.0 : 0.4)
         * (1.0 / max(distance(e), 100))
         * (e.isPlayer ? 1.2 : 1.0)
target = argmax(score)
```

Lead-pursuit (`targeting.leadSolve`):
```
t_lead = max(0, range / (bulletV - targetClosingMs))
leadPoint = target.x_W + target.v_W * t_lead
bearingCmd = bearing(self.x_W, leadPoint)
```

Fire trigger (guns):
```
if (state==Engage AND inGunCone AND range<gunRangeM AND tSinceLastShot>fireRateMinIntervalS) → trigger
```

Fire trigger (missile):
```
if (state==Engage AND hasMissileLock continuously for lockHoldT AND tSinceLastMissile>missileCooldownS
    AND range in [missileRangeMinM, missileRangeMaxM]) → launch
```

Break-off: `selfHp < disengageHp` → `Engage → RTB`.

### 5.2 Strike-Mission defenders (SAM / AAA tanks)

Different FSM:

| State | Behaviour |
|---|---|
| `Standby` | scan 360° to `samDetectRangeM` (8000 m SAM, 1500 m AAA) |
| `Tracking` | target acquired; rotate radar/turret; charge launch timer |
| `Firing` | emit projectile (SAM: 1 missile / 10 s; AAA: 8 rounds/s, 3-round bursts) |
| `Reload` | post-burst cool-down |
| `Destroyed` | static |

Ground units do NOT consume the aircraft `Controls` struct. They run
their own targeting in `src/mission/ground-targets.ts` and emit
projectiles directly.

---

## 6. Determinism

### 6.1 RNG injection

```ts
export function createAIPilot(seed: number, tuning: AI_TUNING): AIPilot;

interface AIPilot {
  tick(percepts: Percepts, dt_ai: number): Controls;
  getState(): { fsmState: FsmState; lastGoal: Goal; rng_cursor: number };
  snapshot(): AIPilotSnapshot;
  restore(snap: AIPilotSnapshot): void;
}
```

- PRNG: `mulberry32(seed)`, 20 LoC, zero deps.
- All randomness routes through `rng.next()`.
- `tickIndex` increments monotonically.
- No `Math.random`, no `Date.now`. Sums computed in fixed order.

### 6.2 "Feels human" deterministic perturbations

- `gunnerySigmaRad` Gaussian (Box-Muller from two `rng.next()`).
- `wanderAmpRad` heading dither, sampled every `wanderPeriodS`.
- 1-tick coin-flip when both `break-left`/`break-right` equally good.

All reproducible bit-for-bit given seed.

### 6.3 Multi-bot determinism

Each bot gets `createAIPilot(seedN, tuning)` with
`seedN = baseSeed ^ (botIndex * 0x9E3779B9)`. Bots never share PRNG
state. Mode iterates by `botIndex`, not insertion order.

---

## 7. Performance budget

| Metric | Target |
|---|---|
| AI tick rate | 30 Hz |
| Max bots in scene | 8 |
| Per-tick cost | ≤ 0.1 ms (modern laptop) |
| Memory per pilot | < 4 kB |
| Allocations per tick | 0 (steady-state) |

Wave D hooks:
- `pilot.tick()` p99 wall time across 10k calls. Soft-fail above 0.3 ms.
- Budget test: `JSON.stringify(snapshot)` size < 1 kB.

---

## 8. Multiplayer behaviour

### 8.1 Human-join handling

1. Bots never vanish mid-shot.
2. On human-join, bot keeps FSM state. If target slot retires, bot
   transitions to `Patrol` next AI tick.
3. **Retirement policy**: if `humans + bots > maxParticipants` (8),
   retire highest-HP bots first via `Engage|Patrol → RTB` for 10 s,
   then despawn. No score impact.
4. **Promotion**: bot retires per (3) over 10 s for PvP.
5. Logged through `NetClient` envelope (extends `presence` with
   `botRetire`/`botJoin` types; coord with `mp-combat`).

### 8.2 Late-join contract

Bot spawned during "calm" interval (no projectile within 1 km of spawn).
If no calm interval within 30 s, spawn anyway at 2 km altitude on map
edge.

### 8.3 Authority

v0.2: AI runs only on relay-less local host. Relay is presence +
combat-events broadcast, not authoritative. Each client renders AI from
its own deterministic seed. Future: server-authoritative AI (post-v0.2).

---

## 9. Test hooks (Wave D contract — `test-combat-ai`)

The pilot exposes:

```ts
createAIPilot(seed, tuning)
AI_TUNING_ROOKIE / VETERAN / ACE
pilot.snapshot() / restore()
pilot.getState()
```

Deterministic test scenarios (Wave D MUST implement):

| # | Name | Setup | Assertion | Budget |
|---|---|---|---|---|
| T1 | **Altitude hold (Veteran, calm)** | seed=1, altCmd=500, wind=0, V0=42 level | `|alt-500| < 5 m` last 60 s of 90 s | 90 s sim |
| T2 | **Altitude hold (Veteran, wind)** | as T1 + ambient wind | `|alt-500| < 15 m` p95 | 90 s sim |
| T3 | **Heading hold** | hdgCmd=90°, level, calm | within ±2° in ≤ 12 s; holds ±1° for 30 s | 45 s sim |
| T4 | **Banked turn 360°** | hdgCmd swept by +π every 20 s | bank ≤ 60°, alt drift < 30 m, 360° ≤ 25 s | 60 s sim |
| T5 | **Veteran vs stationary target** | Veteran, dummy at 1 km same alt | ≥1 gun hit within 30 s | 30 s sim |
| T6 | **Rookie vs Veteran, 50 trials** | seeds 1..50, head-on at 4 km | Veteran wins ≥ 35/50 (70%) | 50 × 120 s |
| T7 | **Ace vs Veteran, 50 trials** | seeds 1..50, head-on at 4 km | Ace wins ≥ 35/50 (70%) | 50 × 120 s |
| T8 | **Missile evade** | Veteran cruise; missile 1 km behind, tti=8 s | `Evade` within 0.2 s; miss ≥ 70% / 20 seeds | 20 × 15 s |
| T9 | **RTB on low HP** | Veteran engaged; hp=0.20 mid-tick | next tick `state == 'RTB'`; heading toward spawn within 5 s | 10 s sim |
| T10 | **Crash + respawn** | bot ground impact | `Crashed` 15 s; then `Patrol` at spawn | 20 s sim |
| T11 | **Determinism replay** | 60 s sim, snapshot/sec, restart from snap, replay 5 s | state matches ≤ 1e-6 | 60 s sim |
| T12 | **Determinism multi-bot order** | 4 bots, vary array order | trajectories identical after 30 s | 30 s sim |
| T13 | **Stall recovery** | nose-high stall (α=20°) at 600 m | recovers (α<10°, V>30) within 8 s; loss ≤ 200 m | 15 s sim |
| T14 | **Late-join handoff** | 4 bots; inject join at t=20 s | retiree Engage→RTB, despawns t=30 s; no fire after t=20 s | 35 s sim |
| T15 | **Tick cost** | 10k ticks Veteran cruise | p99 < 0.3 ms; mean < 0.1 ms; zero alloc steady-state | one-shot |
| T16 | **Snapshot size** | after 5 min sim | `JSON.stringify(snapshot).length < 1024` | one-shot |

All tests use headless physics harness (no Three.js renderer) at
`PHYSICS_DT=1/240` with AI ticking at 1/30.

---

## Appendix A — `Controls` contract

```ts
interface Controls {
  aileronCmd: number;   // [-1..1] +1 = right roll
  elevatorCmd: number;  // [-1..1] +1 = nose up
  rudderCmd: number;    // [-1..1] +1 = nose right
  throttleCmd: number;  // [0..1]
  flapsCmd: number;     // [0..1]
  brake: boolean;
}
```

AI MUST emit exactly this shape. Physics surface slew (4.0/s) and
throttle lag (τ=0.3 s) apply identically. Bots never use `brake` in
flight.

## Appendix B — Sign-flip checklist

- `+aileronCmd` → right roll → `+selfRoll` (Euler.x in YZX).
- `+elevatorCmd` → nose up → `+selfPitch` (Euler.z in YZX).
- `+rudderCmd` → nose right → heading increases. `selfHdg = -Euler.y`
  (YZX) because world is +X east, +Z south. Confirm against
  `tests/physics-axis-correctness.test.ts` once it lands.
- `Kp_hdg > 0` only if `hdgErr = wrapPi(hdgCmd - selfHdg)` increases
  when target is to the right. Triple-check in T3.

## Appendix C — Open questions

1. Should AI receive own-aircraft `damageState` and re-tune PID gains
   live? v0.2 says no — bots fly with nominal gains until destroyed.
2. Heat-seeking missile lead solver owned by combat-spec.
3. Flaps usage: bots set `flapsCmd=0` in combat. RTB at low V →
   `flapsCmd=0.5` if `selfV < 28 m/s`. Wave B can ship `flapsCmd=0`
   always.
