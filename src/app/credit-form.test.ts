import { describe, expect, it } from 'vitest';
import { defaultRefundApplications, derivedBeneficiaryShares, derivedPayerShares, localBrowserDate, proportionalRefundShare, remainingRefundableMinor, type CreditApplicationDraft } from './credit-form';

const expense = (id: string, amountMinor: number, totalCreditsMinor = 0) => ({ id, description: id, date: '2026-01-01', currency: 'USD' as const, amountMinor, totalCreditsMinor, linkedCredits: [] });

describe('refund form defaults and capacity', () => {
  it('excludes the edited refund from remaining capacity', () => {
    expect(remainingRefundableMinor({ ...expense('e', 1000), linkedCredits: [{ creditId: 'old', amountMinor: 400, subtype: 'refund', date: '2026-01-01', deliveryMode: 'member_reimbursement' }, { creditId: 'editing', amountMinor: 300, subtype: 'refund', date: '2026-01-02', deliveryMode: 'member_reimbursement' }] }, 'editing')).toBe(600);
  });

  it('defaults untouched applications without overwriting user edits', () => {
    const rows: CreditApplicationDraft[] = [{ id: 'a', expenseId: 'one', amount: '', touched: false }, { id: 'b', expenseId: 'two', amount: '3.00', touched: true }];
    expect(defaultRefundApplications(rows, [expense('one', 500), expense('two', 1000)], 700).map((row) => row.amount)).toEqual(['4.00', '3.00']);
    const capacityExpense = { ...expense('one', 500), linkedCredits: [{ creditId: 'editing', amountMinor: 500, subtype: 'refund' as const, date: '2026-01-01', deliveryMode: 'member_reimbursement' as const }] };
    expect(defaultRefundApplications([{ id: 'a', expenseId: 'one', amount: '', touched: false }], [capacityExpense], 500, 'editing')[0].amount).toBe('5.00');
  });

  it('keeps derived payer and beneficiary rounding aligned', () => {
    const source = { amountMinor: 10, expense: { id: 'expense-a', amountMinor: 100, splits: [{ personId: 'b', amountMinor: 67 }, { personId: 'a', amountMinor: 33 }], payers: [{ personId: 'b', amountMinor: 67 }, { personId: 'a', amountMinor: 33 }] } };
    expect(derivedBeneficiaryShares([source])).toEqual([{ personId: 'a', amountMinor: 4 }, { personId: 'b', amountMinor: 6 }]);
    expect(derivedPayerShares([source])).toEqual([{ personId: 'a', amountMinor: 4 }, { personId: 'b', amountMinor: 6 }]);
    expect(derivedBeneficiaryShares([{ amountMinor: 6, expense: { id: 'z-expense', amountMinor: 100, splits: [{ personId: 'b', amountMinor: 67 }, { personId: 'a', amountMinor: 33 }] } }, { amountMinor: 4, expense: { id: 'a-expense', amountMinor: 100, splits: [{ personId: 'a', amountMinor: 33 }, { personId: 'b', amountMinor: 67 }] } }])).toEqual(derivedBeneficiaryShares([{ amountMinor: 4, expense: { id: 'a-expense', amountMinor: 100, splits: [{ personId: 'b', amountMinor: 67 }, { personId: 'a', amountMinor: 33 }] } }, { amountMinor: 6, expense: { id: 'z-expense', amountMinor: 100, splits: [{ personId: 'a', amountMinor: 33 }, { personId: 'b', amountMinor: 67 }] } }]));
    expect(proportionalRefundShare(10, 33, 100)).toBe(3);
  });

  it('uses local calendar components', () => {
    expect(localBrowserDate(new Date(2026, 0, 9, 23, 59))).toBe('2026-01-09');
  });
});
