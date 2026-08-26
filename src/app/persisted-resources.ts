import type { Activity, Balances, Expense, Group, Settlement, Transaction } from '../shared/types';
import { saveActivity, saveCategories, saveExpenseDetailsIfGenerationMatches, saveGroupsIfGenerationMatches, updateGroupSnapshotIfGenerationMatches, type GroupSnapshot } from './idb';
import { SessionGenerationMismatchError } from './session';

type SnapshotPatch = Omit<Partial<GroupSnapshot>, 'userId' | 'groupId' | 'cachedAt'> & { cachedAt?: string };

/** Local persistence is an enhancement: unavailable private storage should not
 * turn a successful network response into an API failure. A session fence is
 * the exception because it protects against repopulating a cleared session. */
const bestEffortWrite = async <T>(write: () => Promise<T>): Promise<T | undefined> => {
  try { return await write(); }
  catch (error) {
    if (error instanceof SessionGenerationMismatchError) throw error;
    return undefined;
  }
};

export async function persistGroupsResponse(value: { userId: string; groups: Group[]; cachedAt: string }, mutationGeneration: number, generation: number) {
  return (await bestEffortWrite(() => saveGroupsIfGenerationMatches(value, mutationGeneration, generation))) !== false;
}

export async function persistGroupResponse(userId: string, groupId: string, patch: SnapshotPatch, mutationGeneration: number, generation: number) {
  return (await bestEffortWrite(() => updateGroupSnapshotIfGenerationMatches(userId, groupId, patch, mutationGeneration, generation))) !== false;
}

export async function persistExpenseResponse(userId: string, groupId: string, expenses: Expense[], mutationGeneration: number, generation: number) {
  return persistGroupResponse(userId, groupId, { expenses }, mutationGeneration, generation);
}

export async function persistBalanceResponse(userId: string, groupId: string, balances: Record<string, Balances>, mutationGeneration: number, generation: number) {
  return persistGroupResponse(userId, groupId, { balances }, mutationGeneration, generation);
}

export async function persistSettlementResponse(userId: string, groupId: string, settlements: Settlement[], mutationGeneration: number, generation: number) {
  return persistGroupResponse(userId, groupId, { settlements }, mutationGeneration, generation);
}

export async function persistTransactionResponse(userId: string, groupId: string, transactions: Transaction[], nextCursor: string | undefined, limit: number, mutationGeneration: number, generation: number) {
  return persistGroupResponse(userId, groupId, { transactions, transactionsNextCursor: nextCursor, transactionsLimit: limit }, mutationGeneration, generation);
}

export async function persistExpenseDetailsResponse(value: { userId: string; expenseId: string; expense: Expense; history: Array<{ id: string; revision: number; createdAt: string }>; fetchedAt: string }, mutationGeneration: number, generation: number) {
  return (await bestEffortWrite(() => saveExpenseDetailsIfGenerationMatches(value, mutationGeneration, generation))) !== false;
}

export async function persistActivityResponse(value: { userId: string; groupId: string; activity: Activity[]; fetchedAt: string }, generation: number, mutationGeneration: number) {
  await bestEffortWrite(() => saveActivity(value, generation, mutationGeneration));
}

export async function persistCategoriesResponse(value: { userId: string; categories: string[]; fetchedAt: string }, generation: number, mutationGeneration: number) {
  await bestEffortWrite(() => saveCategories(value, generation, mutationGeneration));
}

export type { SnapshotPatch };
