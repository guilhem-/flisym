# FLISYM v0.2 — Test Strategy

This document specifies the three test layers the v0.2 release explicitly
requires. Wave D coders implement these without further back-and-forth.

Authoritative references: `docs/physics-spec.md` for axis conventions,
`PRODUCER-v2.md` §"Test guarantees" for scope.

## 0. Axis-convention cheat-sheet (NEVER deviate)

From `physics-spec.md` §1.2 and §1.4 — already encoded in
`src/physics/aero.ts`, `src/physics/state.ts`, `src/physics/step.ts`:

| Concept            | Symbol  | Code field    | +1 means …                |
|--------------------|---------|---------------|---------------------------|
| Roll rate          | p       | `omega_B.x`   | right wing down           |
| Yaw rate           | r       | `omega_B.y`   | nose right                |
| Pitch rate         | q       | `omega_B.z`   | nose up                   |
| Aileron command    | δ_a     | `delta_a`     | right roll                |
| Elevator command   | δ_e     | `delta_e`     | nose up                   |
| Rudder command     | δ_r     | `delta_r`     | nose right                |
| World forward      | —       | `v_W.x` at q=identity | toward world +X (east) |
| Gravity            | g       | `v_W.y` after free-fall | decreases (negative) |

Mixing textbook (ω_y = pitch) labels with code packing (ω.z = pitch)
WILL trigger a false sign-flip alarm. Use code-field names.

---

## 1. Axis-correctness suite (`tests/physics-axis-correctness.test.ts`)

### 1.1 Common harness

```ts
import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  createNeutralControls,
  advance,
  FLIGHT_MODEL,
} from '../src/physics/index.js';

const DT = 1 / 240;
const NO_GROUND = (): number => -1e6;

function airborneAt(speed: number, altitude = 1000) {
  const s = createInitialState();
  s.x_W.set(0, altitude, 0);
  s.v_W.set(speed, 0, 0); // body +X aligned with world +X at identity quat
  s.q.identity();
  s.omega_B.set(0, 0, 0);
  s.onGround = false;
  s.throttle = 0.5;
  return s;
}

function stepFor(state, controls, seconds) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) advance(state, DT, controls, NO_GROUND);
}
```

Invariants:
- No `Date.now`, `performance.now`, `Math.random` (without fixed seed).
- Airborne cases spawn ≥ 500 m AGL with `onGround = false`.
- `getGroundHeight` returns `-1e6` for airborne cases.
- Each `expect` asserts ONE component of ONE vector.

### 1.2 Required cases (13 minimum: 8 mandated + 5 extras)

#### Case 1 — +aileron rolls right
- **Initial:** airborneAt(50 m/s), neutral.
- **Input:** `controls.aileronCmd = +1` for 1.0 s.
- **Assert:** `state.omega_B.x > 0.05 rad/s`.
- **Reasoning:** Full aileron at V=50 produces ≥ 30 °/s ≈ 0.52 rad/s
  steady-state per spec §11. Asserting ≥ 0.05 gives 10× safety margin
  for slew ramp-up.

#### Case 2 — −aileron rolls left
- **Input:** `aileronCmd = -1` for 1.0 s.
- **Assert:** `state.omega_B.x < -0.05`.

#### Case 3 — +elevator pitches nose up
- **Input:** `elevatorCmd = +1` for 0.5 s.
- **Assert:** `state.omega_B.z > 0.03 rad/s` AND
  `(new THREE.Vector3(1,0,0).applyQuaternion(state.q)).y > 0`.
- **Reasoning:** Cm_δe = +0.5. Short window (0.5 s) avoids pitch-damping
  equilibrium. `forwardWorldY > 0` confirms quaternion rotation produces
  real nose-up pitch.

#### Case 4 — −elevator pitches nose down
- **Input:** `elevatorCmd = -1` for 0.5 s.
- **Assert:** `state.omega_B.z < -0.03 rad/s`.

#### Case 5 — +rudder yaws right
- **Input:** `rudderCmd = +1` for 1.0 s.
- **Assert:** `state.omega_B.y > 0.01 rad/s`.
- **Reasoning:** Cn_δr = +0.074 (order of magnitude smaller than Cm_δe).
  Tolerance is deliberately loose; the goal is sign correctness.

#### Case 6 — −rudder yaws left
- **Input:** `rudderCmd = -1` for 1.0 s.
- **Assert:** `state.omega_B.y < -0.01 rad/s`.

