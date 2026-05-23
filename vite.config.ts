/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  // Relative base so dist/index.html and docs/play.html work from any path,
  // including file:// (needed for the offline single-file build).
  base: './',
  publicDir: 'public',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    assetsInlineLimit: 4096,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    open: false,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  test: {
    // Vitest must NOT pick up Playwright e2e specs — they use @playwright/test,
    // not Vitest, and live under tests/e2e/.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      'tests/e2e/**',
    ],
  },
});
