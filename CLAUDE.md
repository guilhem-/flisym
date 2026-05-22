# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                                  # Vite dev server (http://localhost:5173)
npm run build                                # tsc --noEmit then production build into dist/
npm run typecheck                            # tsc --noEmit only
npm test                                     # Vitest, run once
npm run test:watch                           # Vitest in watch mode
npm run test:e2e                             # Playwright (auto-starts dev server, forces SwiftShader)
npm run server                               # Multiplayer presence WS server, port 3030

npx vitest run tests/<file>.test.ts          # Single test file
npx vitest run -t "<pattern>"                # Single test by name pattern
npx playwright test tests/e2e/<file>.spec.ts # Single e2e spec
```

VM / no-GPU host: WebGL is usually blocklisted. Run `./scripts/launch-browser.sh` to launch Chromium with the SwiftShader flags that work; otherwise the page shows a "WebGL unavailable" overlay and `main.ts` throws on boot.

Multiplayer: `npm run server` in one terminal, `npm run dev` in another, press **M** in two tabs to connect. Override URL via `VITE_FLISYM_WS_URL=ws://host:port`; change server port via `FLISYM_PORT=N`.

## Architecture

### Frame conventions (memorize before touching physics or AI)

The body frame deliberately deviates from textbook to keep Three.js mesh authoring sane:

| Concept            | Code field    | +1 means                  |
|--------------------|---------------|---------------------------|
| Body +X            | —             | forward (out the spinner) |
| Body +Y            | —             | up (out the cabin roof)   |
| Body +Z            | —             | right (out the right wingtip) |
| Roll rate p        | `omega_B.x`   | right wing down           |
| Yaw rate r         | `omega_B.y`   | nose right                |
| Pitch rate q       | `omega_B.z`   | nose up                   |
| Aileron δ_a        | `delta_a`     | right roll                |
| Elevator δ_e       | `delta_e`     | nose up                   |
| Rudder δ_r         | `delta_r`     | nose right                |
| World heading 000° | —             | -Z (north); 090° = +X (east) |

`omega_B` packs (p, r, q) in (.x, .y, .z) — NOT the textbook (p, q, r). Inertia is `diag(Ixx, Izz, Iyy)` to match this packing. Mixing textbook labels with code-field names will produce false sign-flip alarms — use code-field names in tests and reviews. The aerodynamic sign conventions in `flightModel.ts` (`Cm_δe`, `Cn_δr`, etc.) are already baked for this packing.

All constants live in `FLIGHT_MODEL` (`src/physics/flightModel.ts`); do not edit without also updating `docs/physics-spec.md`.

### Main loop (`src/main.ts`)

Single RAF loop. Order is load-bearing:

1. `input.update(dt, controls)` — keyboard → command deltas.
2. `advance(state, dt, controls, getGroundHeight)` — fixed-step physics with sub-stepping (`physicsDt = 1/240`, `maxSubsteps = 8`); mutates `state`.
3. `switcher.update(dt)` — active mode tick, runs AFTER physics so modes see fresh state.
4. `hud.update(state)` + `hud.setMode(switcher.status())`.
5. `syncAircraftToState()` — copies state pose onto the THREE group.
6. World + camera + audio + net updates.
7. `renderer.render`.

Bootstrap exposes `globalThis.FLISYM` (debug surface) and global `__FLISYM_READY__` / `__FLISYM_WEBGL_OK__` / `__FLISYM_FRAMES__` flags consumed by Playwright. The canvas carries `data-testid="flisym-canvas"`. URL params: `?seed=<int>` pins the RNG; `?mode=<id>` picks the boot mode.

### Mode system (`src/modes/`)

Four modes share one interface (`Mode` in `types.ts`): `init / update / status / dispose`. Registered in `registry.ts`, switched at runtime by `ModeSwitcher`, selected via hotkeys `1`/`2`/`3`/`4` (Free Flight / Time Trial / Dogfight / Strike Mission). When extending the system:

