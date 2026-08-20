import { describe, expect, it } from 'vitest';
import { allocateEqual, allocateExact, allocatePercentage, allocateShares, checkedAddMinor, formatMoney, parseMoney } from './money';
describe('money', () => {
  it('parses and formats minor units', () => { expect(parseMoney('12.30', 'USD')).toBe(1230); expect(formatMoney(1230, 'USD', 'en-US')).toContain('12.30'); });
  it('allocates remainder in stable input order', () => { expect(allocateEqual(10, 3)).toEqual([4, 3, 3]); expect(allocatePercentage(101, [3333, 3333, 3334])).toEqual([34, 34, 33]); });
  it('validates exact allocations', () => { expect(allocateExact(10, [4, 6])).toEqual([4, 6]); expect(() => allocateExact(10, [4, 5])).toThrow(); });
  it('supports exact, percentage, shares, and cent remainders without floating point', () => {
    expect(allocateExact(10, [1, 9])).toEqual([1, 9]);
    expect(allocateEqual(1, 3)).toEqual([1, 0, 0]);
    expect(allocateEqual(1000, 3)).toEqual([334, 333, 333]);
    expect(allocatePercentage(1000, [2500, 7500])).toEqual([250, 750]);
    expect(allocateShares(10, [1, 2, 1])).toEqual([3, 5, 2]);
    expect(() => parseMoney('1.001', 'USD')).toThrow();
    expect(() => parseMoney('1.00', 'JPY' as never)).toThrow();
  });
  it('rejects a cent above the safe integer boundary instead of rounding it', () => {
    expect(parseMoney('90071992547409.91', 'USD')).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseMoney('90071992547409.92', 'USD')).toThrow('safe integer range');
  });
  it('checks aggregate minor-unit addition even when each input is individually safe', () => {
    expect(() => checkedAddMinor(Number.MAX_SAFE_INTEGER, 1)).toThrow('safe integer range');
  });
});
