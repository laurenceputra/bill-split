import { test, newAuthenticatedContext, BASE_URL, DEV_EMAIL, expect } from './fixtures';

const groupId = '00000000-0000-4000-8000-000000003002';

test('recurring expense setup exposes interval, weekdays, preview, and schedule management', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/groups/${groupId}/scheduled-expense/new`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Schedule an expense' })).toBeVisible();
    await expect(page.getByText('Next dates')).toBeVisible();
    await page.getByLabel('Repeats').selectOption('weekly');
    await expect(page.getByText('Monday')).toBeVisible();
    await expect(page.getByText('Choose at least one weekday', { exact: false })).toHaveCount(0);

    await page.goto(`${BASE_URL}/groups/${groupId}`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Scheduled expenses' })).toBeVisible();
    await expect(page.getByText('Monthly apartment rent')).toBeVisible();
    await expect(page.getByText('Next occurrence 2025-09-01')).toBeVisible();
  } finally {
    await context.close();
  }
});
