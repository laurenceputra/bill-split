import type { GroupBalanceSummary } from '../shared/types';

export type GroupBalanceDisplay =
  | { kind: 'unavailable'; label: 'Balance unavailable'; currency: string }
  | { kind: 'settled'; label: 'Settled up'; currency: string }
  | { kind: 'balance'; label: 'You are owed' | 'You owe'; amountMinor: number; currency: string };

export function groupBalanceDisplay(summary: GroupBalanceSummary | undefined, defaultCurrency: string): GroupBalanceDisplay {
  if (!summary) return { kind: 'unavailable', label: 'Balance unavailable', currency: defaultCurrency };
  if (summary.netMinor === 0) return { kind: 'settled', label: 'Settled up', currency: defaultCurrency };
  return {
    kind: 'balance',
    label: summary.netMinor > 0 ? 'You are owed' : 'You owe',
    amountMinor: Math.abs(summary.netMinor),
    currency: summary.currency,
  };
}

export function groupBalanceDisplays(summaries: GroupBalanceSummary[] | undefined, defaultCurrency: string): GroupBalanceDisplay[] {
  if (summaries === undefined) return [groupBalanceDisplay(undefined, defaultCurrency)];
  const nonZero = summaries.filter((summary) => summary.netMinor !== 0);
  if (!nonZero.length) return [{ kind: 'settled', label: 'Settled up', currency: defaultCurrency }];
  return nonZero.slice(0, 2).map((summary) => groupBalanceDisplay(summary, defaultCurrency));
}
