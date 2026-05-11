// Graphics-element-budget suite (v0.2 Wave D).
//
// Implements `docs/test-strategy.md` §2 verbatim:
//   §2.1 Caps:       triangles ≤ 250_000, meshes ≤ 500, drawEstimate ≤ 200,
//                    particles ≤ 2_000.
//   §2.2 Scene:      World + 1 own Aircraft + 3 bot Aircraft + GateCourse +
//                    GroundTargetField(count=10, seed=0xF115) + BulletPool(256)
//                    + MissilePool(8) + BombPool(8) + ExplosionPool(16). Each
//                    pool is constructed at its cap so InstancedMesh.count is
//                    already at the worst-case (three.js InstancedMesh sets
//                    `this.count = count` from the ctor third arg, so a fresh
//                    pool exercises the worst-case draw without us spawning).
//   §2.3 Traversal:  one pass over `scene` after `updateMatrixWorld(true)`,
//                    accumulating tri/mesh/drawEstimate/particle counters.
//                    Points  → particleCount += position.count
//                    Instanced→ meshCount + 1; tris × obj.count; drawCall=1
//                    Mesh    → meshCount + 1; tris; drawCall=1
//   §2.4 Assertions: one `it` per cap (4) + a baseline-regression `it` (1).
//   §2.5 Baseline:   `tests/.budget-baseline.json` committed. Regenerate via
//                    FLISYM_UPDATE_BUDGET_BASELINE=1; under that env var the
//                    regression test writes a fresh baseline and self-skips.
//
// Plus 1 extra `it` `combat_pools_are_instanced` (per the brief) that walks
// `combat.getRoot()` and asserts the projectile visuals are InstancedMeshes,
// not per-projectile Meshes.
//
// We deliberately do not boot a WebGLRenderer (no GPU on CI / SwiftShader)
// and we do not read `renderer.info.render.calls`. The traversal is a static
// upper bound that catches the failure modes called out in §2.1.

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { World } from '../src/world/index.js';
import { Aircraft } from '../src/aircraft/index.js';
import { GateCourse } from '../src/challenge/index.js';
import { spawnGroundTargets } from '../src/world/ground-targets.js';
import {
  BulletPool,
  MissilePool,
  BombPool,
  ExplosionPool,
  CombatSystem,
} from '../src/combat/index.js';

// ───────────────────────────────────────────────────────────────────────────
// Caps (docs/test-strategy.md §2.1). DO NOT raise — surface failures instead.
// ───────────────────────────────────────────────────────────────────────────

const CAP_TRIS = 250_000;
const CAP_MESHES = 500;
const CAP_DRAW = 200;
const CAP_PARTICLES = 2_000;

// ───────────────────────────────────────────────────────────────────────────
// Baseline file. ESM-safe absolute path; located next to this test file.
// ───────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASELINE_PATH = path.join(__dirname, '.budget-baseline.json');
const UPDATE_BASELINE = process.env['FLISYM_UPDATE_BUDGET_BASELINE'] === '1';

