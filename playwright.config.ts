import { defineConfig } from '@playwright/test';
import { BASE_URL } from './tests/e2e/config.mjs';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 8_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'date-controls-webkit', testMatch: '**/date-controls.spec.ts', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node tests/e2e/web-server-wrapper.mjs',
    url: BASE_URL,
    // The local D1 migration set is intentionally run from a clean persisted
    // directory. Give Wrangler enough time to finish it before classifying the
    // environment as unavailable.
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
