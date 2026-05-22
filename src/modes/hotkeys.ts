// Wire the 1/2/3/4 mode-switch hotkeys.
//
// Extracted from main.ts so the behavior is unit-testable. The listener is
// the only thing that mutates ModeSwitcher in response to user input.
//
// Behavior (frozen by docs/test-strategy.md §3.2):
//   - Keys '1'..'4' map to free-flight, time-trial, dogfight, strike-mission.
//   - If the event target is an <input> or <textarea>, ignore (player is
//     typing into a UI).
//   - If the requested mode is already active, ignore (no dispose+re-init).
//   - On a successful switch, also push the new status to the HUD.
//   - The dispose function returned removes the listener.

import type { HUD } from '../hud/index.js';
import type { ModeSwitcher } from './switcher.js';
import type { ModeId } from './registry.js';

export const MODE_HOTKEYS: Readonly<Record<string, ModeId>> = {
  '1': 'free-flight',
  '2': 'time-trial',
  '3': 'dogfight',
  '4': 'strike-mission',
};

/**
 * Attach a keydown listener to `win` that switches modes on 1/2/3/4. Returns
 * a dispose function that removes the listener.
 */
export function installModeHotkeys(
  switcher: ModeSwitcher,
  hud: Pick<HUD, 'setMode'>,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const handler = (e: KeyboardEvent): void => {
    // `HTMLInputElement` / `HTMLTextAreaElement` are not defined in non-DOM
    // hosts (vitest's default node env, web workers, SSR). Guard with typeof
    // so the listener doesn't ReferenceError on `instanceof`.
    if (typeof HTMLInputElement !== 'undefined' && e.target instanceof HTMLInputElement) {
      return;
    }
    if (typeof HTMLTextAreaElement !== 'undefined' && e.target instanceof HTMLTextAreaElement) {
      return;
    }
    const next = MODE_HOTKEYS[e.key];
    if (!next) return;
    if (switcher.getCurrent()?.meta.id === next) return;
    try {
      switcher.setMode(next);
      hud.setMode(switcher.status());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[mode] failed to switch to ${next}:`, err);
    }
  };
  win.addEventListener('keydown', handler as EventListener);
  return () => win.removeEventListener('keydown', handler as EventListener);
}
