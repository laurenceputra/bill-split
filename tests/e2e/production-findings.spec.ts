import { test, expect, newAuthenticatedContext, REGISTERED_EMAIL, BASE_URL } from './fixtures';

const GROUP_ID = '00000000-0000-4000-8000-000000003002';
const EMPTY_GROUP_ID = '00000000-0000-4000-8000-000000003001';

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
