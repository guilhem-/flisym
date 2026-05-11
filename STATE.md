# Current State — v0.2 SHIPPED

**Phase**: 8 — v0.2 release complete
**Last update**: 2026-05-11 (post Wave E)
**Tag**: `v0.2` (this HEAD)
**v0.1 baseline preserved**: tag `v0.1` at `67f13d2` (28 tests, 553 kB)
**Tests**: 163 passing + 2 skipped (165 total) across 18 test files
**Bundle**: 655.86 kB / 176.75 kB gz
**Time elapsed in v0.2 session**: ~3h 40min wall-clock
**Time budget**: 8h hard cap (4h 20min unused; well under the 6h scope-cut threshold)

## NEXT ACTION

**v0.2 is shipped.** Tag `v0.2` exists on HEAD. Nothing scheduled.

If the user wants further work, candidates (in priority order):

1. Run the e2e suite (`npm run test:e2e`) on a real machine with Chromium to confirm the 6/8 → likely 8/8 transition now that the dogfight HUD crash and time-trial trainer spawn are fixed. Was last measured at 6/8 (before fixes); re-measure to update SHIPPED-v2.md.
2. Address carry-over v0.1 punchlist (P1 ground clamp, P3 CameraRig dispose, P4 wind one-substep, P5 free-fly roll reset). Each is small; bundle as a `v0.2.1` patch.
3. v0.3 — server-authoritative combat, PvP peers as combat participants (not just presence), full SAM FSM, off-screen target box arrows. See `AGENTS/reviewer-v2-report.md` "Future / v0.3".

## Wave summary

| Wave | Outcome | Duration |
|------|---------|----------|
| A — Design | 8 design docs (modes, combat, AI, test strategy) + 4 reports | ~40 min (incl. doc materialization since Plan agents are read-only) |
| B — Foundation | 4 parallel coders (modes, combat, AI, world-extender). +45 tests. | ~50 min (with 2 timeout-resumed agents) |
| C — Integration | 3 parallel + producer main.ts surgery. +30 tests. | ~50 min |
| D — Tests | 3 parallel test suites (axis 13, budget 6, e2e 8). Surfaced 2 product bugs + 1 budget red. | ~30 min |
| Bug fixes | Producer fixed dogfight HUD crash + time-trial trainer spawn | ~10 min |
| E — Review + Polish | reviewer-v2 punchlist → polish-v2 (Cessna merge + combat audio + SHIPPED-v2.md) | ~20 min |

## Ship outputs

| File | Purpose |
|------|---------|
| `SHIPPED-v2.md` | Player-facing release notes |
| `AGENTS/polish-v2-report.md` | Final polish wrap-up |
| `AGENTS/reviewer-v2-report.md` | Pre-ship audit |
| tag `v0.2` | Release tag |
| `docs/modes/*.md` + `docs/combat-spec.md` + `docs/ai-spec.md` + `docs/test-strategy.md` | Frozen v0.2 specs |

## How to run / verify (v0.2)

```sh
npm install
npm test                                           # vitest 163 + 2 skipped
npx tsc --noEmit                                   # 0 errors
npm run build                                      # 656 kB / 177 kB gz
npm run dev                                        # http://localhost:5173

# Mode hotkeys: 1 Free Flight · 2 Time Trial · 3 Dogfight · 4 Strike Mission

# Optional multiplayer relay
npm run server

# Optional e2e (Playwright must be installed: npx playwright install chromium)
npm run test:e2e
```

## Producer scaffolding (unchanged)

See `RESUME.md` for canonical pointer order; `AGENTS/ROSTER.md` for the full dispatch ledger across both v0.1 (15 agents) and v0.2 (16 agents).
