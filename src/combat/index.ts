// CombatSystem — public API for v0.2 combat (docs/combat-spec.md §10).
//
// Composes the four pools, runs per-frame integration + hit detection +
// damage, and exposes a `snapshot()` of HUD-relevant state for Wave C's
// `hud-combat` agent.
//
// IMPORTANT: this module does NOT wire into main.ts; it just provides the
// API. Wave C `hud-combat` adds the rendering hookup; Wave C `mp-combat`
// wires the WS event listeners.

import * as THREE from 'three';
import type { AircraftState } from '../physics/state.js';
import {
  BulletPool,
  MissilePool,
  BombPool,
  type ProjectileWorld,
} from './projectiles.js';
import { ExplosionPool } from './explosion.js';
import {
  sweptSegmentVsOBB,
  resolveZone,
  HULL_HALF_EXTENTS_B,
  type DamageZone,
} from './aabb.js';
import {
  applyBulletHit,
  applyMissileDirect,
  applyMissileProx,
  checkRespawn,
} from './damage.js';
import { seekerStep, type SeekerMissileView, type SeekerTarget } from './seeker.js';
import { COMBAT_TUNING } from './tuning.js';
import {
  createWeaponState,
  type WeaponState,
} from './weapons.js';

const T = COMBAT_TUNING;

/** A combat participant: an aircraft tracked by CombatSystem for hit-tests. */
export interface CombatParticipant {
  id: string;
  state: AircraftState;
  /** Team id; missiles ignore same-team targets per spec §3.2. */
  team?: string;
  /** Weapon state lazily created if absent. */
  weapons?: WeaponState;
}

export interface CombatHitEvent {
  shooterId: string;
  targetId: string;
  weapon: 'gun' | 'missile' | 'bomb' | 'sam';
  zone: DamageZone;
  hpLoss: number;
  t: number;
}

export interface CombatKillEvent {
  shooterId: string;
  victimId: string;
  weapon: 'gun' | 'missile' | 'bomb' | 'sam';
  t: number;
}

export interface CombatSnapshot {
  /** Participants snapshot (HUD reads HP from here). */
  participants: ReadonlyArray<{
    id: string;
    isAlive: boolean;
    hp: { airframe: number; engine: number; aileron: number; elevator: number; rudder: number };
    gunRoundsL: number;
    gunRoundsR: number;
    missileRailsRemaining: number;
    bombsRemaining: number;
  }>;
  /** Hit events since last snapshot. Caller-cleared via getEvents(). */
  recentHits: ReadonlyArray<CombatHitEvent>;
  recentKills: ReadonlyArray<CombatKillEvent>;
  activeBullets: number;
  activeMissiles: number;
  activeBombs: number;
}

const _prevPos = new THREE.Vector3();
const _currPos = new THREE.Vector3();
const _v1 = new THREE.Vector3();

/**
 * CombatSystem assumes one player + N AI / peer participants. The owner is
 * responsible for registering and unregistering participants as join/leave
 * occurs. Pools / instanced meshes live under `getRoot()` for the
 * graphics-budget test.
 */
export class CombatSystem {
  readonly bullets: BulletPool;
  readonly missiles: MissilePool;
  readonly bombs: BombPool;
  readonly explosions: ExplosionPool;

  private readonly root = new THREE.Group();
  private readonly participants = new Map<string, CombatParticipant>();
  /** Pre-step bullet positions for swept hit-tests; reused each tick. */
  private readonly bulletPrev: Float32Array;
  private readonly hitEvents: CombatHitEvent[] = [];
  private readonly killEvents: CombatKillEvent[] = [];

  /** Pseudo-world. CombatSystem only needs ground sampling. */
  private world: ProjectileWorld = {
    getGroundHeight: () => 0,
  };

  /** Optional player position for cull-radius checks. */
  playerPos: THREE.Vector3 | null = null;

  constructor() {
    this.bullets = new BulletPool();
    this.missiles = new MissilePool();
    this.bombs = new BombPool();
    this.explosions = new ExplosionPool();
    this.bulletPrev = new Float32Array(this.bullets.capacity * 3);

    this.root.name = 'CombatSystem';
    this.root.add(this.bullets.group);
    this.root.add(this.missiles.group);
    this.root.add(this.bombs.group);
    this.root.add(this.explosions.group);
  }