- Add new mode metadata to the `ModeMeta['id']` union in `types.ts`, the `MODE_REGISTRY` map, and the `VALID_IDS` set in `registry.ts`.
- Modes mutate `ctx.playerControls`, not `ctx.playerState` (one exception: respawn-style resets).
- Emit telemetry via `ctx.emit(...)` using the discriminated `ModeTelemetryEvent` union — keep it exhaustive.
- HUD pushes are mode-driven via `ctx.hud` (see `hud/types.ts` for `CombatSnapshot`, `MissionHudState`, `TimeTrialHudState`).

### Module layout

- `src/physics/` — 6DOF integrator, aero, propulsion, atmosphere, ground reaction. NOT Cannon-es; we integrate ourselves. Cannon-es is only a dep, not used for the aircraft.
- `src/combat/` — bullets, missiles (heat-seeker), AABB hit-test, damage zones (airframe / engine / control surfaces).
- `src/ai/` — bot pilot FSM (`fsm.ts`), targeting, deterministic PRNG seeded by `seedRNG(SESSION_SEED)`.
- `src/world/` — heightmap terrain, sky, water, wind (set via `setWindFn` so wind doesn't corrupt `state.v_W`), `ground-targets.ts` for strike-mission targets.
- `src/hud/` — plain DOM/CSS overlay (no canvas). ILS indicator, combat HUD (radar, target box, lock tone, damage).
- `src/net/` — WS client; presence + combat events (`shoot`/`hit`/`kill`/`respawn`) relayed by `server/index.ts`. Local trust model, no anti-cheat.
- `src/mission/` — waypoints + strike scoring.
- `src/challenge/` — gate course (v0.1 carryover, reused by Time Trial).
- `src/camera/` — `CameraRig` with cockpit / chase / free modes, cycle via **V**.

## Test guarantees (required for any release)

Three layers must stay green:

1. **`tests/physics-axis-correctness.test.ts`** — for each control axis, apply step input, integrate ≥1s, assert direction of resulting angular velocity / position. Catches sign-flips.
2. **`tests/graphics-budget.test.ts`** — bootstraps scene + max-bullet projectiles and asserts hard caps: ≤250k triangles, ≤500 meshes, ≤200 draw calls, ≤2k particles.
3. **`tests/e2e/*.spec.ts`** — Playwright via SwiftShader. Specs self-skip when `__FLISYM_WEBGL_OK__` is false (see `tests/e2e/_setup.ts`). Use `gotoFlisym(page, {seed})` + `waitForFrames(page, N)`; never `page.waitForTimeout`.

## Project conventions

- TypeScript strict, ESM only (`"type": "module"`), bundler module resolution, `verbatimModuleSyntax: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`. Imports of local files end in `.js` even for `.ts` sources.
- No React/Vue/UI framework. No lodash. No new runtime deps without producer approval.
- HUD is plain DOM, not canvas.
- v0.1 behaviour must not regress; the `v0.1` tag must remain a valid checkout.
- `AircraftState.hp` / `isAlive` / `respawnAt` are optional so v0.1 callers that ignore combat see byte-identical behavior. Preserve that — don't make them required.

## Producer scaffold

This repo is run by an LLM "producer" that dispatches subagents. The scaffold survives compaction:

- `RESUME.md` is the entrypoint on session restart; read it first.
- `STATE.md` has the current phase and the **NEXT ACTION** block — start there.
- `PRODUCER.md` (v0.1) and `PRODUCER-v2.md` hold frozen vision + wave plan.
- `LOG.md` is an append-only decision log.
- `AGENTS/<role>.md` are self-contained agent briefs; `AGENTS/<role>-report.md` are their outputs. `AGENTS/ROSTER.md` is the dispatch ledger.
- `docs/` holds frozen specs (`physics-spec.md`, `combat-spec.md`, `ai-spec.md`, `test-strategy.md`, `world-spec.md`, `modes/*.md`).
- `SHIPPED.md` (v0.1) and `SHIPPED-v2.md` are release notes.

When dispatching an agent: write/update `AGENTS/<role>.md`, append a row to `AGENTS/ROSTER.md`, and instruct the agent to read its brief + `STATE.md` first and write `AGENTS/<role>-report.md` when done. Briefs must be self-contained (reference files, not conversation memory). Use `Plan` for design-only, `general-purpose` for implementation, `Explore` for read-only audits. Plan agents are read-only — for design tasks whose deliverable is committed docs, use `general-purpose` instead.
