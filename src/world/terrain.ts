/**
 * Terrain — single displaced PlaneGeometry with vertex-color biomes.
 *
 * Build order (per spec §15):
 *   plane → displacement (with runway flatten) → vertex colors → normals.
 *
 * The mesh uses a shared noise instance so `getGroundHeight` returns the
 * exact same value the mesh was built with (good for physics queries).
 *
 * See `/docs/world-spec.md` §2-4.
 */

import * as THREE from 'three';
import type { NoiseFunction2D } from 'simplex-noise';
import { WORLD_CONFIG } from './config.js';
import { createNoise, getHeightAt } from './heightmap.js';

const SAND = new THREE.Color(WORLD_CONFIG.biomes.sand);
const GRASS = new THREE.Color(WORLD_CONFIG.biomes.grass);
const ROCK_MIX_HI = new THREE.Color(WORLD_CONFIG.biomes.rockMixHi);
const ROCK = new THREE.Color(WORLD_CONFIG.biomes.rock);
const SNOW = new THREE.Color(WORLD_CONFIG.biomes.snow);

/**
 * Pick a biome color for a vertex from height + slope.
 * Ordering follows the spec: rock dominates on steep slopes regardless of
 * height; otherwise we step through sand → grass → mixed → snow.
 */
function biomeColor(h: number, slope: number, out: THREE.Color): THREE.Color {
  const b = WORLD_CONFIG.biomes;
  if (slope >= b.rockMinSlope) {
    out.copy(ROCK);
    return out;
  }
  if (h >= b.snowMinHeight) {
    out.copy(SNOW);
    return out;
  }
  if (h < b.sandMaxHeight) {
    out.copy(SAND);
    return out;
  }
  if (h < b.grassMaxHeight && slope < b.grassMaxSlope) {
    out.copy(GRASS);
    return out;
  }
  if (h < b.rockMixMaxHeight) {
    // Lerp grass → rock-mix from grassMaxHeight..rockMixMaxHeight.
    const t = (h - b.grassMaxHeight) / (b.rockMixMaxHeight - b.grassMaxHeight);
    out.copy(GRASS).lerp(ROCK_MIX_HI, Math.max(0, Math.min(1, t)));
    return out;
  }
  // Above mix range but below snow: rock mix.
  out.copy(ROCK_MIX_HI);
  return out;
}

export class Terrain {
  readonly mesh: THREE.Mesh;
  private readonly noise: NoiseFunction2D;

  constructor(noise?: NoiseFunction2D) {
    this.noise = noise ?? createNoise();

    const { size, segments } = WORLD_CONFIG.terrain;
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2); // make Y up

    const positions = geometry.attributes.position;
    if (!positions) {
      throw new Error('PlaneGeometry built without position attribute');
    }
    const vertexCount = positions.count;

    // Displace.
    for (let i = 0; i < vertexCount; i++) {
      const x = positions.getX(i);
      const z = positions.getZ(i);
      const h = getHeightAt(x, z, this.noise);
      positions.setY(i, h);
    }
    positions.needsUpdate = true;

    geometry.computeVertexNormals();

    // Vertex colors — height + slope.
    const colors = new Float32Array(vertexCount * 3);
    const normals = geometry.attributes.normal;
    if (!normals) {
      throw new Error('Vertex normals not computed');
    }
    const tmp = new THREE.Color();
    for (let i = 0; i < vertexCount; i++) {
      const h = positions.getY(i);
      const ny = normals.getY(i);
      const slope = 1 - ny; // 0 = flat, 1 = vertical
      biomeColor(h, slope, tmp);
      const o = i * 3;
      colors[o] = tmp.r;
      colors[o + 1] = tmp.g;
      colors[o + 2] = tmp.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
      flatShading: false,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'Terrain';
    // Static — skip per-frame matrix recompute (perf §12).
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /**
   * Ground height at a world XZ coordinate, using the same noise + flatten
   * mask the mesh was built with. Safe for physics ground queries.
   */
  getGroundHeight(x: number, z: number): number {
    return getHeightAt(x, z, this.noise);
  }
}
