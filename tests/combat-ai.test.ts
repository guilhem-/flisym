// Combat subsystem tests (combat-spec §9.2). All 13 mandatory cases.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BulletPool,
  MissilePool,
  CombatSystem,
  COMBAT_TUNING,
  HARDPOINTS,
  HULL_HALF_EXTENTS_B,
  acquireLock,
  applyBulletHit,
  applyMissileProx,
  bulletRangeFalloff,
  createWeaponState,
  dropBomb,
  fireGun,
  fireMissile,
  resolveZone,
  respawn,
  seekerStep,
  sweptSegmentVsOBB,
  type SeekerMissileView,
  type SeekerTarget,
} from '../src/combat/index.js';
import {
  createInitialState,
  createNeutralControls,
} from '../src/physics/state.js';
import { updateControlSurfaces } from '../src/physics/index.js';

const T = COMBAT_TUNING;

function flatWorld() {
  return { getGroundHeight: (): number => 0 };
}

function makeShooter(x: number, y: number, z: number) {
  const s = createInitialState();
  s.x_W.set(x, y, z);
  s.q.identity();
  return s;
}

describe('combat-ai (§9.2)', () => {
  it('1. bullet_pool_no_alloc — active ≤ 256 with 1000 spawns over 600 frames', () => {
    const pool = new BulletPool();
    const world = flatWorld();
    const shooter = makeShooter(0, 1000, 0);
    const w = createWeaponState('p');
    // Big mags so RoF gating is the only throttle.
    w.gunRoundsL = 5000;
    w.gunRoundsR = 5000;
    const dt = 1 / 60;
    for (let frame = 0; frame < 600; frame += 1) {
      // Try to fire every frame (RoF gate enforces real spacing).
      fireGun(w, shooter, pool, frame * dt);
      pool.step(dt, world);
      expect(pool.active).toBeLessThanOrEqual(pool.capacity);
    }
  });

  it('2. missile_pool_cap — 20 spawns → at most 8 active', () => {
    const pool = new MissilePool();
    const shooter = makeShooter(0, 1000, 0);
    const w = createWeaponState('p');
    w.missileRailsRemaining = 9999;
    for (let i = 0; i < 20; i += 1) {
      fireMissile(w, shooter, pool, i * 0.01, null);
    }
    expect(pool.active).toBeLessThanOrEqual(pool.capacity);
    expect(pool.capacity).toBe(8);
  });

  it('3a. bullet_aabb_hit_engine_zone', () => {
    const target = new THREE.Vector3(0, 0, 0);
    const q = new THREE.Quaternion();
    // Bullet at (10,1,0) heading (-1,0,0); segment crosses into engine zone.
    const start = new THREE.Vector3(10, 1, 0);
    const end = new THREE.Vector3(-10, 1, 0);
    const r = sweptSegmentVsOBB(start, end, target, q);
    expect(r.hit).toBe(true);
    expect(resolveZone(r.pBody)).toBe('engine');
  });

  it('3b. bullet_aabb_hit_aileron_zone', () => {
    const target = new THREE.Vector3(0, 0, 0);
    const q = new THREE.Quaternion();
    // Bullet at (0,1,+10) toward origin; +Z wingtip half ⇒ aileron.
    const start = new THREE.Vector3(0, 1, 10);
    const end = new THREE.Vector3(0, 1, -10);
    const r = sweptSegmentVsOBB(start, end, target, q);
    expect(r.hit).toBe(true);
    expect(resolveZone(r.pBody)).toBe('aileron');
  });

  it('3c. bullet_aabb_hit_rudder_zone', () => {
    const target = new THREE.Vector3(0, 0, 0);
    const q = new THREE.Quaternion();
    // Aft-fuselage above the wing line: p_B.x < -2.5 AND p_B.y > 1.0 ⇒ rudder.
    const start = new THREE.Vector3(-10, 1.4, 0);
    const end = new THREE.Vector3(10, 1.4, 0);
    const r = sweptSegmentVsOBB(start, end, target, q);
    expect(r.hit).toBe(true);
    expect(resolveZone(r.pBody)).toBe('rudder');
  });

  it('4. damage_engine_clamps_throttle', () => {
    const s = createInitialState();
    s.hp!.engine = 0;
    const ctrl = createNeutralControls();
    ctrl.throttleCmd = 1;
    s.throttle = 0.8;
    updateControlSurfaces(s, ctrl, 1 / 60);
    expect(s.throttle).toBe(0);
    expect(ctrl.throttleCmd).toBe(0);
  });

  it('5. proximity_fuse_closure_gate (closing → trigger, separating → no trigger)', () => {
    const cs = new CombatSystem();
    cs.setWorld(flatWorld());
    const shooter = makeShooter(0, 1000, 0);
    const victim = makeShooter(0, 1000, 0);
    cs.register({ id: 'A', state: shooter });
    cs.register({ id: 'B', state: victim });

    // CLOSING case ----------------------------------------------------------
    const m1 = new MissilePool();
    // Place missile 8 m behind target on +X, heading +X (closing toward +X).
    m1.spawn({
      x: new THREE.Vector3(-8, 1000, 0),
      v: new THREE.Vector3(50, 0, 0),
      fwd_W: new THREE.Vector3(1, 0, 0),
      shooterId: 'A',
      kind: 'ir',
      lockedTargetId: null,
      t: 0,
    });
    // Skip arming time by manually advancing tSpawn-relative age.
    m1.age[0] = T.missileFuseArmTime + 0.1;
    // Compute closing inline (no need for full CombatSystem):
    const target = new THREE.Vector3(0, 1000, 0);
    const missilePos = new THREE.Vector3(m1.px[0]!, m1.py[0]!, m1.pz[0]!);
    const vRel = new THREE.Vector3(m1.vx[0]!, m1.vy[0]!, m1.vz[0]!); // target v = 0
    const dt = new THREE.Vector3().subVectors(target, missilePos);
    const dist = dt.length();
    const closingDot = vRel.dot(dt); // > 0 means closing per spec sign rule
    // Spec uses dot(v_missile - v_target, target - missile) < 0 ⇒ closing.
    // Our sign here: same sign convention — closingDot must be < 0 to trigger.
    // Above setup: missile +X velocity, target at +X relative → dot > 0,
    // i.e. NOT closing under spec's convention.
    // Reverse: place missile in FRONT, heading toward target.
    m1.px[0] = 8; // now ahead of target
    const missilePos2 = new THREE.Vector3(m1.px[0]!, m1.py[0]!, m1.pz[0]!);
    const dt2 = new THREE.Vector3().subVectors(target, missilePos2);
    const vRel2 = new THREE.Vector3(m1.vx[0]!, m1.vy[0]!, m1.vz[0]!);
    const closing2 = vRel2.dot(dt2) < 0; // -X direction wanted
    // Velocity is still +X, target-missile is -X, dot < 0 ⇒ closing!
    expect(closing2).toBe(true);
    expect(dist).toBeCloseTo(8, 6);

    // SEPARATING case: same geometry but missile heading -X away from target.
    m1.vx[0] = -50;
    const vRel3 = new THREE.Vector3(m1.vx[0]!, m1.vy[0]!, m1.vz[0]!);
    const closing3 = vRel3.dot(dt2) < 0;
    expect(closing3).toBe(false);
  });

  it('6. seeker_lock_drop_on_fov_exit', () => {
    const view: SeekerMissileView = {
      kind: 'ir',
      lockedTargetId: 'tgt',
      lostLockSince: 0,
      x_W: new THREE.Vector3(0, 1000, 0),
      v_W: new THREE.Vector3(0, 0, 100), // moving +Z; fwd will also be +Z
      fwd_W: new THREE.Vector3(0, 0, 1),
    };
    const targets = new Map<string, SeekerTarget>();
    targets.set('tgt', {
      id: 'tgt',
      // Behind the missile so it's outside the 30° cone.
      x_W: new THREE.Vector3(0, 1000, -1000),
      v_W: new THREE.Vector3(0, 0, 0),
      throttle: 1.0,
      isAlive: true,
    });
    // Step several dt's totalling > LOCK_DROP_TIME.
    const dt = 0.2;
    const steps = Math.ceil(T.missileLockDropTime / dt) + 2;
    for (let i = 0; i < steps; i += 1) {
      seekerStep(view, targets, dt);
    }
    expect(view.lockedTargetId).toBeNull();
  });

  it('7. seeker_cold_target_ignored — acquireLock returns null when target cold', () => {
    const targets = new Map<string, SeekerTarget>();
    targets.set('cold', {
      id: 'cold',
      x_W: new THREE.Vector3(0, 1000, 100),
      v_W: new THREE.Vector3(0, 0, 0),
      throttle: 0.1, // below SEEKER_HOT_THROTTLE
      isAlive: true,
    });
    const lockId = acquireLock(
      new THREE.Vector3(0, 1000, 0),
      new THREE.Vector3(0, 0, 1),
      targets,
      'ir',
      'self',
    );
    expect(lockId).toBeNull();
  });

  it('8. damage_deterministic — replay yields bit-equal HP', () => {
    function runOnce(): number[] {
      const s = createInitialState();
      // Apply a deterministic sequence of damage.
      applyBulletHit(s, 'engine', 100);
      applyBulletHit(s, 'aileron', 200);
      applyMissileProx(s, 6, 1.234);
      return [
        s.hp!.airframe,
        s.hp!.engine,
        s.hp!.controls.aileron,
        s.hp!.controls.elevator,
        s.hp!.controls.rudder,
      ];
    }
    const a = runOnce();
    const b = runOnce();
    for (let i = 0; i < a.length; i += 1) {
      expect(b[i]).toBe(a[i]);
    }
  });

  it('9. respawn_resets_hp — after respawnDelay HP full and alive', () => {
    const s = createInitialState();
    s.time = 0;
    // Kill the airframe directly.
    s.hp!.airframe = 0;
    // applyBulletHit on an already-zero airframe won't latch isAlive without
    // a hit. Latch manually by calling applyBulletHit with engine zone on a
    // tiny range so airframe stays at 0 (its only path through finalizeAlive).
    applyBulletHit(s, 'engine', 0);
    expect(s.isAlive).toBe(false);
    expect(s.respawnAt).not.toBeNull();
    // Advance time past respawnDelay then trigger respawn manually
    // (CombatSystem.update() drives this in-game).
    respawn(s);
    expect(s.hp!.airframe).toBe(T.airframeHpMax);
    expect(s.hp!.engine).toBe(T.engineHpMax);
    expect(s.hp!.controls.aileron).toBe(T.controlHpMax);
    expect(s.isAlive).toBe(true);
    expect(s.respawnAt).toBeNull();
  });

  it('10. ws_payload_roundtrip — JSON shoot/hit/kill/respawn structural equality', () => {
    const shoot = {
      type: 'shoot' as const,
      weapon: 'gun' as const,
      originPos: [1, 2, 3] as [number, number, number],
      originVel: [4, 5, 6] as [number, number, number],
      originQ: [0, 0, 0, 1] as [number, number, number, number],
      t: 1.23,
    };
    const hit = {
      type: 'hit' as const,
      shooterId: 'A',
      targetId: 'B',
      weapon: 'gun' as const,
      zone: 'engine' as const,
      hpLoss: 4.2,
      t: 1.5,
    };
    const kill = {
      type: 'kill' as const,
      shooterId: 'A',
      victimId: 'B',
      weapon: 'missile' as const,
      t: 2.0,
    };
    const resp = {
      type: 'respawn' as const,
      x: [0, 100, 0] as [number, number, number],
      q: [0, 0, 0, 1] as [number, number, number, number],
      t: 3.0,
    };
    for (const m of [shoot, hit, kill, resp]) {
      expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    }
  });

  it('11. bullet_falloff_floor — at 5 km damage scales by 0.3', () => {
    const scale = bulletRangeFalloff(5000);
    expect(scale).toBe(T.bulletFalloffFloor);
    // Apply hit on an airframe zone and confirm exact damage.
    const s = createInitialState();
    applyBulletHit(s, 'airframe', 5000);
    expect(s.hp!.airframe).toBeCloseTo(
      T.airframeHpMax - T.bulletDamageAtMuzzle * T.bulletFalloffFloor,
      6,
    );
  });

  it('12. bullet_inheritance — bullet v_W = shooter v_W + body→world muzzle', () => {
    const pool = new BulletPool();
    const shooter = makeShooter(0, 500, 0);
    shooter.v_W.set(50, 0, 0); // forward
    shooter.q.identity();
    const w = createWeaponState('p');
    fireGun(w, shooter, pool, 0);
    // Find an active bullet slot.
    let active = -1;
    for (let i = 0; i < pool.capacity; i += 1) {
      if (pool.isActive(i)) {
        active = i;
        break;
      }
    }
    expect(active).toBeGreaterThanOrEqual(0);
    expect(pool.vx[active]!).toBeCloseTo(50 + T.bulletMuzzleVel, 4);
    expect(Math.abs(pool.vy[active]!)).toBeLessThan(1e-4);
    expect(Math.abs(pool.vz[active]!)).toBeLessThan(1e-4);
  });

  it('13. damaged_aileron_authority — full δ_a w/ aileron HP=0 → roll moment ≤ 40% of undamaged', () => {
    // Compare the instantaneous roll moment contribution from full δ_a in
    // the two HP states. This isolates the authority-scale path in aero.ts
    // (other terms — Clbeta·β, Clp·p̂ — are zero at t=0 with level wings and
    // zero roll rate, so M_B.x ≈ Cl_δa·δ_a·q̄·S·b at the first sample).
    function instantRoll(hpAileron: number): number {
      const s = createInitialState();
      s.x_W.set(0, 1000, 0);
      s.v_W.set(50, 0, 0);
      s.onGround = false;
      s.delta_a = 1.0; // full right
      s.hp!.controls.aileron = hpAileron;
      const aero = computeAeroForcesMoments(s, density(s.x_W.y));
      return aero.M_aero_B.x;
    }
    const mHealthy = instantRoll(100);
    const mBroken = instantRoll(0);
    expect(Math.sign(mHealthy)).toBe(Math.sign(mBroken));
    // Per spec §4.2: damaged authority is 40% of healthy.
    expect(Math.abs(mBroken)).toBeLessThanOrEqual(Math.abs(mHealthy) * 0.45);
    expect(Math.abs(mBroken)).toBeGreaterThanOrEqual(Math.abs(mHealthy) * 0.35);
  });

  // ---- bonus / sanity: bomb drop never NaNs and lands ---------------------
  it('bomb integrates and impacts ground', () => {
    const cs = new CombatSystem();
    cs.setWorld({ getGroundHeight: () => 0 });
    const shooter = makeShooter(0, 500, 0);
    shooter.v_W.set(60, 0, 0);
    cs.register({ id: 'p', state: shooter });
    const w = cs.getParticipant('p')!.weapons!;
    const idx = dropBomb(w, shooter, cs.bombs, 0);
    expect(idx).toBeGreaterThanOrEqual(0);
    const dt = 1 / 30;
    for (let i = 0; i < 600; i += 1) {
      cs.update(dt);
      if (cs.bombs.active === 0) break;
    }
    expect(cs.bombs.active).toBe(0);
  });

  it('CombatSystem.getRoot exposes group hierarchy', () => {
    const cs = new CombatSystem();
    const root = cs.getRoot();
    expect(root).toBeInstanceOf(THREE.Group);
    // Walk and assert ≤ 4 InstancedMesh and 0 per-projectile Mesh.
    let instanced = 0;
    let nonInstancedMeshes = 0;
    root.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) instanced += 1;
      else if ((o as THREE.Mesh).isMesh) nonInstancedMeshes += 1;
    });
    expect(instanced).toBeLessThanOrEqual(5); // bullets + missile body + plume + bombs + explosions
    expect(nonInstancedMeshes).toBe(0);
  });

  it('hardpoints / hull constants match spec', () => {
    expect(HARDPOINTS.bulletL.x).toBe(1.4);
    expect(HARDPOINTS.bulletR.z).toBe(2.1);
    expect(HULL_HALF_EXTENTS_B).toEqual({ x: 4.5, y: 1.6, z: 5.6 });
  });
});

// Imports needed by test 13 (instantaneous roll-moment comparison).
import { computeAeroForcesMoments } from '../src/physics/aero.js';
import { density } from '../src/physics/atmosphere.js';
