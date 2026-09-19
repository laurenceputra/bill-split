import { describe, expect, it } from 'vitest';
import type { Expense } from '../shared/types';
import { advanceCreditExpensePage, createCreditExpensePage, creditExpenseOptions } from './credit-expense-pagination';

const expense = (id: string, currency: Expense['currency'] = 'USD', description = id): Expense => ({
  id, groupId: 'group-a', description, amountMinor: 100, currency, date: '2026-01-01', createdBy: 'user-a', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1, payers: [], splits: [],
});

describe('credit expense pagination state', () => {
  it('keeps the initial cursor until an explicit page response advances it', () => {
    const initial = createCreditExpensePage([expense('newest')], 'cursor-a');

    expect(initial).toEqual({ expenses: [expect.objectContaining({ id: 'newest' })], nextCursor: 'cursor-a' });
    expect(advanceCreditExpensePage(initial, { expenses: [expense('older')], nextCursor: 'cursor-b' }).nextCursor).toBe('cursor-b');
  });

  it('deduplicates an overlapping continuation page without changing server order', () => {
    const next = advanceCreditExpensePage(createCreditExpensePage([expense('newest')], 'cursor-a'), { expenses: [expense('newest'), expense('older'), expense('older')], nextCursor: undefined });

    expect(next.expenses.map((item) => item.id)).toEqual(['newest', 'older']);
    expect(next.nextCursor).toBeUndefined();
  });

  it('preserves a linked expense absent from loaded pages and filters other currencies', () => {
    const options = creditExpenseOptions([expense('loaded'), expense('other', 'EUR')], { id: 'linked', description: 'Older linked expense' }, 'USD');

    expect(options.map((item) => item.id)).toEqual(['loaded', 'linked']);
    expect(options[1]).toMatchObject({ id: 'linked', description: 'Older linked expense', currency: 'USD' });
  });
});
