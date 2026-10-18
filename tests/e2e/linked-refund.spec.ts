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
    const recipientStatus = page.locator('.refund-form output:not(.refund-application-status)');
    await expect(recipientStatus).toHaveText('Fully allocated');
    await page.locator('input[name="allocation-recipient-1-amount"]').fill('40.00');
    await expect(recipientStatus).toHaveText('Remaining to allocate: 2.00 USD');
    await page.locator('input[name="allocation-recipient-1-amount"]').fill('43.00');
    await expect(recipientStatus).toHaveText('Overallocated by 1.00 USD');
    await expect(page.locator('.refund-application-status')).toHaveText('Fully applied');
    await page.locator('input[name="allocation-recipient-1-amount"]').fill('42.00');
    await expect(page.locator('.refund-preview-list')).toContainText('After saving:');
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

test('different recipient: settlement changes and curated refund screenshots', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 }, { serviceWorkers: 'block' });
  const group = '00000000-0000-4000-8000-000000003002';
  const you = '00000000-0000-4000-8000-000000002001';
  const recipient = '00000000-0000-4000-8000-000000002003';
  const expense = '00000000-0000-4000-8000-000000004001';
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    // Construct complete synthetic responses before first render, never inherit identity fields.
    const userId = '00000000-0000-4000-8000-000000001001';
    const members = [
      { personId: you, name: 'Demo user', role: 'owner', joinedAt: '2026-01-01', avatarMode: 'initials', avatarHash: null },
      { personId: recipient, name: 'Demo friend', role: 'member', joinedAt: '2026-01-01', avatarMode: 'initials', avatarHash: null },
    ];
    await page.route('**/api/me', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { id: userId, personId: you, name: 'Demo user', email: DEV_EMAIL, avatarMode: 'initials', avatarHash: null } });
    });
    await page.route(`**/api/groups/${group}`, async (route) => {
      await route.fulfill({ json: { group: { id: group, name: 'Sample project', currency: 'USD', createdAt: '2026-01-01', updatedAt: '2026-01-01' }, members, historicalParticipants: members.map((member) => ({ ...member, status: 'active' })), currentPersonId: you, splitDefault: null } });
    });
    await page.route(`**/api/groups/${group}/expenses*`, async (route) => {
      await route.fulfill({ json: { expenses: [{ id: expense, groupId: group, description: 'Sample purchase', amountMinor: 8400, currency: 'USD', date: '2026-01-01', createdBy: userId, createdAt: '2026-01-01', updatedAt: '2026-01-01', version: 1, payers: [{ personId: you, amountMinor: 8400 }], splits: [{ personId: you, amountMinor: 4200 }, { personId: recipient, amountMinor: 4200 }], linkedCredits: [] }] } });
    });
    let balanceMode: 'normal' | 'missing' | 'error' = 'normal';
    await page.route(`**/api/groups/${group}/balances`, async (route) => {
      if (balanceMode === 'error') { await route.fulfill({ status: 503, json: { error: 'Synthetic balance error' } }); return; }
      if (balanceMode === 'missing') { await route.fulfill({ json: { balances: {} } }); return; }
      await route.fulfill({ json: { balances: { USD: { raw: [{ personId: you, name: 'Demo user', netMinor: -1000, currency: 'USD' }, { personId: recipient, name: 'Demo friend', netMinor: 1000, currency: 'USD' }], simplified: [] }, EUR: { raw: [{ personId: you, name: 'Demo user', netMinor: 300, currency: 'EUR' }, { personId: recipient, name: 'Demo friend', netMinor: -300, currency: 'EUR' }], simplified: [] } }, personalBalance: { groupId: group, personId: you, ledgerRevision: 100, defaultCurrency: 'USD', balances: [{ currency: 'USD', netMinor: -1000 }, { currency: 'EUR', netMinor: 300 }] } } });
    });
    const capture = async (state: string, width: number) => {
      if (width !== 390 && width !== 1440) return;
      await page.evaluate(async () => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); await document.fonts.ready; });
      await expect(page.locator('body')).not.toContainText(/@/);
      for (const option of await page.locator('select[name^="allocation-"][name$="-person"] option').all()) {
        await expect(option).toHaveText(/^(Choose a person|You|Demo user|Demo friend)$/);
      }
      await expect(page.locator('.refund-application-row select').first().locator('option')).toHaveText([
        'Choose an expense', '2026-01-01 · Sample purchase · USD',
      ]);
      await expect(page.locator('.avatar img')).toHaveCount(0);
      for (const avatar of await page.locator('.avatar').all()) {
        await expect(avatar).toHaveAttribute('aria-label', /^(Demo user|Demo friend)$/);
        await expect(avatar).toHaveText(/^(DU|DF)$/);
      }
      await expect(page.locator('.refund-application-row select').first()).toContainText('Sample purchase');
      if (!process.env.REFUND_SCREENSHOTS) return;
      await page.screenshot({ path: `docs/screenshots/refund-improvements-${state}-${width === 390 ? 'mobile' : 'desktop'}.png`, fullPage: true });
    };
    for (const width of [320, 390, 480, 481, 767, 768, 895, 896, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE_URL}/groups/${group}/refund/new`);
      await expect(page.locator('select[name="allocation-recipient-1-person"]')).toHaveValue(you);
      await page.locator('input[type="date"]').fill('2026-01-02');
      await expect(page.getByText('Defaults to you.', { exact: false })).toBeVisible();
      await capture('default', width);
      await page.getByRole('button', { name: 'Record money back', exact: true }).click();
      await expect(page.locator('#refund-total-error')).toBeVisible();
      await expect(page.locator('.refund-preview-list')).toHaveCount(0);
      await capture('validation', width);
      await page.locator('.refund-application-row select').first().selectOption(expense);
      await page.locator('#refund-amount').fill('42.00');
      await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption('claim');
      await page.locator('select[name="allocation-recipient-1-person"]').selectOption(recipient);
      const preview = page.locator('.refund-preview-list');
      await expect(preview).toContainText('You');
      await expect(preview.locator('.refund-preview-person').filter({ has: page.getByText('You', { exact: true }) })).toContainText('Current: You owe 10.00 USD → After saving: You are owed 11.00 USD');
      await expect(preview.locator('.refund-preview-person').filter({ hasText: 'Demo friend' })).toContainText('Current: Demo friend is owed 10.00 USD → After saving: Demo friend owes 11.00 USD');
      await expect(page.locator('.refund-transfer-help')).toContainText('separate payment');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await capture('different-recipient', width);
      await context.setOffline(true);
      await expect(page.locator('.refund-preview-section')).toContainText('Balance projection unavailable');
      await expect(preview).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Record money back', exact: true })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await capture('offline-balances', width);
      await context.setOffline(false);
      // Reconnect can remount authenticated routes while identity is rechecked.
      await page.goto(`${BASE_URL}/groups/${group}/refund/new`);
      await page.locator('.refund-application-row select').first().selectOption(expense);
      await page.locator('#refund-amount').fill('42.00');
      await page.locator('select[name="allocation-recipient-1-person"]').selectOption(recipient);
      await expect(preview).toContainText('After saving:');
      await page.getByRole('button', { name: 'Adjust who benefits', exact: true }).click();
      await page.getByRole('button', { name: 'Add recipient', exact: true }).click();
      await page.locator('select[name="allocation-recipient-2-person"]').selectOption(you);
      await page.locator('input[name="allocation-recipient-1-amount"]').fill('21.00');
      await page.locator('input[name="allocation-recipient-2-amount"]').fill('21.00');
      await expect(preview).toContainText('Current: You owe 10.00 USD → After saving: You owe 10.00 USD');
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
    const savedId = '00000000-0000-4000-8000-000000009900';
    let deleted = false;
    await page.route(`**/api/credits/${savedId}`, async (route) => {
      await route.fulfill({ json: { credit: { id: savedId, groupId: group, subtype: 'refund', deliveryMode: 'member_reimbursement', amountMinor: 4200, currency: 'USD', date: '2026-01-02', createdBy: userId, createdAt: '2026-01-02', updatedAt: '2026-01-02', deletedAt: deleted ? '2026-01-03' : null, version: 1, applications: [], allocations: [{ personId: recipient, allocationType: 'recipient', amountMinor: 4200 }, { personId: you, allocationType: 'beneficiary', amountMinor: 2100 }, { personId: recipient, allocationType: 'beneficiary', amountMinor: 2100 }] }, history: [] } });
    });
    for (const width of [320, 390, 767, 768, 895, 896, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE_URL}/groups/${group}/credit/${savedId}/edit`);
      const preview = page.locator('.refund-preview-list');
      await expect(preview).toContainText('Current: You owe 10.00 USD → After saving: You owe 10.00 USD');
      await page.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('EUR');
      await expect(preview).toContainText('Current: You owe 10.00 USD → After saving: You owe 31.00 USD');
      await expect(preview).toContainText('Current: You are owed 3.00 EUR → After saving: You are owed 24.00 EUR');
      await page.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('USD');
      await expect(preview).toContainText('Current: You owe 10.00 USD → After saving: You owe 10.00 USD');
      await page.locator('input[name="allocation-beneficiary-1-amount"]').fill('10.00');
      await page.locator('input[name="allocation-beneficiary-2-amount"]').fill('32.00');
      await expect(preview).toContainText('Current: You owe 10.00 USD → After saving: You owe 21.00 USD');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (process.env.REFUND_SCREENSHOTS && [390, 1440].includes(width)) await page.screenshot({ path: `docs/screenshots/refund-explanations-edit-${width}.png`, fullPage: true });
      await page.goto(`${BASE_URL}/groups/${group}/credits/${savedId}`);
      await expect(page.getByRole('heading', { name: 'Recorded balance effects' })).toBeVisible();
      await expect(page.getByLabel('Saved refund effects')).toContainText('21.00 USD');
      await expect(page.getByLabel('Saved refund effects')).not.toContainText('After saving');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (process.env.REFUND_SCREENSHOTS && [390, 1440].includes(width)) await page.screenshot({ path: `docs/screenshots/refund-explanations-detail-${width}.png`, fullPage: true });
      await page.getByText('Audit history', { exact: true }).click();
      await expect(page.getByText('No audit history.', { exact: true })).toBeVisible();
      deleted = true;
      await page.reload();
      await expect(page.getByText('It has no active balance effects.', { exact: false })).toBeVisible();
      await expect(page.getByLabel('Saved refund effects')).toHaveCount(0);
      deleted = false;
      for (const mode of ['missing', 'error'] as const) {
        balanceMode = mode;
        await page.goto(`${BASE_URL}/groups/${group}/refund/new`);
        await page.locator('.refund-application-row select').first().selectOption(expense);
        await page.locator('#refund-amount').fill('42.00');
        if (mode === 'missing') {
          await expect(page.locator('.refund-preview-list')).toContainText('Balance unavailable (USD); no projection shown.');
          await expect(page.locator('.refund-preview-list')).not.toContainText('After saving:');
        } else {
          await expect(page.locator('.refund-preview-section')).toContainText('Balance projection unavailable');
          await expect(page.locator('.refund-preview-list')).toHaveCount(0);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      balanceMode = 'normal';
    }
  } finally { await context.close(); }
});
