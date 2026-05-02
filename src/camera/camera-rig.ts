/**
 * CameraRig — multi-mode camera controller wrapping a single
 * THREE.PerspectiveCamera. Handles cockpit, chase, external (orbit),
 * tower, and free-fly modes with a 0.4 s tween between mode swaps.
 *
 * Body convention (matches src/aircraft): +X forward, +Y up, +Z right.
 * Aircraft group origin sits at gear contact.
 *
 * Listens for `window` event `camera:cycle` (HUDCoder dispatches on V).
 */

import * as THREE from 'three';
import { WORLD_CONFIG } from '../world/index.js';

export type CameraMode = 'cockpit' | 'chase' | 'external' | 'tower' | 'free';

const MODE_ORDER: readonly CameraMode[] = [
  'chase',
  'cockpit',
  'external',
  'tower',
  'free',
] as const;

const TWEEN_DURATION = 0.4; // seconds

// Cockpit pilot eye offset in body frame (+X fwd, +Y up, +Z right).
const COCKPIT_EYE_OFFSET = new THREE.Vector3(1.0, 1.4, -0.3);
const COCKPIT_LOOK_DELTA = new THREE.Vector3(10, 0, 0); // forward in body

// Chase camera offset (body frame): 18 m behind, 4.5 m above.
const CHASE_OFFSET = new THREE.Vector3(-18, 4.5, 0);

// External orbit parameters.
const EXTERNAL_RADIUS = 25;
const EXTERNAL_AUTO_RATE = 0.05; // rad/s

// Tower position — runway threshold (negative-X end), 12 m up.
const TOWER_POS = new THREE.Vector3(
  -WORLD_CONFIG.runway.length / 2,
  12,
  0,
);

// Free-fly speeds.
const FREE_SPEED_BASE = 50; // m/s
const FREE_SPEED_BOOST = 200; // m/s with shift

// FOV mapping.
const FOV_BASE = 60;
const FOV_MAX = 75;
const FOV_LERP_RATE = 3; // exponential approach factor

interface TweenState {
  active: boolean;
  t: number;
  fromPos: THREE.Vector3;
  fromQuat: THREE.Quaternion;
  toMode: CameraMode;
}

export class CameraRig {
  private readonly camera: THREE.PerspectiveCamera;
  private mode: CameraMode = 'chase';

  // External orbit yaw (around world +Y) and pitch.
  private externalYaw = 0;
  private externalPitch = 0.15;

  // Free-fly orientation tracked as yaw / pitch (radians).
  private freeYaw = 0;
  private freePitch = 0;
  private freeInitialised = false;

  // Input state.
  private readonly keys = new Set<string>();
  private mouseDown = false;
  private mouseDx = 0;
  private mouseDy = 0;

  // When true, the next chase update skips the exponential lerp and snaps
  // straight to the computed pose. Set by setMode(name, instant=true).
  private snapNextChase = true;

  // Tween state for mode transitions.
  private readonly tween: TweenState = {
    active: false,
    t: 0,
    fromPos: new THREE.Vector3(),
    fromQuat: new THREE.Quaternion(),
    toMode: 'chase',
  };

  // Scratch objects (avoid per-frame allocations).
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredQuat = new THREE.Quaternion();
  private readonly desiredLookAt = new THREE.Vector3();

