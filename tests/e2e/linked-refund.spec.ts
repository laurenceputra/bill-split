import { test, expect, newAuthenticatedContext, BASE_URL, DEV_EMAIL } from './fixtures';

test('mobile refund applies a linked expense and previews its balance effect', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
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
