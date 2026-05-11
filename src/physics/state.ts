// Aircraft state and controls. See spec §2.

import * as THREE from 'three';
import { FLIGHT_MODEL } from './flightModel.js';

/**
 * Pilot input commands (target values), in [-1..1] for surfaces, [0..1] for
 * throttle and flaps. These are commanded values; actual deflections are slewed
 * inside the controls module.
 */
export interface Controls {
  aileronCmd: number;   // [-1..1] +1 = right roll
  elevatorCmd: number;  // [-1..1] +1 = nose up
  rudderCmd: number;    // [-1..1] +1 = nose right
  throttleCmd: number;  // [0..1]
  flapsCmd: number;     // [0..1] (3 detents 0/0.5/1, but stored continuous)
  brake: boolean;       // parking brake
}

/**
 * Per-zone hit-points for the v0.2 combat damage model (see
 * `docs/combat-spec.md` §4). Optional on AircraftState so v0.1 callers
 * that never touch combat see byte-for-byte identical behavior.
 */
export interface AircraftHp {
  airframe: number;
  engine: number;
  controls: {
    aileron: number;
    elevator: number;
    rudder: number;
  };
}

/**
 * Full aircraft 6DOF state. ω_B uses the spec's axis packing where
 *   ω_B.x = p (roll rate, body +X)
 *   ω_B.y = r (yaw rate,  body +Y)
 *   ω_B.z = q (pitch rate, body +Z)
 */
export interface AircraftState {
  /** CG position in world frame (Three.js, Y-up). */
  x_W: THREE.Vector3;
  /** Linear velocity in world frame. */
  v_W: THREE.Vector3;
  /** Body→world quaternion (Three.js convention). */
  q: THREE.Quaternion;
  /** Body angular rates packed (p, r, q) in (.x, .y, .z). */
  omega_B: THREE.Vector3;

  /** Actual throttle [0..1] (lagged from command). */
  throttle: number;
  /** Aileron deflection [-1..1] (slewed from command). */
  delta_a: number;
  /** Elevator deflection [-1..1]. */
  delta_e: number;
  /** Rudder deflection [-1..1]. */
  delta_r: number;
  /** Flap setting [0..1]. */
  delta_f: number;

  onGround: boolean;
  stallFlag: boolean;

  /** Sim time accumulated, seconds. Used for buffet phase. */
  time: number;
  /** Render-time accumulator for fixed-step integration. */
  accumulator: number;

  /**
   * v0.2 combat damage zones. Optional: physics code only reacts when
   * defined, so v0.1 callers that never set `hp` get identical behavior.
   */
  hp?: AircraftHp;
  /** True while `hp.airframe > 0`. v0.1 default `true`. */
  isAlive?: boolean;
  /** When `state.time >= respawnAt`, combat system calls respawn(). */
  respawnAt?: number | null;
}

export function createInitialState(): AircraftState {
  return {
    x_W: new THREE.Vector3(0, FLIGHT_MODEL.groundY, 0),
    v_W: new THREE.Vector3(0, 0, 0),
    q: new THREE.Quaternion(0, 0, 0, 1),
    omega_B: new THREE.Vector3(0, 0, 0),
    throttle: 0,
    delta_a: 0,
    delta_e: 0,
    delta_r: 0,
    delta_f: 0,
    onGround: true,
    stallFlag: false,
    time: 0,
    accumulator: 0,
    hp: {
      airframe: 100,
      engine: 100,
      controls: { aileron: 100, elevator: 100, rudder: 100 },
    },
    isAlive: true,
    respawnAt: null,
  };
}

export function createNeutralControls(): Controls {
  return {
    aileronCmd: 0,
    elevatorCmd: 0,
    rudderCmd: 0,
    throttleCmd: 0,
    flapsCmd: 0,
    brake: false,
  };
}
