import type { Balances, Currency, GroupMember, GroupSplitDefault, PairwiseBalance, Split, SplitMethod } from '../shared/types';
import { allocateByWeights, allocateEqual, allocatePercentage, checkedSumMinor, parseMoney } from '../domain/money';

export type AllocationState = Record<string, string>;
export type PayerState = { personId: string; amount: string };
const MAX_SHARE_VALUE = 1_000_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Apply a stored party arrangement only when every referenced member is still active. */
export function resolveGroupSplitDefault(value: GroupSplitDefault | null | undefined, members: GroupMember[]): { method: SplitMethod; selected: string[]; values: AllocationState; applied: boolean; invalid: boolean } {
  const all = members.map((member) => member.personId);
  if (!value || value.personIds.some((personId) => !all.includes(personId))) return { method: 'equal', selected: all, values: {}, applied: false, invalid: Boolean(value) };
  if (value.method === 'equal') return { method: 'equal', selected: [...value.personIds], values: {}, applied: true, invalid: false };
  if (!value.values || value.values.length !== value.personIds.length) return { method: 'equal', selected: all, values: {}, applied: false, invalid: true };
  return { method: value.method, selected: [...value.personIds], values: Object.fromEntries(value.personIds.map((personId, index) => [personId, value.method === 'percentage' ? String(value.values![index] / 100) : String(value.values![index])])), applied: true, invalid: false };
}

export function groupSplitDefaultSummary(value: GroupSplitDefault | null | undefined, members: GroupMember[]): { label: string; warning: boolean } {
  if (!value) return { label: 'Automatic equal split', warning: false };
  const missing = value.personIds.filter((personId) => !members.some((member) => member.personId === personId));
  const names = value.personIds.map((personId) => members.find((member) => member.personId === personId)?.name || 'Removed member');
  const method = value.method === 'equal' ? 'Equal' : value.method === 'percentage' ? 'Percentage' : 'Shares';
  return { label: `${method} · ${names.join(', ')}`, warning: missing.length > 0 };
}

export type AmountInputLength = 'normal' | 'long' | 'very-long';

/** Keep large monetary values readable without relying on per-element styles. */
export function amountInputLength(value: string): AmountInputLength {
  const length = value.trim().length;
  if (length >= 16) return 'very-long';
  if (length >= 10) return 'long';
  return 'normal';
}

export function amountInputClass(value: string): string {
  return `amount-input amount-input--${amountInputLength(value)}`;
}

export function amountFieldClass(value: string): string {
  return `amount-field amount-field--${amountInputLength(value)}`;
}

export function hasNewerServerVersion(initialVersion: number | undefined, serverVersion: number | undefined, dirty: boolean): boolean {
  return dirty && initialVersion !== undefined && serverVersion !== undefined && serverVersion > initialVersion;
}

/** Select the version for the record currently being edited. */
export function formServerVersion(scheduleMode: boolean, expenseVersion: number | undefined, scheduleVersion: number | undefined): number | undefined {
  return scheduleMode ? scheduleVersion : expenseVersion;
}

export function isExpenseConflict(status: number | undefined, code: string | undefined): boolean {
  return status === 409 || code === 'CONFLICT';
}

export function currentPayerSelection(personId: string | undefined, members: GroupMember[]): string {
  return (personId && members.some((member) => member.personId === personId) ? personId : members[0]?.personId) || '';
}

export function normalizeSinglePayer(payers: PayerState[], amount: string): PayerState[] {
  return payers.length === 1 ? [{ ...payers[0], amount }] : payers;
}

export function allocationStateFromSplits(splits: Split[], method: SplitMethod): AllocationState {
  return Object.fromEntries(splits.map((split) => {
    const value = split.metadata?.value;
    if (method === 'exact') return [split.personId, (split.amountMinor / 100).toFixed(2)];
    if (method === 'percentage') return [split.personId, typeof value === 'number' ? String(value / 100) : ''];
    return [split.personId, typeof value === 'number' ? String(value) : ''];
  }));
}

export function allocationMetadataByPerson(splits: Split[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(splits.filter((split) => split.metadata).map((split) => [split.personId, { ...split.metadata }]));
}

export type AllocationPreview = {
  allocations: Record<string, number>;
  remainingMinor: number | null;
  remainingPercent: number | null;
  totalValue: number;
  error?: string;
};

const emptyPreview = (error?: string): AllocationPreview => ({ allocations: {}, remainingMinor: null, remainingPercent: null, totalValue: 0, error });

function safeAllocation(amountMinor: number, weights: number[]): boolean {
  const maxWeight = Math.max(...weights);
  return Number.isSafeInteger(amountMinor) && amountMinor >= 0 && Number.isFinite(maxWeight) && maxWeight > 0 && amountMinor <= MAX_SAFE / maxWeight;
}

function checkedAllocations(selected: string[], allocations: number[], amountMinor: number): Record<string, number> | undefined {
  if (allocations.length !== selected.length || allocations.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  const total = checkedSumMinor(allocations);
  if (total !== amountMinor) return undefined;
  return Object.fromEntries(selected.map((id, index) => [id, allocations[index]]));
}

function percentageBasisPoints(value: string): number {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value)) throw new Error('Percentages must be between 0% and 100% (up to two decimals).');
  const [whole, fraction = ''] = value.split('.');
  const basisPoints = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(basisPoints) || basisPoints > 10_000) throw new Error('Each percentage must be between 0% and 100%.');
  return basisPoints;
}

