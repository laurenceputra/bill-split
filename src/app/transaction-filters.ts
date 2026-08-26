import type { Currency, Transaction } from '../shared/types';

export type TransactionKind = Transaction['kind'];
export type TransactionFilters = {
  kind?: TransactionKind;
  q?: string;
  person?: string;
  category?: string;
  from?: string;
  to?: string;
  currency?: Currency;
};

const filterKeys: Array<keyof TransactionFilters> = ['kind', 'q', 'person', 'category', 'from', 'to', 'currency'];
const filterParams = filterKeys;

/** Read the history filter namespace without consuming unrelated URL state. */
export function readTransactionFilters(params: URLSearchParams): TransactionFilters {
  const result: TransactionFilters = {};
  for (const key of filterKeys) {
    const value = params.get(key)?.trim();
    if (value) result[key] = value as never;
  }
  return normalizeTransactionFilters(result);
}

/** Categories are meaningful for all transactions except settlements. */
export function normalizeTransactionFilters(filters: TransactionFilters): TransactionFilters {
  const normalized = { ...filters };
  if (normalized.kind === 'settlement') delete normalized.category;
  return normalized;
}

export function transactionFilterCount(filters: TransactionFilters): number {
  return filterKeys.reduce((count, key) => count + (filters[key]?.toString().trim() ? 1 : 0), 0);
}

export function writeTransactionFilters(params: URLSearchParams, filters: TransactionFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of filterParams) next.delete(key);
  const normalized = normalizeTransactionFilters(filters);
  for (const key of filterKeys) {
    const value = normalized[key]?.toString().trim();
    if (value) next.set(key, value);
  }
  return next;
}

export function hasTransactionFilters(filters: TransactionFilters): boolean {
  const normalized = normalizeTransactionFilters(filters);
  return filterKeys.some((key) => Boolean(normalized[key]?.toString().trim()));
}

export function transactionFilterKey(filters: TransactionFilters): string {
  const normalized = normalizeTransactionFilters(filters);
  return JSON.stringify(filterKeys.map((key) => normalized[key]?.toString().trim() || ''));
}

export function transactionFilterQuery(filters: TransactionFilters): URLSearchParams {
  const query = new URLSearchParams();
  const normalized = normalizeTransactionFilters(filters);
  for (const key of filterKeys) {
    const value = normalized[key]?.toString().trim();
    if (value) query.set(key, value);
  }
  return query;
}
