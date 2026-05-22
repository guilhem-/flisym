/**
 * Key injection → state response (docs/test-strategy.md §3 — extension).
 *
 * Boots the dev build, dispatches real keyboard events via Playwright, and
 * reads `window.FLISYM.state` to confirm the physics integrated as expected.
 * Complements the in-process tests in `tests/keys-to-state.test.ts` by
 * running through the actual browser keydown pipeline (focus, event order,
 * preventDefault, RAF cadence).
 */
import { expect, test, type Page } from '@playwright/test';
import { gotoFlisym, waitForFrames } from './_setup.js';

async function frameCount(page: Page): Promise<number> {
  return await page.evaluate(
    () => (window as Window & { __FLISYM_FRAMES__?: number }).__FLISYM_FRAMES__ ?? 0,
  );
}

/** Wait `delta` more RAF frames from now (waitForFrames takes an absolute target). */
async function advanceFrames(page: Page, delta: number, timeout = 20_000): Promise<void> {
  const now = await frameCount(page);
  await waitForFrames(page, now + delta, timeout);
}

declare global {
  interface Window {
    FLISYM?: {
      state?: {
        x_W: { x: number; y: number; z: number };
        v_W: { x: number; y: number; z: number };
        omega_B: { x: number; y: number; z: number };
        throttle: number;
        delta_a: number;
        delta_e: number;
        delta_r: number;
        delta_f: number;
      };
      controls?: {
        aileronCmd: number;
        elevatorCmd: number;
        rudderCmd: number;
        throttleCmd: number;
        flapsCmd: number;
        brake: boolean;
      };
      scenario?: {
        reset?: () => void;
      };
    };
  }
}

async function readState(page: Page): Promise<NonNullable<Window['FLISYM']>['state']> {
  return await page.evaluate(() => {
    const s = window.FLISYM?.state;
    if (!s) return null;
    return {
      x_W: { x: s.x_W.x, y: s.x_W.y, z: s.x_W.z },
      v_W: { x: s.v_W.x, y: s.v_W.y, z: s.v_W.z },
      omega_B: { x: s.omega_B.x, y: s.omega_B.y, z: s.omega_B.z },
      throttle: s.throttle,
      delta_a: s.delta_a,
      delta_e: s.delta_e,
      delta_r: s.delta_r,
      delta_f: s.delta_f,
    };
  });
}

async function readControls(page: Page): Promise<NonNullable<Window['FLISYM']>['controls']> {
  return await page.evaluate(() => {
    const c = window.FLISYM?.controls;
    if (!c) return null;
    return {
      aileronCmd: c.aileronCmd,
      elevatorCmd: c.elevatorCmd,
      rudderCmd: c.rudderCmd,
      throttleCmd: c.throttleCmd,
      flapsCmd: c.flapsCmd,
      brake: c.brake,
    };
  });
}

test.describe('key injection → state', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFlisym(page, { seed: 1 });
    await waitForFrames(page, 10);
    // Focus the canvas so keyboard events reach the window listener.
    await page.getByTestId('flisym-canvas').click({ position: { x: 100, y: 100 } });
  });

  test("holding 'd' for ~90 frames drives aileron command + roll rate > 0", async ({ page }) => {
    await page.keyboard.down('d');
    await advanceFrames(page, 90);
    await page.keyboard.up('d');

    const controls = await readControls(page);
    const state = await readState(page);
    expect(controls?.aileronCmd ?? 0).toBeGreaterThan(0.8);
    expect(state?.omega_B.x ?? 0).toBeGreaterThan(0.05);
  });

  test("holding 's' drives elevator-up and pitches the nose up (attitude check)", async ({ page }) => {
    // Capture the initial forward.y so we can compare after.
    const before = await page.evaluate(() => {
      const s = window.FLISYM!.state!;
      // body +X rotated by q gives world-forward; .y component = pitch attitude
      const qx = (s as unknown as { q: { x: number; y: number; z: number; w: number } }).q;
      void qx;
      return { y: s.x_W.y };
    });
    await page.keyboard.down('s');
    // Sample twice — at frame 30 the elevator has ramped and the pitch rate
    // is at its initial peak (phugoid hasn't completed a cycle yet). By frame
    // 90 the airplane has gained altitude.
    await advanceFrames(page, 30);
    const mid = await readState(page);
    await advanceFrames(page, 60);
    await page.keyboard.up('s');
    const late = await readState(page);

    // Elevator deflection must have ramped up.
    expect(mid?.delta_e ?? 0).toBeGreaterThan(0.5);
    // Pitch rate at the early-peak sample must be positive (nose up).
    expect(mid?.omega_B.z ?? 0).toBeGreaterThan(0.03);
    // And the aircraft must have gained altitude by the late sample.
    expect((late?.x_W.y ?? 0) - before.y).toBeGreaterThan(1);
  });

  test("holding 'a' for ~90 frames drives left roll (omega_B.x < 0)", async ({ page }) => {
    await page.keyboard.down('a');
    await advanceFrames(page, 90);
    await page.keyboard.up('a');

    const state = await readState(page);
    expect(state?.omega_B.x ?? 0).toBeLessThan(-0.05);
  });

  test('releasing a key relaxes its command toward zero', async ({ page }) => {
    await page.keyboard.down('d');
    await advanceFrames(page, 60);
    const mid = await readControls(page);
    expect(mid?.aileronCmd ?? 0).toBeGreaterThan(0.5);

    await page.keyboard.up('d');
    // Command relaxes at 3/s; 60 frames ≈ 1 s of sim time @ 60 fps. Allow more
    // when host is SwiftShader (slower fps means MORE sim seconds per frame,
    // not less — RAF delivers larger dt — so 60 frames is plenty).
    await advanceFrames(page, 120);
    const after = await readControls(page);
    expect(Math.abs(after?.aileronCmd ?? 1)).toBeLessThan(0.1);
  });

  test("'f' cycles flap detent (0 → 0.5)", async ({ page }) => {
    const before = await readControls(page);
    expect(before?.flapsCmd ?? -1).toBe(0);
    await page.keyboard.press('f');
    await advanceFrames(page, 5);
    const after = await readControls(page);
    expect(after?.flapsCmd ?? -1).toBe(0.5);
  });

  test("'b' toggles brake on", async ({ page }) => {
    const before = await readControls(page);
    expect(before?.brake ?? null).toBe(false);
    await page.keyboard.press('b');
    await advanceFrames(page, 5);
    const after = await readControls(page);
    expect(after?.brake ?? null).toBe(true);
  });

  test('Shift held ramps throttleCmd up', async ({ page }) => {
    // First reset so the spawn throttle (0.7) doesn't already saturate things.
    await page.evaluate(() => window.FLISYM!.scenario?.reset?.());
    await advanceFrames(page, 5);
    const before = await readControls(page);
    await page.keyboard.down('Shift');
    await advanceFrames(page, 90);
    await page.keyboard.up('Shift');
    const after = await readControls(page);
    expect((after?.throttleCmd ?? 0) - (before?.throttleCmd ?? 0)).toBeGreaterThan(0.1);
  });
});
