/**
 * Trees — InstancedMesh forest scattered across the playable area.
 *
 * Procedural placement: a deterministic PRNG fans out N candidates over the
 * playable square, accepting those that land in grass-like biome (ground
 * height within [minHeight, maxHeight] and slope below maxSlope) and outside
 * a runway-exclusion square. Each accepted tree gets a small per-instance
 * scale and yaw rotation jitter so they don't look identical.
 *
 * Geometry: two stacked primitives merged into one BufferGeometry so the
 * tree is a single InstancedMesh (one draw call for the whole forest).
 *  - Trunk: short cylinder (4 segments — cheap).
 *  - Canopy: cone above the trunk.
 *
 * One InstancedMesh keeps the mesh count at 1 (well under our 500 budget)
 * and lets us render hundreds of trees in a single draw call.
 */

import * as THREE from 'three';
import type { NoiseFunction2D } from 'simplex-noise';
import { WORLD_CONFIG } from './config.js';
import { getHeightAt } from './heightmap.js';

/** Deterministic mulberry32 PRNG (same algo as heightmap.ts). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a merged trunk+canopy geometry. Origin at the base of the trunk so
 * placing the instance at ground height makes the trunk root sit on the
 * ground.
 */
function buildTreeGeometry(): THREE.BufferGeometry {
  const t = WORLD_CONFIG.trees;
  // Trunk: cylinder, base at y = 0, top at trunkHeight.
  const trunk = new THREE.CylinderGeometry(
    t.trunkRadius,
    t.trunkRadius,
    t.trunkHeight,
    6, // sides
    1,
  );
  trunk.translate(0, t.trunkHeight / 2, 0);

  // Canopy: cone, base at trunkHeight, tip at trunkHeight + canopyHeight.
  const canopy = new THREE.ConeGeometry(t.canopyRadius, t.canopyHeight, 8, 1);
  canopy.translate(0, t.trunkHeight + t.canopyHeight / 2, 0);

  // Tag trunk + canopy with distinct vertex colors so one material can paint
  // both via vertex-color blending. (Cheaper than two separate meshes.)
  const trunkColor = new THREE.Color(t.trunkColor);
  const canopyColor = new THREE.Color(t.canopyColor);
  applyVertexColor(trunk, trunkColor);
  applyVertexColor(canopy, canopyColor);

  // Merge.
  const merged = mergeTwo(trunk, canopy);
  merged.computeVertexNormals();
  return merged;
}

function applyVertexColor(g: THREE.BufferGeometry, color: THREE.Color): void {
  const pos = g.attributes.position;
  if (!pos) throw new Error('Tree primitive missing position');
  const n = pos.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Merge two BufferGeometries by concatenating their position, normal, and
 * color attributes. Indices are translated and concatenated.
 *
 * Doing this manually avoids pulling in BufferGeometryUtils from the
 * three/examples bundle (extra runtime cost) and keeps the merge inline
 * with what trees need.
 */
function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const aPos = a.attributes.position;
  const bPos = b.attributes.position;
  const aCol = a.attributes.color;
  const bCol = b.attributes.color;
  if (!aPos || !bPos || !aCol || !bCol) {
    throw new Error('Tree primitive missing required attributes');
  }
  const totalVerts = aPos.count + bPos.count;
  const pos = new Float32Array(totalVerts * 3);
  const col = new Float32Array(totalVerts * 3);
  for (let i = 0; i < aPos.count; i++) {
    pos[i * 3] = aPos.getX(i);
    pos[i * 3 + 1] = aPos.getY(i);
    pos[i * 3 + 2] = aPos.getZ(i);
    col[i * 3] = (aCol as THREE.BufferAttribute).getX(i);
    col[i * 3 + 1] = (aCol as THREE.BufferAttribute).getY(i);
    col[i * 3 + 2] = (aCol as THREE.BufferAttribute).getZ(i);
  }
  for (let i = 0; i < bPos.count; i++) {
    const j = aPos.count + i;
    pos[j * 3] = bPos.getX(i);
    pos[j * 3 + 1] = bPos.getY(i);
    pos[j * 3 + 2] = bPos.getZ(i);
    col[j * 3] = (bCol as THREE.BufferAttribute).getX(i);
    col[j * 3 + 1] = (bCol as THREE.BufferAttribute).getY(i);
    col[j * 3 + 2] = (bCol as THREE.BufferAttribute).getZ(i);
  }
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));

  // Indices: each primitive may or may not be indexed. Normalize via
  // toNonIndexed() effectively by walking faces. CylinderGeometry and
  // ConeGeometry are indexed, so combine them respecting the offset.
  const aIdx = a.getIndex();
  const bIdx = b.getIndex();
  if (aIdx && bIdx) {
    const total = aIdx.count + bIdx.count;
    const indices = new Uint32Array(total);
    for (let i = 0; i < aIdx.count; i++) indices[i] = aIdx.getX(i);
    for (let i = 0; i < bIdx.count; i++) indices[aIdx.count + i] = bIdx.getX(i) + aPos.count;
    out.setIndex(new THREE.BufferAttribute(indices, 1));
  }
  return out;
}

/** Slope at (x,z) from the local heightmap gradient. */
function slopeAt(x: number, z: number, noise: NoiseFunction2D): number {
  const d = 1;
  const h0 = getHeightAt(x, z, noise);
  const hx = getHeightAt(x + d, z, noise);
  const hz = getHeightAt(x, z + d, noise);
  const dx = (hx - h0) / d;
  const dz = (hz - h0) / d;
  return Math.sqrt(dx * dx + dz * dz);
}

export class Trees {
  readonly mesh: THREE.InstancedMesh;

  constructor(noise: NoiseFunction2D) {
    const t = WORLD_CONFIG.trees;
    const geometry = buildTreeGeometry();
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.0,
      flatShading: true,
    });

    this.mesh = new THREE.InstancedMesh(geometry, material, t.count);
    this.mesh.name = 'Trees';
    this.mesh.matrixAutoUpdate = false;

    const dummy = new THREE.Object3D();
    const half = WORLD_CONFIG.terrain.size / 2;
    const rand = mulberry32(t.seed);

    let placed = 0;
    const maxAttempts = t.count * 8; // give up after ~8x oversample
    for (let attempt = 0; attempt < maxAttempts && placed < t.count; attempt++) {
      const x = (rand() * 2 - 1) * half;
      const z = (rand() * 2 - 1) * half;
      // Exclude a runway/spawn square so departures are unobstructed.
      if (Math.abs(x) < t.runwayExclusionXZ && Math.abs(z) < t.runwayExclusionXZ) continue;
      const h = getHeightAt(x, z, noise);
      if (h < t.minHeight || h > t.maxHeight) continue;
      if (slopeAt(x, z, noise) > t.maxSlope) continue;

      const scale = 0.7 + rand() * 0.7;
      const yaw = rand() * Math.PI * 2;
      dummy.position.set(x, h, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(placed, dummy.matrix);
      placed += 1;
    }
    // If we ran out of attempts before reaching `count`, hide the remaining
    // slots by zeroing their matrices (otherwise they'd render at origin).
    if (placed < t.count) {
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = placed; i < t.count; i++) {
        this.mesh.setMatrixAt(i, zero);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.updateMatrix();
    // CRITICAL: without these, frustum culling uses the bounding box of the
    // single source geometry (centered at origin) and the entire forest
    // disappears as soon as the camera moves. computeBoundingBox/Sphere on
    // InstancedMesh walks all instance matrices.
    this.mesh.computeBoundingBox();
    this.mesh.computeBoundingSphere();
  }
}
