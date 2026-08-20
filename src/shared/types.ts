import type { supportedCurrencies } from './schemas';

export type Currency = typeof supportedCurrencies[number];
export type SplitMethod = 'equal' | 'exact' | 'percentage' | 'shares';

export interface Person { id: string; name: string; email?: string | null; createdAt: string }
export interface Group { id: string; name: string; currency: Currency; createdAt: string; updatedAt: string; role?: 'owner' | 'member' }
export interface GroupMember { personId: string; name: string; email?: string | null; joinedAt: string; role: 'owner' | 'member' }
export interface Split { personId: string; amountMinor: number; metadata?: Record<string, unknown> }
export interface Payer { personId: string; amountMinor: number }
export interface Expense {
  id: string; groupId: string; description: string; amountMinor: number; currency: Currency;
  date: string; category?: string | null; notes?: string | null; createdBy: string; createdAt: string;
  updatedAt: string; deletedAt?: string | null; version: number; payers: Payer[]; splits: Split[]
}
export interface Settlement { id: string; groupId: string; fromPersonId: string; toPersonId: string; amountMinor: number; currency: Currency; date: string; note?: string | null; createdAt: string; updatedAt: string; deletedAt?: string | null; version: number }
export interface Balance { personId: string; name: string; netMinor: number; currency: Currency }
export interface PairwiseBalance { fromPersonId: string; fromName: string; toPersonId: string; toName: string; amountMinor: number; currency: Currency }
export interface Balances { raw: Balance[]; simplified: PairwiseBalance[] }
