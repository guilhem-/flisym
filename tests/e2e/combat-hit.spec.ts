/**
 * S3 — `combat-hit.spec.ts` (docs/test-strategy.md §3.4)
 *
 * `?seed=42` pins the AI RNG. Drops into the dogfight trainer (bot spawns
 * close + on a head-on heading), pulses Space at 50 ms cadence up to 80
 * times, and waits for a kill-feed entry to appear.
 */
import { expect, test } from '@playwright/test';
import { gotoFlisym, waitForFrames } from './_setup.js';

declare global {
  interface Window {
    FLISYM?: {
      scenario?: {
        dogfightTrainer?: () => void;
        timeTrialTrainer?: () => void;
        reset?: () => void;
      };
    };
  }
}

test.describe('combat hit', () => {
  test('Space-pulse in dogfightTrainer produces a kill-feed entry', async ({ page }) => {
    await gotoFlisym(page, { seed: 42 });
    await waitForFrames(page, 5);

    // Drop into the dogfight scenario. window.FLISYM.scenario is dev-only
    // (`import.meta.env.DEV`) so this requires `npm run dev`.
    const scenarioReady = await page.evaluate(
      () => typeof window.FLISYM?.scenario?.dogfightTrainer === 'function',
    );
    test.skip(
      !scenarioReady,
      'window.FLISYM.scenario is dev-only — skip if running against a production build',
    );

    await page.evaluate(() => window.FLISYM!.scenario!.dogfightTrainer!());
    // Click canvas to focus, then settle so the bot reaches firing
    // position. SwiftShader gives ~8 fps so this targets ~30 frames /
    // ~4 s of wall time with a generous timeout.
    await page.getByTestId('flisym-canvas').click({ position: { x: 100, y: 100 } });
    await waitForFrames(page, 30, 20_000);

    // Pulse Space 80 times at 50 ms cadence. waitForTimeout is OK here —
    // it's a key-rate pacer, not a deadline (§3.5).
    for (let i = 0; i < 80; i += 1) {
      await page.keyboard.press('Space');
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(50);
      const hasKill = await page.evaluate(
        () =>
          document.querySelectorAll('[data-testid="hud-kill-feed-entry"]')
            .length > 0,
      );
      if (hasKill) break;
    }

    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="hud-kill-feed-entry"]').length > 0,
      null,
      { timeout: 20_000 },
    );

    const count = await page
      .locator('[data-testid="hud-kill-feed-entry"]')
      .count();
    expect(count).toBeGreaterThan(0);
  });
});
