// Targeting and lead-aim solver. See docs/ai-spec.md §5.1.
//
// `leadSolve()` computes the world-space lead-aim point. The pure
// `targetScore()` function gives the score from §5.1 used to pick a primary
// target. Both are allocation-free for the steady-state path.

import type * as THREE from 'three';

/**
 * Score a candidate target. Higher is better.
 *   inFrontWeight  = inFrontQuadrant ? 1.0 : 0.4
 *   rangeWeight    = 1 / max(distance, 100)
 *   playerWeight   = isPlayer ? 1.2 : 1.0
 */
export function targetScore(
  range: number,
  inFrontQuadrant: boolean,
  isPlayer: boolean,
): number {
  const inFrontW = inFrontQuadrant ? 1.0 : 0.4;
  const rangeW = 1.0 / Math.max(range, 100);
  const playerW = isPlayer ? 1.2 : 1.0;
  return inFrontW * rangeW * playerW;
}

/**
 * Solve for a lead-aim point assuming constant target velocity.
 *
 *   t_lead = max(0, range / max(bulletV - closingMs, 1))
 *   leadPoint = target.x + target.v * t_lead
 *
 * The caller passes a scratch THREE.Vector3 for the result; we overwrite and
 * return it.
 */
export function leadSolve(
  out: THREE.Vector3,
  selfPos: THREE.Vector3,
  targetPos: THREE.Vector3,
  targetVel: THREE.Vector3,
  bulletV: number,
  closingMs: number,
): THREE.Vector3 {
  const dx = targetPos.x - selfPos.x;
  const dy = targetPos.y - selfPos.y;
  const dz = targetPos.z - selfPos.z;
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const effV = Math.max(bulletV - closingMs, 1);
  const tLead = range / effV;
  out.set(
    targetPos.x + targetVel.x * tLead,
    targetPos.y + targetVel.y * tLead,
    targetPos.z + targetVel.z * tLead,
  );
  return out;
}

/**
 * Compute heading bearing from selfPos toward a world-space target point.
 * Returns radians; sign convention matches percepts.selfHdgRad
 * (positive = nose right).
 *
 * `currentHdgRad` is only used so the caller can compute the *delta* if
 * needed; this function returns absolute heading toward the point.
 */
export function bearingToPoint(
  selfX: number,
  selfZ: number,
  pointX: number,
  pointZ: number,
): number {
  const dx = pointX - selfX;
  const dz = pointZ - selfZ;
  // Heading where forward = (cos h, -sin h) in world XZ means
  //   tan(h) = -dz / dx
  return Math.atan2(-dz, dx);
}