  getRoot(): THREE.Group {
    return this.root;
  }

  setWorld(w: ProjectileWorld): void {
    this.world = w;
  }

  register(p: CombatParticipant): void {
    if (!p.weapons) {
      p.weapons = createWeaponState(p.id);
    }
    this.participants.set(p.id, p);
  }

  unregister(id: string): void {
    this.participants.delete(id);
  }

  getParticipant(id: string): CombatParticipant | undefined {
    return this.participants.get(id);
  }

  /**
   * Per-frame tick. Order:
   *   1. respawn checks
   *   2. seeker per active missile
   *   3. integrate bullets / missiles / bombs / explosions
   *   4. bullet hit detection (swept vs OBB), apply damage
   *   5. missile prox-fuse + direct hit, apply damage
   *   6. bomb impact -> explosions only (ground-target damage in world ext.)
   */
  update(dt: number): void {
    // 1) Respawn checks (advance time-driven respawns first).
    for (const p of this.participants.values()) {
      if (checkRespawn(p.state)) {
        // Reset weapon mags too.
        if (p.weapons) {
          p.weapons.gunRoundsL = T.bulletMagPerGun;
          p.weapons.gunRoundsR = T.bulletMagPerGun;
          p.weapons.missileRailsRemaining = T.missileRailsPerAircraft;
          p.weapons.bombsRemaining = T.bombPerAircraft;
        }
      }
    }

    // 2) Build seeker target view + run seekers.
    const seekerTargets = new Map<string, SeekerTarget>();
    for (const p of this.participants.values()) {
      seekerTargets.set(p.id, {
        id: p.id,
        x_W: p.state.x_W,
        v_W: p.state.v_W,
        throttle: p.state.throttle,
        isAlive: p.state.isAlive !== false,
      });
    }
    for (let i = 0; i < this.missiles.capacity; i += 1) {
      if (!this.missiles.isActive(i)) continue;
      // Build a view onto the SoA slot.
      const lockedId = this.missiles.lockedTargetId[i];
      const view: SeekerMissileView = {
        kind: this.missiles.kind[i] ?? 'ir',
        lockedTargetId: lockedId ?? null,
        lostLockSince: this.missiles.lostLockSince[i]!,
        x_W: _v1.set(this.missiles.px[i]!, this.missiles.py[i]!, this.missiles.pz[i]!),
        v_W: new THREE.Vector3(
          this.missiles.vx[i]!,
          this.missiles.vy[i]!,
          this.missiles.vz[i]!,
        ),
        fwd_W: new THREE.Vector3(
          this.missiles.fx[i]!,
          this.missiles.fy[i]!,
          this.missiles.fz[i]!,
        ),
      };
      seekerStep(view, seekerTargets, dt);
      // Write back the (possibly mutated) v + lock fields.
      this.missiles.vx[i] = view.v_W.x;
      this.missiles.vy[i] = view.v_W.y;
      this.missiles.vz[i] = view.v_W.z;
      this.missiles.lockedTargetId[i] = view.lockedTargetId;
      this.missiles.lostLockSince[i] = view.lostLockSince;
    }

    // 3a) Integrate bullets (record prev positions for swept hit).
    this.bullets.step(dt, this.world, this.playerPos, this.bulletPrev);

    // 4) Bullet hits: for every active bullet, swept-test against every
    //    other participant. Cheap because pools are tiny.
    for (let i = 0; i < this.bullets.capacity; i += 1) {
      if (!this.bullets.isActive(i)) continue;
      const shooterIdRaw = this.bullets.shooterId[i];
      if (!shooterIdRaw) continue;
      const shooterId: string = shooterIdRaw;
      _prevPos.set(
        this.bulletPrev[i * 3 + 0]!,
        this.bulletPrev[i * 3 + 1]!,
        this.bulletPrev[i * 3 + 2]!,
      );
      _currPos.set(this.bullets.px[i]!, this.bullets.py[i]!, this.bullets.pz[i]!);
      for (const p of this.participants.values()) {
        if (p.id === shooterId) continue;
        if (p.state.isAlive === false) continue;
        const r = sweptSegmentVsOBB(
          _prevPos,
          _currPos,
          p.state.x_W,
          p.state.q,
          HULL_HALF_EXTENTS_B,
        );
        if (!r.hit) continue;
        const zone = resolveZone(r.pBody);
        // Range = bullet age * approximate speed (constant per frame is fine
        // for tests; full path-length would be a bigger change).
        const range = _v1.copy(_currPos).sub(_prevPos).length() / Math.max(dt, 1e-4) *
          this.bullets.age[i]!;
        applyBulletHit(p.state, zone, range);
        this.hitEvents.push({
          shooterId,
          targetId: p.id,
          weapon: 'gun',
          zone,
          hpLoss: 0,
          t: p.state.time,
        });
        this.maybeKill(p, shooterId, 'gun');
        this.bullets.despawn(i);
        break; // bullet is consumed
      }
    }

    // 3b) Integrate missiles, then resolve direct + prox hits.
    this.missiles.step(dt, this.world);
    for (let i = 0; i < this.missiles.capacity; i += 1) {
      if (!this.missiles.isActive(i)) continue;
      const shooterIdRaw = this.missiles.shooterId[i];
      if (!shooterIdRaw) continue;
      const shooterId: string = shooterIdRaw;
      const lockedId = this.missiles.lockedTargetId[i];
      const armed = this.missiles.age[i]! >= T.missileFuseArmTime;
      _currPos.set(this.missiles.px[i]!, this.missiles.py[i]!, this.missiles.pz[i]!);
      let consumed = false;
      for (const p of this.participants.values()) {
        if (p.id === shooterId) continue;
        if (p.state.isAlive === false) continue;
        // Friendly-fire skip (same team).
        const shooter = this.participants.get(shooterId);
        if (shooter && shooter.team && p.team && shooter.team === p.team) continue;

        // Direct hit: position inside hull OBB.
        _prevPos.copy(_currPos);
        // Use a tiny segment (curr -> curr + 0.01·v) to keep AABB-segment happy.
        _v1.set(
          this.missiles.vx[i]! * dt,
          this.missiles.vy[i]! * dt,
          this.missiles.vz[i]! * dt,
        );
        const nextPos = _v1.add(_currPos);
        const r = sweptSegmentVsOBB(_currPos, nextPos, p.state.x_W, p.state.q);
        if (r.hit) {
          applyMissileDirect(p.state);
          this.hitEvents.push({
            shooterId,
            targetId: p.id,
            weapon: 'missile',
            zone: resolveZone(r.pBody),
            hpLoss: T.missileDirectHpLoss,
            t: p.state.time,
          });
          this.maybeKill(p, shooterId, 'missile');
          this.spawnExplosion(_currPos);
          this.missiles.despawn(i);
          consumed = true;
          break;
        }

        // Proximity fuse: armed + within radius + closing.
        if (!armed) continue;
        const dist = _v1.subVectors(p.state.x_W, _currPos).length();
        if (dist >= T.missileProxRadius) continue;
        // Closing: dot(v_missile - v_target, target - missile) < 0
        const vmx = this.missiles.vx[i]!;
        const vmy = this.missiles.vy[i]!;
        const vmz = this.missiles.vz[i]!;
        const dvx = vmx - p.state.v_W.x;
        const dvy = vmy - p.state.v_W.y;
        const dvz = vmz - p.state.v_W.z;
        const tx = p.state.x_W.x - _currPos.x;
        const ty = p.state.x_W.y - _currPos.y;
        const tz = p.state.x_W.z - _currPos.z;
        const closing = dvx * tx + dvy * ty + dvz * tz < 0;
        if (!closing) continue;
        applyMissileProx(p.state, dist, this.missiles.tSpawn[i]!);
        this.hitEvents.push({
          shooterId,
          targetId: p.id,
          weapon: 'missile',
          zone: 'airframe',
          hpLoss: 0,
          t: p.state.time,
        });
        this.maybeKill(p, shooterId, 'missile');
        this.spawnExplosion(_currPos);
        this.missiles.despawn(i);
        consumed = true;
        break;
      }
      if (consumed) continue;

      // Missile vs ground was already handled inside missiles.step(); if a
      // locked-target missile hits ground we still spawn an explosion.
      // (Skipped — ground despawn here is silent.)
      void lockedId;
    }

    // 3c) Integrate bombs, spawn explosions on impact.
    const impacts = this.bombs.step(dt, this.world);
    for (const idx of impacts) {
      _currPos.set(this.bombs.px[idx]!, this.bombs.py[idx]!, this.bombs.pz[idx]!);
      this.spawnExplosion(_currPos);
    }

    // 3d) Tick explosion fade.
    this.explosions.step(dt);
  }

