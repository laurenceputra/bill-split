import { test, expect, type Page } from '@playwright/test';
import { createUpdateServer } from './fixtures/update-server.mjs';

// These are production core + production worker lifecycle tests, not full App
// tests. Draft ownership and IndexedDB rows are explicitly fixture-owned.
let server: Awaited<ReturnType<typeof createUpdateServer>>;
test.beforeAll(async () => { server = await createUpdateServer(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(() => { server.publish('A'); });

const fixture = (page: Page, expression: string) => page.evaluate((code) => (0, eval)(`window.fixture.${code}`), expression);

async function open(page: Page, url = server.url) {
  await page.goto(url);
  await page.waitForFunction(() => Boolean((window as any).fixture));
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await expect(page.locator('#build')).toHaveText('A');
}
async function update(page: Page, failure?: string) {
  server.publish('B', failure);
  await fixture(page, 'check()');
}

test('first install does not reload; manual checks distinguish no update and transport failure', async ({ page }) => {
  await open(page);
  expect(await fixture(page, 'loads()')).toBe(1);
  await fixture(page, 'check()');
  expect(await fixture(page, 'state().phase')).toBe('no-update');
  server.publish('A', 'worker-error');
  await fixture(page, 'check()');
  expect(await fixture(page, 'state().phase')).toBe('check-error');
  expect(await fixture(page, 'loads()')).toBe(1);
});

test('canonical installs ignore transformed HTML and preserve cached CSP and exact bytes', async ({ page, request }) => {
  await open(page);
  const normal = await request.get(server.url);
  expect(await normal.text()).toContain('data-edge-injection');
  const binary = await request.get(`${server.url}/__billsplit_shell__.bin`);
  const canonical = await binary.text();
  expect(canonical).not.toContain('data-edge-injection');
  const cached = await page.evaluate(async (version) => {
    const cache = await caches.open(version);
    return Promise.all(['/', '/index.html'].map(async (path) => {
      const response = (await cache.match(path))!;
      return { text: await response.text(), type: response.headers.get('content-type'), csp: response.headers.get('content-security-policy'), nosniff: response.headers.get('x-content-type-options') };
    }));
  }, server.artifacts.A.version);
  for (const response of cached) {
    expect(response.text).toBe(canonical);
    expect(response.type).toBe('text/html; charset=utf-8');
    expect(response.csp).toBe(binary.headers()['content-security-policy']);
    expect(response.nosniff).toBe('nosniff');
  }
});

test('standalone recovery has responsive instructions, a normal return link, and no app boot', async ({ browser }) => {
  for (const width of [320, 390, 767, 768, 834, 895, 896, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    try {
      const page = await context.newPage();
      const response = await page.goto(`${server.url}/api/app-update-recovery`);
      expect(response?.headers()['cache-control']).toBe('no-store');
      await expect(page.getByRole('heading', { name: 'Recover a BillSplit update' })).toBeVisible();
      await expect(page.getByText(/including this recovery page/)).toBeVisible();
      await expect(page.getByText(/not an offline recovery tool/)).toBeVisible();
      await expect(page.locator('script, button, input')).toHaveCount(0);
      expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
      const link = page.getByRole('link', { name: 'Return to BillSplit to save work' });
      await expect(link).toHaveAttribute('href', '/');
      await link.focus();
      await expect(link).toBeFocused();
      const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
      if (process.env.UPDATE_RECOVERY_SCREENSHOTS === '1' && [390, 834, 1440].includes(width)) {
        await page.screenshot({ path: `docs/screenshots/update-recovery-${width}.png`, fullPage: true, animations: 'disabled' });
      }
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`${server.url}/`);
      await expect(page.locator('#build')).toHaveText('A');
    } finally { await context.close(); }
  }
});

test('real Update now clicks honor drafts and writes, then apply an installed update offline without idle delay', async ({ page, context }) => {
  await open(page);
  await page.locator('#draft').fill('Demo draft');
  await update(page);
  await expect.poll(() => fixture(page, 'state().updateReady')).toBe(true);
  await page.locator('#update-now').click();
  expect(await fixture(page, 'state().manualError')).toContain('Unsaved');
  await page.locator('#draft').fill('');
  await fixture(page, 'holdMutation()');
  await page.locator('#update-now').click();
  expect(await fixture(page, 'state().manualError')).toContain('Held fixture write');
  await fixture(page, 'releaseMutation()');
  await context.setOffline(true);
  const start = Date.now();
  await page.locator('#update-now').click();
  await expect(page.locator('#build')).toHaveText('B', { timeout: 4_000 });
  expect(Date.now() - start).toBeLessThan(5_000);
  expect(await fixture(page, 'loads()')).toBe(2);
});

test('historical sole page uses local guards and explicitly activates the modern worker', async ({ page }) => {
  const historical = await createUpdateServer({ historical: true });
  try {
    await open(page, historical.url);
    await fixture(page, 'enqueue()');
    historical.publish('B');
    await fixture(page, 'check()');
    await expect.poll(() => fixture(page, 'state().updateReady')).toBe(true);
    await page.locator('#draft').fill('Editing');
    expect(await fixture(page, 'apply()')).toBe(false);
    await page.locator('#blur').click();
    await page.waitForTimeout(300);
    await fixture(page, 'holdMutation()');
    expect(await fixture(page, 'apply()')).toBe(false);
    await fixture(page, 'releaseMutation()');
    await expect.poll(() => fixture(page, 'safety().operations')).toBe(0);
    expect(await fixture(page, 'apply()')).toBe(true);
    await expect(page.locator('#build')).toHaveText('B');
    expect(await fixture(page, 'loads()')).toBe(2);
    expect(await fixture(page, 'outbox()')).toEqual([{ id: 'queued-operation', status: 'queued', amount: 123 }]);
  } finally { await historical.close(); }
});

test('multiple historical pages stay waiting; close-all and reopen recovers without clearing outbox', async ({ page, context }) => {
  const historical = await createUpdateServer({ historical: true });
  try {
    await open(page, historical.url);
    await fixture(page, 'enqueue()');
    const second = await context.newPage();
    await open(second, historical.url);
    historical.publish('B');
    await fixture(page, 'check()');
    await expect.poll(() => fixture(page, 'state().updateReady')).toBe(true);
    expect(await fixture(page, 'apply()')).toBe(true);
    await page.waitForTimeout(1_500);
    await expect(page.locator('#build')).toHaveText('A');
    await expect(second.locator('#build')).toHaveText('A');
    expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);
    await second.close();
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(historical.url);
    await expect(reopened.locator('#build')).toHaveText('B');
    await reopened.waitForFunction(() => Boolean((window as any).fixture));
    expect(await fixture(reopened, 'outbox()')).toEqual([{ id: 'queued-operation', status: 'queued', amount: 123 }]);
  } finally { await historical.close(); }
});

test('unsupported cache-first pages reach network recovery without upgrading storage or forcing tabs to reload', async ({ page, context }) => {
  const historical = await createUpdateServer({ historical: true, unsupported: true });
  try {
    await open(page, historical.url);
    expect(await fixture(page, 'enqueueProduction()')).toBe(true);
    const before = await fixture(page, 'productionOutbox()');
    expect(before).toEqual([{ clientOperationId: 'demo-operation', userId: 'demo-user', groupId: 'demo-group', payload: { description: 'Sample expense', amount_minor: 123, currency: 'USD', date: '2026-01-02', category: 'Other', client_operation_id: 'demo-operation', payers: [{ person_id: '00000000-0000-4000-8000-000000000001', amount_minor: 123 }], splits: [{ person_id: '00000000-0000-4000-8000-000000000001', amount_minor: 123 }] }, display: { description: 'Sample expense', amountMinor: 123, currency: 'USD', date: '2026-01-02' }, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', status: 'pending', attempts: 0, authEpoch: 0 }]);
    const second = await context.newPage();
    await open(second, historical.url);
    historical.publish('B');
    await fixture(page, 'check()');
    await expect.poll(() => fixture(page, 'state().updateReady')).toBe(true);
    expect(await fixture(page, 'apply()')).toBe(false);
    await page.reload();
    await expect(page.locator('#build')).toHaveText('A');
    const recovery = await context.newPage();
    await recovery.goto(`${historical.url}/api/app-update-recovery`);
    await expect(recovery.getByRole('heading', { name: 'Recover a BillSplit update' })).toBeVisible();
    expect(await recovery.evaluate(() => Boolean((window as any).fixture))).toBe(false);
    expect(await recovery.evaluate(async () => (await indexedDB.databases()).find((db) => db.name === 'bill-split-local')?.version)).toBe(10);
    await page.waitForTimeout(7_000);
    await expect(second.locator('#build')).toHaveText('A');
    expect(await fixture(page, 'productionOutbox()')).toEqual(before);
    await context.setOffline(true);
    const offline = await context.newPage();
    await expect(offline.goto(`${historical.url}/api/app-update-recovery`)).rejects.toThrow();
    await offline.close();
    await context.setOffline(false);
    await page.close(); await second.close(); await recovery.close();
    const reopened = await context.newPage();
    await reopened.goto(historical.url);
    await expect(reopened.locator('#build')).toHaveText('B');
    await reopened.waitForFunction(() => Boolean((window as any).fixture));
    expect(await fixture(reopened, 'productionOutbox()')).toEqual(before);
    expect(await reopened.evaluate(async () => (await indexedDB.databases()).find((db) => db.name === 'bill-split-local')?.version)).toBe(11);
  } finally { await historical.close(); }
});

test('clean clients automatically activate B only after two seconds idle and reload once', async ({ page, context }) => {
  await open(page);
  const second = await context.newPage();
  await open(second);
  await page.locator('#blur').click();
  const start = Date.now();
  await update(page);
  await page.waitForTimeout(500);
  await expect(page.locator('#build')).toHaveText('A');
  await expect(page.locator('#build')).toHaveText('B');
  expect(Date.now() - start).toBeGreaterThanOrEqual(2_000);
  await expect(second.locator('#build')).toHaveText('B');
  expect(await fixture(page, 'loads()')).toBe(2);
  expect(await fixture(second, 'loads()')).toBe(2);
  await page.waitForTimeout(6_000);
  expect(await fixture(page, 'loads()')).toBe(2);
});

test('a dirty second client remains protected after blur until its semantic draft clears', async ({ page, context }) => {
  await open(page);
  const second = await context.newPage();
  await open(second);
  await second.locator('#draft').fill('Unsaved name');
  await second.locator('#blur').click();
  await update(page);
  await page.waitForTimeout(7_000);
  await expect(page.locator('#build')).toHaveText('A');
  await expect(second.locator('#draft')).toHaveValue('Unsaved name');
  expect(await fixture(second, 'loads()')).toBe(1);
  await second.locator('#draft').fill('');
  await second.locator('#blur').click();
  // RELEASE schedules the core's existing 15–20s jittered retry, then the
  // two-second idle barrier. The global 8s assertion deadline is too short.
  await expect(page.locator('#build')).toHaveText('B', { timeout: 30_000 });
  await expect(second.locator('#build')).toHaveText('B', { timeout: 30_000 });
});

test('held writes block activation; durable idle outbox and unrelated caches survive reload', async ({ page }) => {
  await open(page);
  await fixture(page, 'enqueue()');
  await page.evaluate(async () => { const cache = await caches.open('unrelated-test-cache'); await cache.put('/unrelated', new Response('preserved')); });
  await fixture(page, 'holdMutation()');
  await update(page);
  await page.waitForTimeout(7_000);
  await expect(page.locator('#build')).toHaveText('A');
  expect(await fixture(page, 'safety().operations')).toBe(1);
  await fixture(page, 'releaseMutation()');
  // Local safety notifications wake promptly once the idle deadline has passed.
  await expect(page.locator('#build')).toHaveText('B', { timeout: 30_000 });
  expect(await fixture(page, 'outbox()')).toEqual([{ id: 'queued-operation', status: 'queued', amount: 123 }]);
  expect(await page.evaluate(async () => (await (await caches.open('unrelated-test-cache')).match('/unrelated'))?.text())).toBe('preserved');
});

for (const failure of ['missing-entry', 'mismatch-entry']) {
  test(`${failure} rejects B installation and preserves the offline A shell`, async ({ page, context }) => {
    await open(page);
    await update(page, failure);
    await expect.poll(() => fixture(page, 'state().phase')).toBe('install-error');
    await page.waitForTimeout(6_000);
    await expect(page.locator('#build')).toHaveText('A');
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#build')).toHaveText('A');
    await page.waitForFunction(() => Boolean((window as any).fixture));
    expect(await fixture(page, 'loads()')).toBe(2);
  });
}
