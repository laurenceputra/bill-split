export const BALANCE_OVERFLOW_CODE = 'BALANCE_OVERFLOW' as const;

/** A checked arithmetic failure for minor-unit aggregates. */
export class BalanceOverflowError extends Error {
  readonly code = BALANCE_OVERFLOW_CODE;

  constructor() {
    super('Minor-unit balance exceeds the safe integer range');
    this.name = 'BalanceOverflowError';
  }
}

export function checkedAddMinor(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new BalanceOverflowError();
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new BalanceOverflowError();
  return result;
}

export function checkedSumMinor(values: Iterable<number>): number {
  let result = 0;
  for (const value of values) result = checkedAddMinor(result, value);
  return result;
}

export function checkedMinor(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new BalanceOverflowError();
  return result;
}
