import { expect, it, vi } from 'vitest';
import { db } from './cloudflare-d1-test';
import { Repository } from './repository';

it('counts unequal allocations and multiple payers independently, retaining historical people and currency/date scope', async () => {
  const repo = new Repository(db);
  const owner = await new Repository(db, 'fixture-key').user(`${crypto.randomUUID()}@example.com`);
  const groupId = crypto.randomUUID(), otherId = crypto.randomUUID();
  const userId = String(owner.user.id), personId = String(owner.person.id);
  await db.batch([
    db.prepare("INSERT INTO groups(id,name,currency,kind,created_at,updated_at) VALUES(?,'Insights','USD','named','now','now')").bind(groupId),
    db.prepare("INSERT INTO people(id,name,created_at) VALUES(?,'Historical participant','now')").bind(otherId),
    db.prepare("INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES(?,?,?,'now','owner')").bind(groupId, personId, userId),
    db.prepare("INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES(?,?,'now','member')").bind(groupId, otherId),
  ]);
  for (const currency of ['USD', 'EUR'] as const) await repo.createExpense(groupId, userId, {
    description: 'Unequal dinner', amount_minor: 1000, currency, date: '2026-01-15',
    payers: [{ person_id: personId, amount_minor: 500 }, { person_id: otherId, amount_minor: 500 }],
    splits: [{ person_id: personId, amount_minor: 200 }, { person_id: otherId, amount_minor: 800 }],
  });
  await db.prepare("UPDATE group_members SET deleted_at='now' WHERE group_id=? AND person_id=?").bind(groupId, otherId).run();
  const batch = vi.spyOn(db, 'batch');
  const result = await repo.spendingInsights(userId, groupId, { from: '2026-01-01', to: '2026-01-31', currency: 'USD' });
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch.mock.calls[0][0]).toHaveLength(2);
  batch.mockRestore();
  expect(result.summaries).toHaveLength(1);
  expect(result.summaries[0]).toMatchObject({ groupSpendMinor: 1000, yourShareMinor: 200, youPaidMinor: 500 });
  expect(result.summaries[0].people).toEqual(expect.arrayContaining([
    expect.objectContaining({ personId, shareMinor: 200, paidMinor: 500 }),
    { personId: otherId, name: 'Historical participant', shareMinor: 800, paidMinor: 500 },
  ]));
  expect((await repo.spendingInsights(userId, groupId, { from: '2026-02-01', to: '2026-02-28' })).summaries).toEqual([]);
  expect((await repo.spendingInsights('unauthorized', groupId)).summaries).toEqual([]);
  expect((await repo.spendingInsights(userId)).summaries.every((summary) => summary.people === undefined)).toBe(true);
});
