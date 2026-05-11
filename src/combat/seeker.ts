// IR / radar missile seeker logic (combat-spec §5).
//
// Operates on the SoA missile pool: given a missile index and a target
// pose/throttle table, mutates `v_W` and `lockedTargetId` /
// `lostLockSince` per the spec.

import * as THREE from 'three';
import { COMBAT_TUNING } from './tuning.js';

const T = COMBAT_TUNING;

export interface SeekerTarget {
  /** Stable id (peer-id, ai-id, or 'player'). */
  id: string;
  x_W: THREE.Vector3;
  v_W: THREE.Vector3;
  /** Engine throttle 0..1. Cold targets (< SEEKER_HOT_THROTTLE) drop IR lock. */
  throttle: number;
  isAlive: boolean;
}

/**
 * Per-missile fields the seeker reads/writes. Wrap your SoA pool with
 * tiny accessors that match this shape.
 */
export interface SeekerMissileView {
  kind: 'ir' | 'radar';
  lockedTargetId: string | null;
  lostLockSince: number;
  /** Position in world frame. Read-only for the seeker. */
  x_W: THREE.Vector3;
  /** Velocity in world frame. The seeker rotates this in place. */
  v_W: THREE.Vector3;
  /** Body-axis +X in world frame. Used as `fwd`. Caller refreshes per tick. */
  fwd_W: THREE.Vector3;
}

const _los = new THREE.Vector3();
const _losDir = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * One seeker step. Returns true if the lock changed during this step
 * (transition to/from null) — useful for HUD audio cue.
 */
export function seekerStep(
  missile: SeekerMissileView,
  targets: Map<string, SeekerTarget>,
  dt: number,
): boolean {
  const initialLock = missile.lockedTargetId;
  if (missile.lockedTargetId === null) return false;

  const target = targets.get(missile.lockedTargetId);
  if (!target || target.isAlive === false) {
    missile.lockedTargetId = null;
    return initialLock !== null;
  }

  _los.subVectors(target.x_W, missile.x_W);
  const range = _los.length();
  if (range < 1e-4) return initialLock !== missile.lockedTargetId;
  _losDir.copy(_los).divideScalar(range);
  const fwd = missile.fwd_W;
  const cosAng = clamp(fwd.dot(_losDir), -1, 1);
  const ang = Math.acos(cosAng);

  // FoV check.
  if (ang > T.missileSeekerHalfFov) {
    missile.lostLockSince += dt;
    if (missile.lostLockSince > T.missileLockDropTime) {
      missile.lockedTargetId = null;
    }
    return initialLock !== missile.lockedTargetId;
  }
  missile.lostLockSince = 0;

  // IR cold-target check.
  if (missile.kind === 'ir' && target.throttle < T.missileSeekerHotThrottle) {
    missile.lostLockSince += dt;
    if (missile.lostLockSince > T.missileLockDropTime) {
      missile.lockedTargetId = null;
    }
    return initialLock !== missile.lockedTargetId;
  }

  // Steering: rotate v_W toward LoS, capped at MAX_TURN_RATE.
  _cross.copy(fwd).cross(_losDir);
  const axisLen = _cross.length();
  if (axisLen < 1e-4) {
    return initialLock !== missile.lockedTargetId;
  }
  _axis.copy(_cross).divideScalar(axisLen);
  const turnRate = Math.min(ang / dt, T.missileMaxTurnRate);
  const angleStep = turnRate * dt;
  _q.setFromAxisAngle(_axis, angleStep);
  missile.v_W.applyQuaternion(_q);

  return initialLock !== missile.lockedTargetId;
}

/**
 * Scan a target set for a new IR lock: closest target inside both the
 * geometric cone (SEEKER_HALF_FOV around missile/aircraft +X_W) and the
 * SEEKER_LOCK_RANGE; warm-throttle gating included for IR.
 */
export function acquireLock(
  shooterPos: THREE.Vector3,
  shooterFwd_W: THREE.Vector3,
  targets: Map<string, SeekerTarget>,
  kind: 'ir' | 'radar' = 'ir',
  selfId: string | null = null,
): string | null {
  let bestId: string | null = null;
  let bestRange = Infinity;
  for (const [id, t] of targets) {
    if (id === selfId) continue;
    if (!t.isAlive) continue;
    _los.subVectors(t.x_W, shooterPos);
    const range = _los.length();
    if (range > T.missileLockRange) continue;
    if (range < 1e-4) continue;
    _losDir.copy(_los).divideScalar(range);
    const cosAng = clamp(shooterFwd_W.dot(_losDir), -1, 1);
    if (Math.acos(cosAng) > T.missileSeekerHalfFov) continue;
    if (kind === 'ir' && t.throttle < T.missileSeekerHotThrottle) continue;
    if (range < bestRange) {
      bestRange = range;
      bestId = id;
    }
  }
  return bestId;
}

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
