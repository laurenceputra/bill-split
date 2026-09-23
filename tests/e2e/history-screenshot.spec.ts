import { test, expect, newAuthenticatedContext, BASE_URL, DEV_EMAIL } from './fixtures';

for (const [label, width] of [['mobile', 390], ['desktop', 1440]] as const) {
test(`${label} History shows the same scoped transaction ledger`, async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/activity?group=00000000-0000-4000-8000-000000003002&view=transactions`);
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Filter history by group' })).toHaveValue('00000000-0000-4000-8000-000000003002');
    await expect(page.getByRole('navigation', { name: 'History views' }).getByRole('link', { name: 'Transactions' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Search and filters')).toBeVisible();
    await expect(page.getByText('Payment · Sam Rivera paid Dev User')).toBeVisible();
    await expect(page.getByText('Expense · Dinner by the canal (edited)')).toBeVisible();
  } finally {
    await context.close();
  }
});
}

for (const [label, width] of [['mobile', 390], ['desktop', 1440]] as const) {
  test(`${label} global insights shows populated all-time USD summary`, async ({ browser }) => {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 });
    try {
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/activity?view=insights&period=all&currency=USD`);
      await expect(page.getByRole('combobox', { name: 'Filter history by group' })).toHaveValue('');
      await expect(page.getByRole('navigation', { name: 'History views' }).getByRole('link', { name: 'Insights' })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByLabel('Spending insight filters').getByRole('combobox', { name: 'Period' })).toHaveValue('all');
      await expect(page.getByRole('tablist', { name: 'Spending insight currencies' }).getByRole('tab', { name: 'USD' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByLabel('Selected-period spending summary')).toBeVisible();
      await expect(page.getByLabel('Selected-period spending summary')).not.toContainText('0 counted expenses');
    } finally {
      await context.close();
    }
  });
}

test('desktop group insights includes the category chart', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 1440, height: 844 });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/activity?group=00000000-0000-4000-8000-000000003002&view=insights&period=month`);
    await expect(page.getByRole('navigation', { name: 'History views' }).getByRole('link', { name: 'Insights' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Highest-spend categories')).toBeVisible();
    await expect(page.getByText('Food', { exact: true }).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

for (const [label, width] of [['mobile', 390], ['desktop', 1440]] as const) {
  test(`${label} refund shows a fully applied linked refund`, async ({ browser }) => {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 844 });
    try {
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/groups/00000000-0000-4000-8000-000000003002/refund/new`);
      await expect(page.getByRole('heading', { name: 'Record money back' })).toBeVisible();
      const expense = page.locator('.refund-application-row select').first();
      await expect(expense).toBeVisible();
      await expense.selectOption('00000000-0000-4000-8000-000000004001');
      await page.locator('input[inputmode="decimal"]').first().fill('42.00');
      await page.locator('select[name="allocation-recipient-1-person"]').selectOption('00000000-0000-4000-8000-000000002003');
      await page.locator('input[name="allocation-recipient-1-amount"]').fill('42.00');
      await expect(page.locator('.refund-application-status')).toHaveText('Fully applied');
      await expect(page.locator('.refund-preview-list')).toContainText('Net balance effect');
    } finally {
      await context.close();
    }
  });
}
