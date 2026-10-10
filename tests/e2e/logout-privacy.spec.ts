import { test, expect, BASE_URL, newAuthenticatedContext, DEV_EMAIL, seedOfflineTrust } from './fixtures';
import { DB_NAME, DB_VERSION } from '../../src/app/idb';
import type { Page } from '@playwright/test';
import path from 'node:path';

async function queueRecords(page: Page, seed = false) {
  return page.evaluate(({ name, version, seed }) => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('expenseOutbox', seed ? 'readwrite' : 'readonly');
      const store = tx.objectStore('expenseOutbox');
      if (seed) for (const userId of ['sample-account-a', 'sample-account-b']) {
        store.put({ clientOperationId: userId, userId, groupId: 'sample-project', payload: { description: 'Sample expense', amount_minor: 1000, currency: 'USD', date: '2026-01-01', payers: [{ person_id: 'sample-person', amount_minor: 1000 }], splits: [{ person_id: 'sample-person', amount_minor: 1000 }], client_operation_id: userId }, display: { description: 'Sample expense', amountMinor: 1000, currency: 'USD', date: '2026-01-01' }, status: 'auth-required', deliveryUncertain: userId.endsWith('b'), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', attempts: 0 });
      }
      const rows = store.getAllKeys();
      tx.oncomplete = () => { db.close(); resolve(rows.result.map(String).sort()); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), { name: DB_NAME, version: DB_VERSION, seed });
}

for (const allDevices of [false, true]) {
  test(`logout ${allDevices ? 'all devices' : 'current device'} always confirms and preserves records on revocation failure`, async ({ authenticatedPage: page }) => {
    await page.goto(`${BASE_URL}/settings`);
    const button = page.getByRole('button', { name: allDevices ? 'Log out all devices' : 'Log out', exact: true });
    await expect(button).toBeEnabled();
    const records = await queueRecords(page, true);
    let calls = 0;
    await page.route(`**/api/${allDevices ? 'sessions' : 'session'}`, async (route) => {
      calls++;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic revocation failure' }) });
    });
    const before = await page.evaluate(() => localStorage.getItem('dev-email'));
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('ALL accounts');
      expect(dialog.message()).toContain('does not undo server expenses');
      await dialog.dismiss();
    });
    await button.click();
    expect(calls).toBe(0);
    expect(await queueRecords(page)).toEqual(records);
    expect(await page.evaluate(() => localStorage.getItem('dev-email'))).toBe(before);
    page.once('dialog', (dialog) => dialog.accept());
    await button.click();
    await expect(page.getByText('Logout was not completed.')).toBeVisible();
    expect(calls).toBe(1);
    expect(await queueRecords(page)).toEqual(records);
    await expect(button).toBeDisabled(); // Transport failure marks connection unavailable.
    expect(await page.evaluate(() => localStorage.getItem('dev-email'))).toBe(before);
  });

  test(`successful ${allDevices ? 'all-device' : 'current-device'} logout deletes every account's durable queue`, async ({ authenticatedPage: page }) => {
    await page.goto(`${BASE_URL}/settings`);
    const button = page.getByRole('button', { name: allDevices ? 'Log out all devices' : 'Log out', exact: true });
    await expect(button).toBeEnabled();
    expect(await queueRecords(page, true)).toHaveLength(2);
    let calls = 0;
    await page.route(`**/api/${allDevices ? 'sessions' : 'session'}`, async (route) => {
      calls++;
      expect(route.request().method()).toBe('DELETE');
      await route.fulfill({ status: 204 });
    });
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Unsent expenses will be lost');
      expect(dialog.message()).toContain('Uncertain expenses may already be on the server');
      await dialog.accept();
    });
    await button.click();
    await expect.poll(() => queueRecords(page)).toEqual([]);
    expect(calls).toBe(1);
    // Open a fresh connection after cleanup, rather than trusting the UI queue.
    expect(await queueRecords(page)).toEqual([]);
  });
}

