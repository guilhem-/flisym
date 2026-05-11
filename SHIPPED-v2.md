# FLISYM v0.2 — Shipped

**Producer**: Claude (Opus 4.7) supervising agent team
**Start**: 2026-05-11 (Wave A dispatch)
**Tag target**: v0.2 (post Wave E polish-v2)
**Budget**: 8h
**Bundle**: 656 kB / 177 kB gz | 163 passed + 2 skipped tests | 6/6 graphics budget caps green

## What ships on top of v0.1

v0.1 sandbox is preserved as `Free Flight`. v0.2 adds three more playable
modes, a combat system, an AI bandit pilot, mission scaffolding, and the
multiplayer combat envelope on top of the existing presence relay.

### Game modes (4)

1. **Free Flight** — the v0.1 sandbox: 50 km × 50 km terrain, free-form
   exploration, gate course remains available via G-reset.
2. **Time Trial** — 12-gate aerobatic course (carried over from v0.1) with
   per-seed personal-best tracking and a ghost-replay HUD strip showing
   delta-distance to your previous run.
3. **Dogfight** — guns + Sidewinder-style heat-seeking missile vs one AI
   bandit. PvE by default; the AI bot retires when human peers join via
   the WebSocket relay (PvP overlay; peer combat targeting is v0.3 work).
4. **Strike Mission** — fly waypoints, drop dumb bombs on a deterministic
   ground-target field (hangars, tanks, SAM site), egress to runway.
   v0.2 ships a single SAM defender with minimal radar AI.

### Combat system (`src/combat/`)

- `CombatSystem` orchestrates `BulletPool(256)`, `MissilePool(8)`,
  `BombPool(8)`, `ExplosionPool(16)` — all `THREE.InstancedMesh`, zero
  per-projectile `THREE.Mesh`.
- IR + radar seeker model (`acquireLock`), missile flight with proportional
  navigation, damage zones (airframe / engine / aileron / elevator /
  rudder), respawn lifecycle.
- `COMBAT_TUNING` constants match `docs/combat-spec.md` verbatim
  (verified by reviewer-v2).
- Client-side hit detection; server is a pure relay (~9 LoC delta on
  `server/index.ts`).

### AI bandit pilot (`src/ai/`)

- 30 Hz tick rate (deterministic dt = 1/30 s).
- `Percepts` snapshot (target range, gun-cone, hot/cold position) +
  finite-state pilot machine (`createAIPilot`, `AI_TUNING_VETERAN`).
- Seeded via `?seed=` query param XOR-folded with `0x9e3779b9`.
- Performance budget: tick p99 0.012 ms, mean 0.007 ms, snapshot < 1 KB
  (per reviewer audit).

### Multiplayer (`src/net/combat-net.ts`)

- v0.1 presence relay extended with typed combat envelopes
  (`peer-shoot`, `peer-hit`, `peer-kill`, `peer-respawn`,
  `peer-bot-retire`, `peer-bot-join`).
- Bot retirement on PvP join is one-shot (no rejoin when peers drop);
  noted as v0.3 polish.

### Mission scaffolding (`src/mission/`)

- `generateStrikeMission(seed, world, field)` — deterministic ingress /
  target-area / egress waypoints, anchored to the runway threshold.
- `GroundTargetField` (`src/world/ground-targets.ts`) with 'hangar',
  'tank', 'sam' kinds; SAM target supports `destroyTarget()` swap to
  debris visual.

### HUD additions (`src/hud/`)

- Radar (240×240 SVG, 5/10/20 km rings, 10 Hz throttle).
- Gun pipper (24 px reticle, `.hot` class when target in cone).
- Target box + lock-tone LED (`.seeking` 4 Hz amber blink → `.locked`
  solid red).
- Damage panel (5 bars: airframe / engine / aileron / elevator / rudder).
- Kill feed (top-left, max 4 rows, 5 s fade).
- Ammo readout, K/D score panel, "DESTROYED" overlay.
- Waypoint strip + bomb readout + target list (strike mission).
- SAM-warning banner (red "MISSILE LAUNCH" auto-clears in 3 s).
- PB panel + ghost-distance readout (time trial).
- All overlays carry `data-testid=hud-*` for Playwright.

### Combat audio (`src/audio/combat.ts`, new)

- `playLockSeeking()` — 1 kHz sine, gain 0.04, pulsed 4 Hz, matches
  `.seeking` LED rhythm.
- `playLockSolid()` — continuous 1.2 kHz sine, gain 0.05.
- `stopLockTone()` — silences whichever voice is playing.
- `playSamWarning()` — descending two-tone 800 → 500 Hz over 600 ms.
- Mirrors the lazy AudioContext init pattern from `src/audio/engine.ts`;
  idempotent across re-calls.

