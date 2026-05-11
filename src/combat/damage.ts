// Damage application + respawn (combat-spec §4).
//
// All functions, no class. Deterministic — no Math.random(). Prox-fuse
// zone distribution uses `floor(missile.tSpawn * 1000) mod 3`.

import * as THREE from 'three';
import type { AircraftState, AircraftHp } from '../physics/state.js';
import { COMBAT_TUNING } from './tuning.js';
import type { DamageZone } from './aabb.js';

const T = COMBAT_TUNING;

/** Range-falloff multiplier per spec §3.1. */
export function bulletRangeFalloff(rangeMeters: number): number {
  const raw = 1 - rangeMeters / T.bulletFalloffRange;
  if (raw < T.bulletFalloffFloor) return T.bulletFalloffFloor;
  if (raw > 1) return 1;
  return raw;
}

/** Per-zone HP loss for one bullet hit, *before* range falloff. */
export function bulletDamageRaw(zone: DamageZone): {
  airframe: number;
  engine: number;
  control: number;
  controlAxis: DamageZone | null;
} {
  if (zone === 'engine') {
    return { airframe: 0, engine: T.bulletDamageEngine, control: 0, controlAxis: null };
  }
  if (zone === 'rudder' || zone === 'elevator' || zone === 'aileron') {
    return {
      airframe: 2,
      engine: 0,
      control: T.bulletDamageControl,
      controlAxis: zone,
    };
  }
  return {
    airframe: T.bulletDamageAtMuzzle,
    engine: 0,
    control: 0,
    controlAxis: null,
  };
}

/** Apply a bullet hit to target HP. Mutates state in place. */
export function applyBulletHit(
  state: AircraftState,
  zone: DamageZone,
  rangeMeters: number,
): void {
  if (!state.hp || state.isAlive === false) return;
  const raw = bulletDamageRaw(zone);
  const scale = bulletRangeFalloff(rangeMeters);
  state.hp.airframe = Math.max(0, state.hp.airframe - raw.airframe * scale);
  state.hp.engine = Math.max(0, state.hp.engine - raw.engine * scale);
  if (raw.control > 0 && raw.controlAxis) {
    const c = state.hp.controls;
    const dmg = raw.control * scale;
    if (raw.controlAxis === 'aileron') c.aileron = Math.max(0, c.aileron - dmg);
    else if (raw.controlAxis === 'elevator') {
      c.elevator = Math.max(0, c.elevator - dmg);
    } else if (raw.controlAxis === 'rudder') {
      c.rudder = Math.max(0, c.rudder - dmg);
    }
  }
  finalizeAlive(state);
}

/** Direct missile / SAM hit (spec §4.1). */
export function applyMissileDirect(state: AircraftState): void {
  if (!state.hp || state.isAlive === false) return;
  state.hp.airframe = Math.max(0, state.hp.airframe - T.missileDirectHpLoss);
  state.hp.engine = Math.max(0, state.hp.engine - 60);
  state.hp.controls.aileron = Math.max(0, state.hp.controls.aileron - 30);
  state.hp.controls.elevator = Math.max(0, state.hp.controls.elevator - 30);
  state.hp.controls.rudder = Math.max(0, state.hp.controls.rudder - 30);
  finalizeAlive(state);
}

/**
 * Apply a proximity-fuse missile hit. Total damage `X = directHpLoss *
 * clamp(1 - dist/proxRadius, 0, 1)^2`. Distributed 0.7 airframe / 0.2
 * engine / 0.1 controls, with the control axis chosen deterministically
 * from `floor(tSpawn * 1000) mod 3`.
 */
export function applyMissileProx(
  state: AircraftState,
  distMeters: number,
  missileTSpawn: number,
): void {
  if (!state.hp || state.isAlive === false) return;
  const falloff = clamp01(1 - distMeters / T.missileProxRadius);
  const X = T.missileDirectHpLoss * falloff * falloff;
  state.hp.airframe = Math.max(0, state.hp.airframe - 0.7 * X);
  state.hp.engine = Math.max(0, state.hp.engine - 0.2 * X);
  const ctrlDmg = 0.1 * X;
  // Deterministic zone selection — no Math.random.
  const idx = Math.abs(Math.floor(missileTSpawn * 1000)) % 3;
  const c = state.hp.controls;
  if (idx === 0) c.aileron = Math.max(0, c.aileron - ctrlDmg);
  else if (idx === 1) c.elevator = Math.max(0, c.elevator - ctrlDmg);
  else c.rudder = Math.max(0, c.rudder - ctrlDmg);
  finalizeAlive(state);
}

/** Latch isAlive / respawnAt when airframe HP hits zero (spec §4.2). */
function finalizeAlive(state: AircraftState): void {
  if (!state.hp) return;
  if (state.hp.airframe <= 0 && state.isAlive !== false) {
    state.isAlive = false;
    state.respawnAt = state.time + T.respawnDelay;
  }
}

/** Reset HP and life flags. Caller sets `x_W` / `q` if respawning. */
export function respawn(
  state: AircraftState,
  x_W?: THREE.Vector3,
  q?: THREE.Quaternion,
): void {
  const hp: AircraftHp = state.hp ?? {
    airframe: T.airframeHpMax,
    engine: T.engineHpMax,
    controls: { aileron: 0, elevator: 0, rudder: 0 },
  };
  hp.airframe = T.airframeHpMax;
  hp.engine = T.engineHpMax;
  hp.controls.aileron = T.controlHpMax;
  hp.controls.elevator = T.controlHpMax;
  hp.controls.rudder = T.controlHpMax;
  state.hp = hp;
  state.isAlive = true;
  state.respawnAt = null;
  if (x_W) state.x_W.copy(x_W);
  if (q) state.q.copy(q);
  state.v_W.set(0, 0, 0);
  state.omega_B.set(0, 0, 0);
  state.throttle = 0;
}

/** Per-frame respawn check: when state.time crosses respawnAt, reset. */
export function checkRespawn(state: AircraftState): boolean {
  if (
    state.isAlive === false &&
    state.respawnAt !== null &&
    state.respawnAt !== undefined &&
    state.time >= state.respawnAt
  ) {
    respawn(state);
    return true;
  }
  return false;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
