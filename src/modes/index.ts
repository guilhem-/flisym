// Barrel for the modes module — single import point for main.ts.
//
// Wave B exports: types, registry, switcher, and the two implemented modes
// (Free Flight + Time Trial). Wave C will register Dogfight + Strike Mission
// factories in `registry.ts` (today they live there as throw-stubs so the
// surface is stable).

export type {
  Mode,
  ModeContext,
  ModeMeta,
  ModeStatus,
  ModeTelemetryEvent,
} from './types.js';
export { MODE_REGISTRY, getDefaultModeId } from './registry.js';
export type { ModeId } from './registry.js';
export { ModeSwitcher } from './switcher.js';
export { FreeFlightMode } from './free-flight.js';
export { TimeTrialMode } from './time-trial.js';
