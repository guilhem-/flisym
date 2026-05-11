# Current State — v0.2 Wave C

**Phase**: 7 — v0.2 Wave C (Integration) dispatching
**Last update**: 2026-05-11 (post Wave B)
**v0.1 baseline**: tag `v0.1` at `67f13d2`
**Tests**: 114 passed + 2 skipped (116) after Wave B. Typecheck clean.
**Time elapsed in v0.2 session**: ~1h 30min
**Remaining budget**: ~6h 30min

## NEXT ACTION

Wave C dispatches **3 agents** in parallel PLUS producer (me) does main.ts integration surgery.

Three Wave C agents:
1. **hud-combat** (general-purpose) → extends `src/hud/hud.ts` with combat overlays (radar, damage panel, kill feed) + mission overlays (waypoints, bombs) + Time Trial overlays (PB, ghost) + Playwright testids. Brief: `AGENTS/hud-combat.md`.
2. **mp-combat** (general-purpose) → creates `src/net/combat-net.ts` adapter wiring combat events to/from NetClient; adds `bot-retire`/`bot-join` envelope. Brief: `AGENTS/mp-combat.md`.
3. **mission-coder** (general-purpose) → creates `src/mission/` (waypoints + strike mission generator) AND replaces the Dogfight + Strike Mission throw-stubs in `src/modes/registry.ts` with full implementations composing CombatSystem, AI pilot, GroundTargetField, CombatNet, HUD. Brief: `AGENTS/mission-coder.md`.

Producer (me) does main.ts in parallel:
- Remove top-level `course = new GateCourse()` (Time Trial owns its own; per modes-coder report).
- Construct `ModeSwitcher` and tick it before physics.
- Add mode hotkeys `1`/`2`/`3`/`4` for free-flight / time-trial / dogfight / strike-mission.
- Add `data-testid="flisym-canvas"` on renderer.domElement.
- Add `window.__FLISYM_READY__`, `__FLISYM_WEBGL_OK__`, `__FLISYM_FRAMES__` counter.
- Parse `?seed=` query param + pass to mode ctx + AI seedRNG.
- Dev-only `window.FLISYM.scenario.{dogfightTrainer, timeTrialTrainer, reset}` via `import.meta.env.DEV`.

When Wave C reports return:
- `npm test` and `npx tsc --noEmit` green.
- `npm run dev` boots in a browser cleanly (manual verification).
- Append LOG.md entry "Wave C complete — N min".
- Update NEXT ACTION → Wave D.

## Waves overview

| Wave | Status | Agents | Budget |
|------|--------|--------|--------|
| A — Design | complete | 4 designers | ~40 min |
| B — Foundation | complete | 4 coders | ~50 min |
| C — Integration | **dispatching** | hud-combat / mp-combat / mission-coder + producer main.ts | 75 min target |
| D — Tests | pending | axis-correctness / e2e+budget | 75 min |
| E — Final | pending | reviewer-v2 → polish-v2 | 60 min |

## Hard constraints

- Body axes: +X fwd, +Y up, +Z right.
- TypeScript strict-mode clean.
- `npm test` stays green at each wave.
- No new runtime deps. Playwright is dev-dep only, deferred to Wave D.
- v0.1 tag remains valid.

## Wave B artifacts (use these — they're authoritative)

| Module | Path | API to reuse |
|---|---|---|
| Modes | `src/modes/index.ts` | `MODE_REGISTRY`, `ModeSwitcher`, `Mode`, `ModeContext`, `ModeStatus` |
| Combat | `src/combat/index.ts` | `CombatSystem`, `snapshot()`, `getRoot()`, `BulletPool`, `MissilePool`, `BombPool` |
| AI | `src/ai/index.ts` | `createAIPilot`, `AI_TUNING_*`, `seedRNG` |
| Ground targets | `src/world/ground-targets.ts` | `spawnGroundTargets`, `GroundTargetField` |
| Net (extended) | `src/net/client.ts` | typed `peer-shoot/-hit/-kill/-respawn` emitter; new `bot-retire/-join` from mp-combat |
| Physics (extended) | `src/physics/state.ts` | optional `state.hp`, `isAlive`, `respawnAt` fields |

## Open issues (carried)

- **P1** ground clamp falls back to `groundY = 0.5` on `<= 0`. Should fall back only on NaN/Inf.
- **P3** `CameraRig` has no `dispose()`.
- **P4** Wind sampler reads `state.time` one substep late.

## Producer scaffolding

See `RESUME.md` for canonical pointer order; `AGENTS/ROSTER.md` for ledger.
