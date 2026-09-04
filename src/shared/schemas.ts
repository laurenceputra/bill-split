import { z } from 'zod';
import { checkedSumMinor } from './money';
import type { Weekday } from './types';
import { isSupportedPushEndpoint } from './push-endpoints';
export { normalizeCategoryDescription } from './category';

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
export const invitationInput = z.object({ email: z.string().trim().email().max(320) });
export const ownershipTransferInput = z.object({ person_id: id });
export const transactionVersionInput = z.object({ version: z.number().int().positive() });
export const categorySuggestionInput = z.object({ description: z.string().trim().min(1).max(240) });
export const groupInput = z.object({ name: z.string().trim().min(1).max(120), currency: currency.default('USD') });
export const friendInput = personInput.extend({ currency: currency.default('USD'), client_operation_id: z.string().trim().min(1).max(100).optional() });
export const payerInput = z.object({ person_id: id, amount_minor: safeMinor });
export const splitInput = z.object({ person_id: id, amount_minor: safeMinor, metadata: z.record(z.unknown()).optional() });
export const expenseInput = z.object({
  description: z.string().trim().min(1).max(240), amount_minor: z.number().int().positive().refine(Number.isSafeInteger), currency,
  date, category: z.string().trim().max(80).optional().nullable(), notes: z.string().max(2000).optional().nullable(), version: z.number().int().positive().optional(),
  payers: z.array(payerInput).min(1).max(100), splits: z.array(splitInput).min(1).max(100), client_operation_id: z.string().trim().min(1).max(100).optional()
});
export const settlementInput = z.object({ from_person_id: id, to_person_id: id, amount_minor: z.number().int().positive().refine(Number.isSafeInteger), currency, date, note: z.string().max(500).optional().nullable(), version: z.number().int().positive().optional(), client_operation_id: z.string().trim().min(1).max(100).optional() });
export const timezone = z.string().trim().min(1).max(64).refine((value) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}, 'Timezone must be a valid IANA timezone');
export const recurrenceFrequency = z.enum(['daily', 'weekly', 'monthly', 'yearly']);
const weekday = z.number().int().min(0).max(6) as z.ZodType<Weekday>;
export const scheduledExpenseInput = z.object({
  description: z.string().trim().min(1).max(240), amount_minor: z.number().int().positive().refine(Number.isSafeInteger), currency,
  category: z.string().trim().max(80).optional().nullable(),
  start_date: date, end_date: date.optional().nullable(), frequency: recurrenceFrequency, interval: z.number().int().positive().max(366),
  weekdays: z.array(weekday).max(7).default([]), timezone, version: z.number().int().positive().optional(),
  payers: z.array(payerInput).min(1).max(100), splits: z.array(splitInput).min(1).max(100), client_operation_id: z.string().trim().min(1).max(100).optional(),
}).superRefine((value, context) => {
  if (value.end_date && value.end_date < value.start_date) context.addIssue({ code: z.ZodIssueCode.custom, path: ['end_date'], message: 'End date must not precede start date' });
  if (value.weekdays.some((day, index) => value.weekdays.indexOf(day) !== index)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['weekdays'], message: 'Weekdays must be unique' });
  if (value.frequency === 'weekly' && value.weekdays.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ['weekdays'], message: 'Weekly schedules require at least one weekday' });
  if (value.frequency !== 'weekly' && value.weekdays.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ['weekdays'], message: 'Weekdays are only valid for weekly schedules' });
});
export const scheduledExpenseStatusInput = z.object({ version: z.number().int().positive() });
export const ACCOUNT_DELETION_CONFIRMATION = 'DELETE MY ACCOUNT' as const;
export const accountDeletionInput = z.object({ confirmation: z.literal(ACCOUNT_DELETION_CONFIRMATION) });
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Push key must be base64url encoded');
export const pushSubscriptionInput = z.object({
  endpoint: z.string().trim().url().max(2048).refine(isSupportedPushEndpoint, 'Push endpoint is not a supported browser push service'),
  expirationTime: z.number().int().nonnegative().nullable().optional(),
  keys: z.object({ p256dh: base64Url.min(40).max(256), auth: base64Url.min(16).max(128) }).strict(),
}).strict();
export const pushSubscriptionDeleteInput = z.object({ endpoint: pushSubscriptionInput.shape.endpoint }).strict();
export const notificationPreferencesInput = z.object({
  money_changes: z.boolean().default(true), scheduled_events: z.boolean().default(true), detail_level: z.enum(['generic', 'detailed']).default('generic'),
}).strict();
export const allocationInput = z.object({ method: z.enum(['equal', 'exact', 'percentage', 'shares']), values: z.array(z.number().nonnegative()).min(1) });
const splitDefaultPersonIds = z.array(id).min(1).max(100).refine((values) => new Set(values).size === values.length, 'Included members must be unique');
const splitDefaultValues = z.array(z.number().finite().positive()).min(1).max(100);
export const groupSplitDefaultInput = z.union([
  z.object({ method: z.literal('equal'), person_ids: splitDefaultPersonIds }).strict(),
  z.object({ method: z.literal('percentage'), person_ids: splitDefaultPersonIds, values: z.array(z.number().int().min(1).max(10_000)).min(1).max(100) }).strict().superRefine((value, context) => {
    if (value.values.length !== value.person_ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['values'], message: 'Each included member needs one percentage' });
    else if (value.values.reduce((sum, current) => sum + current, 0) !== 10_000) context.addIssue({ code: z.ZodIssueCode.custom, path: ['values'], message: 'Percentages must total 10000 basis points' });
  }),
  z.object({ method: z.literal('shares'), person_ids: splitDefaultPersonIds, values: splitDefaultValues }).strict().superRefine((value, context) => {
    if (value.values.length !== value.person_ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['values'], message: 'Each included member needs one share value' });
    if (value.values.reduce((sum, current) => sum + current, 0) > 1_000_000) context.addIssue({ code: z.ZodIssueCode.custom, path: ['values'], message: 'Total shares must not exceed 1000000' });
  }),
]);
export type GroupSplitDefaultInput = z.infer<typeof groupSplitDefaultInput>;
export type ExpenseInput = z.infer<typeof expenseInput>;
export type SettlementInput = z.infer<typeof settlementInput>;
export type FriendInput = z.infer<typeof friendInput>;
export type InvitationInput = z.infer<typeof invitationInput>;
export type ScheduledExpenseInput = z.infer<typeof scheduledExpenseInput>;
export type CategorySuggestionInput = z.infer<typeof categorySuggestionInput>;
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInput>;
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesInput>;

export function assertFinancialInput(input: ExpenseInput): void {
  const uniquePayers = new Set(input.payers.map((p) => p.person_id));
  const uniqueSplits = new Set(input.splits.map((s) => s.person_id));
  if (uniquePayers.size !== input.payers.length || uniqueSplits.size !== input.splits.length) throw new Error('Each payer and split person must be unique');
  const safeSum = (values: number[]) => checkedSumMinor(values);
  if (safeSum(input.payers.map((p) => p.amount_minor)) !== input.amount_minor) throw new Error('Payers must sum to expense amount');
  if (safeSum(input.splits.map((s) => s.amount_minor)) !== input.amount_minor) throw new Error('Splits must sum to expense amount');
  if (input.payers.some((p) => !Number.isSafeInteger(p.amount_minor)) || input.splits.some((s) => !Number.isSafeInteger(s.amount_minor))) throw new Error('Amounts must be safe integers');
}
