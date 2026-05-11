// Public API for the physics module.

export { FLIGHT_MODEL } from './flightModel.js';
export type { FlightModelConstants } from './flightModel.js';

export { density, densityRatio, pressure, temperature, speedOfSound } from './atmosphere.js';

export {
  computeAeroForcesMoments,
  liftCoefficient,
  dragCoefficient,
  sideForceCoefficient,
  rollMomentCoefficient,
  pitchMomentCoefficient,
  yawMomentCoefficient,
} from './aero.js';
export type { AeroResult } from './aero.js';

export { thrust } from './propulsion.js';

export { updateControlSurfaces } from './controls.js';

export { physicsStep, advance, setWindFn } from './step.js';
export type { GroundHeightFn, WindFn } from './step.js';

export { createInitialState, createNeutralControls } from './state.js';
export type { AircraftState, AircraftHp, Controls } from './state.js';
