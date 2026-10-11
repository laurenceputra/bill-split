import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const groupId = '00000000-0000-4000-8000-000000003002';

// Capture-only tier: normal behavior suites own assertions about navigation.
test.skip(process.env.UPDATE_GROUP_SCREENSHOTS !== '1', 'Run test:screenshots:group explicitly to regenerate references');

const identities = new Map([
  ['Dev User', 'Demo user'], ['Sam Rivera', 'Demo friend'],
  ['Priya Shah', 'Demo participant'], ['Mateo Silva', 'Demo member'],
  ['Registered User', 'Demo guest'],
]);

async function anonymizeReferences(page: Page) {
  await page.route('**/api/**', async (route) => {
    const response = await route.fetch();
    if (!response.headers()['content-type']?.includes('application/json')) {
      await route.fulfill({ response });
      return;
    }
    const sanitize = (value: unknown, key = ''): unknown => {
      if (/avatar/i.test(key)) return key === 'avatarMode' ? 'initials' : null;
      if (/email/i.test(key)) return null;
      if (Array.isArray(value)) return value.map((item) => sanitize(item));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, sanitize(item, field)]));
      if (typeof value !== 'string') return value;
      if (identities.has(value)) return identities.get(value);
      if (/name$/i.test(key)) return key === 'groupName' || value.includes('trip') ? 'Sample project' : 'Demo participant';
      return value;
    };
    await route.fulfill({ response, json: sanitize(await response.json()) });
  });
}

async function capture(page: Page, testInfo: TestInfo, name: string, fullPage = true) {
  if (process.env.GROUP_SCREENSHOTS_SKIP_HISTORY === '1' && name.startsWith('warm-ledger-history-')) return;
  await page.evaluate(() => document.fonts.ready);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/Dev User|Sam Rivera|Priya|Mateo|Registered User|Alexandra|Christopher|Maximiliana|Theodore|Elizabeth|Juan Carlos|Margaret|Konstantin|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[a-f0-9]{64}\b/i);
  await expect(page.locator('.avatar img')).toHaveCount(0);
  for (const avatar of await page.locator('.avatar').all()) {
    expect(await avatar.getAttribute('aria-label')).toMatch(/^Demo (user|friend|participant|member|guest)$/);
    expect(await avatar.innerText()).toMatch(/^D[UFPMG]$/);
  }
  const file = `${name}.png`;
  const destination = process.env.UPDATE_GROUP_SCREENSHOTS === '1'
    ? path.join(process.cwd(), 'docs', 'screenshots', file)
    : testInfo.outputPath(file);
  await page.screenshot({
    path: destination, fullPage, animations: 'disabled',
    ...(fullPage ? { style: '.bottom-nav { visibility: hidden !important; }' } : {}),
  });
  await testInfo.attach(name, { path: destination, contentType: 'image/png' });
}

for (const [device, width, height] of [['mobile', 390, 844], ['desktop', 1440, 900]] as const) {
  test(`seeded group reference screenshots at ${device} size`, async ({ authenticatedPage: page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await anonymizeReferences(page);
    await page.goto(`/groups/${groupId}`);
    await expect(page.getByRole('heading', { name: 'Recent transactions' })).toBeVisible();
    await expect(page.getByText('Dinner by the canal (edited)', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.skeleton')).toHaveCount(0);
    const tools = page.locator('.group-overview-tools');
    await expect(tools).toHaveValue('');
    await expect(page.getByRole('link', { name: 'Settle up', exact: true })).toBeVisible();
    if (device === 'mobile') {
      await expect(page.locator('.bottom-nav')).toBeVisible();
      await capture(page, testInfo, 'group-overview-mobile-viewport', false);
    }
    await capture(page, testInfo, `warm-ledger-${device}`);
    await tools.focus();
    await capture(page, testInfo, `group-overview-more-actions-focused-${device}`);
    if (process.env.GROUP_SCREENSHOTS_OVERVIEW_ONLY === '1') return;

    await tools.selectOption('history');
    const back = page.getByRole('link', { name: '← Back to group', exact: true });
    await expect(back).toHaveAttribute('href', `/groups/${groupId}`);
    await expect(page.getByRole('combobox', { name: 'Filter history by group' })).toHaveValue(groupId);
    await expect(page.locator('.skeleton')).toHaveCount(0);
    await capture(page, testInfo, `warm-ledger-history-${device}`);

    await page.goto(`/activity?group=${groupId}&view=insights&period=all&currency=USD`);
    await expect(back).toHaveAttribute('href', `/groups/${groupId}`);
    await expect(page.getByLabel('Spending insight filters').getByRole('combobox', { name: 'Period' })).toHaveValue('all');
    await expect(page.getByRole('tab', { name: 'USD', exact: true })).toHaveAttribute('aria-selected', 'true');
    const people = page.getByRole('region', { name: 'Spending by person' });
    await expect(people).toBeVisible();
    await expect(people.locator('li').first()).toContainText(/Allocated share.*Paid/s);
    await expect(people.getByText('Highest payer', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.skeleton')).toHaveCount(0);
    await capture(page, testInfo, `spending-insights-group-${device}`);
  });
}