  // Bound listeners (kept so we could detach later if needed).
  private readonly onCycle = (): void => {
    const idx = MODE_ORDER.indexOf(this.mode);
    const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length] ?? 'chase';
    this.setMode(next);
  };
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.mode !== 'free') return;
    this.keys.add(e.code);
  };
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    // Always clear, even if mode changed mid-press.
    this.keys.delete(e.code);
  };
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.mouseDown = true;
  };
  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.mouseDown = false;
  };
  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.mouseDown) return;
    this.mouseDx += e.movementX;
    this.mouseDy += e.movementY;
  };

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  /** Returns the current mode. */
  getMode(): CameraMode {
    return this.mode;
  }

  /**
   * Switch camera mode. Captures current pose for a 0.4 s tween toward the
   * new mode's first computed pose. Pass `instant` to skip the tween.
   */
  setMode(name: CameraMode, instant = false): void {
    if (name === this.mode && !this.tween.active) return;
    if (instant) {
      this.tween.active = false;
      // Suppress the chase-mode lerp on the very next update so the camera
      // snaps to its computed pose instead of dragging in from wherever it
      // happened to be (e.g. world origin on bootstrap).
      this.snapNextChase = true;
    } else {
      this.tween.active = true;
      this.tween.t = 0;
      this.tween.fromPos.copy(this.camera.position);
      this.tween.fromQuat.copy(this.camera.quaternion);
    }
    this.tween.toMode = name;
    this.mode = name;
    // Reset free-fly seeding so we initialise from the next computed pose.
    if (name === 'free') {
      this.freeInitialised = false;
    }
  }

  /**
   * Wire DOM listeners. Call once after the renderer's canvas is in the DOM.
   * Mouse listeners attach to `window` so dragging continues if the cursor
   * leaves the canvas.
   */
  attachInput(): void {
    window.addEventListener('camera:cycle', this.onCycle);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
  }

  /**
   * Per-frame update.
   * @param dt seconds.
   * @param target aircraft group (origin at gear contact).
   * @param targetVelocity world-frame velocity of the aircraft.
   */
  update(
    dt: number,
    target: THREE.Object3D,
    targetVelocity: THREE.Vector3,
  ): void {
    // 1) Compute the desired pose for the current (target) mode.
    switch (this.mode) {
      case 'cockpit':
        this.computeCockpit(target);
        break;
      case 'chase':
        this.computeChase(target, dt);
        break;
      case 'external':
        this.computeExternal(target, dt);
        break;
      case 'tower':
        this.computeTower(target);
        break;
      case 'free':
        this.computeFree(target, dt);
        break;
    }

    // 2) Apply the desired pose, blending if a tween is active.
    if (this.tween.active) {
      this.tween.t += dt;
      const k = Math.min(1, this.tween.t / TWEEN_DURATION);
      // smoothstep
      const s = k * k * (3 - 2 * k);
      this.camera.position.copy(this.tween.fromPos).lerp(this.desiredPos, s);
      this.camera.quaternion
        .copy(this.tween.fromQuat)
        .slerp(this.desiredQuat, s);
      if (k >= 1) this.tween.active = false;
    } else {
      this.camera.position.copy(this.desiredPos);
      this.camera.quaternion.copy(this.desiredQuat);
    }

    // 3) FOV: lerp toward 60 + min(15, speed/8), capped at 75.
    const speed = targetVelocity.length();
    const fovTarget = Math.min(FOV_MAX, FOV_BASE + Math.min(15, speed / 8));
    const k = 1 - Math.exp(-dt * FOV_LERP_RATE);
    const newFov = this.camera.fov + (fovTarget - this.camera.fov) * k;
    if (Math.abs(newFov - this.camera.fov) > 0.01) {
      this.camera.fov = newFov;
      this.camera.updateProjectionMatrix();
    }
  }

  // ---------- per-mode pose computation ----------

  private computeCockpit(target: THREE.Object3D): void {
    // Eye position = aircraft origin + body offset rotated into world.
    this.tmpVec.copy(COCKPIT_EYE_OFFSET).applyQuaternion(target.quaternion);
    this.desiredPos.copy(target.position).add(this.tmpVec);

    // Look direction = forward in body, rotated into world.
    this.tmpVec2
      .copy(COCKPIT_LOOK_DELTA)
      .applyQuaternion(target.quaternion)
      .add(this.desiredPos);
    // Up = body +Y in world.
    this.tmpVec.set(0, 1, 0).applyQuaternion(target.quaternion);
    this.lookAtQuat(this.desiredPos, this.tmpVec2, this.tmpVec, this.desiredQuat);
  }

  private computeChase(target: THREE.Object3D, dt: number): void {
    // Desired position: aircraft + body offset (behind/above) → world.
    this.tmpVec.copy(CHASE_OFFSET).applyQuaternion(target.quaternion);
    const desiredWorld = this.tmpVec2
      .copy(target.position)
      .add(this.tmpVec);

    // Critically-damped exponential approach (lerp factor 1 - exp(-dt*5)).
    if (this.tween.active) {
      // While tweening, just publish the snap target; the tween blender will
      // smooth from `fromPos` to here.
      this.desiredPos.copy(desiredWorld);
    } else if (this.snapNextChase) {
      // First frame after a setMode(..., instant=true): snap straight to the
      // computed pose instead of dragging in from world origin.
      this.camera.position.copy(desiredWorld);
      this.desiredPos.copy(desiredWorld);
      this.snapNextChase = false;
    } else {
      const k = 1 - Math.exp(-dt * 5);
      this.camera.position.lerp(desiredWorld, k);
      this.desiredPos.copy(this.camera.position);
    }

    // Look at the aircraft, world up.
    this.desiredLookAt.copy(target.position);
    this.tmpVec.set(0, 1, 0);
    this.lookAtQuat(this.desiredPos, this.desiredLookAt, this.tmpVec, this.desiredQuat);
  }

  private computeExternal(target: THREE.Object3D, dt: number): void {
    // Mouse drag (LMB held) overrides auto-rotate this frame.
    if (this.mouseDown && (this.mouseDx !== 0 || this.mouseDy !== 0)) {
      this.externalYaw -= this.mouseDx * 0.005;
      this.externalPitch = THREE.MathUtils.clamp(
        this.externalPitch - this.mouseDy * 0.005,
        -1.2,
        1.2,
      );
    } else {
      this.externalYaw += EXTERNAL_AUTO_RATE * dt;
    }
    // Consume mouse delta each frame.
    this.mouseDx = 0;
    this.mouseDy = 0;

    const cy = Math.cos(this.externalYaw);
    const sy = Math.sin(this.externalYaw);
    const cp = Math.cos(this.externalPitch);
    const sp = Math.sin(this.externalPitch);

    // Spherical offset around target. yaw=0 puts camera on +X (forward) side.
    this.desiredPos.set(
      target.position.x + EXTERNAL_RADIUS * cp * cy,
      target.position.y + EXTERNAL_RADIUS * sp,
      target.position.z + EXTERNAL_RADIUS * cp * sy,
    );

    this.desiredLookAt.copy(target.position);
    this.tmpVec.set(0, 1, 0);
    this.lookAtQuat(this.desiredPos, this.desiredLookAt, this.tmpVec, this.desiredQuat);
  }

  private computeTower(target: THREE.Object3D): void {
    this.desiredPos.copy(TOWER_POS);
    this.desiredLookAt.copy(target.position);
    this.tmpVec.set(0, 1, 0);
    this.lookAtQuat(this.desiredPos, this.desiredLookAt, this.tmpVec, this.desiredQuat);
  }

  private computeFree(target: THREE.Object3D, dt: number): void {
    if (!this.freeInitialised) {
      // Seed position from current camera pose (so transition is sane), and
      // derive yaw/pitch from current quaternion.
      this.desiredPos.copy(this.camera.position);
      this.tmpEuler.setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.freeYaw = this.tmpEuler.y;
      this.freePitch = this.tmpEuler.x;
      this.freeInitialised = true;
    } else {
      this.desiredPos.copy(this.camera.position);
    }

    // Mouse-look while LMB held (consistent with external mode's drag affordance).
    if (this.mouseDown && (this.mouseDx !== 0 || this.mouseDy !== 0)) {
      this.freeYaw -= this.mouseDx * 0.0025;
      this.freePitch = THREE.MathUtils.clamp(
        this.freePitch - this.mouseDy * 0.0025,
        -Math.PI / 2 + 0.01,
        Math.PI / 2 - 0.01,
      );
    }
    this.mouseDx = 0;
    this.mouseDy = 0;

    // Build orientation quaternion (YXZ: yaw then pitch).
    this.tmpEuler.set(this.freePitch, this.freeYaw, 0, 'YXZ');
    this.desiredQuat.setFromEuler(this.tmpEuler);

    // WASD translation in camera-local axes. Forward = -Z (Three convention).
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
      ? FREE_SPEED_BOOST
      : FREE_SPEED_BASE;
    const move = this.tmpVec.set(0, 0, 0);
    if (this.keys.has('KeyW')) move.z -= 1;
    if (this.keys.has('KeyS')) move.z += 1;
    if (this.keys.has('KeyA')) move.x -= 1;
    if (this.keys.has('KeyD')) move.x += 1;
    if (this.keys.has('Space')) move.y += 1;
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize().applyQuaternion(this.desiredQuat).multiplyScalar(speed * dt);
      this.desiredPos.add(move);
    }

    // Suppress unused-parameter lint while keeping API consistent.
    void target;
  }

  // ---------- helpers ----------

  /**
   * Compute a quaternion that orients an object at `eye` to look at
   * `targetPoint` with the given world-up. Writes into `out`.
   */
  private lookAtQuat(
    eye: THREE.Vector3,
    targetPoint: THREE.Vector3,
    up: THREE.Vector3,
    out: THREE.Quaternion,
  ): void {
    // THREE.Matrix4.lookAt produces an orientation as if the object is
    // looking down -Z (camera convention). Use it directly.
    const m = lookAtMatrix(eye, targetPoint, up);
    out.setFromRotationMatrix(m);
  }
}

// Module-level scratch matrix for lookAtQuat (function lives outside the
// class so it can own its own scratch without polluting per-instance state).
const _lookAtMatrix = new THREE.Matrix4();
function lookAtMatrix(
  eye: THREE.Vector3,
  target: THREE.Vector3,
  up: THREE.Vector3,
): THREE.Matrix4 {
  _lookAtMatrix.lookAt(eye, target, up);
  return _lookAtMatrix;
}
