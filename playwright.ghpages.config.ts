import { defineConfig, devices } from '@playwright/test';

/**
 * Verifies the build works as a GitHub Pages *project* site:
 * served from a subpath, with no custom headers.
 *
 * Kept separate from the main config so the everyday suite does not pay for a
 * second production build.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: /ghpages\.spec\.ts/,
  timeout: 150_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: {
    command:
      'BASE_PATH=/python-web/ npx vite build --outDir dist-ghpages && node tests/subpath-server.mjs',
    url: 'http://localhost:4174/python-web/',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
