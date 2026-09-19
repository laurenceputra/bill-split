import { defineConfig } from '@playwright/test';
import { BASE_URL } from './tests/e2e/config.mjs';

const playwrightExecutablePath = process.env.BILLSPLIT_PLAYWRIGHT_EXECUTABLE_PATH;

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
    browserName: 'chromium',
    ...(playwrightExecutablePath
      ? { launchOptions: { executablePath: playwrightExecutablePath } }
      : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'node tests/e2e/start-server.mjs',
    url: BASE_URL,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
