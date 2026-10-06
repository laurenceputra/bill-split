import { test, expect, type Page } from '@playwright/test';
import { createUpdateServer } from './fixtures/update-server.mjs';

// These are production core + production worker lifecycle tests, not full App
// tests. Draft ownership and IndexedDB rows are explicitly fixture-owned.
let server: Awaited<ReturnType<typeof createUpdateServer>>;
test.beforeAll(async () => { server = await createUpdateServer(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(() => { server.publish('A'); });

const fixture = (page: Page, expression: string) => page.evaluate((code) => (0, eval)(`window.fixture.${code}`), expression);
async function open(page: Page) {
  await page.goto(server.url);
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
  await expect(page.locator('#build')).toHaveText('B');
  await expect(second.locator('#build')).toHaveText('B');
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
  await expect(page.locator('#build')).toHaveText('B');
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
