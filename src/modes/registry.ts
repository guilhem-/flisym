// Mode factory registry.
//
// Maps stable mode ids to zero-arg factories that return a fresh `Mode`
// instance. `getDefaultModeId()` inspects `location.search` for `?mode=<id>`
// and falls back to `'free-flight'` when the URL is absent or invalid.

import type { Mode, ModeMeta } from './types.js';
import { FreeFlightMode } from './free-flight.js';
import { TimeTrialMode } from './time-trial.js';
import { DogfightMode } from './dogfight.js';
import { StrikeMissionMode } from './strike-mission.js';

export type ModeId = ModeMeta['id'];

export const MODE_REGISTRY: ReadonlyMap<ModeId, () => Mode> = new Map<ModeId, () => Mode>([
  ['free-flight', () => new FreeFlightMode()],
  ['time-trial', () => new TimeTrialMode()],
  ['dogfight', () => new DogfightMode()],
  ['strike-mission', () => new StrikeMissionMode()],
]);

const VALID_IDS: ReadonlySet<string> = new Set<string>([
  'free-flight',
  'time-trial',
  'dogfight',
  'strike-mission',
]);

/**
 * Resolve the default boot mode id from `location.search`. Returns
 * `'free-flight'` when the URL has no `?mode=` query, when the value is
 * unrecognized, or when `location` is unavailable (non-browser env).
 */
export function getDefaultModeId(): ModeId {
  if (typeof window === 'undefined' || !window.location) {
    return 'free-flight';
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const candidate = params.get('mode');
    if (candidate && VALID_IDS.has(candidate)) {
      return candidate as ModeId;
    }
  } catch {
    // fallthrough to default
  }
  return 'free-flight';
}
