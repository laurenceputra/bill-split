import type { Expense } from '../shared/types';

export type CreditApplicationDraft = { id: string; expenseId: string; amount: string; touched?: boolean; provenance?: 'user' | 'default' };
export type CreditAllocationDraft = { id: string; personId: string; allocationType: 'recipient' | 'beneficiary'; amount: string };

/** YYYY-MM-DD in the browser's local calendar, rather than UTC. */
export function localBrowserDate(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export type RefundCapacityExpense = Pick<Expense, 'id' | 'amountMinor' | 'currency' | 'date' | 'description'> & { totalCreditsMinor?: number; linkedCredits?: Expense['linkedCredits'] };

export function remainingRefundableMinor(expense: RefundCapacityExpense, editingCreditId?: string): number {
  const alreadyRefunded = expense.linkedCredits ? expense.linkedCredits.filter((credit) => credit.creditId !== editingCreditId).reduce((sum, credit) => sum + credit.amountMinor, 0) : (expense.totalCreditsMinor || 0);
  return Math.max(0, expense.amountMinor - alreadyRefunded);
}

/** Defaults only untouched rows. User-entered amounts are never overwritten. */
export function defaultRefundApplications(rows: CreditApplicationDraft[], expenses: RefundCapacityExpense[], totalMinor: number, editingCreditId?: string): CreditApplicationDraft[] {
  const touchedTotal = rows.filter((row) => row.touched).reduce((sum, row) => {
    const value = Number(row.amount);
    return Number.isFinite(value) ? sum + Math.round(value * 100) : sum;
  }, 0);
  let unallocated = Math.max(0, totalMinor - touchedTotal);
  return rows.map((row) => {
    if (row.touched) return row;
    const expense = expenses.find((candidate) => candidate.id === row.expenseId);
    const next = expense ? Math.min(unallocated, remainingRefundableMinor(expense, editingCreditId)) : 0;
    unallocated -= next;
    return { ...row, amount: (next / 100).toFixed(2), provenance: 'default' };
  });
}

/** Exact floor allocation with a stable first-row remainder shared by the form and repository. */
export function proportionalRefundShare(applicationMinor: number, shareMinor: number, expenseMinor: number): number {
  if (![applicationMinor, shareMinor, expenseMinor].every(Number.isSafeInteger) || applicationMinor < 0 || shareMinor < 0 || expenseMinor <= 0) throw new Error('Invalid proportional refund inputs');
  const result = Number((BigInt(applicationMinor) * BigInt(shareMinor)) / BigInt(expenseMinor));
  if (!Number.isSafeInteger(result)) throw new Error('Refund share exceeds the safe integer range');
  return result;
}

function derivedExpenseSideShares(applications: Array<{ amountMinor: number; expense: Pick<Expense, 'id' | 'amountMinor'> & { splits?: Expense['splits']; payers?: Expense['payers'] } }>, side: 'splits' | 'payers') {
  const totals = new Map<string, number>();
  const orderedApplications = [...applications].sort((left, right) => left.expense.id.localeCompare(right.expense.id));
  for (const application of orderedApplications) for (const allocation of [...(application.expense[side] || [])].sort((left, right) => left.personId.localeCompare(right.personId))) {
    const share = proportionalRefundShare(application.amountMinor, allocation.amountMinor, application.expense.amountMinor);
    totals.set(allocation.personId, (totals.get(allocation.personId) || 0) + share);
  }
  const target = applications.reduce((sum, application) => sum + application.amountMinor, 0);
  const current = [...totals.values()].reduce((sum, value) => sum + value, 0);
  if (totals.size && current < target) {
    const first = [...totals.keys()][0];
    totals.set(first, (totals.get(first) || 0) + target - current);
  }
  return [...totals.entries()].filter(([, amountMinor]) => amountMinor > 0).map(([personId, amountMinor]) => ({ personId, amountMinor }));
}

export function derivedBeneficiaryShares(applications: Array<{ amountMinor: number; expense: Pick<Expense, 'id' | 'amountMinor' | 'splits'> }>) {
  return derivedExpenseSideShares(applications, 'splits');
}

export function derivedPayerShares(applications: Array<{ amountMinor: number; expense: Pick<Expense, 'id' | 'amountMinor' | 'payers'> }>) {
  return derivedExpenseSideShares(applications, 'payers');
}
