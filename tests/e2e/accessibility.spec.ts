import { test, expect, newAuthenticatedContext, DEV_EMAIL, REGISTERED_EMAIL, BASE_URL, seedOfflineTrust } from './fixtures';
import { DB_NAME, DB_VERSION } from '../../src/app/idb';
import type { Locator, Page } from '@playwright/test';

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
    await expect(nav.getByRole('link', { name: 'Add transaction' })).toBeVisible();
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
      const select = document.querySelector<HTMLSelectElement>('.bottom-nav[aria-label="Primary navigation"] select');
      const selectBox = select?.getBoundingClientRect();
      const selectHit = select && selectBox ? document.elementFromPoint(selectBox.left + selectBox.width / 2, selectBox.top + selectBox.height / 2) : null;
      return { bannerBottom: banner?.bottom || 0, navTop: nav?.top || 0, controls, select: { visible: Boolean(selectBox && selectBox.width > 0 && selectBox.height > 0), accessible: Boolean(select && selectHit && (selectHit === select || select.contains(selectHit))), bottom: selectBox?.bottom || 0 } };
    });
    expect(geometry.bannerBottom).toBeLessThanOrEqual(geometry.navTop - 4);
    expect(geometry.controls).toHaveLength(4);
    expect(geometry.controls.filter((control) => control.visible && control.accessible && control.bottom <= 1024)).toHaveLength(4);
    expect(geometry.select.visible).toBe(true);
    expect(geometry.select.accessible).toBe(true);
    expect(geometry.select.bottom).toBeLessThanOrEqual(1024);
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

