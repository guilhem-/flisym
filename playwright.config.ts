import { defineConfig, devices } from '@playwright/test';

/**
 * FLISYM Playwright config. See docs/test-strategy.md §3.1.
 *
 * Software-WebGL (SwiftShader) is forced via Chromium launch args so the
 * suite can run on CI / sandboxed hosts. On hosts where even that fails,
 * each spec self-skips via the `__FLISYM_WEBGL_OK__` global (see
 * `tests/e2e/_setup.ts`).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  reporter: 'line',
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
    actionTimeout: 5_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
            '--disable-dev-shm-usage',
          ],
        },
      },
    },
  ],
});
