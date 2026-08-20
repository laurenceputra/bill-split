import type { Currency } from '../shared/types';
import { supportedCurrencies } from '../shared/schemas';

export function parseMoney(value: string, currency: Currency): number {
  if (!supportedCurrencies.includes(currency) || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error('Invalid money or currency');
  const [whole, fraction = ''] = value.trim().split('.');
  const minor = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(minor)) throw new Error('Money exceeds safe integer range');
  return minor;
}
export function formatMoney(minor: number, currency: Currency, locale = 'en-US'): string {
  if (!Number.isSafeInteger(minor) || !supportedCurrencies.includes(currency)) throw new Error('Invalid money');
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
}
export function allocateEqual(amount: number, count: number): number[] { return allocateByWeights(amount, Array(count).fill(1)); }
export function allocateByWeights(amount: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0 || !weights.length || weights.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('Invalid allocation');
  const total = weights.reduce((a, b) => a + b, 0); if (!total) throw new Error('Allocation weights cannot be zero');
  const values = weights.map((w) => Math.floor(amount * w / total));
  let remainder = amount - values.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % values.length, remainder--) values[i]++;
  return values;
}
export function allocatePercentage(amount: number, basisPoints: number[]): number[] {
  if (basisPoints.reduce((a, b) => a + b, 0) !== 10000) throw new Error('Percentages must sum to 10000 basis points');
  return allocateByWeights(amount, basisPoints);
}
export function allocateExact(amount: number, values: number[]): number[] {
  if (!Number.isSafeInteger(amount) || values.some((n) => !Number.isSafeInteger(n) || n < 0) || values.reduce((a, b) => a + b, 0) !== amount) throw new Error('Exact allocations must sum to the amount');
  return [...values];
}
export function allocateShares(amount: number, shares: number[]): number[] { return allocateByWeights(amount, shares); }
