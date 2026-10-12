import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { tabletReferences } from './tablet-evidence';

const widths = [320, 390, 767, 768, 820, 834, 895, 896, 1024, 1180, 1194, 1440];
const groupId = '00000000-0000-4000-8000-000000003002';

// Sanitize before rendering, including nested historical people and free text.
async function demoData(page: Page, amount = 987654321) {
  await page.route('**/api/**', async (route) => {
    const response = await route.fetch();
    if (!response.headers()['content-type']?.includes('application/json')) return route.fulfill({ response });
    const sanitize = (value: unknown, key = ''): unknown => {
      if (/avatar/i.test(key)) return key === 'avatarMode' ? 'initials' : null;
      if (/email/i.test(key)) return null;
      if (Array.isArray(value)) return value.map((item) => sanitize(item));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, sanitize(item, field)]));
      if (typeof value === 'number' && (/netMinor|groupSpendMinor|allocatedSpendMinor|yourShareMinor|youPaidMinor/.test(key) || key === 'amountMinor' && amount === Number.MAX_SAFE_INTEGER)) return Math.sign(value) * (key === 'amountMinor' && value === 12345 ? -amount : amount);
      if (typeof value !== 'string') return value;
      if (/name$/i.test(key)) return key === 'groupName' || /trip/i.test(value) ? 'Sample project with a long generic label for tablet testing' : 'Demo participant with a long generic label';
      if (/description|note|summary$/i.test(key)) return 'Sample transaction for responsive testing';
      return value.replace(/Dev User|Sam Rivera|Priya Shah|Mateo Silva|Registered User/g, 'Demo participant');
    };
    await route.fulfill({ response, json: sanitize(await response.json()) });
  });
}

async function contained(page: Page) {
  const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, outside: [...document.querySelectorAll<HTMLElement>('.route-view *')].filter(node => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(node => ({ className: node.className, tag: node.tagName, right: node.getBoundingClientRect().right })) }));
  expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
  const route = page.locator('.route-view');
  const box = await route.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x + box!.width / 2 - page.viewportSize()!.width / 2)).toBeLessThanOrEqual(1);
  for (const money of await page.locator('.money').all()) {
    expect(await money.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await expect(money).toHaveCSS('white-space', 'nowrap');
  }
}

async function capture(page: Page, info: TestInfo, name: string) {
  const reference = process.env.UPDATE_TABLET_SCREENSHOTS === '1' && tabletReferences.has(name);
  if (!reference && process.env.TABLET_SCREENSHOT_ARTIFACTS !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/Dev User|Sam Rivera|Priya|Mateo|Registered User|Alex|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[a-f0-9]{64}\b/i);
  await expect(page.locator('.avatar img')).toHaveCount(0);
  for (const avatar of await page.locator('.avatar').all()) expect(await avatar.getAttribute('aria-label')).toMatch(/^Demo /);
  const destination = reference ? path.join(process.cwd(), 'docs', 'screenshots', `tablet-${name}.png`) : info.outputPath(`tablet-${name}.png`);
  await page.screenshot({ path: destination, animations: 'disabled' });
  await info.attach(name, { path: destination, contentType: 'image/png' });
}

