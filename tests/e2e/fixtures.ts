import { test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const BASE_URL = 'http://127.0.0.1:8788';
export const DEV_EMAIL = 'dev@example.com';
export const EMPTY_EMAIL = 'empty@example.com';
export const REGISTERED_EMAIL = 'registered@example.com';

export async function newAuthenticatedContext(browser: Browser, email = DEV_EMAIL, viewport?: { width: number; height: number }) {
  return browser.newContext({
    viewport,
    extraHTTPHeaders: { 'X-Dev-Email': email },
  });
}

export async function seedOfflineTrust(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('bill-split-local', 10);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('offlineTrust', 'readwrite');
      transaction.objectStore('offlineTrust').put({ key: 'current', state: 'active', revision: 1, userId: '00000000-0000-4000-8000-000000001001', email: 'dev@example.com', personId: '00000000-0000-4000-8000-000000002001', clerkUserId: 'e2e-clerk', verifiedAt: new Date().toISOString() });
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  }));
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