#### Case 7 — Full throttle from idle on runway, accel +X
- **Initial:** `createInitialState()` (onGround, x_W = (0, 0.5, 0), v_W = 0).
- **Input:** `throttleCmd = 1.0`, surfaces neutral.
- **Window:** 5.0 s with `getGround = () => FLIGHT_MODEL.groundY`.
- **Assert:** `state.v_W.x > 3.0 m/s`.
- **Reasoning:** Static thrust 2800 N, m=1100 kg → bare accel 2.5 m/s².
  Throttle lag τ=0.3 s + rolling friction (0.02 × v_W) hold early.
  Expected ~10 m/s after 5 s; threshold 3 m/s is huge cushion.

#### Case 8 — Throttle to zero in cruise, speed decreases
- **Initial:** airborneAt(50 m/s), throttle = 0.7.
- **Input:** `throttleCmd = 0`, surfaces neutral.
- **Window:** 2.0 s.
- **Assert:** `state.v_W.length() < 50.0 - 0.5`.
- **Reasoning:** Throttle decay τ=0.3 s + drag at 50 m/s ≈ 1490 N →
  decel 1.35 m/s². 2 s loss ≈ 2.7 m/s. Threshold 0.5 m/s is conservative.

#### Case 9 (extra) — Climb at full power + small back stick
- **Initial:** airborneAt(50 m/s).
- **Input:** `throttleCmd = 1.0`, `elevatorCmd = +0.2` for 3.0 s.
- **Assert:** `state.v_W.y > 0.5 m/s`.
- **Reasoning:** Spec §11 V4 ROC 3.5–6 m/s at full power. With only 0.2
  elevator over 3 s, asserting ROC > 0.5 m/s catches elevator sign-flip.

#### Case 10 (extra) — Flaps lower stall AoA
- **Initial:** airborneAt(22 m/s, alt=1000).
- **Input:** `flapsCmd = 1.0`, `elevatorCmd = +1.0`, `throttleCmd = 0`.
- **Window:** 5.0 s.
- **Assert:** `state.stallFlag === false`.
- **Reasoning:** Spec §5.1: α_stall drops by ~2° with full flaps.
  V_stall_flapped ≈ 22.4 m/s. With flaps stall is deferred.

#### Case 11 (extra) — Same maneuver, flaps up, DOES stall
- **Initial:** airborneAt(22 m/s, alt=1000).
- **Input:** `flapsCmd = 0`, `elevatorCmd = +1.0`, `throttleCmd = 0`.
- **Window:** 5.0 s.
- **Assert:** `state.stallFlag === true`.

#### Case 12 (extra) — Quaternion rotates body +X to world +X at identity
- **Initial:** airborneAt(50 m/s).
- **Input:** `elevatorCmd = 1` for 0.3 s.
- **Assert:** `fwd = (1,0,0).applyQuaternion(state.q)` → `fwd.y > 0`
  AND `|fwd.z| < 0.05`.
- **Reasoning:** Catches pitch leaking into yaw/roll from quaternion bug.

#### Case 13 (extra) — Pure aileron does not pitch the nose
- **Initial:** airborneAt(50 m/s).
- **Input:** `aileronCmd = +1.0` for 0.5 s.
- **Assert:** `|state.omega_B.z| < 0.05 rad/s` AND `state.omega_B.x > 0.05`.
- **Reasoning:** No Cm_δa term in spec §5.5; pure aileron must not
  excite pitch.

### 1.3 Tolerance philosophy

- Inequality (`> threshold`), not `toBeCloseTo`. Sign correctness > magnitude.
- Thresholds 5–10× smaller than expected magnitude — robust to tuning changes.
- One assertion per `expect()` — failing test pinpoints axis.

---

## 2. Graphics budget suite (`tests/graphics-budget.test.ts`)

### 2.1 Caps

| Metric | Cap | Failure mode |
|---|---:|---|
| Triangles (visible meshes) | **≤ 250 000** | Three.js stalls > 500k on integrated GPUs |
| Meshes (THREE.Mesh + InstancedMesh) | **≤ 500** | Each mesh ≈ one draw call on WebGL1 |
| Draw-call estimate | **≤ 200** | Predictable frame-time |
| Particles | **≤ 2 000** | > 2k transparent tanks fill-rate on SwiftShader |

### 2.2 Scene construction