  /** Spawn an explosion at the given world position. */
  spawnExplosion(pos: THREE.Vector3): void {
    this.explosions.spawn(pos);
  }

  private maybeKill(
    target: CombatParticipant,
    shooterId: string,
    weapon: 'gun' | 'missile' | 'bomb' | 'sam',
  ): void {
    if (target.state.isAlive === false) {
      this.killEvents.push({
        shooterId,
        victimId: target.id,
        weapon,
        t: target.state.time,
      });
      this.spawnExplosion(target.state.x_W);
    }
  }

  /**
   * Build a HUD snapshot. Does NOT clear the recent-events buffers (call
   * `consumeEvents()` for that).
   */
  snapshot(): CombatSnapshot {
    type SnapshotParticipant = CombatSnapshot['participants'] extends ReadonlyArray<
      infer U
    >
      ? U
      : never;
    const participants: SnapshotParticipant[] = [];
    for (const p of this.participants.values()) {
      const hp = p.state.hp ?? {
        airframe: T.airframeHpMax,
        engine: T.engineHpMax,
        controls: { aileron: T.controlHpMax, elevator: T.controlHpMax, rudder: T.controlHpMax },
      };
      participants.push({
        id: p.id,
        isAlive: p.state.isAlive !== false,
        hp: {
          airframe: hp.airframe,
          engine: hp.engine,
          aileron: hp.controls.aileron,
          elevator: hp.controls.elevator,
          rudder: hp.controls.rudder,
        },
        gunRoundsL: p.weapons?.gunRoundsL ?? 0,
        gunRoundsR: p.weapons?.gunRoundsR ?? 0,
        missileRailsRemaining: p.weapons?.missileRailsRemaining ?? 0,
        bombsRemaining: p.weapons?.bombsRemaining ?? 0,
      });
    }
    return {
      participants,
      recentHits: this.hitEvents.slice(),
      recentKills: this.killEvents.slice(),
      activeBullets: this.bullets.active,
      activeMissiles: this.missiles.active,
      activeBombs: this.bombs.active,
    };
  }