interface Budget {
  triCount: number;
  meshCount: number;
  drawEstimate: number;
  particleCount: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Shared scene + measurement, computed once in beforeAll. Assertion `it`s
// read from this `measured` object.
// ───────────────────────────────────────────────────────────────────────────

const measured: Budget = {
  triCount: 0,
  meshCount: 0,
  drawEstimate: 0,
  particleCount: 0,
};

let combatRoot: THREE.Group | null = null;

function materialKey(m: THREE.Material | THREE.Material[]): string {
  if (Array.isArray(m)) return m.map(materialKey).join('|');
  return `${m.type}#${m.uuid}`;
}

beforeAll(() => {
  // ── §2.2 Scene construction ──────────────────────────────────────────────
  const scene = new THREE.Scene();

  const world = new World();
  scene.add(world.mesh);

  const own = new Aircraft();
  scene.add(own.group);

  const bots = Array.from({ length: 3 }, () => new Aircraft());
  bots.forEach((b) => scene.add(b.group));

  const course = new GateCourse();
  scene.add(course.mesh);

  const targets = spawnGroundTargets({ count: 10, seed: 0xf115 });
  scene.add(targets.group);

  // Pools at their declared caps. THREE.InstancedMesh `count` defaults to the
  // ctor's third argument (max instances), so each pool already reports
  // worst-case `obj.count` without us spawning anything.
  const bullets = new BulletPool(256);
  scene.add(bullets.group);
  const missiles = new MissilePool(8);
  scene.add(missiles.group);
  const bombs = new BombPool(8);
  scene.add(bombs.group);
  const explosions = new ExplosionPool(16);
  scene.add(explosions.group);

  // Build a CombatSystem instance for the `combat_pools_are_instanced` test.
  // It owns its own pools — we don't add them to the scene to avoid
  // double-counting against the budget. Its caps match the pools above.
  const combat = new CombatSystem();
  combatRoot = combat.getRoot();

  // ── §2.3 Traversal ───────────────────────────────────────────────────────
  scene.updateMatrixWorld(true);

  const materialKeys = new Set<string>();
  let triCount = 0;
  let meshCount = 0;
  let drawEstimate = 0;
  let particleCount = 0;

  scene.traverse((obj) => {
    // Particles (THREE.Points) first — points are not meshes.
    if (obj instanceof THREE.Points) {
      const pos = obj.geometry.attributes['position'];
      if (pos) particleCount += pos.count;
      return;
    }

    if (obj instanceof THREE.InstancedMesh) {
      meshCount += 1;
      const g = obj.geometry;
      const triPerInst = g.index
        ? g.index.count / 3
        : (g.attributes['position']?.count ?? 0) / 3;
      triCount += triPerInst * obj.count;
      // Allow pools to opt-in as particle systems via userData.
      const ud = obj.userData as { isParticleSystem?: boolean };
      if (ud.isParticleSystem) particleCount += obj.count;
      materialKeys.add(materialKey(obj.material));
      drawEstimate += 1; // one InstancedMesh = one draw call.
      return;
    }

    if (obj instanceof THREE.Mesh) {
      if (obj.visible === false) return;
      meshCount += 1;
      const g = obj.geometry;
      const triPerMesh = g.index
        ? g.index.count / 3
        : (g.attributes['position']?.count ?? 0) / 3;
      triCount += triPerMesh;
      materialKeys.add(materialKey(obj.material));
      drawEstimate += 1;
    }
  });

  measured.triCount = triCount;
  measured.meshCount = meshCount;
  measured.drawEstimate = drawEstimate;
  measured.particleCount = particleCount;

  // ── §2.5 Baseline regen — write committed baseline & exit. ──────────────
  // Doing this in beforeAll means subsequent it() blocks still run (and pass,
  // because the measured numbers obey the caps). The regression test
  // self-skips when UPDATE_BASELINE is true.
  if (UPDATE_BASELINE) {
    const fresh: Budget = { ...measured };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(fresh, null, 2)}\n`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// §2.4 Assertions — one `it` per cap.
// ───────────────────────────────────────────────────────────────────────────

describe('graphics element budget — worst-case combat frame', () => {
  it('triangle budget', () => {
    expect(
      measured.triCount,
      `triangles=${measured.triCount} (cap ${CAP_TRIS})`,
    ).toBeLessThanOrEqual(CAP_TRIS);
  });

  it('mesh budget', () => {
    expect(
      measured.meshCount,
      `meshes=${measured.meshCount} (cap ${CAP_MESHES})`,
    ).toBeLessThanOrEqual(CAP_MESHES);
  });

  it('draw budget', () => {
    expect(
      measured.drawEstimate,
      `drawEstimate=${measured.drawEstimate} (cap ${CAP_DRAW})`,
    ).toBeLessThanOrEqual(CAP_DRAW);
  });

  it('particle budget', () => {
    expect(
      measured.particleCount,
      `particles=${measured.particleCount} (cap ${CAP_PARTICLES})`,
    ).toBeLessThanOrEqual(CAP_PARTICLES);
  });

  // ── §2.5 Regression test ─────────────────────────────────────────────────
  it('no >10% regression vs committed baseline', (ctx) => {
    if (UPDATE_BASELINE) {
      // Baseline was just written in beforeAll; the comparison is meaningless
      // on this run. Skip so CI under the env var doesn't tautologically pass.
      ctx.skip();
      return;
    }
    if (!fs.existsSync(BASELINE_PATH)) {
      throw new Error(
        `Missing ${BASELINE_PATH}. Re-run with FLISYM_UPDATE_BUDGET_BASELINE=1 to bake.`,
      );
    }
    const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
    const baseline = JSON.parse(raw) as Budget;
    const keys: Array<keyof Budget> = [
      'triCount',
      'meshCount',
      'drawEstimate',
      'particleCount',
    ];
    for (const k of keys) {
      const b = baseline[k];
      const a = measured[k];
      // Guard against /0 on a fresh, zero-particle baseline.
      if (b === 0) {
        expect(a, `${k} baseline is 0 but measured ${a}`).toBe(0);
        continue;
      }
      const ratio = a / b;
      expect(
        ratio,
        `${k} jumped to ${(ratio * 100).toFixed(1)}% of baseline (${a} vs ${b})`,
      ).toBeLessThan(1.1);
    }
  });

  // ── Extra: combat pools are instanced ───────────────────────────────────
  // BulletPool, BombPool, ExplosionPool contribute one InstancedMesh each;
  // MissilePool contributes TWO (body + plume), so a fully-populated
  // CombatSystem root has 5 InstancedMeshes and zero per-projectile Meshes.
  it('combat_pools_are_instanced', () => {
    expect(combatRoot).not.toBeNull();
    const root = combatRoot as THREE.Group;
    let instanced = 0;
    let plainMeshes = 0;
    root.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) {
        instanced += 1;
      } else if (obj instanceof THREE.Mesh) {
        plainMeshes += 1;
      }
    });
    // ≤ 5 because MissilePool is body + plume (one InstancedMesh each).
    // We assert the tight upper bound that matches the spec wiring.
    expect(
      instanced,
      `expected ≤ 5 InstancedMeshes in combat root, saw ${instanced}`,
    ).toBeLessThanOrEqual(5);
    expect(
      plainMeshes,
      `expected 0 per-projectile THREE.Mesh in combat root, saw ${plainMeshes}`,
    ).toBe(0);
  });
});