test('Settings privacy warning and guarded actions fit responsive states with synthetic screenshot evidence', async ({ browser }, testInfo) => {
  for (const width of [320, 390, 767, 768, 895, 896, 1440]) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 }, { serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      let releaseIdentity!: () => void;
      const held = new Promise<void>((resolve) => { releaseIdentity = resolve; });
      await page.route('**/api/me', async (route) => {
        const response = await route.fetch();
        const { id, personId, profileRevision, updatedAt, idleExpiresAt } = await response.json();
        await held;
        await route.fulfill({ response, json: { id, personId, profileRevision, updatedAt, idleExpiresAt, email: '', name: 'Demo user', avatarMode: 'initials' } });
      });
      await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'Log out', exact: true })).toHaveCount(0);
      releaseIdentity();
      await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Demo user');
      const logout = page.getByRole('button', { name: 'Log out', exact: true });
      await expect(logout).toBeEnabled();
      await expect(page.getByText('No expenses pending', { exact: false })).toBeVisible();
      await expect(page.getByText(/Logout always requires confirmation/)).toBeVisible();
      const headings = await page.locator('main h2').allTextContents();
      expect(headings.indexOf('Profile')).toBeLessThan(headings.indexOf('Account'));
      expect(headings.indexOf('Device')).toBeLessThan(headings.indexOf('Account'));
      const account = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: 'Account', exact: true }) });
      await expect(account.locator('#logout-privacy-help')).toBeVisible();
      await expect(logout).toHaveAttribute('aria-describedby', 'logout-privacy-help');
      expect(await account.evaluate((section) => {
        const help = section.querySelector('#logout-privacy-help')!;
        return Boolean(help.compareDocumentPosition(section.querySelector('button')!) & Node.DOCUMENT_POSITION_FOLLOWING);
      })).toBe(true);
      const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await fits();
      page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('ALL accounts'); await dialog.dismiss(); });
      await logout.click();
      if ([390, 1440].includes(width)) {
        // A generic demo glyph replaces synthetic initials; no emails or hashes
        // are inherited from backend identity data in this screenshot fixture.
        await page.locator('.avatar').evaluateAll((nodes) => nodes.forEach((node) => { node.textContent = '●'; node.setAttribute('aria-label', 'Generic demo avatar'); }));
        expect(await page.locator('body').innerText()).not.toContain('@');
        expect(await page.locator('.avatar img').count()).toBe(0);
        await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
        await page.evaluate(() => document.fonts.ready);
        const file = `settings-${width === 390 ? 'mobile' : 'desktop'}.png`;
        await page.screenshot({ path: process.env.UPDATE_SETTINGS_SCREENSHOTS === '1' ? path.join(process.cwd(), 'docs/screenshots', file) : testInfo.outputPath(file), fullPage: true, animations: 'disabled', style: '.bottom-nav { visibility: hidden !important; }' });
      }
      await page.route('**/api/session', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic revocation failure' } }));
      page.once('dialog', (dialog) => dialog.accept());
      await logout.click();
      await expect(page.getByText('Logout was not completed.')).toBeVisible();
      await fits();
      await context.setOffline(true);
      await expect(logout).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Log out all devices', exact: true })).toBeDisabled();
      await fits();
      await page.unroute('**/api/me');
      await page.route('**/api/me', (route) => route.abort('internetdisconnected'));
      await seedOfflineTrust(page);
      await page.evaluate(({ name, version }) => new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['offlineTrust', 'identities'], 'readwrite');
          for (const [storeName, key] of [['offlineTrust', 'current'], ['identities', 'last']]) {
            const store = tx.objectStore(storeName);
            const row = store.get(key);
            row.onsuccess = () => { if (row.result) store.put({ ...row.result, name: 'Demo user', email: 'dev@example.com' }); };
          }
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }), { name: DB_NAME, version: DB_VERSION });
      await context.setOffline(false);
      await page.reload();
      await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Demo user');
      await expect(page.getByText('Showing cached profile.', { exact: true })).toBeVisible();
      await expect(logout).toBeDisabled();
      await fits();
    } finally { await context.close(); }
  }
});
