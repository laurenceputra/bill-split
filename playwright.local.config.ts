import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';
// @ts-expect-error The Node-only resolver has no browser declaration.
import { requireValidatedPlaywrightLaunchOptions } from './scripts/playwright-browser-resolver.mjs';

const localBrowserOptions = requireValidatedPlaywrightLaunchOptions(process.env);

export default defineConfig({
  ...baseConfig,
  use: {
    ...baseConfig.use,
    ...localBrowserOptions,
  },
});
