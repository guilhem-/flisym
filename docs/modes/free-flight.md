# Mode — Free Flight

## 1. Pitch
A pressure-free sandbox: take off, climb, sightsee, land. No clock, no
threats, no scoring. This is the v0.1 experience preserved verbatim so
players have somewhere to go when they want to fly, not compete.

## 2. Win / Lose conditions
- **Win**: none. `status().won === false` always.
- **Lose**: none. `status().lost === false` always.
- `status().score`: airborne-seconds (monotonic counter, integer seconds).
- `status().headline`: `"FREE FLIGHT — <hh:mm>"` of airborne time
  (`"FREE FLIGHT — on ground"` when `onGround`).

## 3. Spawn state
Identical to v0.1 (`src/main.ts` lines 53–58):
- World position: `x_W = (-700, groundY + 30.48, 0)` — 100 ft AGL above
  the runway threshold, on the runway centerline.
- World velocity: `v_W = (50, 0, 0)` m/s along +X — heading 090° (east).
- `throttle = 0.7`, `delta_a = delta_e = delta_r = delta_f = 0`.
- `onGround = false`, `q = identity`. Body axes therefore align with
  world axes at spawn: body +X (forward) = world +X (east).
- Aircraft loadout: bare Cessna mesh (`buildCessna()`), no hardpoints.

## 4. HUD surface
Adds **nothing** beyond v0.1 HUD. Specifically the mode does NOT push:
- challenge panel (`hud.setChallenge(null)` on init)
- finish overlay (`hud.hideFinishOverlay()` on init)
- combat panels (do not exist in this mode at all)

The mode's `headline` is rendered into the bottom-center mode badge
(`<div data-h="mode-badge">`, new in v0.2 HUD, see PRODUCER-v2.md).

## 5. Input bindings
Strictly the v0.1 set (`src/input/keyboard.ts`):
- W/S, ↑/↓: elevator   • A/D, ←/→: aileron   • Q/E: rudder
- Shift / Ctrl: throttle   • F / Shift+F: flaps
- B: brake   • V: camera cycle   • G: (no-op in this mode)
- 1..9, 0: time-of-day   • M: multiplayer presence connect

**No additions.** Free Flight is the baseline.

## 6. World/scene additions
None. The mode adds no meshes to the scene. Graphics-budget impact: 0
extra tris, 0 extra meshes, 0 extra draw calls beyond the World +
Aircraft baseline.

## 7. State shape
```ts
interface FreeFlightState {
  /** Seconds of airborne time accumulated this session. */
  airborneSeconds: number;
  /** Last frame's `onGround` value — for edge detection. */
  wasOnGround: boolean;
}
```

## 8. Telemetry events
- `mode_started` on `init`.
- `mode_ended` on `dispose` (never emitted with `won=true`).
- No other events.

## 9. AI involvement
None. No bots are ever spawned in Free Flight.

## 10. Multiplayer involvement
Solo by default. **Optional**: pressing `M` connects to the WS presence
server and shows other live pilots (v0.1 behavior, preserved). No combat
events are processed even if the server sends them. This is presence-only
multiplayer.

## 11. Test hooks
- After 60 s of neutral controls + spawn state, `score` should advance
  monotonically (no overflow, no reset).
- `status().won` and `status().lost` are `false` on every frame for at
  least 600 s of simulated time.
- `mode.dispose()` followed by `mode.init(ctx)` results in
  `airborneSeconds === 0`.
- HUD has no `data-h="radar"`, `data-h="target-box"`, `data-h="lock"`,
  `data-h="damage"`, `data-h="kill-feed"` elements visible (their
  display style is `none` or they are absent entirely).

## 12. Open questions
- Should we persist a "total airborne hours" counter to `localStorage`
  across sessions? Producer-call: yes/no for v0.2.
- Should pressing `1..9,0` (time-of-day) be considered a Free-Flight-only
  cheat, or universal? Today it's universal — keep it universal.
