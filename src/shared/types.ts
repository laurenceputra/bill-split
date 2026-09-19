import type { supportedCurrencies } from './schemas';

export type Currency = typeof supportedCurrencies[number];
export type GroupKind = 'named' | 'peer';
export type SplitMethod = 'equal' | 'exact' | 'percentage' | 'shares';
export type GroupSplitDefaultMethod = Exclude<SplitMethod, 'exact'>;
export interface GroupSplitDefault {
  method: GroupSplitDefaultMethod;
  personIds: string[];
  values?: number[];
}
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type ScheduledExpenseStatus = 'active' | 'paused' | 'cancelled' | 'blocked' | 'completed';
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface Person { id: string; name: string; email?: string | null; createdAt: string }
export interface GroupBalanceSummary { currency: Currency; netMinor: number }
/** kind is optional only for pre-kind offline snapshots; server responses always carry it. */
export interface Group { id: string; name: string; currency: Currency; kind?: GroupKind; createdAt: string; updatedAt: string; role?: 'owner' | 'member'; memberCount?: number; counterpartName?: string | null; balanceSummaries?: GroupBalanceSummary[] }
export interface GroupMember { personId: string; name: string; email?: string | null; joinedAt: string; role: 'owner' | 'member'; linked?: boolean; removedAt?: string | null }
export type HistoricalParticipantStatus = 'active' | 'removed' | 'deleted';
export interface HistoricalParticipant { personId: string; name: string; joinedAt: string; role: 'owner' | 'member'; linked?: boolean; removedAt?: string | null; status: HistoricalParticipantStatus }
export interface GroupInvitation { id: string; groupId: string; email: string; createdBy: string; createdAt: string; expiresAt: string; targetPersonId?: string | null; revokedAt?: string | null; acceptedAt?: string | null; acceptedBy?: string | null; rejectedAt?: string | null }
export interface GroupResponse { group: Group; members: GroupMember[]; historicalParticipants: HistoricalParticipant[]; splitDefault: GroupSplitDefault | null; currentPersonId: string | null }
export interface Split { personId: string; amountMinor: number; metadata?: Record<string, unknown> }
export interface Payer { personId: string; amountMinor: number }
export type CreditSubtype = 'refund' | 'claim';
export type CreditDeliveryMode = 'member_reimbursement' | 'direct_provider_offset';
export type CreditAllocationType = 'recipient' | 'beneficiary';
export interface CreditApplication { expenseId: string; amountMinor: number; expenseDescription?: string; expenseDate?: string }
export interface CreditAllocation { personId: string; allocationType: CreditAllocationType; amountMinor: number }
export interface Credit { id: string; groupId: string; subtype: CreditSubtype; deliveryMode: CreditDeliveryMode; amountMinor: number; currency: Currency; date: string; note?: string | null; createdBy: string; createdAt: string; updatedAt: string; deletedAt?: string | null; version: number; clientOperationId?: string | null; applications: CreditApplication[]; allocations: CreditAllocation[] }
export interface CreditApplicationSummary { creditId: string; subtype: CreditSubtype; amountMinor: number; date: string; deliveryMode: CreditDeliveryMode }
export interface Expense {
  id: string; groupId: string; description: string; amountMinor: number; currency: Currency;
  date: string; category?: string | null; notes?: string | null; createdBy: string; createdAt: string;
  updatedAt: string; deletedAt?: string | null; version: number; clientOperationId?: string | null; payers: Payer[]; splits: Split[]; linkedCredits?: CreditApplicationSummary[]; totalCreditsMinor?: number; netCostMinor?: number
}
export interface ScheduledExpense {
  id: string; groupId: string; description: string; amountMinor: number; currency: Currency;
  category?: string | null;
  startDate: string; endDate?: string | null; frequency: RecurrenceFrequency; interval: number;
  weekdays: Weekday[]; timezone: string; status: ScheduledExpenseStatus; blockedReason?: string | null;
  nextOccurrenceDate?: string | null; createdBy: string; createdAt: string; updatedAt: string; version: number;
  clientOperationId?: string | null; payers: Payer[]; splits: Split[];
}
export interface Settlement { id: string; groupId: string; fromPersonId: string; toPersonId: string; amountMinor: number; currency: Currency; date: string; note?: string | null; createdAt: string; updatedAt: string; deletedAt?: string | null; version: number }
export interface SpendingInsightSummary {
  currency: Currency;
  /** Total expense amount. Meaningful for group scope; global scope uses allocatedSpendMinor as primary. */
  groupSpendMinor: number;
  /** Sum of this user's non-zero split allocations. This is the global primary metric. */
  allocatedSpendMinor: number;
  yourShareMinor: number;
  youPaidMinor: number;
  expenseCount: number;
}
export interface SpendingInsightCategoryTrend {
  currency: Currency;
  bucket: string;
  category: string;
  groupSpendMinor: number;
  allocatedSpendMinor: number;
  expenseCount: number;
}
export interface SpendingInsightSummaryResponse {
  scope: 'global' | 'group';
  from?: string;
  to?: string;
  summaries: SpendingInsightSummary[];
  previous?: {
    from: string;
    to: string;
    summaries: Array<Pick<SpendingInsightSummary, 'currency' | 'groupSpendMinor' | 'allocatedSpendMinor' | 'yourShareMinor' | 'youPaidMinor' | 'expenseCount'>>;
  };
}
export interface SpendingInsightTrends {
  scope: 'global' | 'group';
  trendFrom: string;
  trendTo: string;
  categoryTrends: SpendingInsightCategoryTrend[];
}
/** The deliberately small row returned by the unified transaction list. */
export interface ExpenseTransaction {
    kind: 'expense'; id: string; groupId: string; groupName?: string; description: string; amountMinor: number; currency: Currency;
    date: string; category?: string | null; notes?: string | null; createdBy: string; createdAt: string;
    clientOperationId?: string | null;
    /** Deliberately small context for history rows; details remain on the detail route. */
    payerPersonIds?: string[]; payerNames?: string[]; splitPersonIds?: string[]; splitNames?: string[];
}
export interface SettlementTransaction {
    kind: 'settlement'; id: string; groupId: string; groupName?: string; amountMinor: number; currency: Currency; date: string;
    note?: string | null; fromPersonId: string; toPersonId: string; fromName: string; toName: string; createdAt: string;
}
export interface CreditTransaction { kind: 'credit'; id: string; groupId: string; groupName?: string; subtype: CreditSubtype; deliveryMode: CreditDeliveryMode; amountMinor: number; currency: Currency; date: string; note?: string | null; createdAt: string }
export type Transaction = ExpenseTransaction | SettlementTransaction | CreditTransaction;
export type AuditAction = 'create' | 'update' | 'delete' | 'restore';
export interface AuditEvent { id: string; groupId: string; entityType: 'expense' | 'settlement' | 'credit'; entityId: string; version: number; action: AuditAction; actorId: string; actorPersonId?: string; actorName: string; occurredAt: string; before?: unknown; after?: unknown }
/** Redacted, entity-scoped audit data intended for transaction detail views. */
export interface AuditDisclosureEvent { entityType: 'expense' | 'settlement' | 'credit'; version: number; action: AuditAction; actorName: string; occurredAt: string; beforeSummary?: string; afterSummary?: string }
export interface CursorPage<T> { items: T[]; nextCursor?: string }
export interface Balance { personId: string; name: string; netMinor: number; currency: Currency }
export interface PairwiseBalance { fromPersonId: string; fromName: string; toPersonId: string; toName: string; amountMinor: number; currency: Currency }
export interface Balances { raw: Balance[]; simplified: PairwiseBalance[] }

export type ActivityType = 'expense' | 'settlement' | 'credit' | 'expense_revision' | 'settlement_revision' | 'credit_revision' | 'expense_deleted' | 'settlement_deleted' | 'credit_deleted';
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
  groupId?: string;
  groupName?: string;
}
export type Activity =
  | (ActivityBase & { type: 'expense' | 'expense_revision' | 'expense_deleted'; fromName?: null; toName?: null })
  | (ActivityBase & { type: 'settlement' | 'settlement_revision' | 'settlement_deleted'; fromName: string | null; toName: string | null })
  | (ActivityBase & { type: 'credit' | 'credit_revision' | 'credit_deleted'; fromName?: null; toName?: null });
