import { describe, expect, it } from 'vitest';
import type { Transaction } from '../shared/types';
import { transactionKey, transactionPeople, transactionTitle, transactionTypeLabel } from './transaction-ui';

const expense: Transaction = { kind: 'expense', id: 'e-1', groupId: 'g-1', description: 'Dinner', amountMinor: 1200, currency: 'USD', date: '2026-01-01', category: null, notes: null, createdBy: 'u-1', createdAt: '2026-01-01T00:00:00Z', clientOperationId: null };
const settlement: Transaction = { kind: 'settlement', id: 's-1', groupId: 'g-1', amountMinor: 500, currency: 'USD', date: '2026-01-02', note: null, fromPersonId: 'p-1', toPersonId: 'p-2', fromName: 'Former A', toName: 'Former B', createdAt: '2026-01-02T00:00:00Z' };

describe('transaction row helpers', () => {
  it('keeps expense and settlement identities distinct', () => {
    expect(transactionKey(expense)).toBe('expense:e-1');
    expect(transactionKey(settlement)).toBe('settlement:s-1');
  });

  it('uses historical settlement names and explicit type labels', () => {
    expect(transactionTypeLabel(expense)).toBe('Expense');
    expect(transactionTitle(settlement)).toBe('Former A paid Former B');
    expect(transactionPeople(settlement)).toBe('Former A → Former B');
    expect(transactionPeople(expense)).toBeUndefined();
  });
});
