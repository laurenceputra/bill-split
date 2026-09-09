import { test, expect } from './fixtures';

test('profile rename is online and transaction audit stays progressively disclosed', async ({ authenticatedPage }) => {
  const apiRequests: string[] = [];
  authenticatedPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiRequests.push(`${url.pathname}${url.search}`);
  });

  await authenticatedPage.goto('/settings');
  await expect(authenticatedPage.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await authenticatedPage.getByLabel('Display name').fill('Playwright user');
  await authenticatedPage.getByRole('button', { name: 'Save name' }).click();
  await expect(authenticatedPage.getByRole('status').filter({ hasText: 'Display name updated' })).toBeVisible();

  await authenticatedPage.goto('/groups/00000000-0000-4000-8000-000000003002/expenses/00000000-0000-4000-8000-000000004001');
  const expenseAuditPath = '/api/groups/00000000-0000-4000-8000-000000003002/audit/expense/00000000-0000-4000-8000-000000004001';
  const audit = authenticatedPage.getByText('View audit history', { exact: true });
  await expect(audit).toBeVisible();
  await expect(audit.locator('..')).not.toHaveAttribute('open', '');
  expect(apiRequests.filter((request) => request.startsWith(expenseAuditPath))).toEqual([]);

  const expenseAuditResponse = authenticatedPage.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === expenseAuditPath && response.status() === 200;
  });
  await audit.click();
  const expenseResponse = await expenseAuditResponse;
  expect(new URL(expenseResponse.url()).search).toBe('?limit=50');
  const expenseBody = await expenseResponse.json() as { audit: Array<Record<string, unknown>> };
  expect(expenseBody.audit[0]).toMatchObject({ entityType: 'expense', action: 'update', actorName: 'Dev User', beforeSummary: expect.stringContaining('Description “Dinner by the canal”'), afterSummary: expect.stringContaining('Description “Dinner by the canal (edited)”') });
  expect(expenseBody.audit[0]).not.toHaveProperty('before');
  expect(expenseBody.audit[0]).not.toHaveProperty('after');
  await expect(authenticatedPage.getByRole('heading', { name: 'Audit history' })).toBeVisible();
  await expect(authenticatedPage.getByText('Updated expense', { exact: true })).toBeVisible();
  await expect(authenticatedPage.getByText(/Previously: .*Dinner by the canal/)).toBeVisible();
  await expect(authenticatedPage.getByText(/Now: .*Dinner by the canal \(edited\)/)).toBeVisible();

  await authenticatedPage.goto('/groups/00000000-0000-4000-8000-000000003002/settlements/00000000-0000-4000-8000-000000005001');
  await expect(authenticatedPage.getByRole('heading', { name: /paid/ })).toBeVisible();
  const settlementAuditPath = '/api/groups/00000000-0000-4000-8000-000000003002/audit/settlement/00000000-0000-4000-8000-000000005001';
  const settlementAudit = authenticatedPage.getByText('View audit history', { exact: true });
  await expect(settlementAudit).toBeVisible();
  expect(apiRequests.filter((request) => request.startsWith(settlementAuditPath))).toEqual([]);
  const settlementAuditResponse = authenticatedPage.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === settlementAuditPath && response.status() === 200;
  });
  await settlementAudit.click();
  const settlementResponse = await settlementAuditResponse;
  expect(new URL(settlementResponse.url()).search).toBe('?limit=50');
  const settlementBody = await settlementResponse.json() as { audit: Array<Record<string, unknown>> };
  expect(settlementBody.audit[0]).toMatchObject({ entityType: 'settlement', action: 'update', afterSummary: expect.stringContaining('Note “Partial repayment”') });
  expect(settlementBody.audit[0]).not.toHaveProperty('before');
  expect(settlementBody.audit[0]).not.toHaveProperty('after');
  await expect(authenticatedPage.getByText('Updated settlement', { exact: true })).toBeVisible();
  await expect(authenticatedPage.getByText(/Previously: .*Initial partial repayment/)).toBeVisible();
  await expect(authenticatedPage.getByText(/Now: .*Partial repayment/)).toBeVisible();
});
