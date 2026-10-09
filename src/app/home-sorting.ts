import type { Group } from '../shared/types';
import { groupDisplayName } from './group-display';
import { sortOptionsByLabel } from './dropdown-options';

export type HomeSort = 'name' | 'outstanding';
export const homeSortKey = (userId: string) => `billsplit:home-sort:${userId}`;
export const parseHomeSort = (value: unknown): HomeSort => value === 'outstanding' ? 'outstanding' : 'name';

export function readHomeSort(userId: string): HomeSort {
  try { return parseHomeSort(localStorage.getItem(homeSortKey(userId))); }
  catch { return 'name'; }
}

export function writeHomeSort(userId: string, mode: HomeSort): void {
  try { localStorage.setItem(homeSortKey(userId), mode); }
  catch { /* The current in-memory selection remains usable. */ }
}

export function outstandingBalance(group: Group) {
  const nonzero = group.balanceSummaries?.filter((balance) => balance.netMinor !== 0) || [];
  return nonzero.find((balance) => balance.currency === group.currency)
    || [...nonzero].sort((a, b) => a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)[0];
}

export function sortHomeGroups(groups: readonly Group[], mode: HomeSort): Group[] {
  const named = sortOptionsByLabel(groups, groupDisplayName, (group) => group.id);
  if (mode === 'name') return named;
  const rank = (group: Group) => {
    const balance = outstandingBalance(group);
    return balance ? { state: 0, amount: Math.abs(balance.netMinor) }
      : { state: group.balanceSummaries === undefined ? 1 : 2, amount: 0 };
  };
  return named.sort((a, b) => {
    const left = rank(a); const right = rank(b);
    return left.state - right.state || right.amount - left.amount;
  });
}
