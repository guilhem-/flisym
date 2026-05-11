// Percepts module — see docs/ai-spec.md §2.1.
//
// The AI pilot consumes a `Percepts` snapshot every tick. `observe()` is a
// pure function that fills a pre-allocated scratch object (or one supplied by
// the caller) so the steady-state allocation count is zero.
//
// Sign convention reminder (Appendix B of ai-spec.md):
//   selfHdg increases when nose turns right (world +X east, +Z south)
//   heading is derived from YZX Euler.y with a sign flip.

import * as THREE from 'three';
import type { AircraftState } from '../physics/state.js';

/**
 * Incoming-threat descriptor. Currently only missiles surface as threats —
 * combat-coder owns the projectile pool; the host fills this in when an
 * inbound is detected (see ai-spec.md §2.1).
 */
export interface IncomingMissile {
  range: number;
  ttiSec: number;
  /** Bearing in radians (sign: positive ⇒ missile from the right). */
  bearingRad: number;
}

/** Generic enemy view supplied by the host. */
export interface EnemyView {
  id: string;
  isAlive: boolean;
  isPlayer: boolean;
  hp: number;
  x_W: THREE.Vector3;
  v_W: THREE.Vector3;
}

/**
 * Percepts: zero-alloc snapshot of the AI's view of the world.
 * See ai-spec.md §2.1 for the canonical shape.
 */
export interface Percepts {
  selfHdgRad: number;
  selfPitchRad: number;
  selfRollRad: number;
  selfAlt: number;
  selfV: number;
  selfAlpha: number;
  selfBeta: number;
  selfHp: number;
  selfOnGround: boolean;
  selfStall: boolean;

  /** Body-axis rates (for inner-loop controllers). */
  selfP: number; // roll rate (omega_B.x)
  selfQ: number; // pitch rate (omega_B.z)
  selfR: number; // yaw rate (omega_B.y)

  /** Self world position (read-only — controllers may need bearing to spawn). */
  selfX: number;
  selfY: number;
  selfZ: number;

  primaryTargetId: string | null;
  targetRangeM: number;
  targetBearingRad: number;
  targetElevRad: number;
  targetClosingMs: number;
  targetAspectRad: number;
  /** Lead-aim point in world (set by targeting.leadSolve when target valid). */
  targetLeadX: number;
  targetLeadY: number;
  targetLeadZ: number;
  /** Target altitude — used for `altCmd = clamp(targetAlt + offset, …)`. */
  targetAltM: number;

  incomingMissileRange: number;
  incomingMissileTti: number;
  incomingMissileBearing: number;
  hasIncomingMissile: boolean;

  inFrontQuadrant: boolean;
  inGunCone: boolean;
  hasMissileLock: boolean;
  threatLevel: number;
  tickIndex: number;
}

/** Allocate a Percepts instance with neutral values. */
export function createPercepts(): Percepts {
  return {
    selfHdgRad: 0,
    selfPitchRad: 0,
    selfRollRad: 0,
    selfAlt: 0,
    selfV: 0,
    selfAlpha: 0,
    selfBeta: 0,
    selfHp: 1,
    selfOnGround: false,
    selfStall: false,
    selfP: 0,
    selfQ: 0,
    selfR: 0,
    selfX: 0,
    selfY: 0,
    selfZ: 0,
    primaryTargetId: null,
    targetRangeM: Infinity,
    targetBearingRad: 0,
    targetElevRad: 0,
    targetClosingMs: 0,
    targetAspectRad: 0,
    targetLeadX: 0,
    targetLeadY: 0,
    targetLeadZ: 0,
    targetAltM: 0,
    incomingMissileRange: 0,
    incomingMissileTti: 0,
    incomingMissileBearing: 0,
    hasIncomingMissile: false,
    inFrontQuadrant: false,
    inGunCone: false,
    hasMissileLock: false,
    threatLevel: 0,
    tickIndex: 0,
  };
}

// Reused scratch values — module-local, never escapes observe().
const _eulerScratch = new THREE.Euler(0, 0, 0, 'YZX');
const _bodyVelScratch = new THREE.Vector3();
const _invQScratch = new THREE.Quaternion();

/**
 * Wrap angle to [-π, π].
 */
