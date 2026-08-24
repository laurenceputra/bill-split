import { describe, expect, it } from 'vitest';
import { hasTransactionFilters, normalizeTransactionFilters, readTransactionFilters, transactionFilterCount, transactionFilterKey, transactionFilterQuery, writeTransactionFilters } from './transaction-filters';

describe('transaction filter helpers', () => {
  it('keeps filter keys stable and query values encoded by URLSearchParams', () => {
    const filters = { kind: 'expense' as const, q: 'dinner & drinks', from: '2026-01-01' };
    expect(hasTransactionFilters(filters)).toBe(true);
    expect(transactionFilterQuery(filters).toString()).toBe('kind=expense&q=dinner+%26+drinks&from=2026-01-01');
    expect(transactionFilterKey(filters)).toBe(JSON.stringify(['expense', 'dinner & drinks', '', '', '2026-01-01', '', '']));
  });

  it('does not treat blank values as active filters', () => {
    expect(hasTransactionFilters({ q: '  ' })).toBe(false);
    expect(transactionFilterQuery({ q: '  ' }).toString()).toBe('');
  });

  it('counts and clears categories that are incompatible with settlement filters', () => {
    const filters = normalizeTransactionFilters({ kind: 'settlement', category: 'Dinner', q: 'paid' });
    expect(filters).toEqual({ kind: 'settlement', q: 'paid' });
    expect(transactionFilterCount(filters)).toBe(2);
    expect(readTransactionFilters(new URLSearchParams('kind=settlement&category=Dinner'))).toEqual({ kind: 'settlement' });
    expect(writeTransactionFilters(new URLSearchParams('kind=settlement&category=Dinner'), filters).toString()).toBe('kind=settlement&q=paid');
  });
});
