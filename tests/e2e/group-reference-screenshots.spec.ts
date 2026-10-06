import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const groupId = '00000000-0000-4000-8000-000000003002';

async function capture(page: Page, testInfo: TestInfo, name: string, fullPage = true) {
  if (process.env.GROUP_SCREENSHOTS_SKIP_HISTORY === '1' && name.startsWith('warm-ledger-history-')) return;
  await page.evaluate(() => document.fonts.ready);
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
    await page.goto(`/groups/${groupId}`);
    await expect(page.getByRole('heading', { name: 'Recent transactions' })).toBeVisible();
    await expect(page.getByText('Dinner by the canal (edited)', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.skeleton')).toHaveCount(0);
    const tools = page.locator('.group-overview-tools');
    await expect(tools).toHaveJSProperty('open', false);
    await expect(page.getByRole('link', { name: 'Settle up', exact: true })).toBeVisible();
    if (device === 'mobile') {
      await expect(page.locator('.bottom-nav')).toBeVisible();
      await capture(page, testInfo, 'group-overview-mobile-viewport', false);
    }
    await capture(page, testInfo, `warm-ledger-${device}`);
    await tools.locator('summary').click();
    for (const name of ['Group history', 'Group settings']) {
      await expect(tools.getByRole('link', { name, exact: true })).toBeVisible();
    }
    await capture(page, testInfo, `group-overview-more-actions-open-${device}`);
    if (process.env.GROUP_SCREENSHOTS_OVERVIEW_ONLY === '1') return;

    await tools.getByRole('link', { name: 'Group history', exact: true }).click();
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
    if (device === 'desktop') await capture(page, testInfo, 'warm-ledger-insights-desktop');
  });
}
