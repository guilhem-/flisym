// Projectile pools: BulletPool / MissilePool / BombPool.
//
// Each pool owns:
//   - SoA Float32Array storage (positions, velocities, ages, etc.)
//   - A THREE.InstancedMesh wrapped in a Group (`.group`)
//
// Per tick, each pool's `step(dt, world)` integrates active slots and
// writes their instance matrices. Inactive slots get a zero-scale matrix
// so they're effectively invisible without removing them from the pool.
//
// No per-projectile JS object allocations. No per-projectile Mesh.

import * as THREE from 'three';
import { COMBAT_TUNING } from './tuning.js';
import { density } from '../physics/atmosphere.js';

const T = COMBAT_TUNING;

const G = 9.80665;

const _mat = new THREE.Matrix4();
const _scratchPos = new THREE.Vector3();
const _scratchQuat = new THREE.Quaternion();
const _scratchScale = new THREE.Vector3(1, 1, 1);
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _zeroPos = new THREE.Vector3();

export interface BulletSpawn {
  /** World-frame position. */
  x: THREE.Vector3;
  /** World-frame velocity (already includes shooter inheritance + muzzle). */
  v: THREE.Vector3;
  /** Stable shooter id for hit attribution + friendly-fire. */
  shooterId: string;
  /** Spawn time, seconds, monotonic. */
  t: number;
}

export interface MissileSpawn {
  x: THREE.Vector3;
  v: THREE.Vector3;
  /** Initial body-axis +X in world frame (used for seeker fwd). */
  fwd_W: THREE.Vector3;
  shooterId: string;
  kind: 'ir' | 'radar';
  lockedTargetId: string | null;
  t: number;
}

export interface BombSpawn {
  x: THREE.Vector3;
  v: THREE.Vector3;
  shooterId: string;
  t: number;
}

/** Slim ground sampler. Wrapped by CombatSystem's world adapter. */
export interface ProjectileWorld {
  getGroundHeight(x: number, z: number): number;
}

// -----------------------------------------------------------------------
// BulletPool
// -----------------------------------------------------------------------

export class BulletPool {
  readonly capacity: number;
  readonly group = new THREE.Group();

  // SoA storage. Vec3 fields packed as flat Float32Arrays (xN, yN, zN).
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  /** Time alive in seconds; <0 means inactive slot. */
  readonly age: Float32Array;
  /** Spawn time (sim seconds). */
  readonly tSpawn: Float32Array;
  /** Shooter id table (string indexed by slot). */
  readonly shooterId: (string | null)[];

  /** Number of slots currently active. Read-only externally. */
  active = 0;

  private readonly mesh: THREE.InstancedMesh;
  private writeCursor = 0;