## How to play

```sh
npm install
npm run dev          # http://localhost:5173
# optional:
npm run server       # multiplayer relay on :3030
```

### Mode hotkeys (top-row digits, all modes)

| Key | Mode |
|-----|------|
| `1` | Free Flight |
| `2` | Time Trial |
| `3` | Dogfight |
| `4` | Strike Mission |

### Combat keys (Dogfight)

| Key | Action |
|-----|--------|
| `Space` | Hold gun trigger (auto-fire) |
| `X` | Fire missile (consumes 1 rail) |
| `T` | Cycle target (designate → seeker seeking) |
| `L` | Refresh lock (engages full lock if target in IR cone) |
| `R` | Respawn (only legal while dead) |

### Strike Mission keys

| Key | Action |
|-----|--------|
| `Space` | Pickle one bomb |
| `Z` | Cycle pickle quantity (1 / 2 / 4 — v0.2 honors only 1) |

### Carried-forward v0.1 controls

`W/S` `Up/Down` elevator (W = nose down), `A/D` `Left/Right` aileron,
`Q/E` rudder, `Shift/Ctrl` throttle, `F` flaps cycle, `B` parking brake,
`V` cycle camera, `0..9` time-of-day presets, `G` reset gate course,
`M` connect multiplayer.

### URL parameters

- `?seed=N` — deterministic seed for AI + mission generation.
- `?mp=1` — auto-attempt multiplayer connect on boot (bot retires).

## Test layers passing

| Layer | Count | Result |
|---|---:|---|
| Physics axis-correctness (`tests/physics-axis-correctness.test.ts`) | 13 | **13/13 green** |
| Graphics element budget (`tests/graphics-budget.test.ts`) | 6 | **6/6 green** (tris 97 336/250 000, meshes 115/500, draw 115/200, particles 0/2000) |
| Combat / AI / HUD / modes (vitest) | 144 | **all green** |
| Playwright e2e (`tests/e2e/*`) | 8 | **8 tests authored**; smoke-runnable under SwiftShader on host machines (v0.2 ship gate verifies via vitest only, since CI lacks `sudo` for full Chromium deps; the 2 product bugs Playwright surfaced were fixed during Wave D → E) |

Total: **163 unit tests passed + 2 skipped (165 total)**, **0 failed**.
TypeScript strict-mode clean.

## Known limitations

- **PvP combat peers**: the WebSocket relay broadcasts presence and the
  combat envelope is typed end-to-end, but peers are not yet first-class
  combat participants (you see each other fly, but lock/hit targeting
  addresses only the local bot). v0.3 work.
- **SAM AI is minimal**: one site, fires every 10 s when the player is
  within an 8 km omni-cone. The full Standby / Tracking / Firing FSM in
  the combat-spec is deferred to v0.3.
- **Bot retirement is one-shot**: when a peer joins the dogfight room
  the bot enters a 10 s RTB ramp and despawns. No re-add when the peer
  count drops back to 0; mode restart required.
- **Lock-tone audio is basic**: a single shared voice in
  `src/audio/combat.ts`. It doesn't model proximity, doppler, or
  per-missile growl-amplitude. Adequate for v0.2 ship.

## Carried-forward v0.1 punchlist

These items were documented in `REVIEW_PUNCHLIST.md` against v0.1 and
remain present in v0.2 — they are **not regressions**.

- **P1**: ground clamp falls back to `groundY = 0.5` whenever the
  heightmap returns ≤ 0. Should fall back only on NaN/Inf.
  (`src/physics/step.ts:157-158`)
- **P3**: `CameraRig` has no `dispose()` method.
- **P4**: wind sampler reads `state.time` one substep late
  (~4 ms phase offset).
- **P5**: free-fly camera mode resets roll on entry.

`P2` was fixed during v0.1 (`e702b83`).

## Polish-v2 deltas (this wave)

- **Cessna mesh merge** (`src/aircraft/cessna.ts`): static sub-meshes
  are now collapsed by material via
  `THREE.BufferGeometryUtils.mergeGeometries`. Animated control surfaces
  (ailerons, elevator, rudder, flaps, propeller pivot's three blade-tier
  meshes) remain separate. Per-aircraft mesh count: **41 → 15**. Scene
  draw estimate at worst-case: **219 → 115** (was 9.5% over the 200 cap,
  now 42.5% under). Baseline file `tests/.budget-baseline.json` re-baked.
- **Combat audio** (`src/audio/combat.ts`, new): `CombatAudio` class with
  lock-tone + SAM-warning voices, wired from `DogfightMode` (lock-state
  edges) and `StrikeMissionMode` (SAM-fire).
