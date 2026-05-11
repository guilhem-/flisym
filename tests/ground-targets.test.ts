// Ground-targets tests — covers the 6 cases mandated by
// `AGENTS/world-extender.md`. No GPU required; we only inspect the scene
// graph and triangle counts.
//
// Determinism: every test that calls `spawnGroundTargets` passes an explicit
// seed. No reliance on `Date.now()` or `Math.random()`.

import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import {
  spawnGroundTargets,
  destroyTarget,
  GROUND_TARGETS_TUNING,
  type GroundTargetInstance,
} from '../src/world/ground-targets.js';

function countTris(group: THREE.Object3D): number {
  let n = 0;
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const g = obj.geometry;
      const idx = g.index;
      if (idx) n += idx.count / 3;
      else {
        const pos = g.attributes['position'];
        if (pos) n += pos.count / 3;
      }
    }
  });
  return n;
}

function countKinds(targets: ReadonlyArray<GroundTargetInstance>): {
  sam: number;
  tank: number;
  hangar: number;
} {
  let sam = 0, tank = 0, hangar = 0;
  for (const t of targets) {
    if (t.spec.kind === 'sam') sam++;
    else if (t.spec.kind === 'tank') tank++;
    else if (t.spec.kind === 'hangar') hangar++;
  }
  return { sam, tank, hangar };
}

describe('ground-targets', () => {
  test('spawnGroundTargets({count: 10}) returns exactly 10 targets', () => {
    const field = spawnGroundTargets({ count: 10, seed: 0x1234 });
    expect(field.targets.length).toBe(10);
    expect(field.group).toBeInstanceOf(THREE.Group);
    // group has one child mesh per target.
    expect(field.group.children.length).toBe(10);
  });

  test('same seed → identical positions (determinism)', () => {
    const a = spawnGroundTargets({ count: 10, seed: 0xCAFE });
    const b = spawnGroundTargets({ count: 10, seed: 0xCAFE });
    expect(a.targets.length).toBe(b.targets.length);
    for (let i = 0; i < a.targets.length; i++) {
      const ai = a.targets[i]!;
      const bi = b.targets[i]!;
      expect(ai.spec.kind).toBe(bi.spec.kind);
      expect(ai.spec.pos[0]).toBeCloseTo(bi.spec.pos[0], 10);
      expect(ai.spec.pos[1]).toBeCloseTo(bi.spec.pos[1], 10);
      expect(ai.spec.pos[2]).toBeCloseTo(bi.spec.pos[2], 10);
    }
  });

  test('different seeds → different positions', () => {
    const a = spawnGroundTargets({ count: 10, seed: 1 });
    const b = spawnGroundTargets({ count: 10, seed: 2 });
    // At least one target must be at a meaningfully different (x, z).
    let differs = 0;
    const n = Math.min(a.targets.length, b.targets.length);
    for (let i = 0; i < n; i++) {
      const ap = a.targets[i]!.spec.pos;
      const bp = b.targets[i]!.spec.pos;
      const dx = ap[0] - bp[0];
      const dz = ap[2] - bp[2];
      if (dx * dx + dz * dz > 1) differs++;
    }
    expect(differs).toBeGreaterThan(0);
  });

  test('mix-of-kinds floor: ≥1 SAM, ≥2 tanks, ≥1 hangar for every seed', () => {
    // Spot-check several seeds — including some that the deterministic
    // shuffle could otherwise bias.
    const seeds = [0, 1, 42, 0x1234, 0xCAFE, 0xF115, 0xDEADBEEF >>> 0];
    for (const seed of seeds) {
      const field = spawnGroundTargets({ count: 5, seed });
      const m = countKinds(field.targets);
      expect(m.sam, `seed ${seed} SAM count`).toBeGreaterThanOrEqual(GROUND_TARGETS_TUNING.minSAM);
      expect(m.tank, `seed ${seed} tank count`).toBeGreaterThanOrEqual(GROUND_TARGETS_TUNING.minTank);
      expect(m.hangar, `seed ${seed} hangar count`).toBeGreaterThanOrEqual(GROUND_TARGETS_TUNING.minHangar);
    }
  });

  test('destroyTarget swaps mesh to debris (smaller tri count) and flips `destroyed`', () => {
    const field = spawnGroundTargets({ count: 10, seed: 7 });
    // Pick a hangar if possible — that's the highest tri count and gives the
    // clearest "smaller" delta. Fall back to first target otherwise.
    const tgt =
      field.targets.find((t) => t.spec.kind === 'hangar') ?? field.targets[0]!;
    const before = countTris(tgt.mesh);
    destroyTarget(tgt);
    expect(tgt.destroyed).toBe(true);
    expect(tgt.hp).toBe(0);
    const after = countTris(tgt.mesh);
    expect(after).toBeLessThan(before);
    // Debris tri-count cap from the brief: <= 30.
    expect(after).toBeLessThanOrEqual(30);
    // Idempotent: destroying twice does not regress state nor mutate mesh.
    const meshRef = tgt.mesh;
    destroyTarget(tgt);
    expect(tgt.mesh).toBe(meshRef);
    expect(tgt.destroyed).toBe(true);
  });

  test('total scene tris across 10 targets <= 5000 (graphics-budget headroom)', () => {
    const field = spawnGroundTargets({ count: 10, seed: 0xF115 });
    const total = countTris(field.group);
    expect(total).toBeLessThanOrEqual(5000);
    // Sanity floor — guard against an empty/no-mesh regression.
    expect(total).toBeGreaterThan(0);
  });

  test('count is clamped to [5, 10]', () => {
    expect(spawnGroundTargets({ count: 0, seed: 1 }).targets.length).toBe(5);
    expect(spawnGroundTargets({ count: 100, seed: 1 }).targets.length).toBe(10);
  });

  test('field uses exactly one material per active kind (≤ 4 materials total)', () => {
    const field = spawnGroundTargets({ count: 10, seed: 11 });
    const mats = new Set<string>();
    field.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((mm) => mats.add(mm.uuid));
        else mats.add(m.uuid);
      }
    });
    // Pre-destruction: 3 kinds present → at most 3 unique materials. After
    // any destruction it could rise to 4 (debris material added).
    expect(mats.size).toBeLessThanOrEqual(4);
    // And: every kind that's present contributes exactly ONE unique material.
    const kinds = new Set(field.targets.map((t) => t.spec.kind));
    expect(mats.size).toBe(kinds.size);
  });

  test('honors provided world.getGroundHeight for Y placement', () => {
    const stubGroundY = 137.5;
    const world = { getGroundHeight: (): number => stubGroundY };
    const field = spawnGroundTargets({ count: 5, seed: 99, world });
    for (const t of field.targets) {
      expect(t.spec.pos[1]).toBeCloseTo(stubGroundY, 6);
      expect(t.mesh.position.y).toBeCloseTo(stubGroundY, 6);
    }
  });
});
