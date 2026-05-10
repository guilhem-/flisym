# Current State — v0.2 in flight

**Phase**: 7 — v0.2 Wave A (Design) dispatching
**Last update**: 2026-05-11 (session restart, post-pause)
**v0.1 baseline**: tag `v0.1` at `67f13d2` (28 tests). HEAD checkpoint `91ea520` + hardening (71 tests passing).
**Time elapsed (this v0.2 session)**: ~5 min orientation + scaffold refresh
**Time budget for v0.2 session**: 8h hard stop, scope cut at 6h

## NEXT ACTION (read this first if resuming)

**You are mid-dispatch of Wave A.** Four design agents are about to be (or have been) dispatched in parallel:

1. `modes-designer` (Plan) → writes `docs/modes/{free-flight,time-trial,dogfight,strike-mission}.md`
2. `combat-designer` (Plan) → writes `docs/combat-spec.md`
3. `ai-designer` (Plan) → writes `docs/ai-spec.md`
4. `test-strategy-designer` (Plan) → writes `docs/test-strategy.md`

Briefs at `AGENTS/modes-designer.md`, `AGENTS/combat-designer.md`, `AGENTS/ai-designer.md`, `AGENTS/test-strategy-designer.md`.

When Wave A reports return:
- Read all 4 reports at `AGENTS/<role>-report.md`.
- Verify deliverable files exist under `docs/`.
- If reports flag missing primitives (e.g., a physics helper), open an issue row in this file before moving to Wave B.
- Append a LOG.md entry "Wave A complete — N min".
- Update this file's NEXT ACTION block to point at Wave B.
- Then dispatch Wave B (briefs to be written when Wave A reports land).

## Waves overview (full plan in `PRODUCER-v2.md`)

| Wave | Status | Agents | Budget |
|------|--------|--------|--------|
| A — Design | **dispatching** | modes/combat/ai/test-strategy designers | 30 min |
| B — Foundation | pending | modes/combat/ai/world-extender coders | 90 min |
| C — Integration | pending | hud-combat / mp-combat / mission coders | 75 min |
| D — Tests | pending | axis / combat-ai / e2e+budget | 75 min |
| E — Final | pending | reviewer-v2 → polish-v2 | 60 min |

## Hard constraints every agent must obey

- Body axes: **+X forward, +Y up, +Z right.** Never silently flip. See `docs/physics-spec.md`.
- TypeScript strict-mode clean (`npx tsc --noEmit`).
- `npm test` must stay green at every wave end.
- No new runtime dependencies without producer approval (dev deps like Playwright OK if needed).
- Never regress v0.1: `git checkout v0.1 && npm test` must remain valid.
- Reuse existing primitives: `createInitialState`, `KeyboardInput`, `HUD`, `World`, `Aircraft`, `NetClient`, `CameraRig`.

## Open issues (carry-over from v0.1 punchlist — fix opportunistically)

- **P1** `src/physics/step.ts` ground clamp falls back to `groundY = 0.5` when `getGroundHeight` returns `<= 0`. Should only fall back on NaN/Inf.
- **P3** `CameraRig` has no `dispose()` / event-listener cleanup.
- **P4** Wind sampler reads `state.time` one substep late.
- **P5** Free-fly mode resets roll on entry.

## How to run / verify

```sh
npm install          # already done
npm test             # vitest — must be 71+ green
npx tsc --noEmit     # typecheck
npm run build        # produces dist/
npm run dev          # http://localhost:5173
npm run server       # ws relay on :3030 (optional)
```

For v0.2 release-gate (after Wave D):
- `npx vitest run tests/physics-axis-correctness.test.ts`
- `npx vitest run tests/graphics-budget.test.ts`
- `npx playwright test` (or documented skip)

## Producer scaffolding (do not delete)

| File | Purpose |
|------|---------|
| `RESUME.md` | Entry pointer for fresh sessions |
| `PRODUCER.md` | v0.1 vision (frozen) |
| `PRODUCER-v2.md` | v0.2 plan (this release) |
| `STATE.md` | **this file** — restart-safe state |
| `LOG.md` | Append-only decision log |
| `SHIPPED.md` | v0.1 feature list (frozen) |
| `REVIEW_PUNCHLIST.md` | v0.1 reviewer's open items |
| `AGENTS/ROSTER.md` | Dispatch ledger |
| `AGENTS/<role>.md` | Per-agent brief (re-dispatchable) |
| `AGENTS/<role>-report.md` | Per-agent run report |
