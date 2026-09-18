import { test, expect, newAuthenticatedContext, DEV_EMAIL, REGISTERED_EMAIL, BASE_URL } from './fixtures';

const GROUP_ID = '00000000-0000-4000-8000-000000003002';
const EMPTY_GROUP_ID = '00000000-0000-4000-8000-000000003001';
const SECOND_GROUP_ID = '00000000-0000-4000-8000-000000003003';

function shortInsightFixture(monthCount: number) {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = (value: Date) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const trendFrom = date(new Date(now.getFullYear(), now.getMonth() - 5, 1));
  const trendTo = date(now);
  const firstMonth = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const months = Array.from({ length: 6 }, (_, index) => date(new Date(firstMonth.getFullYear(), firstMonth.getMonth() + index, 1)).slice(0, 7));
  const categoryTrends = ['Food', 'Travel', 'Bills', 'Other'].flatMap((category, categoryIndex) => months.slice(-monthCount).map((bucket, monthIndex) => ({ currency: 'USD', bucket, category, groupSpendMinor: (categoryIndex + 1) * (monthIndex + 1) * 100, allocatedSpendMinor: (categoryIndex + 1) * (monthIndex + 1) * 50, expenseCount: 1 })));
  return { summary: { scope: 'global' as const, summaries: [{ currency: 'USD' as const, groupSpendMinor: 1000, allocatedSpendMinor: 500, yourShareMinor: 500, youPaidMinor: 500, expenseCount: categoryTrends.length }] }, trends: { scope: 'global' as const, trendFrom, trendTo, categoryTrends } };
}

