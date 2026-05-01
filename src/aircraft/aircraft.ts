import * as THREE from 'three';
import { buildCessna, type CessnaParts } from './cessna.js';

/**
 * Control surface deflections. All angles are in radians.
 *
 * Sign conventions (matched to body frame +X fwd, +Y up, +Z right):
 *   - aileron: +ve = roll-right command. Right aileron up, left aileron down.
 *   - elevator: +ve = pitch-up command. Trailing edge up.
 *   - rudder: +ve = yaw-right command. Trailing edge right.
 *   - flaps: +ve = flaps deployed (trailing edge down). Conventionally >= 0.
 */
export interface ControlDeflections {
  aileron: number;
  elevator: number;
  rudder: number;
  flaps: number;
}

const ZERO_CONTROLS: ControlDeflections = {
  aileron: 0,
  elevator: 0,
  rudder: 0,
  flaps: 0,
};

export class Aircraft {
  /** Public group, ready to be added to a scene. Origin is at gear contact. */
  public readonly group: THREE.Group;

  private readonly parts: CessnaParts;
  private propellerRpm = 0;
  /** Accumulated propeller angle (radians). */
  private propellerAngle = 0;

  constructor() {
    const built = buildCessna();
    this.group = built.group;
    this.parts = built.parts;
    // Initialize all control surfaces to zero.
    this.setControls(ZERO_CONTROLS);
  }

  /**
   * Apply control surface deflections. Angles in radians; see
   * {@link ControlDeflections} for sign conventions.
   */
  setControls(c: ControlDeflections): void {
    // Ailerons: hinge along +Z. Right aileron up = trailing edge up =
    //   rotation about +Z that brings the trailing edge (at -X) towards +Y,
    //   which by right-hand rule is a positive rotation about +Z.
    //   Right rolls right when right aileron up + left aileron down.
    this.parts.rightAileron.rotation.set(0, 0, +c.aileron);
    this.parts.leftAileron.rotation.set(0, 0, -c.aileron);

    // Elevator: hinge along +Z. +elevator (pitch up) = trailing edge up =
    //   rotation about +Z by +elevator.
    this.parts.elevator.rotation.set(0, 0, +c.elevator);

    // Rudder: hinge along +Y. +rudder (yaw right) = trailing edge to +Z
    //   (right). Trailing edge is at -X relative to the pivot, so rotating
    //   about +Y by +rudder moves -X towards +Z. That's a positive rotation
    //   about +Y by right-hand rule.
    this.parts.rudder.rotation.set(0, +c.rudder, 0);

    // Flaps: hinge along +Z. Flaps down = trailing edge down (towards -Y).
    //   Rotation about +Z that moves -X (trailing edge) towards -Y is a
    //   negative rotation about +Z. Convention: callers pass non-negative
    //   `flaps` for a flaps-down deployment.
    this.parts.flaps.rotation.set(0, 0, -c.flaps);
  }

  /**
   * Set the propeller RPM. The propeller is animated each {@link update}
   * call; this just stores the target spin rate.
   */
  setPropellerRPM(rpm: number): void {
    this.propellerRpm = rpm;
  }

  /**
   * Step time-dependent visuals. Currently spins the propeller.
   * @param dt time delta in seconds.
   */
  update(dt: number): void {
    // RPM -> rad/s : (rpm / 60) * 2π
    const omega = (this.propellerRpm / 60) * Math.PI * 2;
    this.propellerAngle += omega * dt;
    // Propeller hinge axis: aircraft's nose direction = +X. So we rotate
    //   about +X to spin in the plane normal to flight direction.
    this.parts.propeller.rotation.x = this.propellerAngle;
  }
}
