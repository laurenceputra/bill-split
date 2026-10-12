import { useSyncExternalStore } from 'react';
import type { Group, PersonalBalanceSnapshot } from '../shared/types';
import { readGroupSnapshot, readMutationGeneration, savePersonalBalance } from './idb';
import { captureSessionGeneration, isSessionGenerationCurrent } from './session';

type RecordValue = { snapshot: PersonalBalanceSnapshot; fetchedAt: number; stale: boolean };
const records = new Map<string, RecordValue>();
const listeners = new Set<() => void>();
let version = 0;
let mutationEpoch = 0;
export const capturePersonalBalanceEpoch = () => mutationEpoch;
const key = (userId: string, groupId: string) => JSON.stringify([userId, groupId]);
const notify = () => { version++; listeners.forEach((listener) => listener()); };
export const getPersonalBalance = (userId: string, groupId: string) => records.get(key(userId, groupId));
export function usePersonalBalances() {
  useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => 0);
}
export function acceptPersonalBalance(userId: string, snapshot: PersonalBalanceSnapshot | undefined, generation = captureSessionGeneration(), fetchedAt = Date.now()) {
  if (!snapshot || !isSessionGenerationCurrent(generation) || !Number.isSafeInteger(snapshot.ledgerRevision) || snapshot.ledgerRevision < 0) return false;
  const id = key(userId, snapshot.groupId);
  const current = records.get(id);
  if (current && current.snapshot.ledgerRevision > snapshot.ledgerRevision) return false;
  if (current && current.snapshot.ledgerRevision === snapshot.ledgerRevision && current.fetchedAt > fetchedAt) return false;
  records.set(id, { snapshot, fetchedAt, stale: fetchedAt === 0 });
  notify();
  return true;
}
export async function persistPersonalBalance(userId: string, snapshot: PersonalBalanceSnapshot | undefined, mutationGeneration: number, generation: number, epoch = mutationEpoch) {
  if (!snapshot || !isSessionGenerationCurrent(generation)) return;
  try {
    const saved = await savePersonalBalance(userId, snapshot, mutationGeneration, generation);
    if (saved && await readMutationGeneration(userId) === mutationGeneration && epoch === mutationEpoch) acceptPersonalBalance(userId, saved.personalBalance, generation, Date.parse(saved.personalBalanceFetchedAt || '') || 0);
  } catch { if (epoch === mutationEpoch) acceptPersonalBalance(userId, snapshot, generation); /* Offline storage is an enhancement. */ }
}
export async function hydratePersonalBalance(userId: string, groupId: string, generation = captureSessionGeneration()) {
  const epoch = mutationEpoch;
  try {
    const row = await readGroupSnapshot(userId, groupId);
    if (epoch === mutationEpoch) acceptPersonalBalance(userId, row?.personalBalance, generation, Date.parse(row?.personalBalanceFetchedAt || '') || 0);
  } catch { /* Legacy caches have no complete snapshot. */ }
}
export function stalePersonalBalances(userId: string, groupId?: string) {
  mutationEpoch++;
  for (const [id, record] of records) {
    const [user, group] = JSON.parse(id) as string[];
    if (user === userId && (!groupId || group === groupId)) records.set(id, { ...record, stale: true });
  }
  notify();
}
export function clearPersonalBalances() { mutationEpoch++; records.clear(); notify(); }
export function personalBalanceGroup(userId: string, group: Group): Group {
  const canonical = getPersonalBalance(userId, group.id)?.snapshot;
  return canonical ? { ...group, currency: canonical.defaultCurrency, personalBalance: canonical, balanceSummaries: canonical.balances } : group;
}