  constructor(capacity = T.bulletPool) {
    this.capacity = capacity;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.age = new Float32Array(capacity).fill(-1);
    this.tSpawn = new Float32Array(capacity);
    this.shooterId = new Array<string | null>(capacity).fill(null);

    // Bullet visual: small bright box ~0.05m. Single shared geometry.
    const geom = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe9a8 });
    this.mesh = new THREE.InstancedMesh(geom, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'BulletPool.instanced';
    // Initialise all slots scaled to 0.
    for (let i = 0; i < capacity; i += 1) {
      _mat.compose(_zeroPos, _scratchQuat, _zeroScale);
      this.mesh.setMatrixAt(i, _mat);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.group.name = 'BulletPool';
    this.group.add(this.mesh);
  }

  /** Spawn a bullet. Returns slot index, or -1 if pool is full. */
  spawn(s: BulletSpawn): number {
    // Find a free slot starting at writeCursor (round-robin reduces churn).
    for (let i = 0; i < this.capacity; i += 1) {
      const idx = (this.writeCursor + i) % this.capacity;
      if (this.age[idx]! < 0) {
        this.px[idx] = s.x.x;
        this.py[idx] = s.x.y;
        this.pz[idx] = s.x.z;
        this.vx[idx] = s.v.x;
        this.vy[idx] = s.v.y;
        this.vz[idx] = s.v.z;
        this.age[idx] = 0;
        this.tSpawn[idx] = s.t;
        this.shooterId[idx] = s.shooterId;
        this.writeCursor = (idx + 1) % this.capacity;
        this.active += 1;
        return idx;
      }
    }
    return -1;
  }

  /** Mark a slot inactive (does NOT trigger a visual update — step() does). */
  despawn(idx: number): void {
    if (this.age[idx]! >= 0) {
      this.age[idx] = -1;
      this.shooterId[idx] = null;
      this.active -= 1;
    }
  }

  /**
   * Integrate all active slots one render-rate dt. Despawns bullets that
   * exceed lifetime, fall below ground, or exit cull radius. Hit detection
   * lives in CombatSystem (so we can use prev/curr positions for the swept
   * AABB test without re-deriving them).
   *
   * @param dt seconds since last call.
   * @param world ground sampler.
   * @param playerPos optional — used for the cull-radius check.
   * @param prevOut optional — if provided, populated with pre-step positions
   *                (flat xyz triplets per slot) so the caller can run a
   *                swept hit-test against `curr`.
   */
  step(
    dt: number,
    world: ProjectileWorld,
    playerPos: THREE.Vector3 | null = null,
    prevOut: Float32Array | null = null,
  ): void {
    const cullRsq = T.bulletCullRadius * T.bulletCullRadius;
    for (let i = 0; i < this.capacity; i += 1) {
      const a = this.age[i]!;
      if (a < 0) continue;

      if (prevOut) {
        prevOut[i * 3 + 0] = this.px[i]!;
        prevOut[i * 3 + 1] = this.py[i]!;
        prevOut[i * 3 + 2] = this.pz[i]!;
      }

      const py = this.py[i]!;
      const rho = density(py);
      let vx = this.vx[i]!;
      let vy = this.vy[i]!;
      let vz = this.vz[i]!;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      // F_drag = -0.5 * rho * Cd*A * |v| * v; a = F/m + g
      const dragCoef = -0.5 * rho * T.bulletCdA * speed;
      const ax = (dragCoef * vx) / T.bulletMass;
      const ay = (dragCoef * vy) / T.bulletMass - G;
      const az = (dragCoef * vz) / T.bulletMass;
      vx += ax * dt;
      vy += ay * dt;
      vz += az * dt;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      let px = this.px[i]!;
      let py2 = py;
      let pz = this.pz[i]!;
      px += vx * dt;
      py2 += vy * dt;
      pz += vz * dt;
      this.px[i] = px;
      this.py[i] = py2;
      this.pz[i] = pz;
      this.age[i] = a + dt;

      // Despawn checks.
      if (this.age[i]! >= T.bulletLifetime) {
        this.despawn(i);
        continue;
      }
      const g = world.getGroundHeight(px, pz);
      if (py2 <= g + 0.1) {
        this.despawn(i);
        continue;
      }
      if (playerPos !== null) {
        const dx = px - playerPos.x;
        const dy = py2 - playerPos.y;
        const dz = pz - playerPos.z;
        if (dx * dx + dy * dy + dz * dz > cullRsq) {
          this.despawn(i);
        }
      }
    }
    this.flushInstances();
  }

  /** Update the instanced-mesh matrix for every slot. */
  flushInstances(): void {
    for (let i = 0; i < this.capacity; i += 1) {
      if (this.age[i]! < 0) {
        _mat.compose(_zeroPos, _scratchQuat, _zeroScale);
      } else {
        _scratchPos.set(this.px[i]!, this.py[i]!, this.pz[i]!);
        _mat.compose(_scratchPos, _scratchQuat, _scratchScale);
      }
      this.mesh.setMatrixAt(i, _mat);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** True iff slot is active. */
  isActive(idx: number): boolean {
    return this.age[idx]! >= 0;
  }
}

// -----------------------------------------------------------------------
// MissilePool
// -----------------------------------------------------------------------

export class MissilePool {
  readonly capacity: number;
  readonly group = new THREE.Group();

  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly fx: Float32Array;
  readonly fy: Float32Array;
  readonly fz: Float32Array;
  readonly age: Float32Array;
  readonly tSpawn: Float32Array;
  readonly lostLockSince: Float32Array;
  readonly shooterId: (string | null)[];
  readonly lockedTargetId: (string | null)[];
  readonly kind: ('ir' | 'radar' | null)[];

  active = 0;
  private writeCursor = 0;

  private readonly body: THREE.InstancedMesh;
  private readonly plume: THREE.InstancedMesh;

  constructor(capacity = T.missilePool) {
    this.capacity = capacity;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.fx = new Float32Array(capacity);
    this.fy = new Float32Array(capacity);
    this.fz = new Float32Array(capacity);
    this.age = new Float32Array(capacity).fill(-1);
    this.tSpawn = new Float32Array(capacity);
    this.lostLockSince = new Float32Array(capacity);
    this.shooterId = new Array<string | null>(capacity).fill(null);
    this.lockedTargetId = new Array<string | null>(capacity).fill(null);
    this.kind = new Array<'ir' | 'radar' | null>(capacity).fill(null);

    const bodyGeom = new THREE.CylinderGeometry(0.07, 0.07, 1.5, 6);
    bodyGeom.rotateZ(Math.PI / 2); // align with body +X
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0xb0b0b0 });
    this.body = new THREE.InstancedMesh(bodyGeom, bodyMat, capacity);
    this.body.frustumCulled = false;
    this.body.name = 'MissilePool.body.instanced';

    const plumeGeom = new THREE.SphereGeometry(0.4, 6, 6);
    const plumeMat = new THREE.MeshBasicMaterial({
      color: 0xffd060,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.plume = new THREE.InstancedMesh(plumeGeom, plumeMat, capacity);
    this.plume.frustumCulled = false;
    this.plume.name = 'MissilePool.plume.instanced';

    for (let i = 0; i < capacity; i += 1) {
      _mat.compose(_zeroPos, _scratchQuat, _zeroScale);
      this.body.setMatrixAt(i, _mat);
      this.plume.setMatrixAt(i, _mat);
    }
    this.body.instanceMatrix.needsUpdate = true;
    this.plume.instanceMatrix.needsUpdate = true;

    this.group.name = 'MissilePool';
    this.group.add(this.body);
    this.group.add(this.plume);
  }

  spawn(s: MissileSpawn): number {
    for (let i = 0; i < this.capacity; i += 1) {
      const idx = (this.writeCursor + i) % this.capacity;
      if (this.age[idx]! < 0) {
        this.px[idx] = s.x.x;
        this.py[idx] = s.x.y;
        this.pz[idx] = s.x.z;
        this.vx[idx] = s.v.x;
        this.vy[idx] = s.v.y;
        this.vz[idx] = s.v.z;
        this.fx[idx] = s.fwd_W.x;
        this.fy[idx] = s.fwd_W.y;
        this.fz[idx] = s.fwd_W.z;
        this.age[idx] = 0;
        this.tSpawn[idx] = s.t;
        this.lostLockSince[idx] = 0;
        this.shooterId[idx] = s.shooterId;
        this.lockedTargetId[idx] = s.lockedTargetId;
        this.kind[idx] = s.kind;
        this.writeCursor = (idx + 1) % this.capacity;
        this.active += 1;
        return idx;
      }
    }
    return -1;
  }

  despawn(idx: number): void {
    if (this.age[idx]! >= 0) {
      this.age[idx] = -1;
      this.shooterId[idx] = null;
      this.lockedTargetId[idx] = null;
      this.kind[idx] = null;
      this.active -= 1;
    }
  }

  isActive(idx: number): boolean {
    return this.age[idx]! >= 0;
  }

  /**
   * Integrate one render-rate dt. Caller is responsible for running the
   * seeker (which mutates v + lockedTargetId) before invoking this, so the
   * integrator just applies thrust/drag/gravity to the steered velocity.
   */
  step(dt: number, world: ProjectileWorld): void {
    for (let i = 0; i < this.capacity; i += 1) {
      const a = this.age[i]!;
      if (a < 0) continue;

      // Refresh fwd from current v_W (normalised). Used by seeker next tick.
      let vx = this.vx[i]!;
      let vy = this.vy[i]!;
      let vz = this.vz[i]!;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed > 1e-3) {
        this.fx[i] = vx / speed;
        this.fy[i] = vy / speed;
        this.fz[i] = vz / speed;
      }

      const motorOn = a < T.missileMotorBurnTime;
      const Tn = motorOn ? T.missileThrust : 0;
      // Thrust along current fwd_W (already normalised).
      const Tx = Tn * this.fx[i]!;
      const Ty = Tn * this.fy[i]!;
      const Tz = Tn * this.fz[i]!;

      const rho = density(this.py[i]!);
      const dragCoef = -0.5 * rho * T.missileCdA * speed;
      const Dx = dragCoef * vx;
      const Dy = dragCoef * vy;
      const Dz = dragCoef * vz;

      const Fx = Tx + Dx;
      const Fy = Ty + Dy - T.missileMass * G;
      const Fz = Tz + Dz;

      const ax = Fx / T.missileMass;
      const ay = Fy / T.missileMass;
      const az = Fz / T.missileMass;
      vx += ax * dt;
      vy += ay * dt;
      vz += az * dt;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      this.px[i]! += vx * dt;
      this.py[i]! += vy * dt;
      this.pz[i]! += vz * dt;
      this.age[i] = a + dt;

      // Despawn checks (lifetime / ground / lost-lock-then-old).
      if (this.age[i]! >= T.missileLifetime) {
        this.despawn(i);
        continue;
      }
      const g = world.getGroundHeight(this.px[i]!, this.pz[i]!);
      if (this.py[i]! <= g + 0.1) {
        this.despawn(i);
        continue;
      }
      if (
        this.lockedTargetId[i] === null &&
        this.lostLockSince[i]! > 1.0 &&
        this.age[i]! > 2.0
      ) {
        this.despawn(i);
        continue;
      }
    }
    this.flushInstances();
  }

  flushInstances(): void {
    for (let i = 0; i < this.capacity; i += 1) {
      if (this.age[i]! < 0) {
        _mat.compose(_zeroPos, _scratchQuat, _zeroScale);
        this.body.setMatrixAt(i, _mat);
        this.plume.setMatrixAt(i, _mat);
        continue;
      }
      _scratchPos.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      // Orient missile body along velocity (cylinder is already rotated to +X).
      _scratchQuat.setFromUnitVectors(
        UNIT_X,
        _v1.set(this.fx[i]!, this.fy[i]!, this.fz[i]!).normalize(),
      );
      _mat.compose(_scratchPos, _scratchQuat, _scratchScale);
      this.body.setMatrixAt(i, _mat);
      // Plume sits slightly behind the body along -fwd, scaled with motor.
      const burning = this.age[i]! < T.missileMotorBurnTime;
      if (burning) {
        _v2.set(
          _scratchPos.x - this.fx[i]! * 0.8,
          _scratchPos.y - this.fy[i]! * 0.8,
          _scratchPos.z - this.fz[i]! * 0.8,
        );
        _mat.compose(_v2, _scratchQuat, _scratchScale);
      } else {
        _mat.compose(_zeroPos, _scratchQuat, _zeroScale);
      }
      this.plume.setMatrixAt(i, _mat);
    }
    this.body.instanceMatrix.needsUpdate = true;
    this.plume.instanceMatrix.needsUpdate = true;
  }
}

const UNIT_X = new THREE.Vector3(1, 0, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// -----------------------------------------------------------------------
// BombPool
// -----------------------------------------------------------------------

export class BombPool {
  readonly capacity: number;
  readonly group = new THREE.Group();

  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly age: Float32Array;
  readonly tSpawn: Float32Array;
  readonly shooterId: (string | null)[];

  active = 0;
  private writeCursor = 0;
  private readonly mesh: THREE.InstancedMesh;

  constructor(capacity = T.bombPool) {
    this.capacity = capacity;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.age = new Float32Array(capacity).fill(-1);
    this.tSpawn = new Float32Array(capacity);
    this.shooterId = new Array<string | null>(capacity).fill(null);

    const geom = new THREE.CylinderGeometry(0.15, 0.15, 1.2, 6);
    geom.rotateZ(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x555555 });
    this.mesh = new THREE.InstancedMesh(geom, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'BombPool.instanced';
    for (let i = 0; i < capacity; i += 1) {
      _mat.compose(_zeroPos, _scratchQuat, _zeroScale);
      this.mesh.setMatrixAt(i, _mat);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.group.name = 'BombPool';
    this.group.add(this.mesh);
  }

  spawn(s: BombSpawn): number {
    for (let i = 0; i < this.capacity; i += 1) {
      const idx = (this.writeCursor + i) % this.capacity;
      if (this.age[idx]! < 0) {
        this.px[idx] = s.x.x;
        this.py[idx] = s.x.y;
        this.pz[idx] = s.x.z;
        this.vx[idx] = s.v.x;
        this.vy[idx] = s.v.y;
        this.vz[idx] = s.v.z;
        this.age[idx] = 0;
        this.tSpawn[idx] = s.t;
        this.shooterId[idx] = s.shooterId;
        this.writeCursor = (idx + 1) % this.capacity;
        this.active += 1;
        return idx;
      }
    }
    return -1;
  }

  despawn(idx: number): void {
    if (this.age[idx]! >= 0) {
      this.age[idx] = -1;
      this.shooterId[idx] = null;
      this.active -= 1;
    }
  }

  isActive(idx: number): boolean {
    return this.age[idx]! >= 0;
  }

  /**
   * Step. Returns indexes of bombs that impacted ground this frame (in
   * insertion order) — caller resolves blast damage via combat/damage.ts.
   */
  step(dt: number, world: ProjectileWorld): number[] {
    const impacts: number[] = [];
    for (let i = 0; i < this.capacity; i += 1) {
      const a = this.age[i]!;
      if (a < 0) continue;

      const rho = density(this.py[i]!);
      let vx = this.vx[i]!;
      let vy = this.vy[i]!;
      let vz = this.vz[i]!;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const dragCoef = -0.5 * rho * T.bombCdA * speed;
      const ax = (dragCoef * vx) / T.bombMass;
      const ay = (dragCoef * vy) / T.bombMass - G;
      const az = (dragCoef * vz) / T.bombMass;
      vx += ax * dt;
      vy += ay * dt;
      vz += az * dt;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      this.px[i]! += vx * dt;
      this.py[i]! += vy * dt;
      this.pz[i]! += vz * dt;
      this.age[i] = a + dt;

      if (this.age[i]! >= T.bombLifetime) {
        this.despawn(i);
        continue;
      }
      const g = world.getGroundHeight(this.px[i]!, this.pz[i]!);
      if (this.py[i]! <= g + 0.1) {
        impacts.push(i);
        this.despawn(i);
      }
    }
    this.flushInstances();
    return impacts;
  }

  flushInstances(): void {
    for (let i = 0; i < this.capacity; i += 1) {
      if (this.age[i]! < 0) {
        _mat.compose(_zeroPos, _scratchQuat, _zeroScale);
        this.mesh.setMatrixAt(i, _mat);
        continue;
      }
      _scratchPos.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      _v1.set(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      if (_v1.lengthSq() > 1e-6) {
        _v1.normalize();
        _scratchQuat.setFromUnitVectors(UNIT_X, _v1);
      } else {
        _scratchQuat.identity();
      }
      _mat.compose(_scratchPos, _scratchQuat, _scratchScale);
      this.mesh.setMatrixAt(i, _mat);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
