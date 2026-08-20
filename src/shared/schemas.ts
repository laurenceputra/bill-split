import { z } from 'zod';
import { checkedSumMinor } from './money';

export const id = z.string().uuid();
export const supportedCurrencies = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'NZD', 'SGD', 'HKD', 'CHF', 'CNY', 'INR'] as const;
export const currencyOptions = supportedCurrencies.map((value) => ({ value, label: value }));
export const currency = z.enum(supportedCurrencies, { errorMap: () => ({ message: 'Unsupported currency (only two-decimal ISO currencies are supported)' }) });
export const date = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return parsed.toISOString().slice(0, 10) === value;
}, 'Date must be a real calendar date in YYYY-MM-DD format');
const safeMinor = z.number().int().nonnegative().refine(Number.isSafeInteger, 'Amount must be a safe integer');
export const personInput = z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email().max(320).optional().nullable() });
export const groupInput = z.object({ name: z.string().trim().min(1).max(120), currency: currency.default('USD') });
export const payerInput = z.object({ person_id: id, amount_minor: safeMinor });
export const splitInput = z.object({ person_id: id, amount_minor: safeMinor, metadata: z.record(z.unknown()).optional() });
export const expenseInput = z.object({
  description: z.string().trim().min(1).max(240), amount_minor: z.number().int().positive().refine(Number.isSafeInteger), currency,
  date, category: z.string().trim().max(80).optional().nullable(), notes: z.string().max(2000).optional().nullable(), version: z.number().int().positive().optional(),
  payers: z.array(payerInput).min(1).max(100), splits: z.array(splitInput).min(1).max(100), client_operation_id: z.string().trim().min(1).max(100).optional()
});
export const settlementInput = z.object({ from_person_id: id, to_person_id: id, amount_minor: z.number().int().positive().refine(Number.isSafeInteger), currency, date, note: z.string().max(500).optional().nullable(), version: z.number().int().positive().optional(), client_operation_id: z.string().trim().min(1).max(100).optional() });
export const allocationInput = z.object({ method: z.enum(['equal', 'exact', 'percentage', 'shares']), values: z.array(z.number().nonnegative()).min(1) });
export type ExpenseInput = z.infer<typeof expenseInput>;
export type SettlementInput = z.infer<typeof settlementInput>;

export function assertFinancialInput(input: ExpenseInput): void {
  const uniquePayers = new Set(input.payers.map((p) => p.person_id));
  const uniqueSplits = new Set(input.splits.map((s) => s.person_id));
  if (uniquePayers.size !== input.payers.length || uniqueSplits.size !== input.splits.length) throw new Error('Each payer and split person must be unique');
  const safeSum = (values: number[]) => checkedSumMinor(values);
  if (safeSum(input.payers.map((p) => p.amount_minor)) !== input.amount_minor) throw new Error('Payers must sum to expense amount');
  if (safeSum(input.splits.map((s) => s.amount_minor)) !== input.amount_minor) throw new Error('Splits must sum to expense amount');
  if (input.payers.some((p) => !Number.isSafeInteger(p.amount_minor)) || input.splits.some((s) => !Number.isSafeInteger(s.amount_minor))) throw new Error('Amounts must be safe integers');
}