```ts
import * as THREE from 'three';
import { World } from '../src/world/index.js';
import { Aircraft } from '../src/aircraft/index.js';
import { GateCourse } from '../src/challenge/index.js';
import { spawnGroundTargets } from '../src/world/ground-targets.js';
import { BulletPool } from '../src/combat/bullets.js';
import { MissilePool } from '../src/combat/missiles.js';

const scene = new THREE.Scene();
const world = new World();                       scene.add(world.mesh);
const own  = new Aircraft();                     scene.add(own.group);
const bots = Array.from({ length: 3 }, () => new Aircraft());
bots.forEach((b) => scene.add(b.group));
const course = new GateCourse();                 scene.add(course.mesh);
const targets = spawnGroundTargets({ count: 10, seed: 0xF115 });
scene.add(targets.group);
const bullets = new BulletPool(256);             scene.add(bullets.group);
const missiles = new MissilePool(8);             scene.add(missiles.group);
```

### 2.3 Traversal algorithm

```ts
let triCount = 0;
let meshCount = 0;
const materialKeys = new Set<string>();
let drawEstimate = 0;
let particleCount = 0;

scene.updateMatrixWorld(true);
scene.traverse((obj) => {
  if (obj instanceof THREE.Points) {
    const pos = obj.geometry.attributes.position;
    if (pos) particleCount += pos.count;
    return;
  }
  if (obj instanceof THREE.InstancedMesh) {
    meshCount += 1;
    const g = obj.geometry;
    const triPerInst = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    triCount += triPerInst * obj.count;
    if ((obj.userData as { isParticleSystem?: boolean }).isParticleSystem) {
      particleCount += obj.count;
    }
    materialKeys.add(materialKey(obj.material));
    drawEstimate += 1; // InstancedMesh = 1 draw call
    return;
  }
  if (obj instanceof THREE.Mesh) {
    if (obj.visible === false) return;
    meshCount += 1;
    const g = obj.geometry;
    const triPerMesh = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    triCount += triPerMesh;
    materialKeys.add(materialKey(obj.material));
    drawEstimate += 1;
  }
});

function materialKey(m: THREE.Material | THREE.Material[]): string {
  if (Array.isArray(m)) return m.map(materialKey).join('|');
  return `${m.type}#${m.uuid}`;
}
```

### 2.4 Assertions (separate `it` per cap)

```ts
it('triangle budget', () => expect(triCount).toBeLessThanOrEqual(250_000));
it('mesh budget',     () => expect(meshCount).toBeLessThanOrEqual(500));
it('draw budget',     () => expect(drawEstimate).toBeLessThanOrEqual(200));
it('particle budget', () => expect(particleCount).toBeLessThanOrEqual(2_000));
```

### 2.5 Regression-aware baseline

```ts
it('no >10% regression vs committed baseline', () => {
  const baseline = JSON.parse(fs.readFileSync('tests/.budget-baseline.json','utf8'));
  for (const k of ['triCount','meshCount','drawEstimate','particleCount']) {
    const ratio = actual[k] / baseline[k];
    expect(ratio, `${k} jumped ${(ratio*100).toFixed(1)}% of baseline`)
      .toBeLessThan(1.10);
  }
});
```

Baseline regenerated with `FLISYM_UPDATE_BUDGET_BASELINE=1 npx vitest
run tests/graphics-budget.test.ts`.

### 2.6 NOT asserted

- No pixel readback (software WebGL hosts).
- No `WebGLRenderer.info.render.calls`.
- No FPS measurement.

---

## 3. Playwright e2e suite (`tests/e2e/*.spec.ts`)

### 3.1 Dev-dep + config

- Add `@playwright/test` as dev dependency (call out for producer approval — RECOMMENDED).
- `/home/gb/git/flisym/playwright.config.ts`:
  - Single project: Chromium with `--use-angle=swiftshader
    --enable-unsafe-swiftshader --ignore-gpu-blocklist`.
  - `webServer: { command: 'npm run dev', url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI, timeout: 60_000 }`.
  - `use.baseURL: 'http://localhost:5173'`.
  - `use.actionTimeout: 5_000`, `use.navigationTimeout: 15_000`.
  - `reporter: 'line'`.
  - `retries: process.env.CI ? 1 : 0`.

### 3.2 main.ts hooks needed (Wave B/C dependency)

1. `<canvas data-testid="flisym-canvas">` set in main.ts.
2. `<div class="flisym-hud" data-testid="flisym-hud">` in hud.ts.
3. Per-mode HUD label gets `data-testid="hud-mode-name"`.
4. Kill-feed entries get `data-testid="hud-kill-feed-entry"`.
5. Gate-count gets `data-testid="hud-gates-pass"` + `data-gates-pass` attr.
6. Damage HUD gets `data-testid="hud-damage-airframe"` + `data-hp` attr.
7. After WebGL probe success:
   `window.__FLISYM_WEBGL_OK__ = true;
    window.__FLISYM_READY__ = true;`
8. main.ts parses `?seed=<int>` from `location.search`.
9. `window.FLISYM = { scenario: { dogfightTrainer(), timeTrialTrainer(),
   reset() } }` dev-only via `import.meta.env.DEV`.

### 3.3 Skip predicate

```ts
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const ready = await page.waitForFunction(
    () => (window as any).__FLISYM_READY__ === true,
    null,
    { timeout: 5_000 }
  ).catch(() => null);
  const webglOk = await page.evaluate(
    () => (window as any).__FLISYM_WEBGL_OK__ === true
  );
  if (!ready || !webglOk) test.skip(true, 'WebGL unavailable on host');
});
```

### 3.4 Spec inventory (8 tests across 5 files)

#### S1 — `boot.spec.ts`
- `await expect(page.getByTestId('flisym-canvas')).toBeVisible();`
- `await expect(page.getByTestId('flisym-hud')).toBeVisible();`
- `await page.waitForFunction(() => (window as any).__FLISYM_FRAMES__ > 30);`

#### S2 — `mode-switch.spec.ts` (4 tests)
- For each m in {free-flight, time-trial, dogfight, strike-mission}:
  - `await page.keyboard.press('1' | '2' | '3' | '4');`
  - `await expect(page.getByTestId('hud-mode-name')).toHaveText(/<m>/i,
    { timeout: 5_000 });`

#### S3 — `combat-hit.spec.ts`
- `?seed=42` for deterministic AI.
- `await page.evaluate(() => window.FLISYM.scenario.dogfightTrainer())`.
- Wait `__FLISYM_FRAMES__ > 60`.
- Pulse Space 80 times at 50 ms cadence.
- `await page.waitForFunction(
   () => document.querySelectorAll('[data-testid="hud-kill-feed-entry"]').length > 0,
   { timeout: 20_000 });`

#### S4 — `time-trial-gate.spec.ts`
- `?seed=1`, `timeTrialTrainer()`.
- `await page.waitForFunction(
   () => Number(document.querySelector('[data-testid="hud-gates-pass"]')
     ?.getAttribute('data-gates-pass') ?? 0) >= 1,
   { timeout: 15_000 });`

#### S5 — `reset-key.spec.ts`
- Press `R`, expect aircraft position resets to spawn via
  `window.FLISYM.state.position` test-only getter.

### 3.5 Determinism / flakiness controls

- Vitest: fixed DT, no clock calls, no unseeded random.
- Playwright: never `page.waitForTimeout` as deadline (only as key-rate pacer).
- `?seed=` query param pins AI RNG.
- `window.__FLISYM_FRAMES__++` per RAF tick is the canonical "progress"
  predicate.

---

## 4. Determinism appendix

| Source | Mitigation |
|---|---|
| `Math.random` in AI | Seedable RNG in `src/ai/`, `?seed=` param |
| `Date.now` in physics | Forbidden — DT is fixed |
| `performance.now` for game state | Allowed only in main.ts render loop |
| RAF jitter changing physics | Physics fixed-dt; render rate decouples |
| Test-host CPU variance | Tolerances ≥ 10× safety margin |
| Cross-browser CSS layout | Select by `data-testid`, never CSS path |

---

## 5. CI gate (v0.2 release)

```sh
# Static
npx tsc --noEmit

# Unit + integration (Vitest)
npx vitest run

# Specific release-gate
npx vitest run tests/physics-axis-correctness.test.ts
npx vitest run tests/graphics-budget.test.ts

# E2E (Playwright)
npx playwright test --reporter=line
# On no-WebGL hosts: exits 0 with all tests `skipped`.

# Build
npm run build
```

All five must exit 0.

---

## 6. Open questions for producer

1. **Playwright dev-dep approval.** `@playwright/test@^1.48.0`,
   ~50 MB Chromium download. RECOMMENDED.
2. **`FLISYM_UPDATE_BUDGET_BASELINE` env flag or `npm run budget:bake`?**
3. **AI seed param.** `main.ts` reads `new URLSearchParams(location.search)
   .get('seed')`, calls `seedRNG(Number(s))`.
4. **`window.FLISYM.scenario.*` dev surface.** Gate behind
   `import.meta.env.DEV` so production bundle has no test hooks?
5. **Roll Case 1 tolerance.** After first green, raise threshold to ≥ 0.15
   rad/s (10 °/s).
6. **Rudder Case 5/6 tolerance.** First run may surface lower magnitude;
   if so, add higher-speed (V=80) variant.
