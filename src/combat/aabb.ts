// Swept segment vs body-OBB hit detection (combat-spec §3.1).
//
// Strategy: an OBB in world space is just an AABB in the target's body
// frame. We pull the segment endpoints into the target body frame via
// q^-1, then run the textbook slab-method AABB-segment intersection
// there. Returns:
//   - hit: boolean
//   - tHit: 0..1 normalised along the segment
//   - pBody: hit point in target body frame (for zone resolution)
//
// All math uses scratch vectors / quaternions — no per-call allocations
// on the steady-state path (the returned `pBody` is freshly allocated
// only on hit, since callers store it).

import * as THREE from 'three';
import { COMBAT_TUNING } from './tuning.js';

/** Aircraft hull half-extents in body frame (spec §3.1). */
export const HULL_HALF_EXTENTS_B = COMBAT_TUNING.hullHalfExtents;

export interface SweptHit {
  hit: boolean;
  tHit: number;
  pBody: THREE.Vector3;
}

const _invQ = new THREE.Quaternion();
const _relStart = new THREE.Vector3();
const _relEnd = new THREE.Vector3();
const _bodyStart = new THREE.Vector3();
const _bodyEnd = new THREE.Vector3();
const _bodyDir = new THREE.Vector3();

/**
 * Sweep a line segment (xStartWorld → xEndWorld) against the OBB at
 * (targetPos, targetQuat, HULL_HALF_EXTENTS_B). World→body transform is
 * `v_B = q^-1 · (v_W - target_W)`.
 *
 * @returns SweptHit. When `.hit` is true, `pBody` is the body-frame entry
 *          point usable for zone resolution. When false, `pBody` is the
 *          zero vector (do not read it).
 */
export function sweptSegmentVsOBB(
  xStartWorld: THREE.Vector3,
  xEndWorld: THREE.Vector3,
  targetPos: THREE.Vector3,
  targetQuat: THREE.Quaternion,
  half: { x: number; y: number; z: number } = HULL_HALF_EXTENTS_B,
): SweptHit {
  _invQ.copy(targetQuat).invert();
  _relStart.copy(xStartWorld).sub(targetPos);
  _relEnd.copy(xEndWorld).sub(targetPos);
  _bodyStart.copy(_relStart).applyQuaternion(_invQ);
  _bodyEnd.copy(_relEnd).applyQuaternion(_invQ);
  _bodyDir.copy(_bodyEnd).sub(_bodyStart);

  // Slab-method intersection of segment [p, p+d] with AABB [-half, +half].
  // Compute the entry / exit t along the segment per axis, and the segment
  // hits iff the entry < exit and clamped to [0, 1].
  let tEnter = 0;
  let tExit = 1;

  const axes: ['x' | 'y' | 'z', number][] = [
    ['x', half.x],
    ['y', half.y],
    ['z', half.z],
  ];

  for (const [axis, h] of axes) {
    const p = _bodyStart[axis];
    const d = _bodyDir[axis];
    if (Math.abs(d) < 1e-9) {
      // Segment parallel to slab. Miss iff origin outside slab.
      if (p < -h || p > h) {
        return { hit: false, tHit: 0, pBody: new THREE.Vector3() };
      }
      continue;
    }
    let t1 = (-h - p) / d;
    let t2 = (+h - p) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tEnter) tEnter = t1;
    if (t2 < tExit) tExit = t2;
    if (tEnter > tExit) {
      return { hit: false, tHit: 0, pBody: new THREE.Vector3() };
    }
  }
  if (tEnter < 0 || tEnter > 1) {
    // Entry is outside the [0,1] segment range.
    return { hit: false, tHit: 0, pBody: new THREE.Vector3() };
  }

  const pBody = new THREE.Vector3(
    _bodyStart.x + _bodyDir.x * tEnter,
    _bodyStart.y + _bodyDir.y * tEnter,
    _bodyStart.z + _bodyDir.z * tEnter,
  );
  return { hit: true, tHit: tEnter, pBody };
}

/**
 * Resolve a body-frame hit point to a damage zone (spec §3.1 table).
 * First-match wins: engine > rudder > elevator > aileron > airframe.
 */
export type DamageZone =
  | 'engine'
  | 'rudder'
  | 'elevator'
  | 'aileron'
  | 'airframe';

export function resolveZone(pBody: THREE.Vector3): DamageZone {
  if (pBody.x > 2.5) return 'engine';
  if (pBody.x < -2.5 && pBody.y > 1.0) return 'rudder';
  if (pBody.x < -2.5 && Math.abs(pBody.z) > 1.0 && pBody.y < 1.0) {
    return 'elevator';
  }
  if (Math.abs(pBody.z) > 3.0) return 'aileron';
  return 'airframe';
}
