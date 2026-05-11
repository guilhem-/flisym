/**
 * collision.ts — minimal axis-aligned bounding-box helpers used by the
 * world subsystem (ground-targets in particular).
 *
 * No physics dependency: pure math over plain tuples + Vector3. Bombs and
 * other projectiles query these helpers from the combat layer in Wave C.
 *
 * AABB convention: a box is defined by its world-frame `center` and
 * positive `halfExtents` (Δx, Δy, Δz). The box covers
 * `[center - halfExtents, center + halfExtents]` in each axis. Ground
 * targets do not rotate in v0.2 so AABB is sufficient.
 */

import type * as THREE from 'three';

export type Vec3Tuple = readonly [number, number, number];

/**
 * Returns true if `p` is strictly inside (or on the boundary of) the AABB
 * defined by `center` and `halfExtents`.
 *
 * Generic over Vector-like inputs (THREE.Vector3 or any `{x,y,z}` shape)
 * for both `p` and `center`; tuple-typed for `halfExtents` so a target's
 * collider can be passed straight from `GroundTargetInstance.collider`.
 */
export function pointInsideAABB(
  p: THREE.Vector3 | { x: number; y: number; z: number },
  center: THREE.Vector3 | { x: number; y: number; z: number } | Vec3Tuple,
  halfExtents: Vec3Tuple,
): boolean {
  const cx = Array.isArray(center) ? (center as Vec3Tuple)[0] : (center as { x: number }).x;
  const cy = Array.isArray(center) ? (center as Vec3Tuple)[1] : (center as { y: number }).y;
  const cz = Array.isArray(center) ? (center as Vec3Tuple)[2] : (center as { z: number }).z;
  const hx = halfExtents[0];
  const hy = halfExtents[1];
  const hz = halfExtents[2];
  return (
    Math.abs(p.x - cx) <= hx &&
    Math.abs(p.y - cy) <= hy &&
    Math.abs(p.z - cz) <= hz
  );
}