  /** Consume + clear queued hit/kill events. */
  consumeEvents(): { hits: CombatHitEvent[]; kills: CombatKillEvent[] } {
    const hits = this.hitEvents.slice();
    const kills = this.killEvents.slice();
    this.hitEvents.length = 0;
    this.killEvents.length = 0;
    return { hits, kills };
  }
}

// Re-exports so callers can `import { COMBAT_TUNING, HARDPOINTS, fireGun, ... }`.
export { COMBAT_TUNING } from './tuning.js';
export type { CombatTuning } from './tuning.js';
export { HULL_HALF_EXTENTS_B, sweptSegmentVsOBB, resolveZone } from './aabb.js';
export type { DamageZone, SweptHit } from './aabb.js';
export {
  applyBulletHit,
  applyMissileDirect,
  applyMissileProx,
  respawn,
  checkRespawn,
  bulletRangeFalloff,
  bulletDamageRaw,
} from './damage.js';
export { seekerStep, acquireLock } from './seeker.js';
export type { SeekerMissileView, SeekerTarget } from './seeker.js';
export {
  BulletPool,
  MissilePool,
  BombPool,
} from './projectiles.js';
export type {
  BulletSpawn,
  MissileSpawn,
  BombSpawn,
  ProjectileWorld,
} from './projectiles.js';
export { ExplosionPool } from './explosion.js';
export {
  createWeaponState,
  fireGun,
  fireMissile,
  dropBomb,
  HARDPOINTS,
} from './weapons.js';
export type { WeaponState } from './weapons.js';
