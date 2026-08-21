import { describe, expect, it } from 'vitest';
import { generatedExpenseInput } from './scheduled-expense';
import type { ScheduledExpense } from '../shared/types';

const template = {
  id: 'template-1', groupId: 'group-1', description: 'Subscription', amountMinor: 1250, currency: 'USD', startDate: '2026-01-01', endDate: null,
  frequency: 'monthly', interval: 1, weekdays: [], timezone: 'UTC', status: 'active', nextOccurrenceDate: '2026-02-01', createdBy: 'user-1', createdAt: '', updatedAt: '', version: 1,
  payers: [{ personId: 'person-1', amountMinor: 1250 }], splits: [{ personId: 'person-1', amountMinor: 1250, metadata: { source: 'template' } }],
} satisfies ScheduledExpense;

describe('generated scheduled expenses', () => {
  it('uses the ordinary expense payload without a user-controlled operation key', () => {
    expect(generatedExpenseInput(template, '2026-02-01')).toEqual({
      description: 'Subscription', amount_minor: 1250, currency: 'USD', date: '2026-02-01',
      payers: [{ person_id: 'person-1', amount_minor: 1250 }], splits: [{ person_id: 'person-1', amount_minor: 1250, metadata: { source: 'template' } }],
    });
  });
});
