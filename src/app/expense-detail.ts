import type { Expense } from '../shared/types';

export type ExpenseRefundSummary = {
  grossMinor: number;
  refundedMinor: number;
  netGroupCostMinor: number;
  remainingRefundableMinor: number;
  fullyRefunded: boolean;
};

/** Presentation-only totals; the repository remains authoritative for writes. */
export function expenseRefundSummary(expense: Pick<Expense, 'amountMinor' | 'deletedAt' | 'linkedCredits' | 'totalCreditsMinor'>): ExpenseRefundSummary {
  const refundedMinor = expense.totalCreditsMinor ?? (expense.linkedCredits || []).reduce((sum, credit) => sum + credit.amountMinor, 0);
  const remainingRefundableMinor = Math.max(0, expense.amountMinor - refundedMinor);
  return {
    grossMinor: expense.amountMinor,
    refundedMinor,
    netGroupCostMinor: expense.amountMinor - refundedMinor,
    remainingRefundableMinor,
    fullyRefunded: !expense.deletedAt && remainingRefundableMinor === 0,
  };
}

export function refundActionLabel(expense: Pick<Expense, 'deletedAt' | 'amountMinor' | 'linkedCredits' | 'totalCreditsMinor'>): string {
  if (expense.deletedAt) return 'Refund unavailable for deleted expense';
  return expenseRefundSummary(expense).fullyRefunded ? 'Fully refunded' : 'Add refund';
}
