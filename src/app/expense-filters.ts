import type { Currency } from '../shared/types';

export type ExpenseFilters = {
  q?: string;
  person?: string;
  category?: string;
  from?: string;
  to?: string;
  currency?: Currency;
};

const filterParams = ['expense_q', 'expense_person', 'expense_category', 'expense_from', 'expense_to', 'expense_currency'] as const;
const filterKeys: Array<keyof ExpenseFilters> = ['q', 'person', 'category', 'from', 'to', 'currency'];
const paramFor = (key: keyof ExpenseFilters) => `expense_${key}`;

/** Read only the group expense filter namespace; unrelated route parameters remain untouched. */
export function readExpenseFilters(params: URLSearchParams): ExpenseFilters {
  const result: ExpenseFilters = {};
  for (const key of filterKeys) {
    const value = params.get(paramFor(key))?.trim();
    if (value) result[key] = value as never;
  }
  return result;
}

export function hasExpenseFilters(filters: ExpenseFilters): boolean {
  return filterKeys.some((key) => Boolean(filters[key]));
}

export function expenseFilterKey(filters: ExpenseFilters): string {
  // JSON array encoding is unambiguous even when a value contains the old
  // delimiter or JSON punctuation.
  return JSON.stringify(filterKeys.map((key) => filters[key]?.trim() || ''));
}

/** Replace only expense filter parameters, preserving activity and other route state. */
export function writeExpenseFilters(params: URLSearchParams, filters: ExpenseFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name of filterParams) next.delete(name);
  for (const key of filterKeys) {
    const value = filters[key]?.trim();
    if (value) next.set(paramFor(key), value);
  }
  return next;
}

export function expenseFilterQuery(filters: ExpenseFilters): URLSearchParams {
  const query = new URLSearchParams();
  for (const key of filterKeys) {
    const value = filters[key]?.trim();
    if (value) query.set(key, value);
  }
  return query;
}
