import type { Balance, GroupBalanceSummary } from '../shared/types';

export type GroupBalanceDisplay =
  | { kind: 'unavailable'; label: 'Balance unavailable'; currency: string }
  | { kind: 'settled'; label: 'Settled up'; currency: string }
  | { kind: 'balance'; label: 'You are owed' | 'You owe'; amountMinor: number; currency: string };

/** The ledger convention is positive net = paid more than one's share. */
export function personalBalanceDisplay(balance: Balance | undefined, currency: string): GroupBalanceDisplay {
  if (!balance) return { kind: 'unavailable', label: 'Balance unavailable', currency };
  if (balance.netMinor === 0) return { kind: 'settled', label: 'Settled up', currency: balance.currency };
  return {
    kind: 'balance',
    label: balance.netMinor > 0 ? 'You are owed' : 'You owe',
    amountMinor: Math.abs(balance.netMinor),
    currency: balance.currency,
  };
}

export function personalBalances(balances: Record<string, { raw: Balance[] }>, personId: string, defaultCurrency: string): GroupBalanceDisplay[] {
  const displays = Object.entries(balances).map(([currency, value]) => personalBalanceDisplay(value.raw.find((balance) => balance.personId === personId), currency));
  return displays.length ? displays : [personalBalanceDisplay(undefined, defaultCurrency)];
}

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
