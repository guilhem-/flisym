// Mode factory registry.
//
// Maps stable mode ids to zero-arg factories that return a fresh `Mode`
// instance. `getDefaultModeId()` inspects `location.search` for `?mode=<id>`
// and falls back to `'free-flight'` when the URL is absent or invalid.
//
// Dogfight and Strike Mission land in Wave C — their slots are present so
// the registry contract is stable, but invoking the factory throws so any
// accidental wiring fails loudly instead of silently booting nothing.

import type { Mode, ModeMeta } from './types.js';
import { FreeFlightMode } from './free-flight.js';
import { TimeTrialMode } from './time-trial.js';

export type ModeId = ModeMeta['id'];

export const MODE_REGISTRY: ReadonlyMap<ModeId, () => Mode> = new Map<ModeId, () => Mode>([
  ['free-flight', () => new FreeFlightMode()],
  ['time-trial', () => new TimeTrialMode()],
  [
    'dogfight',
    (): Mode => {
      throw new Error('dogfight not implemented yet');
    },
  ],
  [
    'strike-mission',
    (): Mode => {
      throw new Error('strike-mission not implemented yet');
    },
  ],
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
