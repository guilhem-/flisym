/**
 * Wind layer — light horizontal wind that grows with altitude and rotates
 * slowly with time.
 *
 * - Magnitude: 0 m/s at ground, 6 m/s at 1500 m AGL (linear, clamped above).
 * - Direction: base ~210° (SW wind, blowing toward NE), rotates a full turn
 *   every ~10 minutes (period 600 s).
 * - Adds a small low-amplitude noise wobble for liveliness.
 *
 * Returns a fresh `THREE.Vector3` each call (Y component always 0).
 */

import * as THREE from 'three';

const ALT_REF_M = 1500;
const WIND_AT_REF_MS = 6;
const BASE_DIR_DEG = 210;
const ROTATION_PERIOD_S = 600;
const NOISE_AMPLITUDE_MS = 0.4;

/**
 * Compute the inertial-frame wind vector at the given altitude and time.
 *
 * @param altitude Aircraft altitude in meters (world Y).
 * @param time     Wall-clock or sim-time seconds (monotonically increasing).
 */
export function getWind(altitude: number, time: number): THREE.Vector3 {
  // Magnitude scales linearly with altitude up to 1500 m, clamped above.
  const altFrac = Math.max(0, Math.min(1, altitude / ALT_REF_M));
  const speed = altFrac * WIND_AT_REF_MS;

  // Direction: base angle + slow rotation with time.
  const rotPhase = (time / ROTATION_PERIOD_S) * Math.PI * 2;
  const baseRad = (BASE_DIR_DEG * Math.PI) / 180;
  const angle = baseRad + rotPhase;

  // World convention (per docs/world-spec.md §1): +X east, +Z south.
  // Heading 210° is measured clockwise from east, so a wind "from 210°"
  // blowing toward 30° has direction vector (cos 30°, 0, -sin 30°). Here we
  // treat `angle` as the direction the wind is blowing toward.
  let vx = Math.cos(angle) * speed;
  let vz = Math.sin(angle) * speed;

  // Small horizontal noise wobble (deterministic, two slow sines).
  const nx = Math.sin(time * 0.13 + 1.7) * NOISE_AMPLITUDE_MS;
  const nz = Math.sin(time * 0.17 + 4.3) * NOISE_AMPLITUDE_MS;
  vx += nx;
  vz += nz;

  return new THREE.Vector3(vx, 0, vz);
}
