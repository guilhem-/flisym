/**
 * S4 — `time-trial-gate.spec.ts` (docs/test-strategy.md §3.4)
 *
 * `?seed=1` for determinism. Drops into the time-trial trainer (positions
 * the aircraft slightly before gate 0 with cruise velocity so it crosses
 * the first gate within a few seconds with no input), then polls the
 * `data-gates-pass` attribute on the CHALLENGE panel.
 */
import { expect, test } from '@playwright/test';
import { gotoFlisym, waitForFrames } from './_setup.js';

test.describe('time trial', () => {
  test('crossing gate 0 increments hud-gates-pass', async ({ page }) => {
    await gotoFlisym(page, { seed: 1 });
    await waitForFrames(page, 5);

    const scenarioReady = await page.evaluate(
      () => typeof window.FLISYM?.scenario?.timeTrialTrainer === 'function',
    );
    test.skip(
      !scenarioReady,
      'window.FLISYM.scenario is dev-only — skip if running against a production build',
    );

    await page.evaluate(() => window.FLISYM!.scenario!.timeTrialTrainer!());

    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="hud-gates-pass"]');
        const raw = el?.getAttribute('data-gates-pass') ?? '0';
        return Number(raw) >= 1;
      },
      null,
      { timeout: 15_000 },
    );

    const gates = await page.evaluate(() =>
      Number(
        document
          .querySelector('[data-testid="hud-gates-pass"]')
          ?.getAttribute('data-gates-pass') ?? 0,
      ),
    );
    expect(gates).toBeGreaterThanOrEqual(1);
  });
});
