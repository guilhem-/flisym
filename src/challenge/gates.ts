// Aerobatic gate course. 12 floating toruses arranged along a winding path
// the player must thread. Detection is via per-frame plane-crossing of the
// active gate, with a lateral-distance check against the inner radius.
//
// Conventions:
//  - World axes: +X east, +Y up, +Z south. Heading 000° = -Z.
//  - "Gate normal" is the axis the torus disc is normal to — i.e. the
//    direction the player must fly through. We orient each torus by its
//    normal vector; quaternion is computed via setFromUnitVectors so the
//    geometry's native +Z axis aligns with that normal.
//  - The course timer starts on the first plane-crossing of gate 0, whether
//    or not it counts as cleared.

import * as THREE from 'three';

export interface GateState {
  activeIndex: number;     // current target gate (0..N). Equals N when finished.
  totalCleared: number;    // gates cleared so far
  missed: number;          // gates skipped (plane crossed, lateral > inner R)
  courseTime: number;      // seconds since timer started; 0 until first crossing
  finished: boolean;       // true once last gate has been resolved
}

const GATE_RADIUS = 25;     // metres (torus disc radius)
const GATE_TUBE = 1.5;      // metres (torus tube radius)
const CLEAR_RADIUS = 23;    // a touch under inner radius for a fair clear test

const COLOR_START = new THREE.Color(0x00ffff); // cyan
const COLOR_END = new THREE.Color(0xff00ff);   // magenta

// Hard-coded path — east through gate 0, climb north, hairpin, return.
// Each entry: [x, y, z, normalX, normalY, normalZ]. Normal is the direction
// the aircraft should be flying when it passes through the gate.
const GATE_PATH: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  // 0: gate at (1500, 250, 0), pointing +X (player flies east through it)
  [1500, 250, 0, 1, 0, 0],
  // 1: north-east, climbing — still mostly +X with a touch of -Z
  [2100, 380, -250, 0.92, 0.10, -0.38],
  // 2: continuing the climb, curving north
  [2550, 560, -700, 0.65, 0.10, -0.75],
  // 3: top of the climb, heading north
  [2700, 800, -1300, 0.20, 0.05, -0.98],
  // 4: high cruise north — apex
  [2500, 1050, -2000, -0.30, 0.05, -0.95],
  // 5: lead-in to the hairpin — heading west-ish, descending slightly
  [1900, 1150, -2400, -0.80, -0.05, -0.60],
  // 6: HAIRPIN — sharp 90° turn, still heading mostly west
  [1100, 1100, -2500, -1, 0, 0],
  // 7: post-hairpin, snapped to a southward heading (the 90° pivot)
  [800, 1000, -2200, 0, 0, 1],
  // 8: descending south, curving back east
  [950, 850, -1500, 0.45, -0.10, 0.89],
  // 9: continuing return leg, lower
  [1300, 650, -800, 0.75, -0.15, 0.65],
  // 10: low and east, almost back to the start line
  [1700, 470, -250, 0.95, -0.10, 0.30],
  // 11: finish — past the start, heading east again
  [2200, 380, 100, 1, 0, 0.05],
];

function gateColor(i: number, count: number): THREE.Color {
  const t = count <= 1 ? 0 : i / (count - 1);
  return new THREE.Color().lerpColors(COLOR_START, COLOR_END, t);
}

interface Gate {
  readonly mesh: THREE.Mesh;
  readonly center: THREE.Vector3;
  readonly normal: THREE.Vector3; // unit
  readonly baseColor: THREE.Color;
  /** Sign of (aircraftPos - center) · normal at the previous frame, or 0 if unknown. */
  prevSide: number;
}

export class GateCourse {
  readonly mesh: THREE.Group;

  private readonly gates: Gate[] = [];
  private state: GateState = {
    activeIndex: 0,
    totalCleared: 0,
    missed: 0,
    courseTime: 0,
    finished: false,
  };
  private timerStarted = false;

  // Scratch vectors to avoid per-frame allocation.
  private readonly _toAircraft = new THREE.Vector3();
  private readonly _lateral = new THREE.Vector3();

