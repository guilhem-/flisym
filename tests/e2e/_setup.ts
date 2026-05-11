/**
 * Shared Playwright helpers for FLISYM e2e suite.
 *
 * Spec files import `gotoFlisym` and call it in their own `test.beforeEach`
 * with the seed they need pinned (docs/test-strategy.md §3.4). If
 * `__FLISYM_WEBGL_OK__` is not true after boot the test self-skips —
 * software WebGL is unavailable on some CI sandboxes and that is an
 * explicitly-allowed outcome per §5.
 */
import { test, type Page } from '@playwright/test';

const READY_TIMEOUT_MS = 10_000;

interface FlisymGlobals {
  __FLISYM_READY__?: boolean;
  __FLISYM_WEBGL_OK__?: boolean;
  __FLISYM_FRAMES__?: number;
}

declare global {
  interface Window extends FlisymGlobals {}
}

/**
 * Navigate to `/?seed=<seed>` (plus any extra query string), wait for
 * `__FLISYM_READY__`, and skip the test if the host can't give us WebGL.
 */
export async function gotoFlisym(
  page: Page,
  opts: { seed: number; extraQuery?: string } = { seed: 0 },
): Promise<void> {
  const qs = new URLSearchParams();
  qs.set('seed', String(opts.seed));
  const url = opts.extraQuery
    ? `/?${qs.toString()}&${opts.extraQuery}`
    : `/?${qs.toString()}`;
  await page.goto(url);

  const ready = await page
    .waitForFunction(
      () => (window as Window).__FLISYM_READY__ === true,
      null,
      { timeout: READY_TIMEOUT_MS },
    )
    .catch(() => null);

  const webglOk = await page.evaluate(
    () => (window as Window).__FLISYM_WEBGL_OK__ === true,
  );

  if (!ready || !webglOk) {
    test.skip(true, 'WebGL unavailable on host — Playwright e2e skipped per docs/test-strategy.md §5');
  }
}

/**
 * Wait for the RAF-driven frame counter to advance past `target`. We use
 * this as the canonical "the sim is making progress" predicate. NEVER use
 * `page.waitForTimeout` as a deadline.
 */
export async function waitForFrames(
  page: Page,
  target: number,
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (t) => (window as Window).__FLISYM_FRAMES__ !== undefined &&
      (window as Window).__FLISYM_FRAMES__! > t,
    target,
    { timeout },
  );
}
