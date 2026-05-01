# FLISYM

Browser-based flight simulator. TypeScript + Three.js + Vite + Cannon-es.

## Quick start

```bash
npm install
npm run dev
```

Then open the URL printed by Vite (typically http://127.0.0.1:5173).

If everything is wired up, you should see a slowly spinning teal cube on a
dark background — that is the toolchain proof.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start Vite dev server with HMR |
| `npm run build` | Type-check then build production bundle into `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run typecheck` | Run `tsc --noEmit` |
| `npm test` | Run Vitest once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run server` | Start the multiplayer presence server (ws, port 3030) |

## Multiplayer

Lightweight presence: see other pilots' aircraft in the same world. No
matchmaking, no auth — strictly local trust.

```bash
# Terminal 1 — start the WebSocket presence server (default port 3030).
npm run server

# Terminal 2 — start the Vite dev server.
npm run dev
```

Open the dev URL in two (or more) browser tabs. In each tab, press
**M** once to connect. You should see the other tabs' aircraft as live
peer Cessnas in the same scene.

Override the server URL at build time via `VITE_FLISYM_WS_URL`
(e.g. `VITE_FLISYM_WS_URL=ws://192.168.1.42:3030 npm run dev`). The
server port can be changed with `FLISYM_PORT=4040 npm run server`.

## Project layout

```
flisym/
├── index.html              # Entry HTML, full-viewport canvas
├── src/
│   ├── main.ts             # Bootstrap: scene, camera, renderer, animate loop
│   ├── physics/            # Flight model (lift, drag, mass, 6DOF)
│   ├── world/              # Terrain, sky, weather
│   ├── aircraft/           # Aircraft mesh + state
│   ├── hud/                # Heads-up display overlay
│   ├── camera/             # Camera modes (cockpit, chase, free)
│   ├── input/              # Keyboard / gamepad input
│   └── net/                # (Stretch) multiplayer client
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## Tech stack

- **Three.js** — rendering
- **Cannon-es** — physics (rigid bodies; flight model lives on top)
- **Vite** — dev server and bundler
- **TypeScript** — strict mode, ES2022, bundler module resolution
- **Vitest** — unit tests for physics & math

## Constraints

- ESM only (`"type": "module"`)
- TypeScript strict
- No React / Vue / UI frameworks; HUD is plain DOM or canvas overlay
- No lodash; the standard library is enough

## Status

Phase 0 scaffold. Game systems not yet implemented — see `PRODUCER.md`,
`STATE.md`, and `AGENTS/` for the plan.
