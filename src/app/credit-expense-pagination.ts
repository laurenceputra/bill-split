import type { Currency, Expense } from '../shared/types';

export type CreditExpensePage = { expenses: Expense[]; nextCursor?: string };
export type LinkedCreditExpense = { id: string; description?: string };
export type CreditExpenseOption = { id: string; description: string; amountMinor?: number; currency: Currency };

export function createCreditExpensePage(expenses: Expense[], nextCursor?: string): CreditExpensePage {
  return { expenses: [...expenses], nextCursor };
}

/** Apply exactly one explicitly fetched page while preserving the server order. */
export function advanceCreditExpensePage(current: CreditExpensePage, page: CreditExpensePage): CreditExpensePage {
  const seen = new Set(current.expenses.map((expense) => expense.id));
  return {
    expenses: [...current.expenses, ...page.expenses.filter((expense) => {
      if (seen.has(expense.id)) return false;
      seen.add(expense.id);
      return true;
    })],
    nextCursor: page.nextCursor,
  };
}

/** Keep an already-linked expense selectable even when it is outside loaded pages. */
export function creditExpenseOptions(expenses: Expense[], linked: LinkedCreditExpense | undefined, currency: Currency): CreditExpenseOption[] {
  const options: CreditExpenseOption[] = expenses.filter((expense) => expense.currency === currency).map((expense) => ({ id: expense.id, description: expense.description, amountMinor: expense.amountMinor, currency: expense.currency }));
  if (linked && !options.some((expense) => expense.id === linked.id)) options.push({ id: linked.id, description: linked.description || linked.id, amountMinor: undefined, currency });
  return options;
}