export function wrapPi(rad: number): number {
  // Stable wrap that avoids modulus surprises for large negatives.
  let a = rad;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Heading from quaternion (radians). Positive = nose right per Appendix B.
 *   selfHdg = -Euler.y (YZX)
 */
export function headingFromQuat(q: THREE.Quaternion): number {
  _eulerScratch.setFromQuaternion(q, 'YZX');
  return -_eulerScratch.y;
}

/** Pitch from quaternion. Euler.z under YZX is pitch. */
export function pitchFromQuat(q: THREE.Quaternion): number {
  _eulerScratch.setFromQuaternion(q, 'YZX');
  return _eulerScratch.z;
}

/** Roll from quaternion. Euler.x under YZX is roll. */
export function rollFromQuat(q: THREE.Quaternion): number {
  _eulerScratch.setFromQuaternion(q, 'YZX');
  return _eulerScratch.x;
}

/**
 * Fill `out` with current percepts. Zero-alloc after first call.
 *
 * @param out         scratch Percepts to overwrite
 * @param self        own aircraft state
 * @param enemies     optional enemy list (host filters its own slot)
 * @param incoming    optional incoming-missile descriptor (or null)
 * @param tuning      AI_TUNING (for cones / aspect bookkeeping)
 * @param tickIndex   monotonic tick counter (caller increments)
 */
export interface ObserveTuning {
  detectRangeM: number;
  gunConeRad: number;
  lockConeRad: number;
}

export function observe(
  out: Percepts,
  self: AircraftState,
  enemies: readonly EnemyView[] | null,
  incoming: IncomingMissile | null,
  tuning: ObserveTuning,
  tickIndex: number,
): Percepts {
  // --- Self attitude (single Euler decomposition; reuse the scratch) ---
  _eulerScratch.setFromQuaternion(self.q, 'YZX');
  out.selfHdgRad = -_eulerScratch.y;
  out.selfPitchRad = _eulerScratch.z;
  out.selfRollRad = _eulerScratch.x;

  out.selfAlt = self.x_W.y;
  out.selfX = self.x_W.x;
  out.selfY = self.x_W.y;
  out.selfZ = self.x_W.z;

  const vx = self.v_W.x;
  const vy = self.v_W.y;
  const vz = self.v_W.z;
  out.selfV = Math.sqrt(vx * vx + vy * vy + vz * vz);

  // Body-frame velocity for α / β (forward = +X_B, right = +Z_B, up = +Y_B).
  _invQScratch.copy(self.q).invert();
  _bodyVelScratch.copy(self.v_W).applyQuaternion(_invQScratch);
  const u = _bodyVelScratch.x;
  const v = _bodyVelScratch.y; // body-up
  const w = _bodyVelScratch.z; // body-right
  // α = atan2(-v, u): if body-up velocity is downward (v<0), AoA positive.
  // Spec uses the convention "vertical body component, signed against lift".
  const speed2D = Math.sqrt(u * u + v * v);
  out.selfAlpha = speed2D < 1e-3 ? 0 : Math.atan2(-v, u);
  out.selfBeta = out.selfV < 1e-3 ? 0 : Math.asin(Math.max(-1, Math.min(1, w / out.selfV)));

  out.selfHp = self.hp ? Math.max(0, self.hp.airframe) / 100 : 1;
  out.selfOnGround = self.onGround;
  out.selfStall = self.stallFlag;

  out.selfP = self.omega_B.x;
  out.selfR = self.omega_B.y;
  out.selfQ = self.omega_B.z;

  // --- Target selection (host may have pre-sorted; we just pick top by score) ---
  out.primaryTargetId = null;
  out.targetRangeM = Infinity;
  out.targetBearingRad = 0;
  out.targetElevRad = 0;
  out.targetClosingMs = 0;
  out.targetAspectRad = 0;
  out.targetAltM = 0;
  out.targetLeadX = 0;
  out.targetLeadY = 0;
  out.targetLeadZ = 0;
  out.inFrontQuadrant = false;
  out.inGunCone = false;
  out.hasMissileLock = false;

  if (enemies && enemies.length > 0) {
    let bestScore = -Infinity;
    let bestIdx = -1;
    let bestRange = Infinity;
    let bestBearing = 0;
    let bestElev = 0;
    for (let i = 0; i < enemies.length; i += 1) {
      const e = enemies[i];
      if (!e || !e.isAlive || e.hp <= 0) continue;
      const dx = e.x_W.x - self.x_W.x;
      const dy = e.x_W.y - self.x_W.y;
      const dz = e.x_W.z - self.x_W.z;
      const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (range > tuning.detectRangeM) continue;
      // Bearing relative to own heading. World heading-vector lies in XZ.
      // Forward vec from heading: (cos h, 0, -sin h) using selfHdg = -Euler.y.
      const cosH = Math.cos(out.selfHdgRad);
      const sinH = Math.sin(out.selfHdgRad);
      const fx = cosH;
      const fz = -sinH;
      // Right vector (cross of up × fwd): (sin h, 0, cos h).
      const rx = sinH;
      const rz = cosH;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const forwardComp = dx * fx + dz * fz;
      const rightComp = dx * rx + dz * rz;
      const bearing = Math.atan2(rightComp, forwardComp);
      const elev = horizDist < 1e-3 ? 0 : Math.atan2(dy, horizDist);
      const inFront = forwardComp > 0;
      // Spec §5.1 scoring.
      const inFrontWeight = inFront ? 1.0 : 0.4;
      const rangeWeight = 1.0 / Math.max(range, 100);
      const playerWeight = e.isPlayer ? 1.2 : 1.0;
      const score = inFrontWeight * rangeWeight * playerWeight;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
        bestRange = range;
        bestBearing = bearing;
        bestElev = elev;
      }
    }
    if (bestIdx >= 0) {
      const e = enemies[bestIdx];
      if (!e) return out;
      out.primaryTargetId = e.id;
      out.targetRangeM = bestRange;
      out.targetBearingRad = bestBearing;
      out.targetElevRad = bestElev;
      out.targetAltM = e.x_W.y;
      // Closing speed: positive if range is decreasing.
      const dvx = e.v_W.x - self.v_W.x;
      const dvy = e.v_W.y - self.v_W.y;
      const dvz = e.v_W.z - self.v_W.z;
      const dxN = (e.x_W.x - self.x_W.x) / Math.max(bestRange, 1e-3);
      const dyN = (e.x_W.y - self.x_W.y) / Math.max(bestRange, 1e-3);
      const dzN = (e.x_W.z - self.x_W.z) / Math.max(bestRange, 1e-3);
      const rangeRate = dvx * dxN + dvy * dyN + dvz * dzN; // +ve means opening
      out.targetClosingMs = -rangeRate;
      // Aspect: target's nose-to-us angle (approx using target velocity dir).
      const tSpeed = Math.sqrt(
        e.v_W.x * e.v_W.x + e.v_W.y * e.v_W.y + e.v_W.z * e.v_W.z,
      );
      if (tSpeed > 1.0 && bestRange > 1e-3) {
        const tnx = e.v_W.x / tSpeed;
        const tny = e.v_W.y / tSpeed;
        const tnz = e.v_W.z / tSpeed;
        // Vector from target to us, normalized.
        const tdx = (self.x_W.x - e.x_W.x) / bestRange;
        const tdy = (self.x_W.y - e.x_W.y) / bestRange;
        const tdz = (self.x_W.z - e.x_W.z) / bestRange;
        const cosA = Math.max(-1, Math.min(1, tnx * tdx + tny * tdy + tnz * tdz));
        out.targetAspectRad = Math.acos(cosA);
      } else {
        out.targetAspectRad = 0;
      }
      // Initial lead point = current target position (targeting.leadSolve refines).
      out.targetLeadX = e.x_W.x;
      out.targetLeadY = e.x_W.y;
      out.targetLeadZ = e.x_W.z;
      out.inFrontQuadrant = Math.abs(bestBearing) < Math.PI / 2;
      out.inGunCone =
        out.inFrontQuadrant && Math.abs(bestBearing) < tuning.gunConeRad;
      out.hasMissileLock = Math.abs(bestBearing) < tuning.lockConeRad;
    }
  }

  // --- Incoming missile ---
  if (incoming) {
    out.hasIncomingMissile = true;
    out.incomingMissileRange = incoming.range;
    out.incomingMissileTti = incoming.ttiSec;
    out.incomingMissileBearing = incoming.bearingRad;
  } else {
    out.hasIncomingMissile = false;
    out.incomingMissileRange = 0;
    out.incomingMissileTti = 0;
    out.incomingMissileBearing = 0;
  }

  // Simple threat heuristic: missile in flight ⇒ near-1; nothing ⇒ 0.
  if (out.hasIncomingMissile) {
    // Closer / sooner → higher.
    const tti = Math.max(0.1, out.incomingMissileTti);
    out.threatLevel = Math.min(1, 6.0 / tti);
  } else if (out.primaryTargetId && out.targetRangeM < 1500) {
    out.threatLevel = 0.3;
  } else {
    out.threatLevel = 0;
  }

  out.tickIndex = tickIndex;
  return out;
}
