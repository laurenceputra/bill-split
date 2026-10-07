import { test, expect, newAuthenticatedContext, DEV_EMAIL } from './fixtures';
import type { Page } from '@playwright/test';

const firstId = '00000000-0000-4000-8000-000000003001';
const secondId = '00000000-0000-4000-8000-000000003002';

async function checkGeometry(page: Page, width: number) {
  const geometry = await page.locator('.chooser-options').evaluate((element) => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    boxes: [...element.children, ...document.querySelectorAll('.chooser-groups select')].map((child) => child.getBoundingClientRect().toJSON()),
    clipped: [...element.children].some((child) => child.scrollWidth > child.clientWidth + 1 || child.scrollHeight > child.clientHeight + 1),
  }));
  expect(geometry.overflow).toBe(false);
  expect(geometry.clipped).toBe(false);
  expect(geometry.boxes.every((box) => box.height >= 44 && box.left >= 0 && box.right <= width)).toBe(true);
  for (const [index, box] of geometry.boxes.entries()) {
    for (const next of geometry.boxes.slice(index + 1)) expect(box.right <= next.left + 1 || next.right <= box.left + 1 || box.bottom <= next.top + 1 || next.bottom <= box.top + 1).toBe(true);
  }
  if (width <= 599) expect(geometry.boxes.slice(0, 3).every((box, index) => index === 0 || box.top >= geometry.boxes[index - 1].bottom)).toBe(true);
}

async function refreshGroups(page: Page) {
  // The successful-auth event forces visible private resources to refresh
  // without expiring/replacing the independently verified identity.
  await page.evaluate(() => window.dispatchEvent(new Event('billsplit-authenticated')));
}

for (const outcome of ['removed', 'failed'] as const) {
  test(`chooser refresh ${outcome} keeps selection truthful`, async ({ browser }) => {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 320, height: 900 }, { serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let requests = 0;
      await page.route('**/api/groups', async (route) => {
        requests++;
        const refresh = requests > 1;
        if (refresh) await gate;
        // A non-network API failure leaves the existing online rules intact.
        if (refresh && outcome === 'failed') return route.fulfill({ status: 400, json: { error: { message: 'Chooser refresh failed' } } });
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, groups: body.groups.filter((group: { id: string }) => group.id === secondId || (!refresh && group.id === firstId)) } });
      });
      await page.goto('/add');
      const select = page.getByRole('combobox', { name: 'Group / person' });
      await select.selectOption(firstId);
      await expect(select).toHaveValue(firstId);
      await refreshGroups(page);
      await expect.poll(() => requests).toBeGreaterThan(1);
      release();
      if (outcome === 'removed') {
        await expect(select).toHaveValue('');
        await expect(select.locator('option')).toHaveCount(2);
        await expect(page.locator('.chooser-options button:disabled')).toHaveCount(3);
        await expect(page.locator('.chooser-options a')).toHaveCount(0);
      } else {
        await expect(select).toHaveValue(firstId);
        await expect(page.locator('.chooser-options a')).toHaveCount(3);
        await expect(page.locator('.chooser-options a').nth(0)).toHaveAttribute('href', `/groups/${firstId}/expense/new`);
        await expect(page.locator('.chooser-options a').nth(1)).toHaveAttribute('href', `/groups/${firstId}/refund/new`);
        await expect(page.locator('.chooser-options a').nth(2)).toHaveAttribute('href', `/groups/${firstId}/settle`);
        await expect(page.getByRole('status').filter({ hasText: 'Showing cached groups; refresh is unavailable.' })).toHaveCount(1);
      }
    } finally { await context.close(); }
  });
}

test('global chooser delayed loading, empty and cold error retry remain distinct', async ({ browser }) => {
  for (const state of ['empty', 'error'] as const) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 320, height: 900 }, { serviceWorkers: 'block' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const page = await context.newPage();
      let requested = false;
      let retry = false;
      await page.route('**/api/groups', async (route) => {
        requested = true;
        await gate;
        if (state === 'error' && !retry) return route.fulfill({ status: 500, json: { error: { message: 'Chooser cold failure' } } });
        await route.fulfill({ json: { groups: [] } });
      });
      await page.goto('/add');
      await expect.poll(() => requested).toBe(true);
      await expect(page.locator('main').getByText('Loading…', { exact: true })).toBeVisible();
      await expect(page.locator('.chooser-options')).toHaveCount(0);
      await expect(page.getByText('This group is unavailable.', { exact: false })).toHaveCount(0);
      release();
      if (state === 'error') {
        await expect(page.locator('#transaction-chooser-error')).toBeVisible();
        await expect(page.locator('.chooser-options')).toHaveCount(0);
        retry = true;
        await page.locator('#transaction-chooser-error').getByRole('button', { name: /retry/i }).click();
      }
      await expect(page.getByText('No groups yet.', { exact: false })).toBeVisible();
      await expect(page.locator('main').getByRole('link', { name: 'Create a group' })).toHaveAttribute('href', '/groups/new');
      await expect(page.locator('main').getByRole('link', { name: 'add a friend' })).toHaveAttribute('href', '/friends/new');
      await expect(page.locator('.chooser-options')).toHaveCount(0);
    } finally { release(); await context.close(); }
  }
});

