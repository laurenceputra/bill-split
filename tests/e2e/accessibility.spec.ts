import { test, expect, newAuthenticatedContext, REGISTERED_EMAIL, BASE_URL, seedOfflineTrust } from './fixtures';

const richGroupId = '00000000-0000-4000-8000-000000003002';

test('public shell exposes a skip link and keyboard-focusable auth actions', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.public-shell')).toBeVisible();
  const skipLink = page.locator('.skip-link').first();
  await expect(skipLink).toHaveAttribute('href', '#public-main-content');
  await expect.poll(() => skipLink.evaluate((element) => {
    (element as HTMLElement).focus();
    return document.activeElement === element;
  })).toBe(true);
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign up' }).first()).toBeVisible();
});

test('authenticated settings keeps navigation semantics and labelled controls', async ({ authenticatedPage: page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Settings' }).first()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Typed confirmation')).toBeVisible();
  await page.getByLabel('Typed confirmation').focus();
  await page.keyboard.type('DELETE MY ACCOUNT');
  await expect(page.getByRole('button', { name: 'Delete BillSplit account' })).toBeDisabled();
});

test('owner manage route exposes semantic member rows and owner controls', async ({ authenticatedPage: page }) => {
  await page.goto(`/groups/${richGroupId}/manage`);
  await expect(page.getByRole('heading', { name: 'Manage group' })).toBeVisible();
  const members = page.getByRole('list', { name: 'Group members' });
  await expect(members).toBeVisible();
  await expect(members.getByRole('listitem')).toHaveCount(5);
  await expect(members.getByRole('listitem').filter({ hasText: 'Dev User' }).getByRole('button')).toHaveCount(0);
  await expect(members.getByRole('listitem').filter({ hasText: 'Sam Rivera' }).getByRole('button', { name: 'Remove' })).toBeVisible();
  await expect(page.getByLabel('Invite by email')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Invitations' })).toBeVisible();
  await expect(page.getByText('No invitations yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export JSON' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete group' })).toBeVisible();
});

test('member manage route hides owner controls but keeps export and leave actions', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, REGISTERED_EMAIL);
  const page = await context.newPage();
  try {
    await page.goto(`/groups/${richGroupId}/manage`);
    await expect(page.getByRole('heading', { name: 'Manage group' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Group members' }).getByRole('listitem')).toHaveCount(5);
    await expect(page.getByRole('heading', { name: 'Invitations' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Add friend' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export JSON' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Leave group' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('group page keeps primary actions, balances, and transactions before management summaries on mobile', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/groups/${richGroupId}`);
  await expect(page.getByRole('heading', { name: 'Recent transactions' })).toBeVisible();
  const headings = await page.locator('main h2').allTextContents();
  expect(headings.indexOf('Your balances')).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf('Recent transactions')).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf('Your balances')).toBeLessThan(headings.indexOf('Recent transactions'));
});

test('transaction filter disclosure remains native and opens for URL filters', async ({ authenticatedPage: page }) => {
  await page.goto(`/groups/${richGroupId}/transactions?q=dinner`);
  const disclosure = page.locator('details.transaction-filters-disclosure');
  await expect(disclosure).toHaveJSProperty('open', true);
  await expect(page.getByText('1 active filter')).toBeVisible();
  await disclosure.locator('summary').click();
  await expect(disclosure).toHaveJSProperty('open', false);
});

test('group overview exposes history and manage anchors', async ({ authenticatedPage: page }) => {
  await page.goto(`/groups/${richGroupId}`);
  await page.getByRole('link', { name: 'View all transactions' }).click();
  await expect(page.getByRole('heading', { name: 'All transactions' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Europe trip' }).click();
  await page.getByRole('link', { name: 'Manage people' }).click();
  await expect(page).toHaveURL(new RegExp(`/groups/${richGroupId}/manage#people$`));
  await expect(page.locator('#people')).toBeFocused();
});

test('member manage route renders an online retryable error without cached group data', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, REGISTERED_EMAIL);
  const page = await context.newPage();
  await page.route(`${BASE_URL}/api/groups/${richGroupId}`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AUDIT_SERVICE_UNAVAILABLE', message: 'Fixture outage' } }) }));
  try {
    await page.goto(`/groups/${richGroupId}/manage`);
    await expect(page.locator('#group-manage-error')).toBeVisible();
    await expect(page.locator('#group-manage-error').getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.getByText('Loading…')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('manage route shows loading and then concise offline state', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser);
  const page = await context.newPage();
  await page.route(`${BASE_URL}/api/groups/${richGroupId}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  try {
    await page.goto(`/groups/${richGroupId}/manage`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Loading…')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Manage group' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('No invitations yet.')).toBeVisible();
    await seedOfflineTrust(page);
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await expect(page.getByRole('heading', { name: 'Manage group' })).toBeVisible();
    await expect(page.locator('.offline-banner')).toContainText('cached group data');
    await expect(page.getByText('Showing cached invitations; they may be out of date. Invitation changes require a connection.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Invite' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add friend' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Export JSON' })).toBeDisabled();
  } finally {
    await context.close();
  }
});

test('cold offline manage route does not fetch uncached owner invitations', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser);
  const page = await context.newPage();
  let invitationRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes(`/api/groups/${richGroupId}/invitations`)) invitationRequests += 1;
  });
  try {
    await page.goto(`/groups/${richGroupId}/manage`);
    await expect(page.getByRole('heading', { name: 'Manage group' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Invitations' })).toBeVisible();
    await expect(page.getByText('No invitations yet.')).toBeVisible();
    await seedOfflineTrust(page);
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await expect(page.locator('.offline-banner')).toContainText('cached group data');
    await page.waitForLoadState('networkidle');
    // Keep the cold reload's browser signal deterministic: Chromium can briefly
    // report online during a reload even though the context remains offline.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    });
    invitationRequests = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Manage group' })).toBeVisible();
    await expect(page.getByText('Invitations aren’t cached on this device and need a connection')).toBeVisible();
    await expect(page.getByText('Loading…')).toHaveCount(0);
    await expect(page.locator('#invitation-management-error')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Invite' })).toBeDisabled();
    expect(invitationRequests).toBe(0);
  } finally {
    await context.close();
  }
});

test('cold offline history hydrates the scoped first page and disables server-only controls', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser);
  const page = await context.newPage();
  let transactionRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes(`/api/groups/${richGroupId}/transactions`)) transactionRequests += 1;
  });
  try {
    await page.goto(`/groups/${richGroupId}/transactions`);
    await expect(page.getByRole('heading', { name: 'All transactions' })).toBeVisible();
    await expect(page.getByText('Dinner by the canal (edited)')).toBeVisible();
    await seedOfflineTrust(page);
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('bill-split-local', 10);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('groupSnapshots', 'readwrite');
        const get = transaction.objectStore('groupSnapshots').get(['00000000-0000-4000-8000-000000001001', '00000000-0000-4000-8000-000000003002']);
        get.onsuccess = () => {
          const snapshot = get.result;
          snapshot.transactionsNextCursor = 'cold-next-page';
          transaction.objectStore('groupSnapshots').put(snapshot);
        };
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    }));
    await page.waitForLoadState('networkidle');
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    });
    transactionRequests = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'All transactions' })).toBeVisible();
    await expect(page.getByText('Dinner by the canal (edited)')).toBeVisible();
    await expect(page.getByText('Offline: showing the cached first page only. History is incomplete; filters and loading more need a connection.')).toBeVisible();
    await expect(page.getByLabel('Search')).toBeDisabled();
    await expect(page.locator('.transaction-filters select').first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Load more transactions' })).toBeDisabled();
    expect(transactionRequests).toBe(0);
  } finally {
    await context.close();
  }
});
