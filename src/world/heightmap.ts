/**
 * Pure heightmap functions. Same code path is used by:
 *  - terrain mesh build (per-vertex displacement)
 *  - physics ground query (`getGroundHeight`)
 *
 * The runway flatten/smoothstep mask is applied here, so the mesh and the
 * physics agree about where the runway is.
 *
 * See `/docs/world-spec.md` §3 and §6.
 */

import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { WORLD_CONFIG } from './config.js';

/**
 * Deterministic mulberry32 PRNG seeded from a 32-bit integer.
 * Returns a function compatible with `Math.random()` (output in [0,1)).
 */
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
 * Factory for the noise function used by the world. Re-instantiable in tests.
 * Default seed is `WORLD_CONFIG.noise.seed`.
 */
export function createNoise(seed: number = WORLD_CONFIG.noise.seed): NoiseFunction2D {
  return createNoise2D(mulberry32(seed));
}

// Module-level default noise (lazy: created on first call so tests can swap seed).
let defaultNoise: NoiseFunction2D | null = null;
function getDefaultNoise(): NoiseFunction2D {
  if (defaultNoise === null) {
    defaultNoise = createNoise();
  }
  return defaultNoise;
}

/**
 * Standard smoothstep — 0 at e0, 1 at e1, smooth Hermite in between.
 */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Runway flatten mask.
 *  - Returns 1 inside the inner flatten rectangle (force h = 0).
 *  - Returns 0 outside the outer blend rectangle (use natural noise).
 *  - Smoothstep blend in the margin.
 *
 * The mask is the product of independent X and Z falloffs, so the rectangle
 * has rounded but axis-aligned edges (good enough — no diagonal seams).
 */
export function runwayFlattenMask(x: number, z: number): number {
  const r = WORLD_CONFIG.runway;
  const innerHalfX = r.flattenLength / 2;
  const innerHalfZ = r.flattenWidth / 2;
  const outerHalfX = r.blendLength / 2;
  const outerHalfZ = r.blendWidth / 2;

  const ax = Math.abs(x);
  const az = Math.abs(z);

  // 1 inside inner, 0 outside outer, smoothstep in the margin.
  const fx = 1 - smoothstep(innerHalfX, outerHalfX, ax);
  const fz = 1 - smoothstep(innerHalfZ, outerHalfZ, az);
  return fx * fz;
}

/**
 * Raw layered simplex noise without runway treatment.
 */
function rawHeight(x: number, z: number, noise: NoiseFunction2D): number {
  let h = WORLD_CONFIG.noise.seaLevel;
  for (const o of WORLD_CONFIG.noise.octaves) {
    h += o.amplitude * noise(x / o.frequency, z / o.frequency);
  }
  return h;
}

/**
 * Final ground height at world (x, z). Includes runway flatten + min-clamp.
 *
 * @param x world X (meters)
 * @param z world Z (meters)
 * @param noise optional injected noise (defaults to module singleton)
 */
export function getHeightAt(x: number, z: number, noise?: NoiseFunction2D): number {
  const n = noise ?? getDefaultNoise();
  const natural = rawHeight(x, z, n);
  const mask = runwayFlattenMask(x, z);
  // mask=1 → 0; mask=0 → natural; lerp.
  const blended = natural * (1 - mask);
  return Math.max(WORLD_CONFIG.noise.minHeight, blended);
}
