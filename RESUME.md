# RESUME — read this first on any session restart

**You are the producer of FLISYM, a browser flight simulator.** Your job is to
orchestrate specialized subagents toward shipping v0.2 (4 game modes incl.
dogfight) within an 8h time budget.

## Read in this order (5-min orientation)

1. **`STATE.md`** — current phase, in-flight agents, NEXT ACTION block.
2. **`PRODUCER.md`** — vision + v0.1 baseline + tech stack.
3. **`PRODUCER-v2.md`** — v0.2 plan: 4 modes, combat, AI, test guarantees.
4. **`LOG.md`** — append-only decision log.
5. **`AGENTS/ROSTER.md`** — agent index + dispatch ledger.
6. `git log --oneline -30` — code progression.

## What v0.2 ships

Four playable game modes:
1. **Free Flight** — sandbox (v0.1 baseline).
2. **Time Trial** — gate course with ghost replay + personal-best.
3. **Dogfight** — guns + heat-seeking missiles + damage; opponents are
   AI bots or human peers via WebSocket.
4. **Strike Mission** — waypoints + ground targets (SAM, tanks, hangars) +
   dumb bombs.

Test guarantees the user explicitly required:
- **Axis-correctness simulation tests**: step physics, assert direction of
  motion per control input. Catches sign-flips.
- **Playwright e2e**: boot page, send keys, verify HUD/aircraft response.
- **Graphics element budget**: cap on triangles, draw calls, mesh count.

## Producer cadence

- After every wave of agent dispatches: update `STATE.md` NEXT ACTION + append
  `LOG.md`.
- Every 4 dispatches: check time budget (see `STATE.md` time-used field).
- Hard stop at 8h wall-clock for this session. Cut scope past 6h.
- Survive compaction: never hold critical state in conversation alone.

## How to dispatch a new agent

1. Write/update brief at `AGENTS/<role>.md` (self-contained, references
   files not conversation).
2. Append row to `AGENTS/ROSTER.md` dispatch ledger.
3. Use the Agent tool with prompt: *"Read AGENTS/&lt;role&gt;.md and STATE.md
   first, then execute. Write your result report to AGENTS/&lt;role&gt;-report.md."*
4. Choose `subagent_type`: `Plan` for design-only, `general-purpose` for
   implementation, `Explore` for read-only audits.
5. Parallel-dispatch only when files-touched whitelists don't overlap.

## How to verify before declaring "done"

```
npm test          # must pass (vitest)
npm run typecheck # must pass
npm run build     # must produce dist/
```

For the v0.2 release also:
- `npx vitest run tests/physics-axis-correctness.test.ts` green.
- `npx vitest run tests/graphics-budget.test.ts` green.
- Playwright suite green OR explicitly skipped with documented reason.
