import { defineConfig } from '@playwright/test';

/**
 * Browser / desktop GUI end-to-end tests. Run with `npm run test:e2e`
 * (builds first). On a headless Linux box run under `xvfb-run` for Electron.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'web-gui', testMatch: /(web-gui|portal)\.spec\.ts/, use: { browserName: 'chromium' } },
    { name: 'electron-gui', testMatch: /electron-gui\.spec\.ts/ },
  ],
});
