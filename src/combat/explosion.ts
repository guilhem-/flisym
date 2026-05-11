// Explosion effect pool — visual-only InstancedMesh.
//
// Each active explosion is a single instance that scales up linearly over
// its lifetime and fades opacity to zero. Additive blending, no
// depth-write so explosions never z-fight with terrain.

import * as THREE from 'three';
import { COMBAT_TUNING } from './tuning.js';

const T = COMBAT_TUNING;

const _mat = new THREE.Matrix4();
const _scratchPos = new THREE.Vector3();
const _scratchQuat = new THREE.Quaternion();
const _scratchScale = new THREE.Vector3();
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _zeroPos = new THREE.Vector3();

const EXPLOSION_LIFETIME = 0.7;
const EXPLOSION_MAX_RADIUS = 18;

export class ExplosionPool {
  readonly capacity: number;
  readonly group = new THREE.Group();

  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly age: Float32Array;

  active = 0;
  private writeCursor = 0;
  private readonly mesh: THREE.InstancedMesh;

  constructor(capacity: number = T.explosionPool) {
    this.capacity = capacity;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.age = new Float32Array(capacity).fill(-1);

    const geom = new THREE.SphereGeometry(1, 12, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffa040,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(geom, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'ExplosionPool.instanced';
    for (let i = 0; i < capacity; i += 1) {
      _mat.compose(_zeroPos, _scratchQuat, _zeroScale);
      this.mesh.setMatrixAt(i, _mat);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.group.name = 'ExplosionPool';
    this.group.add(this.mesh);
  }

  spawn(pos: THREE.Vector3): number {
    for (let i = 0; i < this.capacity; i += 1) {
      const idx = (this.writeCursor + i) % this.capacity;
      if (this.age[idx]! < 0) {
        this.px[idx] = pos.x;
        this.py[idx] = pos.y;
        this.pz[idx] = pos.z;
        this.age[idx] = 0;
        this.writeCursor = (idx + 1) % this.capacity;
        this.active += 1;
        return idx;
      }
    }
    return -1;
  }

  step(dt: number): void {
    for (let i = 0; i < this.capacity; i += 1) {
      const a = this.age[i]!;
      if (a < 0) continue;
      const next = a + dt;
      if (next >= EXPLOSION_LIFETIME) {
        this.age[i] = -1;
        this.active -= 1;
        _mat.compose(_zeroPos, _scratchQuat, _zeroScale);
        this.mesh.setMatrixAt(i, _mat);
        continue;
      }
      this.age[i] = next;
      const t = next / EXPLOSION_LIFETIME;
      const radius = EXPLOSION_MAX_RADIUS * t;
      _scratchPos.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      _scratchScale.set(radius, radius, radius);
      _mat.compose(_scratchPos, _scratchQuat, _scratchScale);
      this.mesh.setMatrixAt(i, _mat);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
