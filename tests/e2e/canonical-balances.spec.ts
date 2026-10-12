import { test, expect, BASE_URL } from './fixtures';

const groupId = '00000000-0000-4000-8000-000000003002';
const balances = [{ currency: 'EUR', netMinor: 100 }, { currency: 'GBP', netMinor: -900 }, { currency: 'USD', netMinor: 0 }, { currency: 'CAD', netMinor: 500 }];

for (const width of [320, 768, 1280]) {
  test(`canonical-only overview survives loading, error and offline breakdown at ${width}px`, async ({ authenticatedPage: page, authenticatedContext: context }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route(`${BASE_URL}/api/groups`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const group = body.groups.find((item: { id: string }) => item.id === groupId);
      group.name = 'Sample project';
      group.personalBalance = { groupId, personId: '00000000-0000-4000-8000-000000002001', ledgerRevision: 100, defaultCurrency: 'USD', balances };
      await route.fulfill({ response, json: { ...body, groups: [group] } });
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${BASE_URL}/api/groups/${groupId}/balances`, async (route) => {
      await pending;
      await route.fulfill({ status: 503, json: { error: 'Sample balance details unavailable' } });
    });
    await page.goto('/');
    const preview = page.locator('.group-card').filter({ hasText: 'Sample project' });
    await expect(preview.locator('.card__balance')).toHaveCount(2);
    await expect(preview.locator('.card__balance').nth(0)).toContainText('GBP');
    await expect(preview.locator('.card__balance').nth(1)).toContainText('CAD');
    await preview.click();
    const cards = page.locator('.balance-cards .balance-card');
    await expect(cards).toHaveCount(4);
    await expect(cards.filter({ hasText: 'USD' })).toContainText('Settled up');
    await page.getByText('View full group breakdown', { exact: true }).click();
    await expect(page.getByText('Balance details are unavailable.', { exact: true })).toBeVisible();
    release();
    await expect(page.locator('#balances-error')).toBeVisible();
    await expect(cards).toHaveCount(4);
    await context.setOffline(true);
    await expect(cards).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await context.setOffline(false);
  });
}

test('settlement pair and currency changes update automatic amounts, but refresh preserves manual amounts', async ({ authenticatedPage: page }) => {
  let amountMinor = 900;
  let requests = 0;
  await page.route(`${BASE_URL}/api/groups/${groupId}/balances`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const usd = body.balances.USD;
    requests++;
    const pair = usd.simplified[0];
    pair.amountMinor = amountMinor;
    usd.simplified = [pair];
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/groups/${groupId}/settle`);
  const amount = page.getByLabel('Amount (USD)', { exact: true });
  await expect(amount).toHaveValue('9.00');
  const recipient = page.locator('.settlement-form-surface select').nth(1);
  const originalRecipient = await recipient.inputValue();
  const alternateRecipient = await recipient.locator('option').evaluateAll((options, original) => (options.find((option) => (option as HTMLOptionElement).value !== original) as HTMLOptionElement)?.value, originalRecipient);
  if (alternateRecipient) {
    await recipient.selectOption(alternateRecipient);
    await expect(amount).toHaveValue('');
    await recipient.selectOption(originalRecipient);
    await expect(amount).toHaveValue('9.00');
  }
  await page.locator('.settlement-form-surface select').nth(2).selectOption('EUR');
  await expect(page.getByLabel('Amount (EUR)', { exact: true })).toHaveValue('');
  await page.locator('.settlement-form-surface select').nth(2).selectOption('USD');
  await expect(amount).toHaveValue('9.00');
  await amount.fill('4.25');
  amountMinor = 1500;
  const beforeRefresh = requests;
  await page.waitForTimeout(31_000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => requests).toBeGreaterThan(beforeRefresh);
  await expect(amount).toHaveValue('4.25');
});