- **Strike Mission audit**: `pushHud` already uses `setMission` (not
  `setCombat`), so the snapshot-shape mismatch the producer fixed in
  Dogfight does not apply here. Added `hud.showSamWarning()` invocation
  on SAM fire to unblock the existing HUD banner pathway.

## Bundle size

| Build | Bundle | Gzipped |
|---|---:|---:|
| v0.1 baseline | 553 kB | 144 kB |
| v0.2 post-polish | **656 kB** | **177 kB** |
| Delta | +103 kB (+18.6%) | +33 kB (+22.9%) |

The +18% growth covers: combat system (pools + projectile physics + seeker
geometry), AI pilot FSM + tuning constants, mission scaffolding,
extended HUD, combat-net envelope, ground-target field, combat audio,
and `BufferGeometryUtils` for the mesh merge.

## Architecture delta vs v0.1

```
src/
  modes/                   NEW — Mode interface, registry, ModeSwitcher
    {free-flight,time-trial,dogfight,strike-mission}.ts
  combat/                  NEW — CombatSystem, pools, seeker, damage
  ai/                      NEW — pilot FSM, percepts, deterministic PRNG
  mission/                 NEW — strike mission generation
  world/ground-targets.ts  NEW — deterministic target field
  audio/combat.ts          NEW — lock tone + SAM warning
  hud/                     EXTENDED — combat / mission / time-trial overlays
  net/combat-net.ts        NEW — typed combat envelopes over the v0.1 relay
docs/
  modes/                   NEW — per-mode specs (frozen)
  combat-spec.md           NEW
  ai-spec.md               NEW
  test-strategy.md         NEW
tests/
  physics-axis-correctness.test.ts    NEW — 13 axis assertions
  graphics-budget.test.ts             NEW — 6 element-budget assertions
  e2e/                                NEW — 8 Playwright specs
  combat-ai / modes / hud-combat / ...
SHIPPED-v2.md              this file
```

## Agent dispatches (v0.2)

| Wave | # | Role | Output |
|------|--:|------|--------|
| A | 16 | modes-designer | `docs/modes/*` |
| A | 17 | combat-designer | `docs/combat-spec.md` + `COMBAT_TUNING` table |
| A | 18 | ai-designer | `docs/ai-spec.md` (percepts, FSM, tuning) |
| A | 19 | test-strategy-designer | `docs/test-strategy.md` |
| B | 20 | modes-coder | `src/modes/{types,index,registry}` + ModeSwitcher |
| B | 21 | combat-coder | `src/combat/` (system, pools, seeker, damage) |
| B | 22 | ai-coder | `src/ai/` (pilot, percepts, prng) |
| B | 23 | world-extender | `src/world/ground-targets.ts` + extensions |
| C | 24 | hud-combat | `src/hud/` overlays + `data-testid` hooks |
| C | 25 | mp-combat | `src/net/combat-net.ts` + envelope types |
| C | 26 | mission-coder | `src/mission/` + Dogfight + Strike mode impls |
| C | — | producer | `src/main.ts` integration (hotkeys, scenario hooks, seed) |
| D | 27 | test-axis-correctness | `tests/physics-axis-correctness.test.ts` (13/13) |
| D | 28 | test-graphics-budget | `tests/graphics-budget.test.ts` + baseline |
| D | 29 | test-e2e-playwright | `tests/e2e/*` (8 specs) |
| E | 30 | reviewer-v2 | audit + punchlist |
| E | 31 | polish-v2 | mesh merge + combat audio + this doc |

16 v0.2 dispatches over 5 waves + 1 producer surgery; `PRODUCER-v2.md`,
`STATE.md`, `LOG.md`, and `AGENTS/*.md` continued as the
restart-safe scaffolding.

## Acknowledgments

- **modes-designer, combat-designer, ai-designer, test-strategy-designer**
  (Wave A) — frozen specs that the rest of the team could code against
  without re-litigating contracts.
- **modes-coder, combat-coder, ai-coder, world-extender** (Wave B) —
  parallel foundation lays without trampling each other.
- **hud-combat, mp-combat, mission-coder** (Wave C) — the integration
  wave that wired physics + combat + AI + UI into four playable modes.
- **test-axis-correctness, test-graphics-budget, test-e2e-playwright**
  (Wave D) — the required test guarantees. test-graphics-budget
  surfacing the draw-call over-budget condition truthfully (rather than
  raising the cap) is exactly the contract the producer wanted.
- **reviewer-v2** (Wave E) — single-page audit + actionable punchlist.
- **polish-v2** (Wave E, this report) — punchlist closure + ship doc.

All v0.1 agents whose work this v0.2 release builds on (architect,
physics, world, aircraft, HUD, camera, multiplayer, ILS, gates) — see
`SHIPPED.md` for the v0.1 acknowledgment list.
