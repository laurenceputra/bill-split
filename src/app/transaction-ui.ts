import type { Transaction } from '../shared/types';

export const transactionKey = (transaction: Transaction) => `${transaction.kind}:${transaction.id}`;

export const transactionDate = (transaction: Transaction) => transaction.date;

export const transactionTypeLabel = (transaction: Transaction) => transaction.kind === 'expense' ? 'Expense' : 'Settlement';

export function transactionTitle(transaction: Transaction): string {
  return transaction.kind === 'expense'
    ? transaction.description
    : `${transaction.fromName} paid ${transaction.toName}`;
}

export function transactionPeople(transaction: Transaction): string | undefined {
  return transaction.kind === 'settlement' ? `${transaction.fromName} → ${transaction.toName}` : undefined;
}