test('completed transaction searches preserve cached results on narrow and desktop layouts', async ({ authenticatedPage: page }) => {
  const submitSearch = async (search: Locator, value: string, result: string) => {
    await search.fill(value);
    await search.press('Enter');
    await expect(page).toHaveURL(new RegExp(`[?&]q=${value}(?:&|$)`));
    await expect(page.getByText(result)).toBeVisible();
  };

  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/groups/${richGroupId}/transactions`);
    const disclosure = page.locator('details.transaction-filters-disclosure');
    await disclosure.locator('summary').click();
    const search = page.getByLabel('Search');
    await submitSearch(search, 'dinner', 'Dinner by the canal (edited)');
    await submitSearch(search, 'hotel', 'Hotel near the station');

    await search.fill('dinner');
    await page.evaluate(() => {
      type Observation = { loading: boolean; empty: boolean; dinner: boolean; removedDinner: boolean };
      const panel = document.querySelector('.history-panel');
      if (!panel) throw new Error('Transaction history panel is unavailable');
      const observations: Observation[] = [];
      const read = (): Observation => ({
        loading: [...panel.querySelectorAll('[role="status"]')].some((element) => element.textContent?.trim() === 'Loading…'),
        empty: panel.querySelector('.empty') !== null,
        dinner: panel.textContent?.includes('Dinner by the canal (edited)') === true,
        removedDinner: false,
      });
      const observer = new MutationObserver((records) => observations.push({ ...read(), removedDinner: records.some((record) => [...record.removedNodes].some((node) => node.textContent?.includes('Dinner by the canal (edited)'))) }));
      observer.observe(panel, { attributes: true, childList: true, characterData: true, subtree: true });
      (window as Window & { __transactionSearchObserver?: { observer: MutationObserver; observations: Observation[] } }).__transactionSearchObserver = { observer, observations };
    });
    await search.press('Enter');
    await expect(page).toHaveURL(new RegExp('[?&]q=dinner(?:&|$)'));
    await expect(page.getByText('Dinner by the canal (edited)')).toBeVisible();
    const cachedReturnObservations = await page.evaluate(() => {
      const handle = (window as Window & { __transactionSearchObserver?: { observer: MutationObserver; observations: Array<{ loading: boolean; empty: boolean; dinner: boolean; removedDinner: boolean }> } }).__transactionSearchObserver;
      handle?.observer.disconnect();
      if (handle) delete (window as Window & { __transactionSearchObserver?: unknown }).__transactionSearchObserver;
      return handle?.observations || [];
    });
    expect(cachedReturnObservations.every(({ loading, empty, dinner, removedDinner }) => !loading && !empty && dinner && !removedDinner)).toBe(true);
    await submitSearch(search, 'dinner', 'Dinner by the canal (edited)');
  }
});

test('transaction searches ignore a late result from an earlier scope', async ({ authenticatedPage: page }) => {
  let releaseHotel!: () => void;
  let hotelCompleted = false;
  const hotelResponse = new Promise<void>((resolve) => { releaseHotel = resolve; });
  await page.route('**/api/transactions**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') === 'hotel') {
      await hotelResponse;
      await route.continue();
      hotelCompleted = true;
      return;
    }
    await route.continue();
  });
  let hotelReleased = false;
  const releaseHotelSafely = () => { if (!hotelReleased) { hotelReleased = true; releaseHotel(); } };
  try {
    await page.goto(`/groups/${richGroupId}/transactions`);
    await page.locator('details.transaction-filters-disclosure summary').click();
    const search = page.getByLabel('Search');
    await search.fill('dinner');
    await search.press('Enter');
    await expect(page.getByText('Dinner by the canal (edited)')).toBeVisible();
    await search.fill('hotel');
    await search.press('Enter');
    await expect(page).toHaveURL(new RegExp('[?&]q=hotel(?:&|$)'));
    await expect(page.getByText('Loading…', { exact: true })).toBeVisible();
    await search.fill('dinner');
    await search.press('Enter');
    await expect(page).toHaveURL(new RegExp('[?&]q=dinner(?:&|$)'));
    await expect(page.getByText('Dinner by the canal (edited)')).toBeVisible();
    releaseHotelSafely();
    await expect.poll(() => hotelCompleted).toBe(true);
    await expect(page.getByText('Dinner by the canal (edited)')).toBeVisible();
    await expect(page.getByText('Hotel near the station')).toHaveCount(0);
  } finally {
    releaseHotelSafely();
  }
});

test('normalizes disclosure spacing and nested surfaces across responsive boundaries', async ({ authenticatedPage: page }) => {
  for (const viewport of [390, 768, 895, 896, 1440]) {
    await page.setViewportSize({ width: viewport, height: viewport < 896 ? 844 : 900 });
    await page.goto(`/groups/${richGroupId}`);
    const balance = page.locator('.balance-breakdown');
    await expect(balance).toBeVisible();
    await balance.locator('summary').click();
    await expect(balance).toHaveJSProperty('open', true);
    await expect(balance.locator('.list, .empty, .cache-status').first()).toBeVisible();
    const balanceGeometry = await balance.evaluate((element) => {
      const summary = element.querySelector(':scope > summary')?.getBoundingClientRect();
      const firstContent = Array.from(element.children).find((child) => child.tagName !== 'SUMMARY')?.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { gap: parseFloat(style.rowGap), transition: (firstContent?.top || 0) - (summary?.bottom || 0) };
    });
    expect(balanceGeometry.gap).toBe(12);
    expect(balanceGeometry.transition).toBeGreaterThanOrEqual(11);

    const scheduled = page.locator('.scheduled-summary > details');
    await scheduled.locator('summary').click();
    await expect(scheduled).toHaveJSProperty('open', true);
    await expect(scheduled.locator('.schedule-list-content')).toBeVisible();
    await expect(scheduled.locator('.schedule-list-content > section')).toHaveCount(1);
    await expect(scheduled.locator('.schedule-row')).toHaveCount(1);
    const scheduleChrome = await page.locator('.scheduled-summary .schedule-list-content > section').evaluate((element) => {
      const style = getComputedStyle(element);
      return { margin: style.margin, borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], shadow: style.boxShadow };
    });
    expect(scheduleChrome.margin).toBe('0px');
    expect(scheduleChrome.borderWidths).toEqual(['0px', '0px', '0px', '0px']);
    expect(scheduleChrome.shadow).toBe('none');

    if (viewport < 896) {
      const scheduleTargets = page.locator('.schedule-row a.button, .schedule-row button');
      await expect(scheduleTargets).toHaveCount(3);
      const targetHeights = await scheduleTargets.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
      for (const height of targetHeights) expect(height).toBeGreaterThanOrEqual(44);
    }

    await page.goto(`/groups/${richGroupId}/manage`);
    const generic = page.locator('details.generic-invitation-disclosure');
    await expect(generic).toHaveJSProperty('open', false);
    await generic.locator('summary').click();
    await expect(generic).toHaveJSProperty('open', true);
    await expect(generic.locator('form')).toBeVisible();
    const genericFormMargin = await generic.locator('form').evaluate((element) => getComputedStyle(element).margin);
    expect(genericFormMargin).toBe('0px');

    const sam = page.getByRole('list', { name: 'Group members' }).getByRole('listitem').filter({ hasText: 'Sam Rivera' });
    const targeted = sam.locator('details');
    await expect(targeted).toHaveJSProperty('open', false);
    await targeted.locator('summary').click();
    await expect(targeted).toHaveJSProperty('open', true);
    await expect(targeted.locator('form')).toBeVisible();
    const targetedFormMargin = await targeted.locator('form').evaluate((element) => getComputedStyle(element).margin);
    expect(targetedFormMargin).toBe('0px');

    await page.goto(`/activity?group=${richGroupId}&view=transactions`);
    const filters = page.locator('details.transaction-filters-disclosure');
    await expect(filters).toHaveJSProperty('open', false);
    await filters.locator('summary').click();
    await expect(filters).toHaveJSProperty('open', true);
    await expect(filters.locator('form')).toBeVisible();
    const filterGeometry = await filters.evaluate((element) => {
      const form = element.querySelector('form');
      const style = form ? getComputedStyle(form) : undefined;
      const disclosureStyle = getComputedStyle(element);
      return { formMargin: style?.margin || '', gap: parseFloat(disclosureStyle.rowGap) };
    });
    expect(filterGeometry.formMargin).toBe('0px');
    expect(filterGeometry.gap).toBe(12);
  }
});

test('direct section and surface forms own their flow spacing', async ({ authenticatedPage: page }) => {
  const marginOf = async (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).margin);

  await page.goto('/');
  await page.getByRole('link', { name: '+ Add friend' }).click();
  await expect(page.locator('.surface form')).toBeVisible();
  expect(await marginOf(page.locator('.surface form'))).toBe('0px');

  await page.goto('/groups/new');
  await expect(page.getByRole('heading', { name: 'New group' })).toBeVisible();
  await expect(page.locator('.surface form')).toBeVisible();
  await page.getByRole('button', { name: 'Add another person' }).click();
  await expect(page.locator('.creation-person')).toHaveCount(2);

  await page.goto(`/groups/${richGroupId}/manage`);
  const groupSettingsForm = page.locator('#settings section.group-settings > form');
  await expect(groupSettingsForm).toBeVisible();
  expect(await marginOf(groupSettingsForm)).toBe('0px');

  const addFriend = page.locator('section[aria-labelledby="add-friend-heading"]');
  await addFriend.getByRole('button', { name: 'Add friend' }).click();
  const addFriendForm = addFriend.locator(':scope > form');
  await expect(addFriendForm).toBeVisible();
  expect(await marginOf(addFriendForm)).toBe('0px');

  const splitDefault = page.locator('section.split-default-settings');
  await splitDefault.getByRole('button', { name: /^(Customize|Edit)$/ }).click();
  const splitDefaultForm = splitDefault.locator(':scope > form');
  await expect(splitDefaultForm).toBeVisible();
  expect(await marginOf(splitDefaultForm)).toBe('0px');

  await page.goto('/settings');
  const deletion = page.locator('section[aria-labelledby="delete-account-heading"]');
  const deletionForm = deletion.locator(':scope > form');
  await expect(deletionForm).toBeVisible();
  expect(await marginOf(deletionForm)).toBe('0px');
});

test('standalone section actions stay content-sized across responsive boundaries', async ({ authenticatedPage: page }) => {
  const viewports = [390, 895, 896, 1440];
  const actionGeometry = async (locator: Locator) => locator.evaluate((element) => {
    const parent = element.parentElement;
    const style = getComputedStyle(element);
    const parentStyle = parent ? getComputedStyle(parent) : undefined;
    const parentInset = parentStyle ? parseFloat(parentStyle.paddingLeft) + parseFloat(parentStyle.paddingRight) + parseFloat(parentStyle.borderLeftWidth) + parseFloat(parentStyle.borderRightWidth) : 0;
    return {
      width: element.getBoundingClientRect().width,
      parentContentWidth: parent ? parent.getBoundingClientRect().width - parentInset : 0,
      justifySelf: style.justifySelf,
    };
  });

  for (const width of viewports) {
    await page.setViewportSize({ width, height: width < 896 ? 844 : 900 });
    await page.goto(`/groups/${richGroupId}`);
    const managePeople = page.locator('section[aria-labelledby="people-summary-heading"] > .inline-action');
    await expect(managePeople).toBeVisible();
    const manageGeometry = await actionGeometry(managePeople);
    expect(manageGeometry.justifySelf).toBe('start');
    expect(manageGeometry.width).toBeLessThan(manageGeometry.parentContentWidth);
    const recentList = page.locator('section[aria-labelledby="recent-transactions-heading"] > .list');
    await expect(recentList).toBeVisible();
    const listGeometry = await actionGeometry(recentList);
    expect(Math.abs(listGeometry.width - listGeometry.parentContentWidth)).toBeLessThanOrEqual(1);

    await page.goto(`/groups/${richGroupId}/manage`);
    const actionGroup = page.locator('#settings section.group-settings > .actions');
    await expect(actionGroup).toBeVisible();
    const actionGroupGeometry = await actionGeometry(actionGroup);
    expect(Math.abs(actionGroupGeometry.width - actionGroupGeometry.parentContentWidth)).toBeLessThanOrEqual(1);

    await page.goto('/settings');
    const clearCachedData = page.getByRole('button', { name: 'Clear cached data' });
    await expect(clearCachedData).toBeVisible();
    const clearGeometry = await actionGeometry(clearCachedData);
    expect(clearGeometry.justifySelf).toBe('start');
    expect(clearGeometry.width).toBeLessThan(clearGeometry.parentContentWidth);

    const accountForm = page.locator('section[aria-labelledby="delete-account-heading"] > form');
    await expect(accountForm).toBeVisible();
    const formGeometry = await accountForm.evaluate((element) => {
      const parent = element.parentElement;
      const parentStyle = parent ? getComputedStyle(parent) : undefined;
      const parentInset = parentStyle ? parseFloat(parentStyle.paddingLeft) + parseFloat(parentStyle.paddingRight) + parseFloat(parentStyle.borderLeftWidth) + parseFloat(parentStyle.borderRightWidth) : 0;
      return { width: element.getBoundingClientRect().width, parentContentWidth: parent ? parent.getBoundingClientRect().width - parentInset : 0 };
    });
    expect(Math.abs(formGeometry.width - formGeometry.parentContentWidth)).toBeLessThanOrEqual(1);
  }
});

test('expense form status messages own spacing through the form grid', async ({ authenticatedPage: page }) => {
  await page.route(`${BASE_URL}/api/groups/${richGroupId}`, async (route) => {
    const response = await route.fetch();
    const group = await response.json();
    await route.fulfill({ response, json: { ...group, splitDefault: { method: 'equal', personIds: ['00000000-0000-4000-8000-000000002001', '00000000-0000-4000-8000-000000002003', '00000000-0000-4000-8000-000000002004'] } } });
  });
  await page.goto(`/groups/${richGroupId}/expense/new`);
  const status = page.locator('.expense-form > .cache-status').filter({ hasText: 'Party default applied.' });
  await expect(status).toBeVisible();
  await expect(status).toHaveCSS('margin', '0px');
});

test('scheduled disclosure keeps loading, offline, empty, and error states inside its flow', async ({ browser }) => {
  const schedulePath = `${BASE_URL}/api/groups/${richGroupId}/scheduled-expenses**`;
  const openSchedule = async (page: Page) => {
    const disclosure = page.locator('.scheduled-summary > details');
    await expect(disclosure).toHaveJSProperty('open', false);
    await expect(disclosure.locator('.schedule-list-content')).toBeHidden();
    await disclosure.locator('summary').click();
    await expect(disclosure).toHaveJSProperty('open', true);
    await expect(disclosure.locator('.schedule-list-content')).toBeVisible();
    const nonZeroFlowMargins = await disclosure.locator('.schedule-list-content > section').evaluate((section) => Array.from(section.children).map((child) => getComputedStyle(child).margin).filter((margin) => margin !== '0px'));
    expect(nonZeroFlowMargins).toEqual([]);
    return disclosure;
  };

  const loadingContext = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const loadingPage = await loadingContext.newPage();
  let releaseLoading!: () => void;
  const loadingGate = new Promise<void>((resolve) => { releaseLoading = resolve; });
  await loadingPage.route(schedulePath, async (route) => { await loadingGate; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scheduledExpenses: [] }) }); });
  try {
    await loadingPage.goto(`/groups/${richGroupId}`);
    await expect(loadingPage.getByRole('heading', { name: 'Europe trip · USD + EUR' })).toBeVisible();
    const disclosure = await openSchedule(loadingPage);
    await expect(disclosure.getByRole('status').filter({ hasText: 'Loading…' })).toBeVisible();
  } finally {
    releaseLoading();
    await loadingContext.close();
  }

  const errorContext = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const errorPage = await errorContext.newPage();
  await errorPage.route(schedulePath, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SCHEDULE_UNAVAILABLE', message: 'Schedule fixture outage' } }) }));
  try {
    await errorPage.goto(`/groups/${richGroupId}`);
    const disclosure = await openSchedule(errorPage);
    await expect(disclosure.locator('.error')).toContainText('Schedule fixture outage');
  } finally {
    await errorContext.close();
  }

  const emptyContext = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const emptyPage = await emptyContext.newPage();
  await emptyPage.route(schedulePath, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scheduledExpenses: [] }) }));
  try {
    await emptyPage.goto(`/groups/${richGroupId}`);
    const disclosure = await openSchedule(emptyPage);
    await expect(disclosure).toContainText('No recurring expenses yet.');
  } finally {
    await emptyContext.close();
  }

  const offlineContext = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const offlinePage = await offlineContext.newPage();
  try {
    await offlinePage.goto(`/groups/${richGroupId}`);
    await expect(offlinePage.locator('.schedule-row')).toHaveCount(1);
    await offlineContext.setOffline(true);
    await offlinePage.evaluate(() => window.dispatchEvent(new Event('offline')));
    const disclosure = await openSchedule(offlinePage);
    await expect(disclosure).toContainText('Schedule management requires a connection.');
  } finally {
    await offlineContext.close();
  }
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

test('split transaction control keeps expense first, routes alternates, and disables them offline', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 390, height: 844 });
  const page = await context.newPage();
  try {
    await page.goto(`/groups/${richGroupId}`);
    const mobileControl = page.locator('.bottom-nav .split-transaction-control');
    await expect(mobileControl.getByRole('link', { name: 'Add expense' })).toHaveAttribute('href', `/groups/${richGroupId}/expense/new`);
    await expect(mobileControl.getByRole('link', { name: 'Add expense' })).not.toHaveAttribute('aria-current');
    const menu = mobileControl.getByRole('combobox', { name: 'Choose transaction type' });
    await expect(menu.locator('option')).toHaveText(['More transaction types', 'Refund/reimbursement', 'Payment between members']);
    await menu.selectOption('refund');
    await expect(page).toHaveURL(new RegExp(`/groups/${richGroupId}/refund/new$`));

    await page.goto(`/groups/${richGroupId}`);
    await page.locator('.bottom-nav .split-transaction-control select').selectOption('payment');
    await expect(page).toHaveURL(new RegExp(`/groups/${richGroupId}/settle$`));
    await expect(page.locator('.bottom-nav .split-transaction-control__primary')).not.toHaveAttribute('aria-current');

    await page.goto(`/groups/${richGroupId}`);
    await expect(page.getByRole('link', { name: 'Settle up', exact: true })).toBeVisible();
    await expect(page.locator('main').getByRole('link', { name: 'Add transaction', exact: true })).toHaveCount(0);
    await expect(page.locator('.expense-heading__actions .split-transaction-control')).toBeVisible();

    await page.goto('/');
    const globalControl = page.locator('.bottom-nav .split-transaction-control');
    await expect(globalControl.getByRole('link', { name: 'Add transaction' })).toHaveAttribute('href', '/add');
    const globalMenu = globalControl.getByRole('combobox', { name: /More transaction types unavailable/ });
    await expect(globalMenu).toBeDisabled();
    await expect(globalMenu).toHaveAttribute('title', /Choose a group first/);
    await expect(globalMenu.locator('option').nth(1)).toBeDisabled();

    await page.goto(`/activity?group=${richGroupId}&view=transactions`);
    await expect(page.locator('.bottom-nav .split-transaction-control a')).toHaveAttribute('href', '/add');
    await expect(page.locator('.bottom-nav .split-transaction-control__primary')).not.toHaveAttribute('aria-current');

    await page.goto(`/groups/${richGroupId}/expense/new`);
    await expect(page.locator('.bottom-nav .split-transaction-control__primary')).toHaveAttribute('aria-current', 'page');
    await page.goto(`/groups/${richGroupId}/refund/new`);
    await expect(page.locator('.bottom-nav .split-transaction-control__primary')).not.toHaveAttribute('aria-current');
    await page.goto(`/groups/${richGroupId}/add`);
    await expect(page.locator('.bottom-nav .split-transaction-control__primary')).not.toHaveAttribute('aria-current');
    await page.goto(`/groups/${richGroupId}/settle`);
    const settleMenu = page.locator('.bottom-nav .split-transaction-control select');
    await settleMenu.selectOption('payment');
    await expect(settleMenu).toHaveValue('');

    await page.goto(`/groups/${richGroupId}`);

    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await expect(mobileControl.getByRole('link', { name: 'Add expense' })).toBeVisible();
    await expect(menu).toBeDisabled();
    await expect(menu).toHaveAttribute('title', /require a connection/);
    await expect(menu.locator('option').nth(1)).toBeDisabled();
    await expect(menu.locator('option').nth(1)).toContainText('online only');
    await expect(menu.locator('option').nth(2)).toBeDisabled();
    await expect(menu.locator('option').nth(2)).toContainText('online only');

    for (const width of [320, 390, 430, 768, 895, 896, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const control = page.locator(`${width >= 896 ? '.desktop-nav' : '.bottom-nav'} .split-transaction-control`).first();
      await expect(control).toBeVisible();
      const geometry = await control.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, primary: element.querySelector('a')?.getBoundingClientRect().toJSON(), menu: element.querySelector('select')?.getBoundingClientRect().toJSON(), viewport: { width: window.innerWidth, height: window.innerHeight } }));
      expect(geometry.width).toBeLessThanOrEqual(width);
      expect(geometry.primary?.left || 0).toBeGreaterThanOrEqual(0);
      expect(geometry.primary?.right || 0).toBeLessThanOrEqual((geometry.menu?.left || 0) + 1);
      expect(geometry.menu?.right || 0).toBeLessThanOrEqual(geometry.viewport.width);
      expect(geometry.height).toBeGreaterThanOrEqual(44);
      expect(geometry.primary?.height || 0).toBeGreaterThanOrEqual(44);
      expect(geometry.menu?.width || 0).toBeGreaterThanOrEqual(44);
      expect(geometry.menu?.height || 0).toBeGreaterThanOrEqual(44);
      if (width === 320) {
        const bottomNavGeometry = await page.locator('.bottom-nav').evaluate((nav) => {
          const rect = nav.getBoundingClientRect();
          const items = [...nav.children].map((item) => item.getBoundingClientRect());
          const control = nav.querySelector('.split-transaction-control')?.getBoundingClientRect();
          const primary = nav.querySelector('.split-transaction-control__primary')?.getBoundingClientRect();
          const menu = nav.querySelector('.split-transaction-control__menu')?.getBoundingClientRect();
          const labels = [...nav.querySelectorAll<HTMLElement>('.nav-item > span:last-child, .split-transaction-control__primary')].map((label) => {
            const labelRect = label.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(label);
            const textRect = range.getBoundingClientRect();
            return { contained: textRect.left >= labelRect.left - 1 && textRect.right <= labelRect.right + 1, width: labelRect.width, textWidth: textRect.width };
          });
          const noOverlap = items.every((left, index) => items.slice(index + 1).every((right) => left.right <= right.left + 1 || right.right <= left.left + 1 || left.bottom <= right.top + 1 || right.bottom <= left.top + 1));
          return {
            rect: { left: rect.left, right: rect.right },
            itemWidths: items.map((item) => item.width),
            control: control ? { left: control.left, right: control.right } : null,
            primary: primary ? { width: primary.width } : null,
            menu: menu ? { width: menu.width } : null,
            labels,
            noOverlap,
            documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            viewportWidth: window.innerWidth,
          };
        });
        expect(bottomNavGeometry.itemWidths).toHaveLength(4);
        expect(bottomNavGeometry.itemWidths.every((itemWidth) => itemWidth >= 44)).toBe(true);
        expect(bottomNavGeometry.primary?.width || 0).toBeGreaterThanOrEqual(44);
        expect(bottomNavGeometry.menu?.width || 0).toBeGreaterThanOrEqual(44);
        expect(bottomNavGeometry.rect.left).toBeGreaterThanOrEqual(0);
        expect(bottomNavGeometry.rect.right).toBeLessThanOrEqual(bottomNavGeometry.viewportWidth);
        expect(bottomNavGeometry.control?.left || 0).toBeGreaterThanOrEqual(0);
        expect(bottomNavGeometry.control?.right || 0).toBeLessThanOrEqual(bottomNavGeometry.viewportWidth);
        expect(bottomNavGeometry.noOverlap).toBe(true);
        expect(bottomNavGeometry.labels.every((label) => label.contained)).toBe(true);
        expect(bottomNavGeometry.documentWidth).toBeLessThanOrEqual(bottomNavGeometry.viewportWidth + 1);
      }
      const pageHeaderGeometry = await page.evaluate(() => {
        const actions = document.querySelector('.expense-heading__actions');
        const actionRects = actions ? [...actions.children].map((child) => child.getBoundingClientRect()) : [];
        const split = document.querySelector('.expense-heading__actions .split-transaction-control')?.getBoundingClientRect();
        const primary = document.querySelector('.expense-heading__actions .split-transaction-control__primary')?.getBoundingClientRect();
        const menu = document.querySelector('.expense-heading__actions .split-transaction-control__menu')?.getBoundingClientRect();
        const noOverlap = actionRects.every((left, index) => actionRects.slice(index + 1).every((right) => left.right <= right.left + 1 || right.right <= left.left + 1 || left.bottom <= right.top + 1 || right.bottom <= left.top + 1));
        return { split, primary, menu, noOverlap, viewportWidth: window.innerWidth };
      });
      expect(pageHeaderGeometry.noOverlap).toBe(true);
      expect(pageHeaderGeometry.split?.left || 0).toBeGreaterThanOrEqual(0);
      expect(pageHeaderGeometry.primary?.right || 0).toBeLessThanOrEqual((pageHeaderGeometry.menu?.left || 0) + 1);
      expect(pageHeaderGeometry.menu?.right || 0).toBeLessThanOrEqual(pageHeaderGeometry.viewportWidth);
    }

  } finally {
    await context.close();
  }
});

test('keeps the mobile Add control compact and aligned across inactive and active states', async ({ browser }) => {
  const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 320, height: 844 });
  const page = await context.newPage();
  const addItem = page.locator('.bottom-nav .nav-item--add').filter({ has: page.locator('.split-transaction-control') });
  const mobileWidths = [320, 390, 895];
  const readGeometry = async () => addItem.evaluate((item) => {
    const capsule = item.matches('.nav-item__capsule') ? item : item.querySelector<HTMLElement>('.nav-item__capsule');
    const primary = item.querySelector<HTMLElement>('.split-transaction-control__primary');
    const menu = item.querySelector<HTMLElement>('.split-transaction-control__menu');
    if (!capsule || !primary || !menu) throw new Error('Mobile Add control geometry is incomplete');
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const capsuleStyle = getComputedStyle(capsule);
    const primaryStyle = getComputedStyle(primary);
    const menuStyle = getComputedStyle(menu);
    const rootStyle = getComputedStyle(document.documentElement);
    const rootFontSize = Number.parseFloat(rootStyle.fontSize);
    const cssLength = (value: string) => {
      const normalized = value.trim();
      if (normalized.endsWith('rem')) return Number.parseFloat(normalized) * rootFontSize;
      return Number.parseFloat(normalized);
    };
    return {
      column: box(item),
      capsule: box(capsule),
      primary: box(primary),
      menu: box(menu),
      viewportWidth: window.innerWidth,
      expected: {
        controlMinHeight: cssLength(rootStyle.getPropertyValue('--control-min-height')),
        radius: cssLength(rootStyle.getPropertyValue('--radius-sm')),
        padding: cssLength(rootStyle.getPropertyValue('--space-2')),
      },
      radii: {
        capsule: cssLength(capsuleStyle.borderTopLeftRadius),
        primaryTopLeft: cssLength(primaryStyle.borderTopLeftRadius),
        primaryTopRight: cssLength(primaryStyle.borderTopRightRadius),
        primaryBottomLeft: cssLength(primaryStyle.borderBottomLeftRadius),
        primaryBottomRight: cssLength(primaryStyle.borderBottomRightRadius),
        menuTopLeft: cssLength(menuStyle.borderTopLeftRadius),
        menuTopRight: cssLength(menuStyle.borderTopRightRadius),
        menuBottomLeft: cssLength(menuStyle.borderBottomLeftRadius),
        menuBottomRight: cssLength(menuStyle.borderBottomRightRadius),
      },
      padding: { left: cssLength(primaryStyle.paddingLeft), right: cssLength(primaryStyle.paddingRight) },
    };
  });
  const captureMobileGeometry = async () => {
    const geometries: Array<Awaited<ReturnType<typeof readGeometry>>> = [];
    for (const width of mobileWidths) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('.bottom-nav')).toBeVisible();
      await expect(page.locator('.desktop-nav')).toBeHidden();
      geometries.push(await readGeometry());
    }
    return geometries;
  };
  try {
    await page.goto(`/groups/${richGroupId}`);
    const inactive = addItem;
    await expect(inactive).not.toHaveClass(/nav-item--add--active/);
    const inactiveGeometry = await captureMobileGeometry();

    await page.goto(`/groups/${richGroupId}/refund/new`);
    const active = addItem;
    await expect(active).toHaveClass(/nav-item--add--active/);
    const activeGeometry = await captureMobileGeometry();

    for (let index = 0; index < mobileWidths.length; index += 1) {
      const inactiveAtWidth = inactiveGeometry[index];
      const activeAtWidth = activeGeometry[index];
      for (const part of ['capsule', 'primary', 'menu'] as const) {
        expect(Math.abs(inactiveAtWidth[part].width - activeAtWidth[part].width), `${mobileWidths[index]}px ${part} width`).toBeLessThanOrEqual(1);
        expect(Math.abs(inactiveAtWidth[part].height - activeAtWidth[part].height), `${mobileWidths[index]}px ${part} height`).toBeLessThanOrEqual(1);
      }
      for (const geometry of [inactiveAtWidth, activeAtWidth]) {
        const columnCenter = (geometry.column.left + geometry.column.right) / 2;
        const capsuleCenter = (geometry.capsule.left + geometry.capsule.right) / 2;
        expect(Math.abs(capsuleCenter - columnCenter), `${mobileWidths[index]}px capsule centering`).toBeLessThanOrEqual(1);
        expect(geometry.capsule.width, `${mobileWidths[index]}px compact capsule`).toBeLessThan(geometry.column.width - 1);
        expect(geometry.capsule.left, `${mobileWidths[index]}px capsule containment`).toBeGreaterThanOrEqual(0);
        expect(geometry.capsule.right, `${mobileWidths[index]}px capsule containment`).toBeLessThanOrEqual(geometry.viewportWidth);
        expect(geometry.capsule.height, `${mobileWidths[index]}px capsule touch target`).toBeGreaterThanOrEqual(44);
        expect(geometry.primary.height, `${mobileWidths[index]}px primary touch target`).toBeGreaterThanOrEqual(44);
        expect(Math.abs(geometry.menu.width - geometry.expected.controlMinHeight), `${mobileWidths[index]}px menu width matches control minimum`).toBeLessThanOrEqual(0.5);
        expect(geometry.menu.height, `${mobileWidths[index]}px menu touch target`).toBeGreaterThanOrEqual(44);
        expect(Math.abs(geometry.radii.capsule - geometry.expected.radius), `${mobileWidths[index]}px capsule radius`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(geometry.radii.primaryTopLeft - geometry.expected.radius), `${mobileWidths[index]}px primary left radius`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(geometry.radii.primaryBottomLeft - geometry.expected.radius), `${mobileWidths[index]}px primary left radius`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(geometry.radii.primaryTopRight), `${mobileWidths[index]}px primary right radius`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(geometry.radii.primaryBottomRight), `${mobileWidths[index]}px primary right radius`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(geometry.radii.menuTopLeft), `${mobileWidths[index]}px menu left radius`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(geometry.radii.menuBottomLeft), `${mobileWidths[index]}px menu left radius`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(geometry.radii.menuTopRight - geometry.expected.radius), `${mobileWidths[index]}px menu right radius`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(geometry.radii.menuBottomRight - geometry.expected.radius), `${mobileWidths[index]}px menu right radius`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(geometry.padding.left - geometry.expected.padding), `${mobileWidths[index]}px primary left padding`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(geometry.padding.right - geometry.expected.padding), `${mobileWidths[index]}px primary right padding`).toBeLessThanOrEqual(0.5);
      }
    }

    await expect(page.locator('#refund-source-help')).toBeVisible();
    await expect(page.locator('#refund-mode-help')).toBeVisible();
    const helpers = await page.locator('#refund-source-help, #refund-mode-help').evaluateAll((elements) => elements.map((helper) => {
      const control = helper.previousElementSibling?.querySelector('select');
      if (!control) throw new Error('Refund helper is missing its preceding select');
      return { helperTop: helper.getBoundingClientRect().top, controlBottom: control.getBoundingClientRect().bottom };
    }));
    expect(helpers).toHaveLength(2);
    for (const helper of helpers) expect(helper.helperTop).toBeGreaterThanOrEqual(helper.controlBottom - 1);

    await page.setViewportSize({ width: 896, height: 900 });
    await expect(page.locator('.bottom-nav')).toBeHidden();
    await expect(page.locator('.desktop-nav')).toBeVisible();
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
