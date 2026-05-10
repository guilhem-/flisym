# Current State — v0.2 Wave B

**Phase**: 7 — v0.2 Wave B (Foundation coders) dispatching
**Last update**: 2026-05-11 (post Wave A)
**v0.1 baseline**: tag `v0.1` at `67f13d2`
**Tests**: 71/71 green at Wave B dispatch (unchanged — Wave A was docs-only)
**Time elapsed in v0.2 session**: ~40 min (Wave A design + materialization)
**Remaining budget**: ~7h 20min before 8h cap

## NEXT ACTION (read this first if resuming)

**Wave A is complete.** All 8 design docs landed under `docs/` (5 mode docs + combat + ai + test-strategy). Reports at `AGENTS/<role>-report.md`.

**Wave B is dispatching now — 4 parallel coders:**

1. `modes-coder` (general-purpose) → `src/modes/` + 5-line edit to `src/challenge/gates.ts`. Implements Free Flight + Time Trial. Leaves Dogfight/Strike registry slots as throw-stubs.
2. `combat-coder` (general-purpose) → `src/combat/` + additive `src/physics/state.ts` edit + `src/physics/controls.ts` + `src/physics/aero.ts` + `server/index.ts` relay extension + `src/net/client.ts` emitter.
3. `ai-coder` (general-purpose) → `src/ai/` only.
4. `world-extender` (general-purpose) → `src/world/ground-targets.ts` + `src/world/collision.ts` if needed.

Briefs at `AGENTS/{modes,combat,ai,world-extender}-coder.md` (modes/combat/ai use `-coder` suffix, world uses `-extender`).

**Files-touched whitelist — verified no overlap.** All four can run in parallel.

When Wave B reports return:
- `npm test` and `npx tsc --noEmit` must both stay green. Producer runs these.
- If any agent's report flags a blocker, surface it in this file before Wave C.
- Append LOG.md entry "Wave B complete — N min".
- Update NEXT ACTION → Wave C.

## Waves overview (full plan in `PRODUCER-v2.md`)

| Wave | Status | Agents | Budget |
|------|--------|--------|--------|
| A — Design | **complete** | 4 designers | used ~40 min (overran on file materialization) |
| B — Foundation | **dispatching** | modes/combat/ai/world-extender | 90 min target |
| C — Integration | pending | hud-combat / mp-combat / mission-coder | 75 min |
| D — Tests | pending | axis / combat-ai / e2e+budget | 75 min |
| E — Final | pending | reviewer-v2 → polish-v2 | 60 min |

## Hard constraints every agent must obey

- Body axes: **+X forward, +Y up, +Z right.** See `docs/physics-spec.md`.
- TypeScript strict-mode clean (`npx tsc --noEmit`).
- `npm test` must stay green at every wave end.
- No new runtime dependencies (dev deps like `@playwright/test` OK with producer approval — see test-strategy.md §3.1).
- Never regress v0.1: `git checkout v0.1 && npm test` must remain valid.
- Reuse existing primitives.

## Wave A artifacts (use these — they're authoritative)

| Path | Contents |
|------|----------|
| `docs/modes/_mode-interface.md` | `Mode` interface, lifecycle, frame conventions |
| `docs/modes/free-flight.md` | Free Flight spec |
| `docs/modes/time-trial.md` | Time Trial spec (ghost replay, localStorage) |
| `docs/modes/dogfight.md` | Dogfight spec (Wave C will implement) |
| `docs/modes/strike-mission.md` | Strike Mission spec (Wave C will implement) |
| `docs/combat-spec.md` | Combat full spec + `COMBAT_TUNING` |
| `docs/ai-spec.md` | AI spec + `AI_TUNING` presets + 16 test scenarios |
| `docs/test-strategy.md` | Test strategy (Wave D contract) |

## Open issues (carry-over from v0.1)

- **P1** `src/physics/step.ts` ground clamp falls back to `groundY = 0.5` when `getGroundHeight` returns `<= 0`. Should fall back only on NaN/Inf.
- **P3** `CameraRig` has no `dispose()`.
- **P4** Wind sampler reads `state.time` one substep late.
- **P5** Free-fly mode resets roll on entry.

## How to run / verify

```sh
npm test
npx tsc --noEmit
npm run build
```

After Wave D, the release-gate adds:
```sh
npx vitest run tests/physics-axis-correctness.test.ts
npx vitest run tests/graphics-budget.test.ts
npx playwright test                  # or skip with documented reason
```

## Producer scaffolding (unchanged)

See `RESUME.md` for the canonical pointer order; see `AGENTS/ROSTER.md` for the dispatch ledger.
