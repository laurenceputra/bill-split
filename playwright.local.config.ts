import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';
// @ts-expect-error The Node-only resolver has no browser declaration.
import { requireValidatedPlaywrightLaunchOptions } from './scripts/playwright-browser-resolver.mjs';

const localBrowserOptions = requireValidatedPlaywrightLaunchOptions(process.env);

export default defineConfig({
  ...baseConfig,
  projects: baseConfig.projects?.map((project) => project.use?.browserName === 'chromium'
    ? { ...project, use: { ...project.use, ...localBrowserOptions } }
    : project),
});
