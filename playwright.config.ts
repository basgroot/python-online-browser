import { defineConfig, devices } from '@playwright/test';

// Phase 0 spike config. Chromium + Firefox only (Safari explicitly out of scope).
export default defineConfig({
  testDir: './tests',
  // The GitHub Pages suite needs its own build and server; it has a dedicated
  // config (playwright.ghpages.config.ts) and must not run here.
  testIgnore: /ghpages\.spec\.ts/,
  // Pyodide boot is heavy; give each test room but not forever.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8123',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: [
    {
      // Serves the raw repo for the low-level spike + integration harnesses.
      command: 'node tests/server.mjs',
      url: 'http://localhost:8123/spike/pyodide/index.html',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // Serves the real, built application - what actually ships.
      command: 'npx vite build && npx vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173/',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
