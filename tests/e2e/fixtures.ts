import { test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const BASE_URL = 'http://127.0.0.1:8788';
export const DEV_EMAIL = 'dev@example.com';
export const EMPTY_EMAIL = 'empty@example.com';

export async function newAuthenticatedContext(browser: Browser, email = DEV_EMAIL, viewport?: { width: number; height: number }) {
  return browser.newContext({
    viewport,
    extraHTTPHeaders: { 'X-Dev-Email': email },
  });
}

export const test = base.extend<{ authenticatedContext: BrowserContext; authenticatedPage: Page }>({
  authenticatedContext: async ({ browser }, use) => {
    const context = await newAuthenticatedContext(browser);
    await use(context);
    await context.close();
  },
  authenticatedPage: async ({ authenticatedContext }, use) => {
    const page = await authenticatedContext.newPage();
    await use(page);
    await page.close();
  },
});

export { expect } from '@playwright/test';
