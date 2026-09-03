import { test, expect, newAuthenticatedContext, DEV_EMAIL, REGISTERED_EMAIL, BASE_URL, seedOfflineTrust } from './fixtures';
import { DB_NAME, DB_VERSION } from '../../src/app/idb';

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
  const sam = members.getByRole('listitem').filter({ hasText: 'Sam Rivera' });
  await expect(sam.locator('summary')).toHaveText('Add email');
  await expect(page.getByLabel('Email for Sam Rivera')).toHaveCount(0);
  await sam.locator('summary').click();
  await expect(page.getByLabel('Email for Sam Rivera')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Invitations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite a new member' })).toBeVisible();
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

test('active auth banner stays clear of tablet navigation controls', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 768, height: 1024 });
  const page = await context.newPage();
  let groupsAttempts = 0;
  await page.route(`${BASE_URL}/api/groups`, async (route) => {
    groupsAttempts += 1;
    if (groupsAttempts === 1) {
      // Hold the specific home-resource request until the authenticated
      // private shell has mounted. This avoids racing the coordinator's
      // /api/me probe while still publishing the outage through the normal
      // API wrapper.
      await expect(page.locator('.auth-loading-shell')).toHaveCount(0);
    }
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AUDIT_SERVICE_UNAVAILABLE', message: 'Fixture outage' } }) });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Friends & groups' })).toBeVisible();
  try {
    // The first response mounts the private shell and exposes the resource's
    // own retry action. Trigger the outage again from that in-app action after
    // startup requests are quiescent, so a late auth probe cannot overwrite
    // the connection-issue state being asserted here.
    await page.waitForLoadState('networkidle');
    await page.locator('#groups-error').getByRole('button', { name: 'Retry' }).click();
    const banner = page.locator('.auth-banner');
    await expect(banner).toContainText('Connection issue');
    const nav = page.locator('.bottom-nav[aria-label="Primary navigation"]');
    await expect(page.locator('.auth-loading-shell')).toHaveCount(0);
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link')).toHaveCount(4);
    await expect(nav.getByRole('link', { name: 'Groups' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'History' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Add expense' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(banner).toContainText('Connection issue');
    const geometry = await page.evaluate(() => {
      const banner = document.querySelector('.auth-banner')?.getBoundingClientRect();
      const nav = document.querySelector('.bottom-nav[aria-label="Primary navigation"]')?.getBoundingClientRect();
      const controls = [...document.querySelectorAll<HTMLAnchorElement>('.bottom-nav[aria-label="Primary navigation"] a')].map((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { visible: box.width > 0 && box.height > 0, accessible: hit === element || element.contains(hit), top: box.top, bottom: box.bottom };
      });
      return { bannerBottom: banner?.bottom || 0, navTop: nav?.top || 0, controls };
    });
    expect(geometry.bannerBottom).toBeLessThanOrEqual(geometry.navTop - 4);
    expect(geometry.controls).toHaveLength(4);
    expect(geometry.controls.every((control) => control.visible && control.accessible && control.bottom <= 1024)).toBe(true);
  } finally {
    await context.close();
  }
});

test('group route cold loading keeps mobile anchors stable and actions horizontal', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const page = await context.newPage();
  await page.addInitScript(() => {
    let value = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!shift.hadRecentInput) value += shift.value || 0;
      }
    });
    observer.observe({ type: 'layout-shift', buffered: false });
    (window as Window & { __groupColdLayoutShift?: () => number }).__groupColdLayoutShift = () => value;
  });
  await page.route(`${BASE_URL}/api/groups/${richGroupId}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    await route.continue();
  });
  try {
    await page.goto(`/groups/${richGroupId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.route-loading--group')).toBeVisible();
    const loading = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return rect ? { top: rect.top, height: rect.height } : undefined;
      };
      return { back: box('.route-loading--group .skeleton--back'), title: box('.route-loading--group .page-title'), actions: box('.route-loading--group .route-loading__actions'), direction: getComputedStyle(document.querySelector('.route-loading--group .route-loading__actions')!).flexDirection };
    });
    expect(loading.back?.height).toBeGreaterThanOrEqual(44);
    expect(loading.actions?.height).toBeGreaterThanOrEqual(44);
    expect(loading.direction).toBe('row');

    await expect(page.getByRole('heading', { name: 'Europe trip · USD + EUR' })).toBeVisible({ timeout: 10_000 });
    const rendered = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return rect ? { top: rect.top, height: rect.height } : undefined;
      };
      return { back: box('.back'), title: box('.page-title'), actions: box('.expense-heading__actions'), direction: getComputedStyle(document.querySelector('.expense-heading__actions')!).flexDirection, layoutShift: (window as Window & { __groupColdLayoutShift?: () => number }).__groupColdLayoutShift?.() || 0 };
    });
    expect(rendered.direction).toBe('row');
    expect(Math.abs((rendered.back?.top || 0) - (loading.back?.top || 0))).toBeLessThanOrEqual(8);
    expect(Math.abs((rendered.title?.top || 0) - (loading.title?.top || 0))).toBeLessThanOrEqual(8);
    expect(Math.abs((rendered.actions?.height || 0) - (loading.actions?.height || 0))).toBeLessThanOrEqual(8);
    expect(rendered.layoutShift).toBeLessThan(0.1);
  } finally {
    await context.close();
  }
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
  await expect(page).toHaveURL(new RegExp(`/activity\\?group=${richGroupId}&view=transactions$`));
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Transactions' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Filter history by group')).toHaveValue(richGroupId);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/groups/${richGroupId}$`));
  await expect(page.getByRole('heading', { name: 'Europe trip · USD + EUR' })).toBeVisible();
  await page.getByRole('link', { name: 'Manage people' }).click();
  await expect(page).toHaveURL(new RegExp(`/groups/${richGroupId}/manage#people$`));
  await expect(page.locator('#people')).toBeFocused();
});

