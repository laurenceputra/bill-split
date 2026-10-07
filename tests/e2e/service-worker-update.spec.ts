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

test('clean clients automatically activate B only after five seconds idle and reload once', async ({ page, context }) => {
  await open(page);
  const second = await context.newPage();
  await open(second);
  await page.locator('#blur').click();
  const start = Date.now();
  await update(page);
  await page.waitForTimeout(2_000);
  await expect(page.locator('#build')).toHaveText('A');
  await expect(page.locator('#build')).toHaveText('B');
  expect(Date.now() - start).toBeGreaterThanOrEqual(5_000);
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
  // five-second idle barrier. The global 8s assertion deadline is too short.
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
  // Local safety notifications use the same bounded 15–20s retry policy.
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
