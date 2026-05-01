# FLISYM Review Punch List

Items found during the integration review that are larger than a trivial
inline fix. Each carries a reproduction steps section, file:line
references, and a recommended approach.

## P1 — Ground clamp masks negative natural terrain (over water / dips)

**Where:** `src/physics/step.ts:157-158`

```ts
let groundY = getGroundHeight(state.x_W.x, state.x_W.z);
if (!Number.isFinite(groundY) || groundY <= 0) groundY = C.groundY;
```

The world's `getHeightAt` (`src/world/heightmap.ts:104`) intentionally returns
heights down to `WORLD_CONFIG.noise.minHeight = -5` (water/dips), and exactly
`0` inside the runway flatten rectangle. The integrator currently overrides
*any* ground height ≤ 0 with `C.groundY = 0.5`. Two consequences:

1. **Over water (h = -5):** the aircraft is unexpectedly clamped at +0.5 m
   instead of allowed to fly down to the water surface (or below).
2. **Just outside the runway flatten zone:** if natural terrain dips below
   0 m, again clamp to 0.5.

**Reproduction:** spawn over water by setting `state.x_W.set(20000, 0, 0)`
in `main.ts` before `animate()`, throttle 0, neutral controls; aircraft sits
at y=0.5 instead of falling to water level.

**Recommended fix:** change the guard to only fall back when the callback
returns NaN/Infinity. Inside the runway flatten zone, the runway mesh
already sits at y=0.5, so we should add 0.5 (or the runway y) directly into
the heightmap when the flatten mask = 1, so `getGroundHeight` returns 0.5
on the runway and the natural value elsewhere. Alternatively, expose the
runway y as part of the world API and clamp `groundY = max(groundY,
runway.y)` only inside the flatten rectangle.

Risk: changes physics behavior in non-runway zones; may break existing
tests if any assume groundY=0.5 universally. Verify `physics-smoke.test.ts`
still passes (it uses an explicit `() => FLIGHT_MODEL.groundY` callback,
so it's safe).

## P2 — Cessna procedural mesh: cessna.ts in-line comment is wrong

**Where:** `src/aircraft/cessna.ts:31-33`

```text
because the aircraft frame is +X forward and surfaces sit at the
trailing edge (negative X relative to the hinge), a rotation that brings
the trailing edge UP (towards +Y) is a positive rotation about +Z by
right-hand rule, i.e. rotation.z = +deflection.
```

The reasoning is inverted — a positive rotation about +Z maps -X → -Y
(trailing edge DOWN), not +Y. The TOP-OF-FILE doc block (lines 19-28) has
the correct sign convention; the inline comment block contradicts it.

`src/aircraft/aircraft.ts:setControls` was implementing the wrong direction
(matching the bad comment). I fixed `aircraft.ts` to match the doc-block
intent. The wrong inline comment in `cessna.ts` should be cleaned up to
avoid future confusion. Pure docs change.

## P3 — Camera rig has no detach / cleanup symmetric with attachInput

**Where:** `src/camera/camera-rig.ts:162-169`

`attachInput()` adds 6 listeners on `window` but there is no `detachInput()`
or `dispose()` method. For a long-lived single-camera SPA this is fine, but
if the app ever needs to swap rigs (e.g. for replay/spectator view) the
old listeners would leak and double-fire.

Recommended: add a symmetric `detach()` method that calls
`window.removeEventListener` with the same bound handlers. ~15 lines.

## P4 — Wind sampler uses sim time before it's incremented

**Where:** `src/physics/step.ts:82-87`

```ts
const wind = _windFn(state.x_W.y, state.time);
```

`state.time` is incremented at the END of physicsStep (line 219). So the
first sub-step of every render tick sees the wind sampled at the previous
sub-step's end time, not the current. Phase error of one sub-step (≈4 ms)
is harmless for this slowly rotating wind, but worth noting if anyone adds
a higher-frequency gust system.

No fix needed today.

## P5 — Camera rig free-fly seeds yaw/pitch from camera quaternion via Euler

**Where:** `src/camera/camera-rig.ts:309-317`

```ts
this.tmpEuler.setFromQuaternion(this.camera.quaternion, 'YXZ');
this.freeYaw = this.tmpEuler.y;
this.freePitch = this.tmpEuler.x;
```

When transitioning from chase/external to free, the seed from the lookAt
quaternion via YXZ Euler can land on a roll-bearing pose; the next frame
free-fly fight rebuilds the quaternion as `(pitch, yaw, 0)` so the roll is
silently dropped. Visually fine, but a brief snap may be visible during
the 0.4 s tween between modes.

Low priority — cosmetic only.
