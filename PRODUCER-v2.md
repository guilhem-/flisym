# FLISYM v0.2 — Producer Plan

**Producer**: Claude (Opus 4.7) acting as game-studio producer
**Started**: 2026-05-11 (session 2)
**Budget**: 8h wall-clock for this session
**Baseline**: v0.1 tag (`67f13d2`) — 28/28 tests, multiplayer presence, gates, ILS.

## Vision (v0.2)

Turn the v0.1 sandbox into a real game with **four playable modes** and a
**realistic combat layer** (guns + heat-seeking missiles + damage).
Multiplayer extends from presence-only to combat-capable, with AI bots as
fallback when no humans are connected.

## Four game modes

### 1. Free Flight (sandbox)
v0.1 baseline. No objectives. Weather, time of day, full HUD.

### 2. Time Trial / Pylon Race
Extends v0.1 gate course. Adds:
- Personal-best time, stored in `localStorage`.
- Ghost replay: prior best run replayed as a translucent peer aircraft.
- Future: multi-pilot races via the WebSocket relay (post-v0.2).

### 3. Dogfight (Air Combat)
PvE or PvP. Opponents are either AI bots (default) or human peers via WS.
- **Weapons**: dual M2 .50-cal style guns (bullet pool, 600 rpm each);
  Sidewinder-class IR missile (2 hardpoints, 30s flight time, heat-seek).
- **Damage**: health model per aircraft (3 zones: airframe, engine, control
  surfaces). Damaged control surfaces reduce control authority.
- **Hit detection**: AABB per aircraft for bullets; proximity-fuse sphere
  for missiles.
- **HUD additions**: radar (top-down 20km), target box, gun pipper,
  missile-lock tone + caret, damage panel.
- **Scoring**: kills, deaths, K/D ratio; kill feed in HUD.

### 4. Strike Mission
Waypoint navigation + ground attack.
- Generated mission: 3-5 waypoints leading to target zone.
- Targets: SAM site (shoots back via radar lock, simple missile), tanks,
  hangars. ~5-10 ground targets per mission.
- Ordnance: 4 dumb bombs (Mk-82 class). Drop with `Space`.
- Scoring: target destruction % + time bonus + survival bonus.

## Tech additions (incremental)

- `src/combat/` — weapons, projectiles, damage.
- `src/ai/` — bot pilot.
- `src/modes/` — Mode interface + registry + switcher.
- `src/mission/` — waypoints, ground targets, scoring.
- `src/world/ground-targets.ts` — SAM/tank/hangar meshes.
- `src/hud/combat-hud.ts` — radar, target box, missile lock, damage.
- `server/index.ts` — extended with combat event types (shoot, hit, kill).

## Test guarantees (v0.2 release gate)

Three layers explicitly required by the user. **No v0.2 release until all
three green.**

1. **`tests/physics-axis-correctness.test.ts`** — for each control axis
   (aileron, elevator, rudder, throttle), apply a step input, integrate the
   physics for ≥1s, and assert the direction of the resulting angular
   velocity / position change. Catches sign-flips no static test would
   catch. Must cover at least 8 cases: ±aileron→roll, ±elevator→pitch,
   ±rudder→yaw, ±throttle→accel.

2. **`tests/graphics-budget.test.ts`** — bootstraps a Three.js scene with
   World + Aircraft + ground targets + max-bullet-count projectiles, walks
   the scene graph, and asserts:
   - triangle count ≤ 250k
   - mesh count ≤ 500
   - draw call estimate ≤ 200 (sum of unique materials × meshes)
   - particles ≤ 2k
   Hard caps; pipeline fails on regression.

3. **`tests/e2e/*.spec.ts`** — Playwright. Boot the page, wait for the
   canvas with `data-testid="flisym-canvas"`, send keystrokes, read the
   HUD DOM, assert state. Skipped automatically on no-WebGL hosts (the
   existing `webgl-check.ts` decides). Smoke + per-mode + combat-hit cases.

## Agent waves (planned)

### Wave A — Design (4 parallel)
1. `modes-designer` (Plan) — write `docs/modes/{free-flight,time-trial,dogfight,strike-mission}.md`.
2. `combat-designer` (Plan) — write `docs/combat-spec.md`.
3. `ai-designer` (Plan) — write `docs/ai-spec.md`.
4. `test-strategy-designer` (Plan) — write `docs/test-strategy.md`.

### Wave B — Foundation (4 parallel, after A)
1. `modes-coder` (general) — `src/modes/` (Mode interface, registry, switcher).
2. `combat-coder` (general) — `src/combat/` (weapons, projectiles, damage).
3. `ai-coder` (general) — `src/ai/` (bot pilot).
4. `world-extender` (general) — `src/world/ground-targets.ts`.

### Wave C — Integration (3 parallel, after B)
1. `hud-combat` (general) — extend HUD with radar, target box, lock, damage.
2. `mp-combat` (general) — extend ws server + `src/net/` for combat events.
3. `mission-coder` (general) — `src/mission/` + `strike-mission.ts` mode.

### Wave D — Test (3 parallel, after C)
1. `test-axis-correctness` (general).
2. `test-combat-ai` (general).
3. `test-e2e-budget` (general) — Playwright + graphics-budget.

### Wave E — Final (sequential, after D)
1. `reviewer-v2` (Explore) — integration audit.
2. `polish-v2` (general) — combat audio, hit feedback, final feel.

## Budget allocation

| Wave | Wall-clock budget | Cumulative |
|------|-------------------|------------|
| A | 30 min | 0:30 |
| B | 90 min | 2:00 |
| C | 75 min | 3:15 |
| D | 75 min | 4:30 |
| E | 60 min | 5:30 |
| Integration buffer | 90 min | 7:00 |
| Margin | 60 min | 8:00 |

## Hard constraints (every agent must obey)

- Body axes: +X forward, +Y up, +Z right. Never silently flip.
- All new code TypeScript strict-mode clean.
- `npm test` and `npm run typecheck` must stay green at every wave end.
- No new runtime dependencies without producer approval; dev deps (Playwright) OK if needed.
- Never regress v0.1 behaviour. v0.1 tag must remain a valid checkout.
- Reuse existing primitives (`createInitialState`, `KeyboardInput`, `HUD`, etc.).

## Crash-survival contract

If this session dies, the next Claude reads `RESUME.md` → `STATE.md` →
`AGENTS/ROSTER.md` and resumes from the NEXT ACTION block. Briefs at
`AGENTS/<role>.md` are self-contained and re-dispatchable.
