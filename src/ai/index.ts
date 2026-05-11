// Barrel exports for the AI pilot module. See docs/ai-spec.md.
//
// Public API used by the host (Wave C wiring):
//   - createAIPilot(seed, tuning) → AIPilot
//   - AI_TUNING_{VETERAN,ROOKIE,ACE}
//   - observe / createPercepts (for the host's pre-tick fill)
//   - leadSolve / targetScore (for host-side prefiltering)
//   - seedRNG (test helper to re-seed the module-level RNG)

import { createAIRng, type AIRng } from './prng.js';

export { mulberry32, createAIRng } from './prng.js';
export type { AIRng } from './prng.js';

export {
  AI_TUNING_VETERAN,
  AI_TUNING_ROOKIE,
  AI_TUNING_ACE,
} from './tuning.js';
export type { AI_TUNING } from './tuning.js';

export {
  createPercepts,
  observe,
  wrapPi,
  headingFromQuat,
  pitchFromQuat,
  rollFromQuat,
} from './percepts.js';
export type {
  Percepts,
  EnemyView,
  IncomingMissile,
  ObserveTuning,
} from './percepts.js';

export { transition, createFsmMemory } from './fsm.js';
export type { FsmState, Goal, GoalIntent, FsmMemory } from './fsm.js';

export {
  altitudeToPitch,
  bankToRollRate,
  clamp,
  createControllerState,
  headingToBank,
  pitchToElevator,
  quantize,
  rollRateToAileron,
  slew,
  speedToThrottle,
  yawCoordinator,
} from './controllers.js';
export type { ControllerState } from './controllers.js';

export { leadSolve, targetScore, bearingToPoint } from './targeting.js';

export { createAIPilot } from './pilot.js';
export type { AIPilot, AIPilotSnapshot } from './pilot.js';

// ---------- Module-level RNG for test trainers ----------
//
// `seedRNG(n)` re-seeds a single module-level AIRng used by Wave D test
// trainers that need shared randomness across multiple bots (e.g. spawn
// position scatter). Production code should always pass an explicit `seed`
// to `createAIPilot`.

let _moduleRng: AIRng = createAIRng(1);

export function seedRNG(n: number): void {
  _moduleRng = createAIRng(n >>> 0);
}

export function moduleRng(): AIRng {
  return _moduleRng;
}
