import { test, newAuthenticatedContext, BASE_URL, DEV_EMAIL, expect } from './fixtures';

const groupId = '00000000-0000-4000-8000-000000003002';
const expenseId = '00000000-0000-4000-8000-000000004001';
const scheduledExpenseId = '00000000-0000-4000-8000-000000007001';

test('global new expense survives a direct reload and re-entry after leaving the route', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/expense/new`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Add expense' })).toBeVisible();
    await expect(page.getByLabel('Expense group')).toBeVisible();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Add expense' })).toBeVisible();
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Friends & groups' })).toBeVisible();
    await page.goto(`${BASE_URL}/expense/new`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Add expense' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('ordinary expense creation starts one-time while recurring fields preserve entered details', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/groups/${groupId}/expense/new`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Add expense' })).toBeVisible();
    await expect(page.getByLabel('Repeat this expense')).not.toBeChecked();
    await page.getByLabel('Expense amount').fill('42');
    await page.getByPlaceholder('What was this for?').fill('Apartment rent');
    await page.getByLabel('Date').fill('2026-01-15');
    await page.getByLabel('Category (optional)').fill('Home');
    await page.getByLabel('Notes (optional)').fill('Keep this detail');

    await page.getByLabel('Repeat this expense').check();
    await expect(page.getByRole('heading', { name: 'Schedule an expense' })).toBeVisible();
    const timezone = page.getByLabel('Creator timezone');
    await expect(timezone).not.toHaveValue('');
    await expect(timezone.locator('option').first()).toContainText('UTC');
    await expect(timezone.locator('option')).not.toHaveCount(0);
    await expect(page.locator('.schedule-preview ol li')).toHaveCount(3);
    await expect(page.getByText('It continues until you pause or cancel it.')).toBeVisible();
    await expect(page.getByText('Category and notes are saved only for one-time expenses.')).toBeVisible();
    await expect(page.getByLabel('Category (optional)')).toBeDisabled();
    await expect(page.getByLabel('Notes (optional)')).toBeDisabled();

    await page.getByLabel('Repeat this expense').uncheck();
    await expect(page.getByRole('heading', { name: 'Add expense' })).toBeVisible();
    await expect(page.getByLabel('Date')).toHaveValue('2026-01-15');
    await expect(page.getByLabel('Category (optional)')).toHaveValue('Home');
    await expect(page.getByLabel('Notes (optional)')).toHaveValue('Keep this detail');
  } finally {
    await context.close();
  }
});

test('legacy recurring route redirects with intent, submits only a schedule, and shows the result', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const page = await context.newPage();
  const postPaths: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') postPaths.push(new URL(request.url()).pathname);
  });
  try {
    await page.goto(`${BASE_URL}/groups/${groupId}/scheduled-expense/new`, { waitUntil: 'networkidle' });
    await expect(page).toHaveURL(`${BASE_URL}/groups/${groupId}/expense/new?recurrence=1`);
    await expect(page.getByRole('heading', { name: 'Schedule an expense' })).toBeVisible();
    await expect(page.getByLabel('Repeat this expense')).toBeChecked();
    await expect(page.getByLabel('Expense amount')).toBeVisible();
    await expect(page.locator('.schedule-preview ol li')).toHaveCount(3);

    const description = `Combined recurring ${Date.now()}`;
    await page.getByLabel('Expense amount').fill('42');
    await page.getByPlaceholder('What was this for?').fill(description);
    await page.getByLabel('Start date').fill('2026-01-15');
    await page.getByRole('button', { name: 'Create schedule' }).click();
    await expect(page).toHaveURL(`${BASE_URL}/groups/${groupId}`);
    await expect(page.getByRole('heading', { name: 'Scheduled expenses' })).toBeVisible();
    await expect(page.getByText(description, { exact: true })).toBeVisible();
    expect(postPaths).toContain(`/api/groups/${groupId}/scheduled-expenses`);
    expect(postPaths).not.toContain(`/api/groups/${groupId}/expenses`);
  } finally {
    await context.close();
  }
});

test('expense and scheduled-expense edit modes do not expose the new-expense recurrence toggle', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/groups/${groupId}/expense/${expenseId}`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Edit expense' })).toBeVisible();
    await expect(page.getByLabel('Repeat this expense')).toHaveCount(0);

    await page.goto(`${BASE_URL}/groups/${groupId}/scheduled-expense/${scheduledExpenseId}`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Edit recurring expense' })).toBeVisible();
    await expect(page.getByLabel('Repeat this expense')).toHaveCount(0);
    await expect(page.getByLabel('Category (optional)')).toBeDisabled();
    await expect(page.getByLabel('Notes (optional)')).toBeDisabled();
  } finally {
    await context.close();
  }
});
