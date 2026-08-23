import { describe, expect, it } from 'vitest';
import { expenseFilterCount, expenseFilterKey, expenseFilterQuery, readExpenseFilters, writeExpenseFilters } from './expense-filters';

describe('expense filter URL state', () => {
  it('reads and writes only the namespaced filter parameters', () => {
    const params = new URLSearchParams('group=group-a&tab=activity&expense_q=dinner&expense_currency=USD');
    expect(readExpenseFilters(params)).toEqual({ q: 'dinner', currency: 'USD' });
    const next = writeExpenseFilters(params, { q: 'lunch', category: 'Dining' });
    expect(next.toString()).toBe('group=group-a&tab=activity&expense_q=lunch&expense_category=Dining');
  });

  it('constructs server query filters and a stable pagination scope', () => {
    const filters = { q: ' dinner ', person: 'person-a', from: '2026-01-01' };
    expect([...expenseFilterQuery(filters).entries()]).toEqual([['q', 'dinner'], ['person', 'person-a'], ['from', '2026-01-01']]);
    expect(expenseFilterKey(filters)).toBe('["dinner","person-a","","2026-01-01","",""]');
  });

  it('keeps delimiter-containing values collision-free', () => {
    expect(expenseFilterKey({ q: 'a|b' })).not.toBe(expenseFilterKey({ q: 'a', person: 'b' }));
  });

  it('counts active filters for the disclosure summary', () => {
    expect(expenseFilterCount({ q: 'dinner', category: 'Dining', currency: 'USD' })).toBe(3);
    expect(expenseFilterCount({ q: '  ' })).toBe(0);
  });
});
