// Weapon firing: gun / missile / bomb. RoF gating + magazine bookkeeping.
//
// Reads aircraft pose (state.x_W, state.v_W, state.q) and emits projectile
// spawns into the supplied pools. Body-frame muzzle / rail / hardpoint
// offsets are transformed into world frame via the shooter's quaternion.

import * as THREE from 'three';
import { COMBAT_TUNING } from './tuning.js';
import { FLIGHT_MODEL } from '../physics/flightModel.js';
import type { AircraftState } from '../physics/state.js';
import {
  BulletPool,
  MissilePool,
  BombPool,
  type BulletSpawn,
  type MissileSpawn,
  type BombSpawn,
} from './projectiles.js';

const T = COMBAT_TUNING;

const _scratch = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _muzzleVel = new THREE.Vector3();

const wingHalfSpan = FLIGHT_MODEL.span * 0.5;

/** Body-frame hardpoint positions per spec §2.1 / §2.2 / §2.3. */
export const HARDPOINTS = {
  bulletL: new THREE.Vector3(1.40, 1.05, -2.10),
  bulletR: new THREE.Vector3(1.40, 1.05, +2.10),
  railL: new THREE.Vector3(0.20, 1.05, -wingHalfSpan),
  railR: new THREE.Vector3(0.20, 1.05, +wingHalfSpan),
  bomb: new THREE.Vector3(0.0, -0.7, 0.0),
} as const;

/**
 * Per-aircraft weapon state. Caller stores one of these per shooter.
 * `gunRoundsL`, `gunRoundsR` mag counters. `missileRailsRemaining` and
 * `bombsRemaining` deplete on each shot. `lastShotT` enforces RoF.
 */
export interface WeaponState {
  shooterId: string;
  gunRoundsL: number;
  gunRoundsR: number;
  /** When `t < nextGunFireAt`, the gun is on cool-down. */
  nextGunFireAt: number;
  missileRailsRemaining: number;
  bombsRemaining: number;
  /** Index of next missile rail: 0 -> L, 1 -> R, then wrap. */
  nextMissileRail: 0 | 1;
}

export function createWeaponState(shooterId: string): WeaponState {
  return {
    shooterId,
    gunRoundsL: T.bulletMagPerGun,
    gunRoundsR: T.bulletMagPerGun,
    nextGunFireAt: 0,
    missileRailsRemaining: T.missileRailsPerAircraft,
    bombsRemaining: T.bombPerAircraft,
    nextMissileRail: 0,
  };
}

/**
 * Attempt to fire one gun pulse (one shot per gun in the pair). Returns
 * the number of bullets actually spawned (0, 1, or 2).
 */
export function fireGun(
  weapons: WeaponState,
  state: AircraftState,
  pool: BulletPool,
  t: number,
): number {
  if (t < weapons.nextGunFireAt) return 0;
  if (weapons.gunRoundsL <= 0 && weapons.gunRoundsR <= 0) return 0;

  const fireIntervalPerGun = 60 / T.bulletRoFPerGun;
  let spawned = 0;

  // Compute muzzle velocity in world frame once (same for both guns).
  _muzzleVel.set(T.bulletMuzzleVel, 0, 0).applyQuaternion(state.q);
  _vel.copy(state.v_W).add(_muzzleVel);

  if (weapons.gunRoundsL > 0) {
    _scratch.copy(HARDPOINTS.bulletL).applyQuaternion(state.q).add(state.x_W);
    const sp: BulletSpawn = {
      x: _scratch.clone(),
      v: _vel.clone(),
      shooterId: weapons.shooterId,
      t,
    };
    if (pool.spawn(sp) >= 0) {
      weapons.gunRoundsL -= 1;
      spawned += 1;
    }
  }
  if (weapons.gunRoundsR > 0) {
    _scratch.copy(HARDPOINTS.bulletR).applyQuaternion(state.q).add(state.x_W);
    const sp: BulletSpawn = {
      x: _scratch.clone(),
      v: _vel.clone(),
      shooterId: weapons.shooterId,
      t,
    };
    if (pool.spawn(sp) >= 0) {
      weapons.gunRoundsR -= 1;
      spawned += 1;
    }
  }

  weapons.nextGunFireAt = t + fireIntervalPerGun;
  return spawned;
}

/**
 * Attempt to launch one missile. Returns the slot index on success or -1
 * if no rails available / pool full.
 */
export function fireMissile(
  weapons: WeaponState,
  state: AircraftState,
  pool: MissilePool,
  t: number,
  lockedTargetId: string | null,
  kind: 'ir' | 'radar' = 'ir',
): number {
  if (weapons.missileRailsRemaining <= 0) return -1;

  const rail = weapons.nextMissileRail === 0 ? HARDPOINTS.railL : HARDPOINTS.railR;
  _scratch.copy(rail).applyQuaternion(state.q).add(state.x_W);
  _muzzleVel.set(T.missileLaunchVel, 0, 0).applyQuaternion(state.q);
  _vel.copy(state.v_W).add(_muzzleVel);
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(state.q);

  const sp: MissileSpawn = {
    x: _scratch.clone(),
    v: _vel.clone(),
    fwd_W: fwd,
    shooterId: weapons.shooterId,
    kind,
    lockedTargetId,
    t,
  };
  const idx = pool.spawn(sp);
  if (idx < 0) return -1;
  weapons.missileRailsRemaining -= 1;
  weapons.nextMissileRail = weapons.nextMissileRail === 0 ? 1 : 0;
  return idx;
}

/** Drop one bomb. */
export function dropBomb(
  weapons: WeaponState,
  state: AircraftState,
  pool: BombPool,
  t: number,
): number {
  if (weapons.bombsRemaining <= 0) return -1;
  _scratch.copy(HARDPOINTS.bomb).applyQuaternion(state.q).add(state.x_W);
  // Bombs inherit aircraft velocity exactly (no muzzle vel).
  const sp: BombSpawn = {
    x: _scratch.clone(),
    v: state.v_W.clone(),
    shooterId: weapons.shooterId,
    t,
  };
  const idx = pool.spawn(sp);
  if (idx < 0) return -1;
  weapons.bombsRemaining -= 1;
  return idx;
}