  constructor() {
    this.mesh = new THREE.Group();
    this.mesh.name = 'GateCourse';

    const geom = new THREE.TorusGeometry(GATE_RADIUS, GATE_TUBE, 8, 24);
    // Geometry is in the XY plane → its native normal is +Z. We rotate to face
    // each gate's desired normal via setFromUnitVectors below.
    const baseAxis = new THREE.Vector3(0, 0, 1);
    const tmpNormal = new THREE.Vector3();

    for (let i = 0; i < GATE_PATH.length; i++) {
      const entry = GATE_PATH[i]!;
      const center = new THREE.Vector3(entry[0], entry[1], entry[2]);
      tmpNormal.set(entry[3], entry[4], entry[5]).normalize();

      const baseColor = gateColor(i, GATE_PATH.length);
      const material = new THREE.MeshBasicMaterial({ color: baseColor.clone() });
      const mesh = new THREE.Mesh(geom, material);
      mesh.position.copy(center);
      mesh.quaternion.setFromUnitVectors(baseAxis, tmpNormal);
      mesh.name = `Gate_${i}`;
      this.mesh.add(mesh);

      this.gates.push({
        mesh,
        center,
        normal: tmpNormal.clone(),
        baseColor,
        prevSide: 0,
      });
    }

    this.applyVisuals();
  }

  /** Advance gate logic and produce a snapshot for HUD/UI. */
  update(
    aircraftPos: THREE.Vector3,
    _aircraftVel: THREE.Vector3,
    dt: number,
  ): GateState {
    if (this.state.finished) {
      return this.snapshot();
    }

    if (this.timerStarted) {
      this.state.courseTime += dt;
    }

    const idx = this.state.activeIndex;
    const gate = this.gates[idx];
    if (!gate) {
      // Defensive — shouldn't happen since we mark finished below.
      this.state.finished = true;
      return this.snapshot();
    }

    this._toAircraft.copy(aircraftPos).sub(gate.center);
    const along = this._toAircraft.dot(gate.normal);
    const side = along > 0 ? 1 : along < 0 ? -1 : 0;

    // Detect plane-crossing: prev side and current side have opposite signs.
    // We require prevSide !== 0 so we don't trigger on the first frame.
    const crossed = gate.prevSide !== 0 && side !== 0 && side !== gate.prevSide;

    if (crossed) {
      // Lateral component: total - along*normal.
      this._lateral
        .copy(this._toAircraft)
        .addScaledVector(gate.normal, -along);
      const lateralDist = this._lateral.length();

      if (!this.timerStarted) {
        this.timerStarted = true;
      }

      const cleared = lateralDist < CLEAR_RADIUS;
      if (cleared) {
        this.state.totalCleared += 1;
        this.markCleared(gate);
      } else {
        this.state.missed += 1;
        this.markMissed(gate);
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('challenge:gate', { detail: { index: idx, cleared, t: this.state.courseTime } }));
      }
      this.advance();
    } else {
      gate.prevSide = side === 0 ? gate.prevSide : side;
    }

    this.applyVisuals();
    return this.snapshot();
  }

  /** Reset all course state and visuals. */
  reset(): void {
    this.state = {
      activeIndex: 0,
      totalCleared: 0,
      missed: 0,
      courseTime: 0,
      finished: false,
    };
    this.timerStarted = false;
    for (const g of this.gates) {
      g.prevSide = 0;
      g.mesh.visible = true;
      g.mesh.scale.setScalar(1);
      const mat = g.mesh.material as THREE.MeshBasicMaterial;
      mat.color.copy(g.baseColor);
      mat.opacity = 1;
      mat.transparent = false;
    }
    this.applyVisuals();
  }

  private advance(): void {
    this.state.activeIndex += 1;
    if (this.state.activeIndex >= this.gates.length) {
      this.state.finished = true;
    }
  }

  private markCleared(gate: Gate): void {
    const mat = gate.mesh.material as THREE.MeshBasicMaterial;
    // Dim cleared gates so the player's eye is drawn to the next one.
    mat.color.copy(gate.baseColor).multiplyScalar(0.35);
    gate.mesh.scale.setScalar(1);
  }

  private markMissed(gate: Gate): void {
    const mat = gate.mesh.material as THREE.MeshBasicMaterial;
    mat.color.set(0x553333);
    gate.mesh.scale.setScalar(1);
  }

  private applyVisuals(): void {
    const active = this.state.activeIndex;
    for (let i = 0; i < this.gates.length; i++) {
      const g = this.gates[i]!;
      if (i === active && !this.state.finished) {
        const mat = g.mesh.material as THREE.MeshBasicMaterial;
        // Emissive boost: brighten the base color and scale the ring up.
        mat.color.copy(g.baseColor).multiplyScalar(1.4);
        g.mesh.scale.setScalar(1.4);
      } else if (i > active) {
        // Upcoming gates: base color, normal scale.
        const mat = g.mesh.material as THREE.MeshBasicMaterial;
        mat.color.copy(g.baseColor);
        g.mesh.scale.setScalar(1);
      }
      // Cleared/missed gates keep whatever markCleared/markMissed set.
    }
  }

  private snapshot(): GateState {
    return { ...this.state };
  }
}
