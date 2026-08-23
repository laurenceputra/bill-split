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
  it('does not restart an exhausted stream when the other has more pages', async () => {
    const calls: Array<{ expenseCursor?: string | null; settlementCursor?: string | null }> = [];
    const result = await collectPagedGroupExport(async (cursors) => {
      calls.push(cursors);
      if (!cursors.expenseCursor && !cursors.settlementCursor) return { group: 'g', members: [], expenses: [{ id: 'e1' }], settlements: [{ id: 's1' }], nextCursor: { expenses: null, settlements: 's2' } };
      if (cursors.settlementCursor === 's2') return { group: 'g', members: [], expenses: [], settlements: [{ id: 's2' }], nextCursor: { expenses: null, settlements: 's3' } };
      return { group: 'g', members: [], expenses: [], settlements: [{ id: 's3' }] };
    }, new AbortController().signal);
    expect(result.expenses).toEqual([{ id: 'e1' }]);
    expect(result.settlements).toEqual([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    expect(calls).toEqual([{}, { expenseCursor: null, settlementCursor: 's2' }, { expenseCursor: null, settlementCursor: 's3' }]);
  });
});

describe('account export collection', () => {
  it('merges continuation pages into one complete group without duplicate rows or members', async () => {
    const result = await collectPagedAccountExport(async (cursor) => cursor
      ? { groups: [{ group: { id: 'group-a' }, members: [{ personId: 'person-a' }], expenses: [{ id: 'expense-2' }], settlements: [{ id: 'settlement-1' }, { id: 'settlement-2' }] }] }
      : { groups: [{ group: { id: 'group-a' }, members: [{ personId: 'person-a' }, { personId: 'person-b' }], expenses: [{ id: 'expense-1' }, { id: 'expense-2' }], settlements: [{ id: 'settlement-1' }] }], nextCursor: 'next' }, new AbortController().signal);
    expect(result).toEqual([{ group: { id: 'group-a' }, members: [{ personId: 'person-a' }, { personId: 'person-b' }], expenses: [{ id: 'expense-1' }, { id: 'expense-2' }], settlements: [{ id: 'settlement-1' }, { id: 'settlement-2' }] }]);
  });
});
