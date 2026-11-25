import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, newAuthenticatedContext, BASE_URL, DEV_EMAIL } from './fixtures';

const widths = [320, 390, 599, 600, 767, 768, 895, 896, 1440];
const syntheticNames = ['Demo user', 'Demo friend', 'Sample project'];
test.setTimeout(45_000);

async function evidence(page: Page, name: string) {
  if (process.env.UPDATE_DEBT_SCREENSHOTS !== '1') return;
  await page.evaluate(async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
    await document.fonts.ready;
  });
  await expect(page.getByText(/Dev User|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[a-f0-9]{64}\b/i)).toHaveCount(0);
  await expect(page.locator('.avatar img')).toHaveCount(0);
  for (const avatar of await page.locator('.avatar').all()) {
    expect(syntheticNames).toContain(await avatar.getAttribute('aria-label'));
    expect(await avatar.innerText()).toMatch(/^D[UF]$/);
  }
  for (const input of await page.locator('input').all()) expect(await input.inputValue()).not.toContain('@');
  await page.screenshot({
    path: path.join(process.cwd(), 'docs/screenshots', `record-debt-${name}.png`),
    fullPage: true,
    animations: 'disabled',
    style: '.bottom-nav { visibility: hidden !important; }',
  });
}

async function demoLedger(page: Page, singleMember = false) {
  const response = await page.request.post(`${BASE_URL}/api/groups`, {
    headers: { Origin: BASE_URL },
    data: { name: 'Sample project', currency: 'USD', people: singleMember ? [] : [{ name: 'Demo friend' }] },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { group } = await response.json();
  const id = group.id as string;
  const groupPath = `/groups/${id}`;
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    const { id, email, personId, profileRevision, updatedAt, idleExpiresAt } = await response.json();
    await route.fulfill({ response, json: { id, email, personId, profileRevision, updatedAt, idleExpiresAt, name: 'Demo user', avatarMode: 'initials' } });
  });
  await page.route('**/api/groups', async (route) => {
    const response = await route.fetch();
    const { groups } = await response.json();
    await route.fulfill({ response, json: { groups: groups.filter((item: { id: string }) => item.id === id) } });
  });
  const groupResponse = (await (await page.request.get(`${BASE_URL}/api${groupPath}`)).json());
  const { currentPersonId, members } = groupResponse;
  const friend = members.find((member: { personId: string }) => member.personId !== currentPersonId);
  await page.route(`**/api${groupPath}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const safe = (member: { personId: string; joinedAt: string; role: string; linked: boolean; status?: string }) => ({
      personId: member.personId, joinedAt: member.joinedAt, role: member.role, linked: member.linked, status: member.status,
      name: member.personId === currentPersonId ? 'Demo user' : 'Demo friend', avatarMode: 'initials',
    });
    await route.fulfill({ response, json: { ...json, members: json.members.map(safe), historicalParticipants: json.historicalParticipants.map(safe) } });
  });
  await page.route('**/api/transactions?**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: {
      ...json,
      transactions: json.transactions.filter((item: { groupId: string; kind: string }) => item.groupId === id && item.kind === 'debt').map((item: { debtorPersonId: string; creditorPersonId: string }) => ({
        ...item, groupName: 'Sample project',
        debtorName: item.debtorPersonId === currentPersonId ? 'Demo user' : 'Demo friend',
        creditorName: item.creditorPersonId === currentPersonId ? 'Demo user' : 'Demo friend',
      })),
    } });
  });
  await page.route('**/api/activity?**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const userName = members.find((item: { personId: string }) => item.personId === currentPersonId)?.name;
    await route.fulfill({ response, json: {
      ...json,
      activity: json.activity.filter((item: { groupId: string; type: string }) => item.groupId === id && item.type === 'debt').map((item: { debtorName: string; creditorName: string }) => ({
        ...item, groupName: 'Sample project',
        debtorName: item.debtorName === userName ? 'Demo user' : 'Demo friend',
        creditorName: item.creditorName === userName ? 'Demo user' : 'Demo friend',
      })),
    } });
  });
  return { id, groupPath, friendId: friend?.personId as string | undefined };
}

async function responsive(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const primary = page.locator('main [data-primary-action]');
  await expect(primary).toBeVisible();
  expect((await primary.boundingBox())?.height).toBeGreaterThanOrEqual(44);
}

for (const [device, width] of [['mobile', 320], ['desktop', 1440]] as const) {
  test(`record both debt directions and preserve retry on ${device}`, async ({ browser }) => {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 900 }, { serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const { id, groupPath, friendId } = await demoLedger(page);
      const operationIds: string[] = [];
      await page.route(`**/api${groupPath}/debts`, async (route) => {
        operationIds.push(route.request().postDataJSON().client_operation_id);
        if (operationIds.length === 1) return route.fulfill({ status: 409, json: { error: { message: 'Sample save error' } } });
        await route.continue();
      });
      await page.goto('/add');
      await expect(page.getByLabel('Group / person')).toHaveValue(id);
      const debtLink = page.getByRole('link', { name: 'Record debt', exact: true });
      await expect(debtLink).toHaveAttribute('href', `${groupPath}/debt/new`);
      await evidence(page, `chooser-${device}`);
      await debtLink.click();
      const submit = page.locator('main').getByRole('button', { name: 'Record debt' });
      await expect(page.getByLabel('Member').locator('option')).toHaveText(['Choose a member', 'Demo friend']);
      await page.getByLabel('Member').selectOption(friendId!);
      const amount = page.getByLabel('Amount (USD)');
      await amount.fill('0');
      await submit.click();
      await expect(page.locator('#debt-form-error')).toContainText('Enter a positive amount');
      expect(operationIds).toHaveLength(0);
      await amount.fill('12.50');
      await page.getByLabel('Date').fill('2026-04-20');
      await page.getByLabel('Note (optional)').fill('Sample note');
      await expect(page.locator('main [role="status"]').filter({ hasText: 'Debt entry' })).toContainText('You owe Demo friend $12.50');
      if (device === 'mobile') for (const width of widths) { await page.setViewportSize({ width, height: 900 }); await responsive(page); }
      await page.setViewportSize({ width, height: 900 });
      await evidence(page, `i-owe-${device}`);
      await submit.click();
      await expect(page.locator('#debt-form-error')).toContainText('Sample save error');
      await expect(amount).toHaveValue('12.50');
      await evidence(page, `save-error-${device}`);
      await submit.click();
      const rows = page.getByRole('list', { name: 'Transactions', exact: true });
      await expect(rows.getByText('Debt · You owe Demo friend')).toBeVisible();
      expect(operationIds[1]).toBe(operationIds[0]);
      await page.goto(`${groupPath}/debt/new`);
      await page.getByLabel('Direction').selectOption('owes_me');
      await page.getByLabel('Member').selectOption(friendId!);
      await page.getByLabel('Currency').selectOption('EUR');
      await page.getByLabel('Amount (EUR)').fill('20.00');
      await page.getByLabel('Date').fill('2026-04-21');
      await expect(page.locator('main [role="status"]').filter({ hasText: 'Debt entry' })).toContainText('Demo friend owes you €20.00');
      await responsive(page);
      await evidence(page, `owes-me-${device}`);
      await submit.click();
      await expect(rows.getByText('Debt · Demo friend owes you')).toBeVisible();
      await expect(rows.getByText('Debt · You owe Demo friend')).toBeVisible();
      await evidence(page, `history-${device}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.locator('.transaction-filters-disclosure summary').click();
      await page.getByRole('combobox', { name: 'Transaction kind', exact: true }).selectOption('debt', { timeout: 5_000 });
      await expect(page.getByRole('combobox', { name: 'Category', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(page).toHaveURL(/kind=debt/);
      await expect(rows.getByText('Debt · Demo friend owes you')).toBeVisible();
      await evidence(page, `history-filters-${device}`);
      await page.getByRole('link', { name: 'Changes', exact: true }).click();
      const changes = page.getByRole('list', { name: 'Changes', exact: true });
      await expect(changes.getByText('Demo friend owes Demo user')).toBeVisible();
      await expect(changes.getByText('Demo user owes Demo friend')).toBeVisible();
      await evidence(page, `history-changes-${device}`);
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect(changes.getByText('Demo friend owes Demo user')).toBeVisible();
      await expect(page.getByText('Offline · showing cached history', { exact: false })).toBeVisible();
      await context.setOffline(false);
    } finally { await context.close(); }
  });
}

test('record debt shows loading, empty, offline and cold group error states', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 320, height: 900 }, { serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const { groupPath } = await demoLedger(page, true);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api${groupPath}`, async (route) => { await pending; await route.fallback(); }, { times: 1 });
    try {
      await page.goto('/add');
      await page.getByRole('link', { name: 'Record debt', exact: true }).click();
      await expect(page.locator('main').getByText('Loading…', { exact: true })).toBeVisible();
    } finally { release(); }
    await expect(page.getByText('There are no other active members in this group.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record debt' })).toHaveCount(0);
    const other = await demoLedger(page);
    await page.route(`**/api${other.groupPath}`, (route) => route.fulfill({ status: 400, json: { error: { message: 'Sample group error' } } }), { times: 1 });
    await page.goto(`${other.groupPath}/debt/new`);
    const error = page.locator('#group-members-error');
    await expect(error).toContainText('Sample group error');
    await error.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByLabel('Member')).toBeVisible();
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByText('Recording debt requires a connection.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record debt' })).toBeDisabled();
  } finally { await context.close(); }
});
