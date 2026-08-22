import { test, expect } from './fixtures';

const GROUP_ID = '00000000-0000-4000-8000-000000003002';
const EMPTY_GROUP_ID = '00000000-0000-4000-8000-000000003001';

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
