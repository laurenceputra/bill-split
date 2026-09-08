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

const contextualName = (name: string, personId: string, currentPersonId?: string | null) => personId === currentPersonId ? 'You' : name || 'Removed participant';

export function transactionContext(transaction: Transaction, currentPersonId?: string | null): string[] {
  if (transaction.kind !== 'expense') return [];
  const lines: string[] = [];
  if (transaction.payerNames?.length) lines.push(`Paid by ${transaction.payerNames.map((name, index) => contextualName(name, transaction.payerPersonIds?.[index] || '', currentPersonId)).join(', ')}`);
  const splitNames = transaction.splitNames?.map((name, index) => contextualName(name, transaction.splitPersonIds?.[index] || '', currentPersonId)) || [];
  const viewerIsIncluded = currentPersonId != null && transaction.splitPersonIds?.includes(currentPersonId);
  if (viewerIsIncluded) {
    const otherSplitNames = splitNames.filter((_name, index) => transaction.splitPersonIds?.[index] !== currentPersonId);
    if (otherSplitNames.length) lines.push(`Split with ${otherSplitNames.join(', ')}`);
  } else if (splitNames.length) {
    lines.push(`Split between ${splitNames.join(', ')}`);
  }
  return lines;
}

export function transactionCategory(transaction: Transaction): string | undefined {
  if (transaction.kind !== 'expense') return undefined;
  const category = transaction.category?.trim();
  return category || undefined;
}

export function transactionNote(transaction: Transaction): string | undefined {
  const note = transaction.kind === 'expense' ? transaction.notes : transaction.note;
  return note?.trim() || undefined;
}
