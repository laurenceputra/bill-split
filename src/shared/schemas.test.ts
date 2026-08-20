import { describe, expect, it } from 'vitest';
import { assertFinancialInput, currencyOptions, expenseInput, friendInput, supportedCurrencies } from './schemas';
import { BalanceOverflowError } from './money';

const base = { description: 'Lunch', amount_minor: 1000, currency: 'USD' as const, date: '2025-01-01', payers: [{ person_id: '00000000-0000-4000-8000-000000000001', amount_minor: 1000 }], splits: [{ person_id: '00000000-0000-4000-8000-000000000001', amount_minor: 1000 }] };
describe('financial input', () => {
  it('rejects mismatched totals and unsafe integers', () => {
    expect(() => assertFinancialInput({ ...base, splits: [{ ...base.splits[0], amount_minor: 999 }] })).toThrow('Splits must sum');
    expect(expenseInput.safeParse({ ...base, amount_minor: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });
  it('accepts exact idempotency keys and integer values', () => {
    expect(expenseInput.parse({ ...base, client_operation_id: 'retry-1' }).client_operation_id).toBe('retry-1');
  });
  it('reports an aggregate overflow separately from an ordinary total mismatch', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(() => assertFinancialInput({ ...base, amount_minor: max, payers: [{ ...base.payers[0], amount_minor: max }, { person_id: '00000000-0000-4000-8000-000000000002', amount_minor: 1 }] })).toThrow(BalanceOverflowError);
  });
  it('rejects impossible dates and currencies with unsupported minor units', () => {
    expect(expenseInput.safeParse({ ...base, date: '2025-02-30' }).success).toBe(false);
    expect(expenseInput.safeParse({ ...base, currency: 'JPY' }).success).toBe(false);
  });
  it('keeps frontend currency options aligned with the validation source', () => {
    expect(currencyOptions.map((option) => option.value)).toEqual([...supportedCurrencies]);
  });
  it('accepts a client operation ID for retry-safe friend creation', () => {
    expect(friendInput.parse({ name: 'Friend', currency: 'USD', client_operation_id: 'friend-op' }).client_operation_id).toBe('friend-op');
    expect(friendInput.safeParse({ name: '   ', currency: 'USD', client_operation_id: 'friend-op' }).success).toBe(false);
  });
});
