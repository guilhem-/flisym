# Current State — SHIPPED + render fix

**Phase**: 6 — Shipped v0.1, plus post-ship render-bug fix
**Last update**: 2026-05-02 06:11 IST (session pause)
**Agent dispatches total**: 15 (no agents in flight)
**Time elapsed**: ~7h 0min wall-clock (most spent post-ship debugging render); active producer work ~70 min
**Working tree**: clean
**Tag**: v0.1 (commit 67f13d2)
**HEAD**: 91ea520 fix(render): chase camera snap on instant + scene background fallback

## Where things stand
- 23 commits on master, all green.
- `npm test` passes 28/28 (5 physics test files + 1 world-render test file).
- `npm run build` clean (553 kB / 144 kB gz).
- `npx tsc --noEmit` clean.
- v0.1 tag points at the feature-complete ship; HEAD is one defensive fix past it.

## Resume instructions (read on next session)

1. **Read `SHIPPED.md`** — full feature list of v0.1.
2. **Read `PRODUCER.md`** — vision, budget, scaffold contract.
3. **Read `LOG.md`** — append-only decision log.
4. **`git log --oneline`** — 23 commits, last is 91ea520.
5. **Read `REVIEW_PUNCHLIST.md`** — 5 known issues from the Reviewer pass (P1–P5).
6. **Re-read `AGENTS/ROSTER.md`** if dispatching new agents — every brief is in `AGENTS/`.

## Open issues (in priority order)
- **P1 (Reviewer punchlist)**: `src/physics/step.ts` ground clamp falls back to `groundY = 0.5` when `getGroundHeight` returns `<= 0`. Masks legitimate negative terrain (water/dips). Recommended fix: only fall back on `NaN`/`Inf`. Affects gameplay only over water — not currently reachable from spawn.
- **P3**: `CameraRig` has no `dispose()` / event-listener cleanup.
- **P4**: wind sampler reads `state.time` one substep late (~4 ms phase offset).
- **P5**: free-fly mode resets roll on entry (cosmetic).
- **Render** (post-ship 91ea520): may still affect users on systems without WebGL — diagnostic in commit message; user should check `about:support` / `chrome://gpu`.

## Stretch ideas not yet implemented (briefs ready in AGENTS/ if you want them)
- AI traffic (NPC autopilot)
- Cloud / rain particles
- Aircraft trail visualization
- ILS to multiple runways
- Persistent multiplayer rooms

## Producer scaffolding
| File | Purpose |
|------|---------|
| `PRODUCER.md` | vision + budget + scaffold contract |
| `STATE.md` | this file — current state, restart-safe |
| `LOG.md` | append-only decision log |
| `SHIPPED.md` | v0.1 feature list + how to play + what was cut |
| `REVIEW_PUNCHLIST.md` | Reviewer's open items |
| `AGENTS/ROSTER.md` | agent roster index |
| `AGENTS/<role>.md` | per-agent brief (re-dispatch ready) |
| `AGENTS/<role>-report.md` | per-agent run report |

## How to run
```sh
npm install
npm run dev          # http://localhost:5173
# optional second terminal for multiplayer:
npm run server       # ws relay on :3030
```

## Time budget summary
- 8h producer budget; ~70 min of active producer time used (15% of budget).
- 22 commits between project init and v0.1 tag.
- 1 post-ship fix commit + new render test (this session, just before pause).
