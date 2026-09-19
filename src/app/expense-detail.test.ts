import { describe, expect, it } from 'vitest';
import { expenseRefundSummary, refundActionLabel } from './expense-detail';

describe('expense refund presentation', () => {
  it('shows gross, money back, net cost, and remaining capacity', () => {
    expect(expenseRefundSummary({ amountMinor: 1000, totalCreditsMinor: 250, linkedCredits: [] })).toEqual({
      grossMinor: 1000, refundedMinor: 250, netGroupCostMinor: 750, remainingRefundableMinor: 750, fullyRefunded: false,
    });
  });

  it('uses linked rows when the aggregate is absent and disables deleted/fully refunded actions', () => {
    expect(refundActionLabel({ amountMinor: 100, linkedCredits: [{ creditId: 'c', amountMinor: 100, subtype: 'refund', date: '2026-01-01', deliveryMode: 'member_reimbursement' }] })).toBe('Fully refunded');
    expect(refundActionLabel({ amountMinor: 100, linkedCredits: [], deletedAt: '2026-01-01' })).toContain('unavailable');
  });
});
