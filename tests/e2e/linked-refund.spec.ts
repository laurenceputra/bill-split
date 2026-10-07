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
    await expect(page.locator('input[name="allocation-recipient-1-amount"]')).toHaveValue('42.00');
    await expect(page.locator('.refund-application-status')).toHaveText('Fully applied');
    await expect(page.locator('.refund-preview-list')).toContainText('Net balance effect');
  } finally {
    await context.close();
  }
});

test('refund defaults, validation and beneficiary disclosure fit audit widths', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 320, height: 844 });
  try {
    const page = await context.newPage();
    let mutations = 0;
    page.on('request', (request) => { if (request.method() !== 'GET' && /\/credits(?:\/|$)/.test(new URL(request.url()).pathname)) mutations++; });
    const checkResponsiveState = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const submit = page.getByRole('button', { name: 'Record money back', exact: true });
      await submit.scrollIntoViewIfNeeded();
      await expect(submit).toBeInViewport();
      await expect(submit).toBeVisible();
    };
    for (const width of [320, 390, 480, 481, 767, 768, 895, 896, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE_URL}/groups/00000000-0000-4000-8000-000000003002/refund/new`);
      await expect(page.getByRole('heading', { name: 'Record money back' })).toBeVisible();
      await page.locator('.refund-form textarea').fill('Unrelated note');
      await page.locator('.refund-form select').first().focus();
      await expect(page.locator('.field-error')).toHaveCount(0);
      await expect(page.locator('[aria-invalid="true"]')).toHaveCount(0);
      await page.getByRole('button', { name: 'Record money back', exact: true }).click();
      await expect(page.locator('#refund-total-error')).toHaveText('Enter an amount.');
      await expect(page.locator('input[inputmode="decimal"]').first()).toBeFocused();
      await checkResponsiveState();
      await page.locator('input[inputmode="decimal"]').first().fill('42.00');
      await page.getByRole('button', { name: 'Record money back', exact: true }).click();
      await expect(page.locator('input[inputmode="decimal"]').first()).toHaveAttribute('aria-invalid', 'false');
      await expect(page.locator('.refund-application-row select').first()).toBeFocused();
      await checkResponsiveState();
      await page.locator('.refund-application-row select').first().selectOption('00000000-0000-4000-8000-000000004001');
      await page.locator('input[name="application-1-amount"]').fill('not money');
      await page.getByRole('button', { name: 'Record money back', exact: true }).click();
      await expect(page.locator('input[name="application-1-amount"]')).toBeFocused();
      await expect(page.locator('input[inputmode="decimal"]').first()).toHaveAttribute('aria-invalid', 'false');
      expect(mutations).toBe(0);
      await checkResponsiveState();
      await page.locator('input[name="application-1-amount"]').fill('42.00');
      await expect(page.locator('input[name="allocation-recipient-1-amount"]')).toHaveValue('42.00');
      await page.locator('input[name="allocation-recipient-1-amount"]').fill('1.00');
      await page.getByRole('button', { name: 'Use full total', exact: true }).click();
      await page.locator('input[inputmode="decimal"]').first().fill('43.00');
      await expect(page.locator('input[name="allocation-recipient-1-amount"]')).toHaveValue('43.00');
      await page.locator('input[inputmode="decimal"]').first().fill('42.00');
      await page.getByRole('button', { name: 'Adjust who benefits', exact: true }).click();
      await expect(page.locator('select[name="allocation-beneficiary-1-person"]')).not.toHaveValue('');
      for (const input of await page.locator('.refund-form input[inputmode="decimal"]').all()) {
        expect((await input.boundingBox())!.width).toBeGreaterThan(100);
        const shell = input.locator('..');
        expect(await shell.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('1px');
      }
      for (const input of await page.locator('input[name^="allocation-beneficiary-"]').all()) {
        const original = await input.inputValue();
        await input.fill('1234567890123456.78');
        await expect(input).toHaveAttribute('data-amount-length', 'very-long');
        await checkResponsiveState();
        await input.fill(original);
      }
      await checkResponsiveState();
      await page.getByRole('button', { name: 'Use original expense split', exact: true }).click();
      await expect(page.locator('select[name="allocation-beneficiary-1-person"]')).toHaveCount(0);
      await checkResponsiveState();
      await page.getByRole('button', { name: 'Add recipient', exact: true }).click();
      await expect(page.locator('select[name="allocation-recipient-2-person"]')).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Add recipient', exact: true })).toBeDisabled();
      await checkResponsiveState();
      for (const input of await page.locator('.refund-form input[inputmode="decimal"]').all()) {
        await input.fill('1234567890123456.78');
        await expect(input).toHaveAttribute('data-amount-length', 'very-long');
        await expect(input).toHaveAttribute('placeholder', '0.00');
      }
      await checkResponsiveState();
    }
  } finally { await context.close(); }
});

test('insurer pays wife: settlement changes and curated refund screenshots', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const group = '00000000-0000-4000-8000-000000003002';
  const you = '00000000-0000-4000-8000-000000002001';
  const wife = '00000000-0000-4000-8000-000000002003';
  const expense = '00000000-0000-4000-8000-000000004001';
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.route(`**/api/groups/${group}`, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, members: data.members.map((member: { personId: string; name: string }) => member.personId === wife ? { ...member, name: 'Wife' } : member) } });
    });
    await page.route(`**/api/groups/${group}/expenses*`, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, expenses: data.expenses.map((item: { id: string }) => item.id === expense ? { ...item, description: 'Medical bill · insurer reimbursement', splits: [{ personId: you, amountMinor: 4200 }, { personId: wife, amountMinor: 4200 }] } : item) } });
    });
    const capture = async (state: string, width: number) => {
      if (!process.env.REFUND_SCREENSHOTS || (width !== 390 && width !== 1440)) return;
      await page.evaluate(async () => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); await document.fonts.ready; });
      await page.screenshot({ path: `docs/screenshots/refund-improvements-${state}-${width === 390 ? 'mobile' : 'desktop'}.png`, fullPage: true });
    };
    for (const width of [320, 390, 480, 481, 767, 768, 895, 896, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE_URL}/groups/${group}/refund/new`);
      await expect(page.locator('select[name="allocation-recipient-1-person"]')).toHaveValue(you);
      await expect(page.getByText('Defaults to you.', { exact: false })).toBeVisible();
      await capture('default', width);
      await page.getByRole('button', { name: 'Record money back', exact: true }).click();
      await expect(page.locator('#refund-total-error')).toBeVisible();
      await expect(page.locator('.refund-preview-list')).toHaveCount(0);
      await capture('validation', width);
      await page.locator('.refund-application-row select').first().selectOption(expense);
      await page.locator('#refund-amount').fill('42.00');
      await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption('claim');
      await page.locator('select[name="allocation-recipient-1-person"]').selectOption(wife);
      const preview = page.locator('.refund-preview-list');
      await expect(preview).toContainText('You');
      await expect(preview.locator('.refund-preview-person').filter({ has: page.getByText('You', { exact: true }) })).toContainText('The amount you owe decreases, or the amount you are owed increases by 21.00 USD.');
      await expect(preview.locator('.refund-preview-person').filter({ hasText: 'Wife' })).toContainText('The amount you owe increases, or the amount you are owed decreases by 21.00 USD.');
      await expect(page.locator('.refund-transfer-help')).toContainText('separate payment');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await capture('insurer-wife', width);
      await page.getByRole('button', { name: 'Adjust who benefits', exact: true }).click();
      await page.getByRole('button', { name: 'Add recipient', exact: true }).click();
      await page.locator('select[name="allocation-recipient-2-person"]').selectOption(you);
      await page.locator('input[name="allocation-recipient-1-amount"]').fill('21.00');
      await page.locator('input[name="allocation-recipient-2-amount"]').fill('21.00');
      await expect(preview).toContainText('Your settlement balance is unchanged.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await capture('allocations', width);
      while (await page.getByRole('button', { name: /^Remove affected member allocation/ }).count()) {
        await page.getByRole('button', { name: /^Remove affected member allocation/ }).first().click();
      }
      let mutations = 0;
      const mutationListener = (request: import('@playwright/test').Request) => { if (request.method() !== 'GET' && /\/credits(?:\/|$)/.test(new URL(request.url()).pathname)) mutations++; };
      page.on('request', mutationListener);
      await page.getByRole('button', { name: 'Record money back', exact: true }).click();
      await expect(page.locator('#refund-money-flow')).toBeFocused();
      await expect(page.locator('#refund-affected-member-total-error')).toContainText('must total');
      expect(mutations).toBe(0);
      page.off('request', mutationListener);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await capture('empty-beneficiaries', width);
      await page.getByRole('button', { name: 'Use original expense split', exact: true }).click();
      await expect(preview).toBeVisible();
      await page.getByRole('button', { name: 'Adjust who benefits', exact: true }).click();
      await page.locator('input[name="allocation-beneficiary-1-amount"]').fill('bad');
      await expect(preview).toHaveCount(0);
      await page.getByRole('combobox', { name: 'How was it handled?', exact: true }).selectOption('direct_provider_offset');
      await expect(page.locator('.refund-transfer-help')).toHaveCount(0);
      await page.getByRole('combobox', { name: 'Apply this to', exact: true }).selectOption('standalone');
      await expect(page.getByRole('combobox', { name: 'Currency', exact: true })).toBeVisible();
      await expect(page.locator('.refund-transfer-help')).toHaveCount(0);
    }
  } finally { await context.close(); }
});
