import { defineConfig } from '@playwright/test';

// No Wrangler/D1/auth server: the spec owns a real same-origin artifact server.
export default defineConfig({
  testDir: '..',
  testMatch: 'service-worker-update.spec.ts',
  outputDir: '../../../test-results',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.UPDATE_FIXTURE_BROWSER ? { executablePath: process.env.UPDATE_FIXTURE_BROWSER } : {},
  },
});