function shareValue(value: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Shares must be finite values no greater than ${MAX_SHARE_VALUE}.`);
  const share = Number(value);
  if (!Number.isFinite(share) || share < 0 || share > MAX_SHARE_VALUE) throw new Error(`Shares must be finite values no greater than ${MAX_SHARE_VALUE}.`);
  return share;
}

export function previewAllocation(amountMinor: number, selected: string[], method: SplitMethod, values: AllocationState, currency: Currency): AllocationPreview {
  if (!selected.length) return emptyPreview('Select at least one participant.');
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return emptyPreview('The expense amount is outside the safe range.');
  try {
    if (method === 'equal') {
      const allocations = allocateEqual(amountMinor, selected.length);
      const checked = checkedAllocations(selected, allocations, amountMinor);
      return checked ? { allocations: checked, remainingMinor: 0, remainingPercent: 0, totalValue: selected.length } : emptyPreview('The equal allocation is outside the safe amount range.');
    }
    const raw = selected.map((personId) => values[personId] ?? '');
    if (raw.some((value) => !value.trim())) return emptyPreview('Enter a value for every selected person.');
    if (method === 'exact') {
      const exact = raw.map((value) => parseMoney(value, currency));
      const total = checkedSumMinor(exact);
      const checked = checkedAllocations(selected, exact, amountMinor);
      return { allocations: checked || {}, remainingMinor: amountMinor - total, remainingPercent: null, totalValue: total, error: checked ? undefined : 'Exact amounts must equal the expense total.' };
    }
    if (method === 'percentage') {
      const basisPoints = raw.map(percentageBasisPoints);
      const totalBasisPoints = checkedSumMinor(basisPoints);
      if (totalBasisPoints !== 10_000) return { allocations: {}, remainingMinor: null, remainingPercent: (10_000 - totalBasisPoints) / 100, totalValue: totalBasisPoints / 100, error: 'Percentages must total 100%.' };
      if (!safeAllocation(amountMinor, basisPoints)) return emptyPreview('These percentages are too large for a safe amount calculation.');
      const checked = checkedAllocations(selected, allocatePercentage(amountMinor, basisPoints), amountMinor);
      return checked ? { allocations: checked, remainingMinor: 0, remainingPercent: 0, totalValue: 100 } : emptyPreview('The percentage allocation is outside the safe amount range.');
    }
    const numbers = raw.map(shareValue);
    const totalShares = numbers.reduce((sum, value) => {
      const next = sum + value;
      if (!Number.isFinite(next) || next > MAX_SAFE) throw new Error('Shares exceed the safe amount range.');
      return next;
    }, 0);
    if (!totalShares) return emptyPreview('Shares must be greater than zero.');
    if (!safeAllocation(amountMinor, numbers)) return emptyPreview('These shares are too large for a safe amount calculation.');
    const checked = checkedAllocations(selected, allocateByWeights(amountMinor, numbers), amountMinor);
    return checked ? { allocations: checked, remainingMinor: 0, remainingPercent: null, totalValue: totalShares } : emptyPreview('The share allocation is outside the safe amount range.');
  } catch (error) {
    return emptyPreview(error instanceof Error ? error.message : 'Enter valid allocation values.');
  }
}

export function allocationSplits(selected: string[], method: SplitMethod, preview: AllocationPreview, values: AllocationState, metadataByPerson: Record<string, Record<string, unknown>> = {}): Array<{ person_id: string; amount_minor: number; metadata: Record<string, unknown> }> {
  return selected.map((personId) => {
    const amountMinor = preview.allocations[personId] ?? 0;
    const value = method === 'equal' ? undefined : method === 'exact' ? amountMinor : Number(values[personId]);
    const metadata = { ...(metadataByPerson[personId] || {}) };
    delete metadata.method;
    delete metadata.value;
    metadata.method = method;
    if (value !== undefined) metadata.value = method === 'percentage' ? Math.round(value * 100) : value;
    return { person_id: personId, amount_minor: amountMinor, metadata };
  });
}

export function settlementSuggestion(balances: Record<string, Balances>, currentPersonId: string | undefined, groupCurrency: Currency): PairwiseBalance | undefined {
  const currencies = Object.keys(balances).sort((a, b) => (a === groupCurrency ? -1 : b === groupCurrency ? 1 : a.localeCompare(b)));
  const debts = currencies.flatMap((currency) => balances[currency]?.simplified.filter((debt) => debt.amountMinor > 0) || []);
  return debts.find((debt) => debt.fromPersonId === currentPersonId || debt.toPersonId === currentPersonId) || debts[0];
}

export function settlementSuggestionFingerprint(suggestion: PairwiseBalance | undefined, groupCurrency: Currency, fallbackFrom = '', fallbackTo = ''): string {
  return [suggestion?.currency || groupCurrency, suggestion?.fromPersonId || fallbackFrom, suggestion?.toPersonId || fallbackTo, suggestion?.amountMinor ?? ''].join(':');
}
