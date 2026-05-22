/**
 * Terrain — displaced PlaneGeometry with vertex-color biomes.
 *
 * Parametric (size + segments) so the World can compose multiple LOD layers:
 * a small high-density patch near the aircraft, a medium static patch, and
 * the existing 50 km coarse mesh covering the whole playable area.
 *
 * The mesh uses a shared noise instance so `getGroundHeight` returns the
 * exact same value the mesh was built with (good for physics queries).
 *
 * If `followAircraft` is true, `setCenter(x, z)` snaps the mesh to a grid
 * aligned with the segment spacing and re-displaces vertices so the
 * heightmap is always sampled at the new world coordinates. The snap step
 * matches one segment so the vertex positions in world frame remain
 * consistent across moves (no jitter at the seams).
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

export interface TerrainOptions {
  /** Mesh side length in meters (default: WORLD_CONFIG.terrain.size). */
  size?: number;
  /** Segments per side (default: WORLD_CONFIG.terrain.segments). */
  segments?: number;
  /** Shared noise instance (default: createNoise()). */
  noise?: NoiseFunction2D;
  /**
   * Render-state polygon offset. Lower values render "above" higher values
   * when meshes overlap (negative pulls toward the camera in depth). Used to
   * layer near/mid/far LODs without z-fighting.
   */
  polygonOffsetFactor?: number;
  /**
   * If true, `setCenter(x, z)` will move the mesh and re-displace vertices.
   * Static terrain (default) ignores setCenter calls.
   */
  followAircraft?: boolean;
  /** Debug name set on the mesh object. */
  name?: string;
}

export class Terrain {
  readonly mesh: THREE.Mesh;
  private readonly noise: NoiseFunction2D;
  private readonly followAircraft: boolean;
  private readonly snapStep: number;
  private centerX = 0;
  private centerZ = 0;

  constructor(opts: TerrainOptions = {}) {
    const size = opts.size ?? WORLD_CONFIG.terrain.size;
    const segments = opts.segments ?? WORLD_CONFIG.terrain.segments;
    this.noise = opts.noise ?? createNoise();
    this.followAircraft = opts.followAircraft ?? false;
    this.snapStep = size / segments;

    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2); // make Y up

    this.displace(geometry);

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
      flatShading: false,
    });
    if (opts.polygonOffsetFactor !== undefined) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = opts.polygonOffsetFactor;
      material.polygonOffsetUnits = opts.polygonOffsetFactor;
    }

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = opts.name ?? 'Terrain';
    // Static unless we follow the aircraft.
    if (!this.followAircraft) {
      this.mesh.matrixAutoUpdate = false;
      this.mesh.updateMatrix();
    }
  }

  /**
   * Re-center a follow-aircraft LOD over the given world XZ. Snaps to one
   * segment so vertex world positions don't drift across frames. Returns
   * true if the center actually moved (caller can skip downstream work
   * like tree placement re-evaluation).
   */
  setCenter(x: number, z: number): boolean {
    if (!this.followAircraft) return false;
    const sx = Math.round(x / this.snapStep) * this.snapStep;
    const sz = Math.round(z / this.snapStep) * this.snapStep;
    if (sx === this.centerX && sz === this.centerZ) return false;
    this.centerX = sx;
    this.centerZ = sz;
    this.mesh.position.set(sx, 0, sz);
    this.displace(this.mesh.geometry as THREE.PlaneGeometry);
    return true;
  }

  /**
   * Ground height at a world XZ coordinate, using the same noise + flatten
   * mask the mesh was built with. Safe for physics ground queries.
   */
  getGroundHeight(x: number, z: number): number {
    return getHeightAt(x, z, this.noise);
  }

  /**
   * Displace vertices in place from the current centerX/centerZ offset.
   * Updates vertex Y, normals, and the vertex-color buffer.
   */
  private displace(geometry: THREE.PlaneGeometry): void {
    const positions = geometry.attributes.position;
    if (!positions) {
      throw new Error('PlaneGeometry built without position attribute');
    }
    const vertexCount = positions.count;
    for (let i = 0; i < vertexCount; i++) {
      const localX = positions.getX(i);
      const localZ = positions.getZ(i);
      const h = getHeightAt(localX + this.centerX, localZ + this.centerZ, this.noise);
      positions.setY(i, h);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();

    const normals = geometry.attributes.normal;
    if (!normals) {
      throw new Error('Vertex normals not computed');
    }

    let colorAttr = geometry.attributes.color;
    let colors: Float32Array;
    if (!colorAttr) {
      colors = new Float32Array(vertexCount * 3);
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    } else {
      colors = (colorAttr as THREE.BufferAttribute).array as Float32Array;
    }
    const tmp = new THREE.Color();
    for (let i = 0; i < vertexCount; i++) {
      const h = positions.getY(i);
      const ny = normals.getY(i);
      const slope = 1 - ny;
      biomeColor(h, slope, tmp);
      const o = i * 3;
      colors[o] = tmp.r;
      colors[o + 1] = tmp.g;
      colors[o + 2] = tmp.b;
    }
    if (colorAttr) {
      (colorAttr as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
