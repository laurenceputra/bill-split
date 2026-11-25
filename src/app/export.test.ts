import { describe, expect, it, vi } from 'vitest';
import { collectPagedAccountExport, collectPagedExport, collectPagedGroupExport } from './export';

describe('paged export collection', () => {
  it('completes all cursor pages and reports progress', async () => {
    const progress: number[] = [];
    const result = await collectPagedExport(async (cursor) => cursor ? { items: ['last'] } : { items: ['first'], nextCursor: 'next' }, new AbortController().signal, (page) => progress.push(page));
    expect(result).toEqual(['first', 'last']);
    expect(progress).toEqual([1, 2]);
  });

  it('cancels before starting another page', async () => {
    const controller = new AbortController();
    const load = vi.fn(async () => ({ items: ['first'], nextCursor: 'next' }));
    controller.abort();
    await expect(collectPagedExport(load, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).not.toHaveBeenCalled();
  });
});

describe('two-stream group export collection', () => {
  it('keeps debts separate from settlements across a shared cursor', async () => {
    const debt = { id: 'debt-1', groupId: 'demo-group', debtorPersonId: 'demo-user', creditorPersonId: 'demo-friend', amountMinor: 1250, currency: 'USD' as const, date: '2026-04-20', createdAt: '', updatedAt: '', version: 1 };
    const first = { group: { id: 'demo-group' }, members: [], expenses: [], settlements: [], debts: [debt] };
    const second = { ...first, settlements: [{ id: 'payment-1' }], debts: [debt, { ...debt, id: 'debt-2' }] };
    const group = await collectPagedGroupExport(async ({ settlementCursor }) => settlementCursor
      ? second : { ...first, nextCursor: { expenses: null, settlements: 'next-transfer' } }, new AbortController().signal);
    expect(group.settlements.map(({ id }) => id)).toEqual(['payment-1']);
    expect(group.debts?.map(({ id }) => id)).toEqual(['debt-1', 'debt-2']);
    const [accountGroup] = await collectPagedAccountExport(async (cursor) => cursor
      ? { groups: [second] } : { groups: [first], nextCursor: 'next-transfer' }, new AbortController().signal);
    expect(accountGroup.debts?.map(({ id }) => id)).toEqual(['debt-1', 'debt-2']);
    expect(accountGroup.settlements.map(({ id }) => id)).toEqual(['payment-1']);
  });

  it('does not restart an exhausted stream when the other has more pages', async () => {
    const calls: Array<{ expenseCursor?: string | null; settlementCursor?: string | null }> = [];
    const result = await collectPagedGroupExport(async (cursors) => {
      calls.push(cursors);
      if (!cursors.expenseCursor && !cursors.settlementCursor) return { group: 'g', splitDefault: { method: 'equal' }, members: [], expenses: [{ id: 'e1' }], settlements: [{ id: 's1' }], nextCursor: { expenses: null, settlements: 's2' } };
      if (cursors.settlementCursor === 's2') return { group: 'g', splitDefault: { method: 'equal' }, members: [], expenses: [], settlements: [{ id: 's2' }], nextCursor: { expenses: null, settlements: 's3' } };
      return { group: 'g', splitDefault: { method: 'equal' }, members: [], expenses: [], settlements: [{ id: 's3' }] };
    }, new AbortController().signal);
    expect(result.expenses).toEqual([{ id: 'e1' }]);
    expect(result.settlements).toEqual([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    expect(result.splitDefault).toEqual({ method: 'equal' });
    expect(calls).toEqual([{}, { expenseCursor: null, settlementCursor: 's2' }, { expenseCursor: null, settlementCursor: 's3' }]);
  });
});

describe('account export collection', () => {
  it('merges continuation pages into one complete group without duplicate rows or members', async () => {
    const result = await collectPagedAccountExport(async (cursor) => cursor
      ? { groups: [{ group: { id: 'group-a' }, splitDefault: { method: 'shares' }, members: [{ personId: 'person-a' }], expenses: [{ id: 'expense-2' }], settlements: [{ id: 'settlement-1' }, { id: 'settlement-2' }] }] }
      : { groups: [{ group: { id: 'group-a' }, splitDefault: { method: 'shares' }, members: [{ personId: 'person-a' }, { personId: 'person-b' }], expenses: [{ id: 'expense-1' }, { id: 'expense-2' }], settlements: [{ id: 'settlement-1' }] }], nextCursor: 'next' }, new AbortController().signal);
    expect(result).toEqual([{ group: { id: 'group-a' }, splitDefault: { method: 'shares' }, members: [{ personId: 'person-a' }, { personId: 'person-b' }], expenses: [{ id: 'expense-1' }, { id: 'expense-2' }], settlements: [{ id: 'settlement-1' }, { id: 'settlement-2' }] }]);
  });

  it('deduplicates credit rows across account-export pages', async () => {
    const result = await collectPagedAccountExport(async (cursor) => cursor
      ? { groups: [{ group: { id: 'group-a' }, members: [], expenses: [], settlements: [], credits: [{ id: 'credit-1' }, { id: 'credit-2' }] }] }
      : { groups: [{ group: { id: 'group-a' }, members: [], expenses: [], settlements: [], credits: [{ id: 'credit-1' }] }], nextCursor: 'next' }, new AbortController().signal);
    expect((result[0] as { credits?: unknown[] }).credits).toEqual([{ id: 'credit-1' }, { id: 'credit-2' }]);
  });
});