test('fits one-, two-, and three-month insight spans on narrow screens', async ({ browser }) => {
  for (const monthCount of [1, 2, 3]) {
    const context = await newAuthenticatedContext(browser, DEV_EMAIL, { width: 320, height: 844 });
    const page = await context.newPage();
    const fixture = shortInsightFixture(monthCount);
    await page.route(`${BASE_URL}/api/spending-insights**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(new URL(route.request().url()).searchParams.get('view') === 'trends' ? fixture.trends : fixture.summary) }));
    try {
      await page.goto(`${BASE_URL}/activity?view=insights&period=month`, { waitUntil: 'domcontentloaded' });
      const plot = page.locator('.category-trend-plot');
      await expect(plot).toHaveCount(1);
      await expect(plot.locator('.category-trend-month')).toHaveCount(monthCount);
      const layout = await plot.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), labels: Array.from(element.querySelectorAll('.category-trend-month small')).map((label) => { const range = document.createRange(); range.selectNodeContents(label); return new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size; }) }));
      expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.clientWidth + 1);
      expect(layout.documentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(321);
      expect(layout.labels, JSON.stringify(layout)).toEqual(Array(monthCount).fill(1));
    } finally {
      await context.close();
    }
  }
});

test('clears stale insight currency when History changes group scope', async ({ authenticatedPage }) => {
  const insightRequests: string[] = [];
  authenticatedPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/spending-insights') insightRequests.push(url.href);
  });
  await authenticatedPage.route(`${BASE_URL}/api/spending-insights**`, (route) => {
    const group = new URL(route.request().url()).searchParams.get('group');
    const currency = group === GROUP_ID ? 'EUR' as const : group === SECOND_GROUP_ID ? 'GBP' as const : 'USD' as const;
    const fixture = shortInsightFixture(1);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...(new URL(route.request().url()).searchParams.get('view') === 'trends'
        ? { ...fixture.trends, scope: group ? 'group' : 'global', categoryTrends: fixture.trends.categoryTrends.map((row) => ({ ...row, currency })) }
        : { ...fixture.summary, scope: group ? 'group' : 'global', summaries: fixture.summary.summaries.map((summary) => ({ ...summary, currency })) }),
    }) });
  });

  await authenticatedPage.goto(`/activity?group=${GROUP_ID}&view=insights&period=custom&from=2026-01-01&to=2026-01-31&currency=EUR`);
  const groupFilter = authenticatedPage.getByLabel('Filter history by group');
  await expect(groupFilter).toHaveValue(GROUP_ID);
  await expect(authenticatedPage.locator('.insight-currency-tab[aria-selected="true"]')).toHaveText('EUR');
  await expect.poll(() => [...new Set(insightRequests.map((requestUrl) => new URL(requestUrl).searchParams.get('view')))].sort()).toEqual(['summary', 'trends']);

  const selectScope = async (group: string | undefined, currency: string) => {
    const requestStart = insightRequests.length;
    await groupFilter.selectOption(group ? { value: group } : { label: 'All groups' });
    await expect.poll(() => [...new Set(insightRequests.slice(requestStart).map((requestUrl) => new URL(requestUrl).searchParams.get('view')))].sort()).toEqual(['summary', 'trends']);
    const subsequentRequests = insightRequests.slice(requestStart).map((requestUrl) => new URL(requestUrl));
    expect(subsequentRequests.every((url) => (url.searchParams.get('group') || undefined) === group)).toBe(true);
    expect(subsequentRequests.every((url) => !url.searchParams.has('currency'))).toBe(true);
    const summaryRequests = subsequentRequests.filter((url) => url.searchParams.get('view') === 'summary');
    expect(summaryRequests.length).toBeGreaterThan(0);
    expect(summaryRequests.every((url) => url.searchParams.get('from') === '2026-01-01' && url.searchParams.get('to') === '2026-01-31')).toBe(true);
    await expect.poll(() => {
      const url = new URL(authenticatedPage.url());
      return { group: url.searchParams.get('group') || undefined, period: url.searchParams.get('period'), from: url.searchParams.get('from'), to: url.searchParams.get('to'), currency: url.searchParams.get('currency') };
    }).toEqual({ group, period: 'custom', from: '2026-01-01', to: '2026-01-31', currency: null });
    await expect(authenticatedPage.locator('.insight-currency-tab[aria-selected="true"]')).toHaveText(currency);
  };

  await selectScope(SECOND_GROUP_ID, 'GBP');
  const reloadRequestStart = insightRequests.length;
  await authenticatedPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(authenticatedPage.locator('.insight-currency-tab[aria-selected="true"]')).toHaveText('GBP');
  await expect.poll(() => [...new Set(insightRequests.slice(reloadRequestStart).map((requestUrl) => new URL(requestUrl).searchParams.get('view')))].sort()).toEqual(['summary', 'trends']);
  await selectScope(undefined, 'USD');
  await selectScope(GROUP_ID, 'EUR');

  await authenticatedPage.goto(`/activity?group=${GROUP_ID}&view=transactions&currency=EUR&from=2026-01-01&to=2026-01-31`);
  await expect(groupFilter).toHaveValue(GROUP_ID);
  await groupFilter.selectOption(SECOND_GROUP_ID);
  await expect.poll(() => {
    const url = new URL(authenticatedPage.url());
    return { group: url.searchParams.get('group'), currency: url.searchParams.get('currency'), from: url.searchParams.get('from'), to: url.searchParams.get('to') };
  }).toEqual({ group: SECOND_GROUP_ID, currency: 'EUR', from: '2026-01-01', to: '2026-01-31' });
});

test('shows targeted participant controls to owners but not regular members', async ({ authenticatedPage, browser }) => {
  let invitationGets = 0;
  authenticatedPage.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes(`/api/groups/${GROUP_ID}/invitations`)) invitationGets += 1;
  });
  await authenticatedPage.goto(`/groups/${GROUP_ID}/manage`);
  const people = authenticatedPage.getByRole('list', { name: 'Group members' });
  const sam = people.getByRole('listitem').filter({ hasText: 'Sam Rivera' });
  await expect(sam.locator('summary')).toHaveText('Add email');
  await sam.locator('summary').click();
  await expect(sam.getByLabel('Email for Sam Rivera')).toBeVisible();
  await expect(authenticatedPage.getByRole('heading', { name: 'Invitations' })).toBeVisible();
  await expect(authenticatedPage.getByLabel('Generic invitation history')).toHaveCount(0);
  await expect.poll(() => invitationGets).toBe(1);

  const memberContext = await newAuthenticatedContext(browser, REGISTERED_EMAIL);
  const memberPage = await memberContext.newPage();
  try {
    await memberPage.goto(`/groups/${GROUP_ID}/manage`);
    await expect(memberPage.getByRole('heading', { name: 'Invitations' })).toHaveCount(0);
    await expect(memberPage.getByRole('heading', { name: 'People' })).toBeVisible();
    await expect(memberPage.getByRole('list', { name: 'Group members' }).locator('summary')).toHaveCount(0);
  } finally {
    await memberContext.close();
  }
});

test('explains named-group peer eligibility across responsive and invitation states', async ({ authenticatedPage, browser }) => {
  await authenticatedPage.goto(`/groups/${GROUP_ID}/manage`);
  await expect(authenticatedPage.getByRole('heading', { name: 'Relationship type' })).toBeVisible();
  await expect(authenticatedPage.getByText('Exactly two active ledger participants are required.')).toBeVisible();
  await expect(authenticatedPage.getByRole('button', { name: 'Convert to peer relationship' })).toHaveCount(0);

  const viewports = [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 895, height: 900 }, { width: 896, height: 900 }, { width: 1440, height: 900 }];
  const installNamedGroupRoutes = async (page: typeof authenticatedPage, invitations: unknown[] = [], kind: () => 'named' | 'peer' = () => 'named') => {
    await page.route(`${BASE_URL}/api/groups/${GROUP_ID}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { group: Record<string, unknown>; members: unknown[]; historicalParticipants?: unknown[] };
      body.members = body.members.slice(0, 2);
      body.historicalParticipants = body.historicalParticipants?.slice(0, 2);
      body.group.memberCount = 2;
      body.group.kind = kind();
      await route.fulfill({ response, body: JSON.stringify(body) });
    });
    await page.route(`${BASE_URL}/api/groups/${GROUP_ID}/invitations**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ invitations }) }));
  };

  const eligibleContext = await newAuthenticatedContext(browser, DEV_EMAIL);
  try {
    const eligiblePage = await eligibleContext.newPage();
    let converted = false;
    let conversionCalls = 0;
    await installNamedGroupRoutes(eligiblePage, [], () => converted ? 'peer' : 'named');
    await eligiblePage.route(`${BASE_URL}/api/groups/${GROUP_ID}/convert-to-peer`, async (route) => {
      conversionCalls += 1;
      converted = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ group: { id: GROUP_ID, name: 'Europe trip · USD + EUR', currency: 'USD', kind: 'peer', createdAt: '', updatedAt: '', role: 'owner', memberCount: 2, counterpartName: 'Sam Rivera' } }) });
    });
    await eligiblePage.setViewportSize(viewports[0]);
    await eligiblePage.goto(`/groups/${GROUP_ID}/manage`, { waitUntil: 'domcontentloaded' });
    for (const viewport of viewports) {
      await eligiblePage.setViewportSize(viewport);
      const peerButton = eligiblePage.getByRole('button', { name: 'Convert to peer relationship' });
      await expect(peerButton).toBeVisible();
      const bounds = await peerButton.boundingBox();
      expect(bounds, `peer conversion action at ${viewport.width}px`).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    }
    eligiblePage.once('dialog', (dialog) => void dialog.accept());
    await eligiblePage.getByRole('button', { name: 'Convert to peer relationship' }).click();
    await expect(eligiblePage.getByRole('button', { name: 'Convert to named group' })).toBeVisible();
    expect(conversionCalls).toBe(1);
  } finally {
    await eligibleContext.close();
  }

  const pendingContext = await newAuthenticatedContext(browser, DEV_EMAIL);
  try {
    const pendingPage = await pendingContext.newPage();
    await installNamedGroupRoutes(pendingPage, [{ id: 'generic-invitation', groupId: GROUP_ID, email: 'generic@example.com', createdBy: 'owner', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' }]);
    await pendingPage.setViewportSize(viewports[0]);
    await pendingPage.goto(`/groups/${GROUP_ID}/manage`, { waitUntil: 'domcontentloaded' });
    await expect(pendingPage.getByRole('button', { name: 'Convert to peer relationship' })).toHaveCount(0);
    await expect(pendingPage.getByRole('button', { name: 'Convert to named group' })).toHaveCount(0);
    await expect(pendingPage.getByText('Revoke pending generic group invitations first.')).toBeVisible();
  } finally {
    await pendingContext.close();
  }
});

test('keeps Add email unavailable while owner invitations are loading', async ({ authenticatedPage }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await authenticatedPage.route(`${BASE_URL}/api/groups/${GROUP_ID}/invitations**`, async (route) => {
    await delayed;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ invitations: [] }) });
  });
  await authenticatedPage.goto(`/groups/${GROUP_ID}/manage`);
  const sam = authenticatedPage.getByRole('list', { name: 'Group members' }).getByRole('listitem').filter({ hasText: 'Sam Rivera' });
  await authenticatedPage.getByRole('button', { name: 'Invite a new member' }).click();
  await expect(authenticatedPage.getByRole('button', { name: 'Invite' })).toBeDisabled();
  await expect(sam).toContainText('Checking invitation status…');
  await expect(sam.locator('summary')).toHaveCount(0);
  release();
  await expect(sam.locator('summary')).toHaveText('Add email');
  await expect(authenticatedPage.getByRole('button', { name: 'Invite' })).toBeEnabled();
});

test('keeps Add email unavailable when owner invitations fail to load', async ({ authenticatedPage }) => {
  await authenticatedPage.route(`${BASE_URL}/api/groups/${GROUP_ID}/invitations**`, async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVITATIONS_UNAVAILABLE', message: 'Invitation service unavailable' } }) });
  });
  await authenticatedPage.goto(`/groups/${GROUP_ID}/manage`);
  const sam = authenticatedPage.getByRole('list', { name: 'Group members' }).getByRole('listitem').filter({ hasText: 'Sam Rivera' });
  await authenticatedPage.getByRole('button', { name: 'Invite a new member' }).click();
  await expect(authenticatedPage.getByRole('button', { name: 'Invite' })).toBeDisabled();
  await expect(sam).toContainText('Email actions unavailable. Retry below.');
  await expect(sam.locator('summary')).toHaveCount(0);
  await expect(authenticatedPage.locator('#invitations-error')).toBeVisible();
});

test('keeps pending targeted invitations in their participant row with change and revoke actions', async ({ authenticatedPage }) => {
  let revoked = false;
  const invitation = { id: 'targeted-invitation', groupId: GROUP_ID, email: 'sam-login@example.com', createdBy: 'owner', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', targetPersonId: '00000000-0000-4000-8000-000000002003' };
  await authenticatedPage.route(`${BASE_URL}/api/groups/${GROUP_ID}/invitations**`, async (route) => {
    if (route.request().method() === 'DELETE') {
      revoked = true;
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ invitations: revoked ? [] : [invitation] }) });
  });
  await authenticatedPage.goto(`/groups/${GROUP_ID}/manage`);
  const sam = authenticatedPage.getByRole('list', { name: 'Group members' }).getByRole('listitem').filter({ hasText: 'Sam Rivera' });
  await expect(sam).toContainText('sam-login@example.com');
  await expect(sam.getByRole('button', { name: 'Change' })).toBeVisible();
  await expect(sam.getByRole('button', { name: 'Revoke' })).toBeVisible();
  await expect(authenticatedPage.getByLabel('Generic invitation history')).toHaveCount(0);
  authenticatedPage.on('dialog', (dialog) => void dialog.accept());
  await sam.getByRole('button', { name: 'Revoke' }).click();
  await expect(sam.locator('summary')).toHaveText('Add email');
  await expect(authenticatedPage.getByText('sam-login@example.com')).toHaveCount(0);
});

test('disables targeted mutations during a stale invitation refresh while keeping cached context', async ({ authenticatedPage }) => {
  let invitationGets = 0;
  let releaseRefresh!: () => void;
  let refreshFailed = false;
  const refresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const targetInvitation = { id: 'targeted-invitation', groupId: GROUP_ID, email: 'sam-login@example.com', createdBy: 'owner', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', targetPersonId: '00000000-0000-4000-8000-000000002003' };
  const genericInvitation = { id: 'generic-invitation', groupId: GROUP_ID, email: 'new-member@example.com', createdBy: 'owner', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' };
  await authenticatedPage.route(`${BASE_URL}/api/groups/${GROUP_ID}/invitations**`, async (route) => {
    if (route.request().method() === 'DELETE') {
      refreshFailed = true;
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    invitationGets += 1;
    if (invitationGets > 1) {
      await refresh;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVITATIONS_REFRESH_FAILED', message: 'Invitation refresh failed' } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ invitations: [targetInvitation, genericInvitation] }) });
  });
  await authenticatedPage.goto(`/groups/${GROUP_ID}/manage`);
  const sam = authenticatedPage.getByRole('list', { name: 'Group members' }).getByRole('listitem').filter({ hasText: 'Sam Rivera' });
  const priya = authenticatedPage.getByRole('list', { name: 'Group members' }).getByRole('listitem').filter({ hasText: 'Priya Shah' });
  const genericHistory = authenticatedPage.getByLabel('Generic invitation history');
  await authenticatedPage.getByRole('button', { name: 'Invite a new member' }).click();
  await expect(authenticatedPage.getByRole('button', { name: 'Invite' })).toBeEnabled();
  await expect(sam.getByRole('button', { name: 'Change' })).toBeEnabled();
  await expect(genericHistory.getByRole('button', { name: 'Revoke' })).toBeEnabled();
  await expect(priya.locator('summary')).toHaveText('Add email');
  authenticatedPage.on('dialog', (dialog) => void dialog.accept());
  await genericHistory.getByRole('button', { name: 'Revoke' }).click();
  await expect.poll(() => refreshFailed).toBe(true);
  await expect(sam).toContainText('Pending invitation for sam-login@example.com');
  await expect(sam.getByRole('button', { name: 'Change' })).toBeDisabled();
  await expect(sam.getByRole('button', { name: 'Revoke' })).toBeDisabled();
  await expect(priya.getByRole('button', { name: 'Add email' })).toBeDisabled();
  await expect(genericHistory.getByRole('button', { name: 'Revoke' })).toBeDisabled();
  await expect(authenticatedPage.getByRole('button', { name: 'Invite' })).toBeDisabled();
  await expect(authenticatedPage.getByText('Refreshing invitations…')).toBeVisible();
  releaseRefresh();
  await expect(authenticatedPage.getByText('Showing cached invitations; it may be out of date.')).toBeVisible();
  await expect(authenticatedPage.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(sam.getByRole('button', { name: 'Change' })).toBeDisabled();
  await expect(sam.getByRole('button', { name: 'Revoke' })).toBeDisabled();
  await expect(priya.getByRole('button', { name: 'Add email' })).toBeDisabled();
  await expect(genericHistory.getByRole('button', { name: 'Revoke' })).toBeDisabled();
  await expect(authenticatedPage.getByRole('button', { name: 'Invite' })).toBeDisabled();
});

test('saves an email from the participant disclosure as a targeted invitation', async ({ authenticatedPage }) => {
  let savedBody: unknown;
  let saved = false;
  const targetPersonId = '00000000-0000-4000-8000-000000002003';
  const invitation = { id: 'targeted-invitation', groupId: GROUP_ID, email: 'sam-login@example.com', createdBy: 'owner', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', targetPersonId };
  await authenticatedPage.route(`${BASE_URL}/api/groups/${GROUP_ID}/members/${targetPersonId}/invitation`, async (route) => {
    savedBody = route.request().postDataJSON();
    saved = true;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ invitation }) });
  });
  await authenticatedPage.route(`${BASE_URL}/api/groups/${GROUP_ID}/invitations**`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ invitations: saved ? [invitation] : [] }) });
  });
  await authenticatedPage.goto(`/groups/${GROUP_ID}/manage`);
  const sam = authenticatedPage.getByRole('list', { name: 'Group members' }).getByRole('listitem').filter({ hasText: 'Sam Rivera' });
  await sam.locator('summary').click();
  await sam.getByLabel('Email for Sam Rivera').fill('sam-login@example.com');
  await sam.getByRole('button', { name: 'Save email' }).click();
  await expect.poll(() => savedBody).toEqual({ email: 'sam-login@example.com' });
  await expect(sam).toContainText('Pending invitation for sam-login@example.com');
});

test('contains the open targeted email form across responsive member-row widths', async ({ authenticatedPage }) => {
  const viewports = [
    { width: 390, height: 844 },
    { width: 480, height: 844 },
    { width: 481, height: 844 },
    { width: 768, height: 1024 },
    { width: 895, height: 900 },
    { width: 896, height: 900 },
    { width: 1440, height: 900 },
  ];

  for (const viewport of viewports) {
    await authenticatedPage.setViewportSize(viewport);
    await authenticatedPage.goto(`/groups/${GROUP_ID}/manage`);
    const sam = authenticatedPage.getByRole('list', { name: 'Group members' }).getByRole('listitem').filter({ hasText: 'Sam Rivera' });
    await sam.locator('summary').click();
    await expect(sam.getByLabel('Email for Sam Rivera')).toBeVisible();

    const layout = await sam.evaluate((row) => {
      const isVisible = (element: Element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && box.width > 0 && box.height > 0;
      };
      const elements = [row, ...Array.from(row.querySelectorAll('*'))].filter(isVisible);
      const rowBox = row.getBoundingClientRect();
      const overflowing = elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { element: element.tagName.toLowerCase(), left: box.left, right: box.right };
      }).filter(({ left, right }) => left < -1 || right > window.innerWidth + 1);
      const outsideRowBounds = elements.filter((element) => element !== row).map((element) => {
        const box = element.getBoundingClientRect();
        return { element: element.tagName.toLowerCase(), left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }).filter(({ left, right, top, bottom }) => left < rowBox.left - 1 || right > rowBox.right + 1 || top < rowBox.top - 1 || bottom > rowBox.bottom + 1);
      const form = row.querySelector('form');
      const field = form?.querySelector('.field');
      const button = form?.querySelector('button');
      return {
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        viewport: window.innerWidth,
        rowBounds: { left: rowBox.left, right: rowBox.right, top: rowBox.top, bottom: rowBox.bottom },
        overflowing,
        outsideRowBounds,
        formDisplay: form ? getComputedStyle(form).display : '',
        fieldBottom: field?.getBoundingClientRect().bottom || 0,
        buttonTop: button?.getBoundingClientRect().top || 0,
      };
    });

    const geometry = JSON.stringify(layout);
    expect(layout.documentWidth, geometry).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.overflowing, geometry).toEqual([]);
    expect(layout.outsideRowBounds, geometry).toEqual([]);
    if (viewport.width <= 480) {
      expect(layout.formDisplay).toBe('grid');
      expect(layout.buttonTop).toBeGreaterThanOrEqual(layout.fieldBottom - 1);
    }
  }
});

test('validates and submits the friend creation form with its consent-safe payload', async ({ authenticatedPage: page }) => {
  let responseStatus = 409;
  let requestBody: unknown;
  await page.route(`${BASE_URL}/api/friends`, async (route) => {
    requestBody = route.request().postDataJSON();
    if (responseStatus === 409) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CONFLICT', message: 'Friend already exists' } }) });
      return;
    }
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ group: { id: '00000000-0000-4000-8000-000000009101' } }) });
  });

  await page.goto('/friends/new');
  await page.getByRole('button', { name: 'Add friend' }).click();
  expect(await page.locator('#friend-name').evaluate((element) => !(element as HTMLInputElement).checkValidity())).toBe(true);
  expect(requestBody).toBeUndefined();

  await page.getByLabel('Friend name').fill('Taylor Reed');
  await page.getByLabel('Email (optional)').fill('taylor@example.com');
  await page.getByRole('button', { name: 'Add friend' }).click();
  await expect(page.locator('#create-friend-error')).toContainText('Friend already exists');
  expect(requestBody).toMatchObject({ name: 'Taylor Reed', email: 'taylor@example.com', currency: 'USD' });
  expect((requestBody as { client_operation_id?: string }).client_operation_id).toEqual(expect.any(String));

  responseStatus = 201;
  await page.getByRole('button', { name: 'Add friend' }).click();
  await expect.poll(() => page.url()).toContain('/groups/00000000-0000-4000-8000-000000009101');
});

test('validates and submits an expanded multi-person group creation payload', async ({ authenticatedPage: page }) => {
  let requestBody: unknown;
  await page.route(`${BASE_URL}/api/groups`, async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ group: { id: '00000000-0000-4000-8000-000000009102' } }) });
  });

  await page.goto('/groups/new');
  await page.getByRole('button', { name: 'Create group' }).click();
  expect(await page.locator('#group-name').evaluate((element) => !(element as HTMLInputElement).checkValidity())).toBe(true);
  await page.getByLabel('Group name').fill('Cabin weekend');
  await page.getByRole('button', { name: 'Create group' }).click();
  const firstParticipantName = page.locator('.creation-person').nth(0).locator('input[required]');
  expect(await firstParticipantName.evaluate((element) => !(element as HTMLInputElement).checkValidity())).toBe(true);
  expect(requestBody).toBeUndefined();

  await firstParticipantName.fill('Taylor Reed');
  await page.getByLabel('Email (optional)').nth(0).fill('taylor@example.com');
  await page.getByRole('button', { name: 'Add another person' }).click();
  await page.locator('.creation-person').nth(1).locator('input[required]').fill('Jordan Lee');
  await page.getByLabel('Email (optional)').nth(1).fill('jordan@example.com');
  await page.getByRole('button', { name: 'Create group' }).click();

  await expect.poll(() => requestBody).toMatchObject({ name: 'Cabin weekend', currency: 'USD', people: [{ name: 'Taylor Reed', email: 'taylor@example.com' }, { name: 'Jordan Lee', email: 'jordan@example.com' }] });
  expect((requestBody as { client_operation_id?: string }).client_operation_id).toEqual(expect.any(String));
  await expect.poll(() => page.url()).toContain('/groups/00000000-0000-4000-8000-000000009102');
});

test('binds existing and later accounts to the targeted person without changing ledger identity', async ({ request }) => {
  const browserHeaders = { Origin: 'http://127.0.0.1:8788', 'Sec-Fetch-Site': 'same-origin' };
  const ownerHeaders = { ...browserHeaders, 'X-Dev-Email': 'dev@example.com' };
  const existingAccountHeaders = { ...browserHeaders, 'X-Dev-Email': 'empty@example.com' };
  const laterAccountHeaders = { ...browserHeaders, 'X-Dev-Email': 'target-created-after@example.com' };
  const samId = '00000000-0000-4000-8000-000000002003';
  const priyaId = '00000000-0000-4000-8000-000000002004';

  const existingInviteResponse = await request.post(`/api/groups/${GROUP_ID}/members/${samId}/invitation`, { headers: ownerHeaders, data: { email: 'empty@example.com' } });
  expect(existingInviteResponse.status(), await existingInviteResponse.text()).toBe(201);
  const existingInvite = (await existingInviteResponse.json()) as { invitation: { id: string; targetPersonId: string } };
  expect(existingInvite.invitation.targetPersonId).toBe(samId);
  const existingAccepted = await request.post(`/api/invitations/${existingInvite.invitation.id}/accept`, { headers: existingAccountHeaders });
  expect(existingAccepted.status(), await existingAccepted.text()).toBe(200);

  const laterInviteResponse = await request.post(`/api/groups/${GROUP_ID}/members/${priyaId}/invitation`, { headers: ownerHeaders, data: { email: 'target-created-after@example.com' } });
  expect(laterInviteResponse.status(), await laterInviteResponse.text()).toBe(201);
  const laterInvite = (await laterInviteResponse.json()) as { invitation: { id: string; targetPersonId: string } };
  expect(laterInvite.invitation.targetPersonId).toBe(priyaId);
  const laterAccepted = await request.post(`/api/invitations/${laterInvite.invitation.id}/accept`, { headers: laterAccountHeaders });
  expect(laterAccepted.status(), await laterAccepted.text()).toBe(200);

  const group = await request.get(`/api/groups/${GROUP_ID}`, { headers: laterAccountHeaders });
  expect(group.status(), await group.text()).toBe(200);
  const members = (await group.json()) as { members: Array<{ personId: string; linked?: boolean; email?: string | null }> };
  expect(members.members.find((member) => member.personId === samId)).toMatchObject({ personId: samId, linked: true, email: 'empty@example.com' });
  expect(members.members.find((member) => member.personId === priyaId)).toMatchObject({ personId: priyaId, linked: true, email: 'target-created-after@example.com' });
});

test('does not grant an existing registered email group access until its invitation is accepted', async ({ request }) => {
  const browserHeaders = { Origin: 'http://127.0.0.1:8788', 'Sec-Fetch-Site': 'same-origin' };
  const ownerHeaders = { ...browserHeaders, 'X-Dev-Email': 'dev@example.com' };
  const registeredHeaders = { ...browserHeaders, 'X-Dev-Email': 'registered@example.com' };
  const added = await request.post(`/api/groups/${EMPTY_GROUP_ID}/people`, { headers: ownerHeaders, data: { name: 'Renamed registered user', email: 'registered@example.com' } });
  expect(added.status(), await added.text()).toBe(201);

  const beforeAccepting = await request.get(`/api/groups/${EMPTY_GROUP_ID}`, { headers: registeredHeaders });
  expect(beforeAccepting.status(), await beforeAccepting.text()).toBe(404);

  const invitationResponse = await request.post(`/api/groups/${EMPTY_GROUP_ID}/invitations`, { headers: ownerHeaders, data: { email: 'registered@example.com' } });
  expect(invitationResponse.status(), await invitationResponse.text()).toBe(201);
  const invitation = (await invitationResponse.json()) as { invitation: { id: string } };
  const accepted = await request.post(`/api/invitations/${invitation.invitation.id}/accept`, { headers: registeredHeaders });
  expect(accepted.status(), await accepted.text()).toBe(200);

  const afterAccepting = await request.get(`/api/groups/${EMPTY_GROUP_ID}`, { headers: registeredHeaders });
  expect(afterAccepting.status(), await afterAccepting.text()).toBe(200);
});

test('accepts the schema maximum participant payload in local D1 and keeps removed settlement history usable', async ({ request }) => {
  const browserHeaders = { Origin: 'http://127.0.0.1:8788', 'Sec-Fetch-Site': 'same-origin' };
  const headers = { ...browserHeaders, 'X-Dev-Email': 'dev@example.com' };
  const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => request.post(`/api/groups/${GROUP_ID}/people`, { headers, data: { name: `Bounded participant ${index}` } })));
  const people: string[] = [];
  for (const response of responses) {
    expect(response.status(), await response.text()).toBe(201);
    people.push(((await response.json()) as { person: { id: string } }).person.id);
  }

  const participants = (amount: number) => people.map((personId) => ({ person_id: personId, amount_minor: amount }));
  const expense = await request.post(`/api/groups/${GROUP_ID}/expenses`, {
    headers,
    data: { description: 'Maximum participant payload', amount_minor: 100, currency: 'USD', date: '2026-01-01', payers: participants(1), splits: participants(1), client_operation_id: 'local-max-participants' },
  });
  expect(expense.status(), await expense.text()).toBe(201);

  const missing = '00000000-0000-4000-8000-000000009999';
  const missingParticipant = await request.post(`/api/groups/${GROUP_ID}/expenses`, {
    headers,
    data: { description: 'Missing participant must fail', amount_minor: 1, currency: 'USD', date: '2026-01-01', payers: [{ person_id: missing, amount_minor: 1 }], splits: [{ person_id: people[1], amount_minor: 1 }] },
  });
  expect(missingParticipant.status(), await missingParticipant.text()).toBe(400);

  const removed = people[0];
  const remove = await request.delete(`/api/groups/${GROUP_ID}/members/${removed}`, { headers });
  expect(remove.status(), await remove.text()).toBe(204);
  const settlement = await request.post(`/api/groups/${GROUP_ID}/settlements`, {
    headers,
    data: { from_person_id: removed, to_person_id: people[1], amount_minor: 1, currency: 'USD', date: '2026-01-02', client_operation_id: 'removed-member-settlement' },
  });
  expect(settlement.status(), await settlement.text()).toBe(201);
});
