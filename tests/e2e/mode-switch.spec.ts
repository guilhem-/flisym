/**
 * S2 — `mode-switch.spec.ts` (docs/test-strategy.md §3.4)
 *
 * Presses each of the 1/2/3/4 hotkeys and verifies the HUD mode badge
 * advertises the matching mode id. The badge's `data-mode-id` attribute
 * mirrors `ModeStatus.id` verbatim (see `src/hud/hud.ts` `setMode`), which
 * is more robust than text matching — Time Trial's running headline is
 * "Gate N/12 · …" and never contains the substring "TIME TRIAL", so
 * `toHaveText(/time-trial/i)` would fail. The attribute is the canonical
 * source of truth.
 */
import { expect, test } from '@playwright/test';
import { gotoFlisym, waitForFrames } from './_setup.js';

const MODES: ReadonlyArray<{ key: string; id: string }> = [
  { key: '1', id: 'free-flight' },
  { key: '2', id: 'time-trial' },
  { key: '3', id: 'dogfight' },
  { key: '4', id: 'strike-mission' },
];

test.describe('mode switch', () => {
  for (const { key, id } of MODES) {
    test(`hotkey ${key} → ${id}`, async ({ page }) => {
      await gotoFlisym(page, { seed: 0 });
      // Ensure the sim is actually ticking before keys are dispatched —
      // mode constructors expect a live ctx.
      await waitForFrames(page, 5);
      // Click the canvas first so the keyboard events reach the window
      // listener (some browsers ignore key events before focus).
      await page.getByTestId('flisym-canvas').click({ position: { x: 100, y: 100 } });
      await page.keyboard.press(key);
      await expect(page.getByTestId('hud-mode-name')).toHaveAttribute(
        'data-mode-id',
        id,
        { timeout: 5_000 },
      );
    });
  }
});
