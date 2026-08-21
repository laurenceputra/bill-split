import type { supportedCurrencies } from './schemas';

export type Currency = typeof supportedCurrencies[number];
export type SplitMethod = 'equal' | 'exact' | 'percentage' | 'shares';
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type ScheduledExpenseStatus = 'active' | 'paused' | 'cancelled' | 'blocked' | 'completed';
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface Person { id: string; name: string; email?: string | null; createdAt: string }
export interface GroupBalanceSummary { currency: Currency; netMinor: number }
export interface Group { id: string; name: string; currency: Currency; createdAt: string; updatedAt: string; role?: 'owner' | 'member'; memberCount?: number; counterpartName?: string | null; balanceSummaries?: GroupBalanceSummary[] }
export interface GroupMember { personId: string; name: string; email?: string | null; joinedAt: string; role: 'owner' | 'member' }
export interface Split { personId: string; amountMinor: number; metadata?: Record<string, unknown> }
export interface Payer { personId: string; amountMinor: number }
export interface Expense {
  id: string; groupId: string; description: string; amountMinor: number; currency: Currency;
  date: string; category?: string | null; notes?: string | null; createdBy: string; createdAt: string;
  updatedAt: string; deletedAt?: string | null; version: number; clientOperationId?: string | null; payers: Payer[]; splits: Split[]
}
export interface ScheduledExpense {
  id: string; groupId: string; description: string; amountMinor: number; currency: Currency;
  startDate: string; endDate?: string | null; frequency: RecurrenceFrequency; interval: number;
  weekdays: Weekday[]; timezone: string; status: ScheduledExpenseStatus; blockedReason?: string | null;
  nextOccurrenceDate?: string | null; createdBy: string; createdAt: string; updatedAt: string; version: number;
  clientOperationId?: string | null; payers: Payer[]; splits: Split[];
}
export interface Settlement { id: string; groupId: string; fromPersonId: string; toPersonId: string; amountMinor: number; currency: Currency; date: string; note?: string | null; createdAt: string; updatedAt: string; deletedAt?: string | null; version: number }
export interface Balance { personId: string; name: string; netMinor: number; currency: Currency }
export interface PairwiseBalance { fromPersonId: string; fromName: string; toPersonId: string; toName: string; amountMinor: number; currency: Currency }
export interface Balances { raw: Balance[]; simplified: PairwiseBalance[] }

export type ActivityType = 'expense' | 'settlement' | 'expense_revision' | 'settlement_revision' | 'expense_deleted' | 'settlement_deleted';
export interface ActivityBase {
  id: string;
  entityId: string;
  /** Undefined means an older cached row did not carry eligibility state. */
  entityActive?: boolean;
  amountMinor: number | null;
  currency: Currency | null;
  transactionDate: string;
  label: string | null;
  createdAt: string;
}
export type Activity =
  | (ActivityBase & { type: 'expense' | 'expense_revision' | 'expense_deleted'; fromName?: null; toName?: null })
  | (ActivityBase & { type: 'settlement' | 'settlement_revision' | 'settlement_deleted'; fromName: string | null; toName: string | null });
