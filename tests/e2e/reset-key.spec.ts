/**
 * S5 — `reset-key.spec.ts` (docs/test-strategy.md §3.4)
 *
 * Verifies the aircraft position resets to spawn. main.ts wires no R-key
 * handler (the test-strategy text was aspirational — see the producer
 * report); the canonical reset surface is
 * `window.FLISYM.scenario.reset()`, gated behind `import.meta.env.DEV`.
 *
 * Strategy: let the sim run for ~120 frames so the aircraft drifts away
 * from spawn (it spawns cruising east at 50 m/s, so x_W.x advances by
 * tens of metres), then invoke `reset()` and assert the position snaps
 * back to the configured spawn point.
 */
import { expect, test } from '@playwright/test';
import { gotoFlisym, waitForFrames } from './_setup.js';

declare global {
  interface Window {
    FLISYM?: {
      state?: { x_W: { x: number; y: number; z: number } };
      scenario?: { reset?: () => void };
    };
  }
}

const SPAWN_X = -700; // matches src/main.ts SPAWN

test.describe('reset', () => {
  test('FLISYM.scenario.reset() returns aircraft to spawn', async ({ page }) => {
    await gotoFlisym(page, { seed: 0 });

    const scenarioReady = await page.evaluate(
      () => typeof window.FLISYM?.scenario?.reset === 'function',
    );
    test.skip(
      !scenarioReady,
      'window.FLISYM.scenario is dev-only — skip if running against a production build',
    );

    // Let the sim run so the aircraft moves away from spawn. SwiftShader
    // hosts can run at ~8 fps so we need a generous timeout for a small
    // frame budget. Even 30 frames (~3.5 s wall time at 8 fps; ~50 m of
    // travel at 50 m/s cruise) is plenty of drift.
    await waitForFrames(page, 30, 20_000);
    const xBefore = await page.evaluate(() => window.FLISYM!.state!.x_W.x);
    expect(xBefore).toBeGreaterThan(SPAWN_X);

    await page.evaluate(() => window.FLISYM!.scenario!.reset!());

    const xAfter = await page.evaluate(() => window.FLISYM!.state!.x_W.x);
    expect(Math.abs(xAfter - SPAWN_X)).toBeLessThan(1);
  });
});
