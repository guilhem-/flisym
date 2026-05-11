/**
 * S1 — `boot.spec.ts` (docs/test-strategy.md §3.4)
 *
 * Verifies the page boots cleanly:
 *  - canvas + HUD are visible
 *  - the RAF-driven frame counter advances past 30 (≈0.5 s of real time)
 */
import { expect, test } from '@playwright/test';
import { gotoFlisym, waitForFrames } from './_setup.js';

test.describe('boot', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFlisym(page, { seed: 0 });
  });

  test('canvas + HUD visible and frames advance', async ({ page }) => {
    await expect(page.getByTestId('flisym-canvas')).toBeVisible();
    await expect(page.getByTestId('flisym-hud')).toBeVisible();
    await waitForFrames(page, 30);
  });
});
