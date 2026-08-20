import type { Currency } from '../shared/types';
import { supportedCurrencies } from '../shared/schemas';
import { checkedAddMinor, checkedMinor, checkedSumMinor } from '../shared/money';

export { BalanceOverflowError, BALANCE_OVERFLOW_CODE, checkedAddMinor, checkedMinor, checkedSumMinor } from '../shared/money';

export function parseMoney(value: string, currency: Currency): number {
  if (!supportedCurrencies.includes(currency) || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error('Invalid money or currency');
  const [whole, fraction = ''] = value.trim().split('.');
  try {
    const minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
    if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('overflow');
    return checkedMinor(Number(minor));
  } catch {
    throw new Error('Money exceeds safe integer range');
  }
}
export function formatMoney(minor: number, currency: Currency, locale = 'en-US'): string {
  if (!Number.isSafeInteger(minor) || !supportedCurrencies.includes(currency)) throw new Error('Invalid money');
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
}
export function allocateEqual(amount: number, count: number): number[] { return allocateByWeights(amount, Array(count).fill(1)); }
export function allocateByWeights(amount: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0 || !weights.length || weights.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('Invalid allocation');
  const maxWeight = Math.max(...weights);
  if (maxWeight > 0 && amount > Number.MAX_SAFE_INTEGER / maxWeight) throw new Error('Allocation exceeds safe integer range');
  const total = weights.reduce((a, b) => a + b, 0); if (!Number.isFinite(total) || !Number.isSafeInteger(Math.round(total)) || !total) throw new Error('Invalid allocation weights');
  const values = weights.map((w) => Math.floor(amount * w / total));
  let remainder = amount - checkedSumMinor(values);
  for (let i = 0; remainder > 0; i = (i + 1) % values.length, remainder--) values[i]++;
  return values;
}
export function allocatePercentage(amount: number, basisPoints: number[]): number[] {
  if (checkedSumMinor(basisPoints) !== 10000) throw new Error('Percentages must sum to 10000 basis points');
  return allocateByWeights(amount, basisPoints);
}
export function allocateExact(amount: number, values: number[]): number[] {
  if (!Number.isSafeInteger(amount) || values.some((n) => !Number.isSafeInteger(n) || n < 0) || checkedSumMinor(values) !== amount) throw new Error('Exact allocations must sum to the amount');
  return [...values];
}
export function allocateShares(amount: number, shares: number[]): number[] { return allocateByWeights(amount, shares); }