test('scoped chooser waits for a cold lookup and retains cached actions during refresh', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 320, height: 900 }, { serviceWorkers: 'block' });
  let release!: () => void;
  let gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const page = await context.newPage();
    let requests = 0;
    await page.route('**/api/groups', (route) => route.fulfill({ json: { groups: [] } }));
    await page.route(`**/api/groups/${secondId}`, async (route) => {
      requests++;
      await gate;
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    await page.goto(`/groups/${secondId}/add`);
    await expect.poll(() => requests).toBe(1);
    await expect(page.locator('main').getByText('Loading…', { exact: true })).toBeVisible();
    await expect(page.getByText('This group is unavailable.', { exact: false })).toHaveCount(0);
    await expect(page.locator('.chooser-options')).toHaveCount(0);
    release();
    await expect(page.locator('.chooser-options a')).toHaveCount(3);
    gate = new Promise<void>((resolve) => { release = resolve; });
    await refreshGroups(page);
    await expect.poll(() => requests).toBe(2);
    await expect(page.locator('.chooser-options [data-primary-action]')).toHaveAttribute('href', `/groups/${secondId}/expense/new`);
    await expect(page.getByText('This group is unavailable.', { exact: false })).toHaveCount(0);
    release();
    await expect(page.locator('.chooser-options a')).toHaveCount(3);
  } finally { release(); await context.close(); }
});

test('compact chooser selects one group, preserves destinations and survives offline at audit widths', async ({ browser }) => {
  for (const width of [320, 390, 599, 600, 768, 895, 896, 1440]) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width, height: 900 }, { serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await page.route('**/api/groups', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, groups: [
          { ...body.groups[0], id: secondId, kind: 'named', name: 'Zebra household and shared care expenses with a very long group name' },
          { ...body.groups[0], id: firstId, kind: 'named', name: 'Alpha family' },
        ] } });
      });
      await page.goto('/add');
      const select = page.getByRole('combobox', { name: 'Group / person' });
      const actions = page.locator('.chooser-options');
      await expect(select).toHaveValue('');
      await expect(select.locator('option')).toHaveText(['Choose a group', 'Alpha family', 'Zebra household and shared care expenses with a very long group name']);
      await expect(actions).toHaveCount(1);
      await expect(actions.locator('button:disabled')).toHaveCount(3);
      await checkGeometry(page, width);
      for (const id of [firstId, secondId]) {
        await select.selectOption(id);
        await expect(actions.getByRole('link', { name: 'Add expense', exact: true })).toHaveAttribute('href', `/groups/${id}/expense/new`);
        await expect(actions.getByRole('link', { name: 'Refund/reimbursement', exact: true })).toHaveAttribute('href', `/groups/${id}/refund/new`);
        await expect(actions.getByRole('link', { name: 'Payment between members', exact: true })).toHaveAttribute('href', `/groups/${id}/settle`);
      }
      await checkGeometry(page, width);
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect(actions.locator('button:disabled')).toHaveCount(2);
      await expect(actions.getByRole('link', { name: 'Add expense' })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Refunds and payments are online-only' })).toHaveCount(1);
      await checkGeometry(page, width);
    } finally { await context.close(); }
  }
});

test('one group auto-selects while scoped and unavailable choosers never offer a dropdown', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 320, height: 900 }, { serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.route('**/api/groups', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, groups: body.groups.filter((group: { id: string }) => group.id === secondId) } });
    });
    await page.goto('/add');
    await expect(page.getByRole('combobox', { name: 'Group / person' })).toHaveValue(secondId);
    await expect(page.locator('.chooser-options [data-primary-action]')).toHaveAttribute('href', `/groups/${secondId}/expense/new`);
    await page.goto(`/groups/${secondId}/add`);
    await expect(page.locator('.chooser-options')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Group / person' })).toHaveCount(0);
    await page.route('**/api/groups/missing-chooser-group', (route) => route.fulfill({ json: { group: null, members: [] } }));
    await page.goto('/groups/missing-chooser-group/add');
    await expect(page.getByRole('alert').filter({ hasText: 'This group is unavailable' })).toBeVisible();
    await expect(page.locator('.chooser-options')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Group / person' })).toHaveCount(0);
  } finally { await context.close(); }
});
