# FLISYM — Flight Simulator (Producer Log)

**Producer**: Claude (Opus 4.7) acting as game studio producer
**Budget**: 8h
**Start**: 2026-05-01 23:10:54 IST
**Hard stop**: 2026-05-02 ~07:10 IST
**Goal**: Best-ever browser-based flight simulator (realtime, ambitious)

## How this scaffold survives compression/restart
On any restart, read in order:
1. `PRODUCER.md` (this file) — vision, budget, current phase
2. `STATE.md` — exact current state, what's done, what's next
3. `LOG.md` — append-only decision log
4. `AGENTS/` — per-agent briefs (self-contained, restart-safe)
5. `git log --oneline` — code progression
Resume by reading STATE.md "NEXT ACTION" section.

## Vision (frozen)
A web-playable flight simulator that runs in modern browsers with:
- Realistic-enough flight physics (6DOF, mass, lift, drag, stall)
- Procedural-ish world: terrain, water, sky, weather, day/night
- Cockpit + chase + free camera; HUD with airspeed/altitude/heading/attitude
- At least one playable aircraft (Cessna-class general aviation)
- Stretch: multiplayer presence, ATC voice, weather systems, navigation aids

## Tech stack (decided up-front to avoid bikeshedding)
- **Client**: TypeScript + Three.js (rendering) + Cannon-es or Rapier (physics) + Vite
- **Server**: Node.js + ws (WebSocket) + simple authoritative state for multiplayer presence
- **World**: heightmap-based terrain with LOD, skybox, sun/moon
- **Tests**: Vitest for unit tests on physics & math; Playwright smoke for client boot

Rationale: TS/Three.js gives fastest iteration, runs everywhere, no install.

## Agent roster
See `AGENTS/ROSTER.md`. Each agent has a brief at `AGENTS/<role>.md`.

## Producer cadence
- Every 10 agent dispatches: check time, reassess scope.
- Add challenges/complexity as foundation stabilizes.
- Cut scope ruthlessly past 6h mark.