test('centered group and History routes retain disclosures and reading width at tablet boundaries', async ({ authenticatedPage: page }, info) => {
  await demoData(page);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/groups/${groupId}`);
    await expect(page.getByRole('heading', { name: 'Recent transactions' })).toBeVisible();
    await contained(page);
    expect(await page.locator('.group-overview-columns').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(width < 896 ? 1 : 2);
    await capture(page, info, `group-${width}`);
    await page.locator('.balance-breakdown > summary').click();
    await expect(page.locator('.balance-breakdown')).toHaveAttribute('open', '');
    await contained(page);
    await page.locator('.balance-breakdown').evaluate((node) => window.scrollTo(0, Math.max(0, window.scrollY + node.getBoundingClientRect().top - 96)));
    await capture(page, info, `group-breakdown-${width}`);
    for (const view of ['changes', 'transactions', 'insights']) {
      await page.goto(`/activity?group=${groupId}&view=${view}&period=all&currency=USD`);
      await expect(page.locator('.history-tabs')).toBeVisible();
      const results = view === 'insights' ? '.insights-page' : '.history-panel';
      await expect(page.locator(results)).toBeVisible();
      await expect(page.locator(view === 'insights' ? '.insight-summary-card' : view === 'transactions' ? '.transaction-list li' : '.activity-list li').first()).toBeVisible();
      await expect(page.locator('.skeleton')).toHaveCount(0);
      await contained(page);
      for (const selector of ['.ui-page-header', '.activity-filter', '.history-tabs', results]) {
        const box = await page.locator(selector).boundingBox();
        expect(Math.abs(box!.x + box!.width / 2 - width / 2), selector).toBeLessThanOrEqual(1);
      }
      if (view === 'transactions') {
        const disclosure = page.locator('.transaction-filters-disclosure');
        if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
        await expect(page.locator('.transaction-filters')).toBeVisible();
        await contained(page);
      }
      await capture(page, info, `${view}-${width}`);
      if (view === 'insights') {
        await page.getByLabel('Spending insight filters').getByRole('combobox', { name: 'Period', exact: true }).selectOption('custom');
        await expect(page.locator('.insight-controls input[type="date"]').first()).toBeVisible();
        await contained(page);
        await capture(page, info, `insights-custom-${width}`);
      }
    }
  }
});

test('safe-integer positive and negative money remains contained and keyboard scrollable at 320px', async ({ authenticatedPage: page }, info) => {
  await demoData(page, Number.MAX_SAFE_INTEGER);
  await page.setViewportSize({ width: 320, height: 900 });
  for (const route of ['/', `/groups/${groupId}`, `/activity?group=${groupId}&view=transactions`, `/activity?group=${groupId}&view=insights&period=all&currency=USD`]) {
    await page.goto(route);
    const amounts = page.locator('.money:visible').filter({ hasText: /90,071,992,547/ });
    await expect(amounts.first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const money of await amounts.all()) {
      await expect(money).toHaveCSS('white-space', 'nowrap');
      await expect(money).toHaveCSS('overflow-x', 'auto');
      await expect(money).toContainText(/USD|EUR|GBP|\$|€|£/);
      const geometry = await money.evaluate((node) => ({ width: node.clientWidth, content: node.scrollWidth, right: node.getBoundingClientRect().right }));
      expect(geometry.right).toBeLessThanOrEqual(320);
      expect(geometry.width).toBeGreaterThan(0);
      if (geometry.content > geometry.width + 1) {
        await expect(money).toHaveAttribute('tabindex', '0');
        await money.focus();
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => money.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
        expect(await money.evaluate((node) => { node.scrollLeft = node.scrollWidth; return node.scrollLeft + node.clientWidth >= node.scrollWidth - 1; })).toBe(true);
      }
    }
    if (route === '/' || route === `/groups/${groupId}`) {
      await expect(page.locator('.money--positive').first()).toContainText('90,071,992,547');
      await expect(page.locator('.money--debt').first()).toContainText('90,071,992,547');
    }
    if (route.includes('view=transactions')) await expect(amounts.filter({ hasText: /^-/ }).first()).toBeVisible();
    if (route === `/groups/${groupId}`) {
      const balance = page.locator('.balance-card .money').first();
      expect(await balance.evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(true);
      await balance.evaluate((node) => { node.scrollLeft = 0; });
      await capture(page, info, 'safe-limit-group-320');
    }
  }
});

test('below-threshold group money overflow gets keyboard focus only while it needs scrolling', async ({ authenticatedPage: page }) => {
  await demoData(page, 999999999999);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`/groups/${groupId}`);
  const money = page.locator('.balance-card .money').first();
  await expect(money).toContainText('$9,999,999,999.99');
  await page.evaluate(() => document.fonts.ready);
  expect(await money.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect(money).toHaveAttribute('tabindex', '0');
  await money.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => money.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(await money.evaluate((node) => { node.scrollLeft = node.scrollWidth; return node.scrollLeft + node.clientWidth >= node.scrollWidth - 1; })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => money.getAttribute('tabindex')).toBeNull();
  expect(await money.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(money).toHaveAttribute('tabindex', '0');
});

test('Home large multi-currency balances use card-width stacking without currency collisions', async ({ authenticatedPage: page }, info) => {
  await demoData(page);
  await page.goto('/');
  await expect(page.locator('.group-card').first()).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await contained(page);
    for (const row of await page.locator('.card__balance:has(.money)').all()) {
      const label = await row.locator('.card__balance-label').boundingBox();
      const money = await row.locator('.card__balance-money').boundingBox();
      expect(label!.y + label!.height <= money!.y + 1 || label!.x + label!.width <= money!.x + 1).toBe(true);
      expect(await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    await capture(page, info, `home-large-${width}`);
  }
});

test('payer modal centers from 768px and stays scrollable at short keyboard-like heights', async ({ authenticatedPage: page }, info) => {
  await demoData(page);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/groups/${groupId}/expense/new`);
    await expect(page.locator('.summary-row').first()).toBeVisible();
    await page.locator('.summary-row').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    if (width >= 768) expect(Math.abs(box!.y + box!.height / 2 - 450)).toBeLessThanOrEqual(1);
    else expect(box!.y + box!.height).toBeGreaterThan(850);
    await capture(page, info, `payer-${width}`);
    await dialog.getByRole('button', { name: '+ Add payer', exact: true }).click();
    await expect(dialog.locator('.payer-row')).toHaveCount(2);
    await page.setViewportSize({ width, height: 360 });
    const short = await dialog.boundingBox();
    expect(short!.y).toBeGreaterThanOrEqual(0);
    expect(short!.y + short!.height).toBeLessThanOrEqual(360);
    await expect(dialog).toHaveCSS('overflow-y', 'auto');
    expect(await dialog.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await dialog.getByRole('button', { name: 'Done', exact: true }).scrollIntoViewIfNeeded();
    await capture(page, info, `payer-short-${width}`);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
});

test('public front keeps a centered container and left-aligned copy at tablet boundaries', async ({ page }, info) => {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('.landing-hero')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const box = await page.locator('.landing-page').boundingBox();
    expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    await expect(page.locator('.landing-hero__copy')).toHaveCSS('text-align', 'left');
    await capture(page, info, `public-${width}`);
  }
});