test('group navigation keeps History and Add expense scoped to the group', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const page = await context.newPage();
  try {
    await page.goto(`/groups/${richGroupId}`);
    const expectedHistory = `/activity?group=${richGroupId}&view=changes`;
    const expectedAdd = `/groups/${richGroupId}/expense/new`;
    await expect(page.locator('.bottom-nav').getByRole('link', { name: 'History' })).toHaveAttribute('href', expectedHistory);
    await expect(page.locator('.bottom-nav').getByRole('link', { name: 'Add expense' })).toHaveAttribute('href', expectedAdd);

    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator('.desktop-nav').getByRole('link', { name: 'History' })).toHaveAttribute('href', expectedHistory);
    await expect(page.locator('.desktop-nav').getByRole('link', { name: 'Add expense' })).toHaveAttribute('href', expectedAdd);
  } finally {
    await context.close();
  }
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
    await page.getByRole('button', { name: 'Invite a new member' }).click();
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
    await page.getByRole('button', { name: 'Invite a new member' }).click();
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
    if (request.url().includes('/api/transactions?')) transactionRequests += 1;
  });
  try {
    await page.goto(`/groups/${richGroupId}/transactions`);
    await expect(page).toHaveURL(new RegExp(`/activity\\?group=${richGroupId}&view=transactions$`));
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Transactions' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByLabel('Filter history by group')).toHaveValue(richGroupId);
    await expect(page.getByText('Dinner by the canal (edited)')).toBeVisible();
    await seedOfflineTrust(page);
    await expect.poll(() => page.evaluate(({ dbName, dbVersion, userId, groupId }) => new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open(dbName, dbVersion);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['groups', 'groupSnapshots'], 'readonly');
        const groups = transaction.objectStore('groups').get(userId);
        const snapshot = transaction.objectStore('groupSnapshots').get([userId, groupId]);
        transaction.oncomplete = () => {
          db.close();
          const cachedSnapshot = snapshot.result;
          resolve(Boolean(groups.result && cachedSnapshot?.group && cachedSnapshot?.members && cachedSnapshot?.transactions && cachedSnapshot.transactionsLimit >= 25));
        };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    }), { dbName: DB_NAME, dbVersion: DB_VERSION, userId: '00000000-0000-4000-8000-000000001001', groupId: richGroupId })).toBe(true);
    await page.evaluate(({ dbName, dbVersion }) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(dbName, dbVersion);
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
    }), { dbName: DB_NAME, dbVersion: DB_VERSION });
    await page.waitForLoadState('networkidle');
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    });
    transactionRequests = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL(new RegExp(`/activity\\?group=${richGroupId}&view=transactions$`));
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Transactions' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByLabel('Filter history by group')).toHaveValue(richGroupId);
    await expect(page.getByText('Dinner by the canal (edited)')).toBeVisible();
    await expect(page.getByText('Offline · transaction history and server filters need a connection.')).toBeVisible();
    await expect(page.getByLabel('Search')).toBeDisabled();
    await expect(page.locator('.transaction-filters select').first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Load more transactions' })).toBeDisabled();
    expect(transactionRequests).toBe(0);
  } finally {
    await context.close();
  }
});
