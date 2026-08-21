import type { Activity, Balances, Expense, Group, GroupMember, Settlement } from '../shared/types';
import { supportedCurrencies, type ExpenseInput } from '../shared/schemas';
import { assertSessionGeneration, captureSessionGeneration, isSessionGenerationCurrent } from './session';

export const DB_NAME = 'bill-split-local';
export const DB_VERSION = 6;

export type OutboxStatus = 'pending' | 'syncing' | 'auth-required' | 'failed';

export interface VerifiedIdentity {
  key: 'last';
  userId: string;
  email: string;
  personId: string;
  verifiedAt: string;
}

/** The Clerk identity is deliberately separate from the internal D1 user ID. */
export interface VerifiedClerkIdentity {
  key: 'last';
  clerkUserId: string;
  verifiedAt: string;
}

export interface CachedGroups {
  userId: string;
  groups: Group[];
  cachedAt: string;
}

export interface GroupSnapshot {
  userId: string;
  groupId: string;
  group?: Group;
  members?: GroupMember[];
  expenses?: Expense[];
  balances?: Record<string, Balances>;
  settlements?: Settlement[];
  cachedAt: string;
  cachedAtByResource?: Partial<Record<'group' | 'members' | 'expenses' | 'balances' | 'settlements', string>>;
}

export interface ResourceFreshness {
  userId: string;
  resource: string;
  resourceKey: string;
  fetchedAt: string;
}

export interface MutationGeneration {
  userId: string;
  generation: number;
}

export interface CachedActivity {
  userId: string;
  groupId: string;
  activity: Activity[];
  fetchedAt: string;
}

export interface CachedExpenseDetails {
  userId: string;
  expenseId: string;
  expense: Expense;
  history: Array<{ id: string; revision: number; createdAt: string }>;
  fetchedAt: string;
}

const activityTypes = ['expense', 'settlement', 'expense_revision', 'settlement_revision', 'expense_deleted', 'settlement_deleted'] as const;
const isActivityType = (value: unknown): value is Activity['type'] => typeof value === 'string' && (activityTypes as readonly string[]).includes(value);
export const validActivityEntityId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !['undefined', 'null'].includes(value.trim().toLowerCase());

const activityEntityActive = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    if (value.trim().toLowerCase() === 'true' || value.trim() === '1') return true;
    if (value.trim().toLowerCase() === 'false' || value.trim() === '0') return false;
  }
  return undefined;
};

/**
 * Older activity caches predate the typed activity payload. Keep their useful
 * labels, but make missing identity fields explicit so a stale row can never
 * produce an `/undefined` link or crash during rendering.
 */
export function normalizeActivity(value: unknown): Activity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const row = candidate as Record<string, unknown>;
    if (!isActivityType(row.type) || !validActivityEntityId(row.id)) return [];
    const settlement = row.type.startsWith('settlement');
    const amountValue = row.amountMinor ?? row.amount_minor ?? row.amount;
    const amount = typeof amountValue === 'number' && Number.isSafeInteger(amountValue) && amountValue >= 0 ? amountValue : null;
    const rawCurrency = typeof row.currency === 'string' && (supportedCurrencies as readonly string[]).includes(row.currency) ? row.currency : null;
    const labelValue = row.label ?? row.description ?? row.note;
    const explicitEntityId = row.entityId ?? row.entity_id;
    const entityId = validActivityEntityId(explicitEntityId) ? explicitEntityId.trim() : row.type === 'expense' ? row.id.trim() : '';
    const parsedEntityActive = activityEntityActive(row.entityActive ?? row.entity_active);
    const expenseEntity = row.type === 'expense' || row.type === 'expense_revision';
    // A legacy direct expense row already represents the current entity, so its
    // event ID is a safe fallback for display/refetch. It is not an eligibility
    // assertion: only an explicit active flag can make an expense linkable.
    const entityActive = parsedEntityActive === undefined ? undefined : Boolean(expenseEntity && parsedEntityActive && validActivityEntityId(entityId));
    const base = {
      type: row.type,
      id: row.id.trim(),
      entityId,
      entityActive,
      amountMinor: amount,
      currency: rawCurrency as Activity['currency'],
      transactionDate: typeof (row.transactionDate ?? row.transaction_date ?? row.date) === 'string' ? String(row.transactionDate ?? row.transaction_date ?? row.date) : '',
      label: typeof labelValue === 'string' ? labelValue : null,
      createdAt: typeof (row.createdAt ?? row.created_at) === 'string' ? String(row.createdAt ?? row.created_at) : '',
    };
    return [{ ...base, ...(settlement ? { fromName: typeof (row.fromName ?? row.from_name) === 'string' ? String(row.fromName ?? row.from_name) : null, toName: typeof (row.toName ?? row.to_name) === 'string' ? String(row.toName ?? row.to_name) : null } : {}) } as Activity];
  });
}

export interface ExpenseOutboxItem {
  clientOperationId: string;
  userId: string;
  groupId: string;
  payload: ExpenseInput;
  display: { description: string; amountMinor: number; currency: string; date: string };
  createdAt: string;
  updatedAt: string;
  status: OutboxStatus;
  attempts: number;
  lastError?: { code?: string; message: string; status?: number };
  leaseOwner?: string;
  leaseExpiresAt?: number;
  deliveryUncertain?: boolean;
}

export class IndexedDBUnavailableError extends Error {
  constructor(message = 'Offline storage is unavailable in this browser.') {
    super(message);
    this.name = 'IndexedDBUnavailableError';
  }
}

const available = () => typeof indexedDB !== 'undefined';

function open(): Promise<IDBDatabase> {
  if (!available()) return Promise.reject(new IndexedDBUnavailableError());
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      // Keep this store and its legacy key intact. Older builds wrote `form` here.
      if (!database.objectStoreNames.contains('recent')) database.createObjectStore('recent');
      if (!database.objectStoreNames.contains('identities')) database.createObjectStore('identities', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('clerkIdentities')) database.createObjectStore('clerkIdentities', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('groups')) database.createObjectStore('groups', { keyPath: 'userId' });
      if (!database.objectStoreNames.contains('groupSnapshots')) database.createObjectStore('groupSnapshots', { keyPath: ['userId', 'groupId'] });
      if (!database.objectStoreNames.contains('resourceFreshness')) database.createObjectStore('resourceFreshness', { keyPath: ['userId', 'resourceKey'] });
      if (!database.objectStoreNames.contains('mutationGenerations')) database.createObjectStore('mutationGenerations', { keyPath: 'userId' });
      if (!database.objectStoreNames.contains('activity')) database.createObjectStore('activity', { keyPath: ['userId', 'groupId'] });
      if (!database.objectStoreNames.contains('expenseDetails')) database.createObjectStore('expenseDetails', { keyPath: ['userId', 'expenseId'] });
      if (!database.objectStoreNames.contains('expenseOutbox')) {
        const store = database.createObjectStore('expenseOutbox', { keyPath: 'clientOperationId' });
        store.createIndex('userId', 'userId', { unique: false });
        store.createIndex('groupId', 'groupId', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new IndexedDBUnavailableError());
    request.onblocked = () => reject(new IndexedDBUnavailableError('Offline storage is busy. Close another BillSplit tab and try again.'));
  });
}

async function transaction<T>(stores: string | string[], mode: IDBTransactionMode, action: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    let result: T | undefined;
    const tx = db.transaction(stores, mode);
    try {
      const request = action(tx);
      if (request) request.onsuccess = () => { result = request.result; };
    } catch (error) { reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function saveRecent(value: unknown, generation = captureSessionGeneration()) {
  assertSessionGeneration(generation);
  await transaction('recent', 'readwrite', (tx) => { if (isSessionGenerationCurrent(generation)) tx.objectStore('recent').put(value, 'form'); });
}

export async function readRecent<T>(): Promise<T | undefined> {
  return transaction<T>('recent', 'readonly', (tx) => tx.objectStore('recent').get('form'));
}

export const saveVerifiedIdentity = (value: Omit<VerifiedIdentity, 'key'>, generation = captureSessionGeneration()) => {
  assertSessionGeneration(generation);
  return transaction('identities', 'readwrite', (tx) => { if (isSessionGenerationCurrent(generation)) tx.objectStore('identities').put({ ...value, key: 'last' }); });
};
export const readLastVerifiedIdentity = () => transaction<VerifiedIdentity>('identities', 'readonly', (tx) => tx.objectStore('identities').get('last'));
export const saveLastVerifiedClerkUserId = (clerkUserId: string, generation = captureSessionGeneration()) => {
  assertSessionGeneration(generation);
  return transaction('clerkIdentities', 'readwrite', (tx) => { if (isSessionGenerationCurrent(generation)) tx.objectStore('clerkIdentities').put({ key: 'last', clerkUserId, verifiedAt: new Date().toISOString() }); });
};
export const readLastVerifiedClerkUserId = () => transaction<VerifiedClerkIdentity>('clerkIdentities', 'readonly', (tx) => tx.objectStore('clerkIdentities').get('last'));

export const saveGroups = async (value: CachedGroups, generation = captureSessionGeneration()) => {
  assertSessionGeneration(generation);
  await transaction(['groups', 'resourceFreshness'], 'readwrite', (tx) => {
    if (!isSessionGenerationCurrent(generation)) return;
    tx.objectStore('groups').put(value);
    tx.objectStore('resourceFreshness').put({ userId: value.userId, resource: 'groups', resourceKey: 'groups', fetchedAt: value.cachedAt });
  });
};
export const readGroups = (userId: string) => transaction<CachedGroups>('groups', 'readonly', (tx) => tx.objectStore('groups').get(userId));

export const readMutationGeneration = async (userId: string) => (await transaction<MutationGeneration>('mutationGenerations', 'readonly', (tx) => tx.objectStore('mutationGenerations').get(userId)))?.generation ?? 0;

/** Save a groups response only if no mutation was committed since the request started. */
export async function saveGroupsIfGenerationMatches(value: CachedGroups, mutationGeneration: number, generation = captureSessionGeneration()) {
  if (!isSessionGenerationCurrent(generation)) return false;
  const db = await open();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(['groups', 'resourceFreshness', 'mutationGenerations'], 'readwrite');
    const generations = tx.objectStore('mutationGenerations');
    const current = generations.get(value.userId);
    let saved = false;
    current.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation) || ((current.result as MutationGeneration | undefined)?.generation ?? 0) !== mutationGeneration) return;
      tx.objectStore('groups').put(value);
      tx.objectStore('resourceFreshness').put({ userId: value.userId, resource: 'groups', resourceKey: 'groups', fetchedAt: value.cachedAt });
      saved = true;
    };
    tx.oncomplete = () => { db.close(); resolve(saved); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

/** Keep the home snapshot available offline, but make it immediately stale online. */
export async function invalidateCachedGroups(userId: string, generation = captureSessionGeneration()) {
  assertSessionGeneration(generation);
  const staleAt = new Date(0).toISOString();
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['groups', 'resourceFreshness', 'mutationGenerations'], 'readwrite');
    const generations = tx.objectStore('mutationGenerations');
    const current = generations.get(userId);
    current.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
      const nextGeneration = ((current.result as MutationGeneration | undefined)?.generation ?? 0) + 1;
      generations.put({ userId, generation: nextGeneration });
      const groups = tx.objectStore('groups');
      const cached = groups.get(userId);
      cached.onsuccess = () => {
        if (cached.result) groups.put({ ...(cached.result as CachedGroups), cachedAt: staleAt });
      };
      tx.objectStore('resourceFreshness').put({ userId, resource: 'groups', resourceKey: 'groups', fetchedAt: staleAt });
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function updateGroupSnapshot(userId: string, groupId: string, patch: Omit<Partial<GroupSnapshot>, 'userId' | 'groupId' | 'cachedAt'> & { cachedAt?: string }, generation = captureSessionGeneration()) {
  assertSessionGeneration(generation);
  const db = await open();
  return new Promise<GroupSnapshot>((resolve, reject) => {
    const tx = db.transaction(['groupSnapshots', 'resourceFreshness'], 'readwrite');
    const store = tx.objectStore('groupSnapshots');
    const request = store.get([userId, groupId]);
    let next: GroupSnapshot;
    request.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
      const resources = (['group', 'members', 'expenses', 'balances', 'settlements'] as const).filter((resource) => patch[resource] !== undefined);
      const fetchedAt = patch.cachedAt || new Date().toISOString();
      next = { ...(request.result as GroupSnapshot | undefined), ...patch, userId, groupId, cachedAt: fetchedAt, cachedAtByResource: { ...(request.result as GroupSnapshot | undefined)?.cachedAtByResource, ...Object.fromEntries(resources.map((resource) => [resource, fetchedAt])) } };
      store.put(next);
      for (const resource of resources) tx.objectStore('resourceFreshness').put({ userId, resource, resourceKey: `group:${groupId}:${resource}`, fetchedAt });
    };
    tx.oncomplete = () => { db.close(); resolve(next); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export const readGroupSnapshot = (userId: string, groupId: string) => transaction<GroupSnapshot>('groupSnapshots', 'readonly', (tx) => tx.objectStore('groupSnapshots').get([userId, groupId]));

export const saveResourceFreshness = (value: ResourceFreshness, generation = captureSessionGeneration()) => {
  assertSessionGeneration(generation);
  return transaction('resourceFreshness', 'readwrite', (tx) => { if (isSessionGenerationCurrent(generation)) tx.objectStore('resourceFreshness').put(value); });
};
export const readResourceFreshness = (userId: string, resourceKey: string) => transaction<ResourceFreshness>('resourceFreshness', 'readonly', (tx) => tx.objectStore('resourceFreshness').get([userId, resourceKey]));

export const saveActivity = (value: CachedActivity, generation = captureSessionGeneration()) => {
  assertSessionGeneration(generation);
  return transaction('activity', 'readwrite', (tx) => { if (isSessionGenerationCurrent(generation)) tx.objectStore('activity').put({ ...value, activity: normalizeActivity(value.activity) }); });
};
export async function readActivity(userId: string, groupId: string) {
  const cached = await transaction<CachedActivity>('activity', 'readonly', (tx) => tx.objectStore('activity').get([userId, groupId]));
  return cached ? { ...cached, activity: normalizeActivity(cached.activity) } : undefined;
}

export const saveExpenseDetails = (value: CachedExpenseDetails, generation = captureSessionGeneration()) => {
  assertSessionGeneration(generation);
  return transaction('expenseDetails', 'readwrite', (tx) => { if (isSessionGenerationCurrent(generation)) tx.objectStore('expenseDetails').put(value); });
};
export const readExpenseDetails = (userId: string, expenseId: string) => transaction<CachedExpenseDetails>('expenseDetails', 'readonly', (tx) => tx.objectStore('expenseDetails').get([userId, expenseId]));

/** Remove private cached data without touching the durable expense outbox. */
export async function clearCachedData() {
  await transaction(['recent', 'identities', 'clerkIdentities', 'groups', 'groupSnapshots', 'resourceFreshness', 'mutationGenerations', 'activity', 'expenseDetails'], 'readwrite', (tx) => {
    for (const storeName of ['recent', 'identities', 'clerkIdentities', 'groups', 'groupSnapshots', 'resourceFreshness', 'mutationGenerations', 'activity', 'expenseDetails']) tx.objectStore(storeName).clear();
  });
}

/** Remove every private record, including expenses waiting to sync. */
export async function clearAllPrivateData() {
  await transaction(['recent', 'identities', 'clerkIdentities', 'groups', 'groupSnapshots', 'resourceFreshness', 'mutationGenerations', 'activity', 'expenseDetails', 'expenseOutbox'], 'readwrite', (tx) => {
    for (const storeName of ['recent', 'identities', 'clerkIdentities', 'groups', 'groupSnapshots', 'resourceFreshness', 'mutationGenerations', 'activity', 'expenseDetails', 'expenseOutbox']) tx.objectStore(storeName).clear();
  });
}

export const saveOutboxItem = (item: ExpenseOutboxItem, generation = captureSessionGeneration()) => {
  assertSessionGeneration(generation);
  return transaction('expenseOutbox', 'readwrite', (tx) => { if (isSessionGenerationCurrent(generation)) tx.objectStore('expenseOutbox').put(item); });
};
export const readOutboxItem = (clientOperationId: string) => transaction<ExpenseOutboxItem>('expenseOutbox', 'readonly', (tx) => tx.objectStore('expenseOutbox').get(clientOperationId));

export async function listOutbox(userId?: string): Promise<ExpenseOutboxItem[]> {
  const all = await transaction<ExpenseOutboxItem[]>('expenseOutbox', 'readonly', (tx) => tx.objectStore('expenseOutbox').getAll());
  return (all || []).filter((item) => !userId || item.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export const deleteOutboxItem = (clientOperationId: string) => transaction('expenseOutbox', 'readwrite', (tx) => tx.objectStore('expenseOutbox').delete(clientOperationId));

export async function recoverStaleSyncing() {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.getAll();
    request.onsuccess = () => {
      const now = Date.now();
      for (const item of request.result as ExpenseOutboxItem[]) {
        if (item.status === 'syncing' && (!item.leaseExpiresAt || item.leaseExpiresAt <= now)) store.put({ ...item, status: 'pending', leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: new Date().toISOString() });
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

/** Atomically claims a pending or expired-syncing row for one browser tab. */
export async function claimOutboxItem(clientOperationId: string, owner: string, now = Date.now(), leaseMs = 30_000, generation = captureSessionGeneration()): Promise<ExpenseOutboxItem | undefined> {
  assertSessionGeneration(generation);
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.get(clientOperationId);
    let claimed: ExpenseOutboxItem | undefined;
    request.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
      const item = request.result as ExpenseOutboxItem | undefined;
      const claimable = item && (item.status === 'pending' || (item.status === 'syncing' && (!item.leaseExpiresAt || item.leaseExpiresAt <= now)));
      if (!claimable) return;
      claimed = { ...item, status: 'syncing', attempts: item.attempts + 1, leaseOwner: owner, leaseExpiresAt: now + leaseMs, updatedAt: new Date(now).toISOString(), lastError: undefined };
      store.put(claimed);
    };
    tx.oncomplete = () => { db.close(); resolve(claimed); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function updateOutboxIfOwned(clientOperationId: string, owner: string, patch: Partial<ExpenseOutboxItem>, now = Date.now(), generation = captureSessionGeneration()): Promise<ExpenseOutboxItem | undefined> {
  assertSessionGeneration(generation);
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.get(clientOperationId);
    let updated: ExpenseOutboxItem | undefined;
    request.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
      const item = request.result as ExpenseOutboxItem | undefined;
      if (!item || item.leaseOwner !== owner || (item.leaseExpiresAt !== undefined && item.leaseExpiresAt <= now)) return;
      updated = { ...item, ...patch, updatedAt: new Date(now).toISOString() };
      store.put(updated);
    };
    tx.oncomplete = () => { db.close(); resolve(updated); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function removeOutboxIfOwned(clientOperationId: string, owner: string, now = Date.now(), generation = captureSessionGeneration()): Promise<boolean> {
  assertSessionGeneration(generation);
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.get(clientOperationId);
    let removed = false;
    request.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
      const item = request.result as ExpenseOutboxItem | undefined;
      if (!item || item.leaseOwner !== owner || (item.leaseExpiresAt !== undefined && item.leaseExpiresAt <= now)) return;
      store.delete(clientOperationId); removed = true;
    };
    tx.oncomplete = () => { db.close(); resolve(removed); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function discardOutboxIfIdle(clientOperationId: string, now = Date.now()): Promise<boolean> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.get(clientOperationId);
    let removed = false;
    request.onsuccess = () => {
      const item = request.result as ExpenseOutboxItem | undefined;
      if (!item || item.deliveryUncertain || (item.status === 'syncing' && item.leaseExpiresAt !== undefined && item.leaseExpiresAt > now)) return;
      store.delete(clientOperationId); removed = true;
    };
    tx.oncomplete = () => { db.close(); resolve(removed); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function resetOutboxIfIdle(clientOperationId: string, now = Date.now()): Promise<ExpenseOutboxItem | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.get(clientOperationId);
    let updated: ExpenseOutboxItem | undefined;
    request.onsuccess = () => {
      const item = request.result as ExpenseOutboxItem | undefined;
      if (!item || (item.status === 'syncing' && item.leaseExpiresAt !== undefined && item.leaseExpiresAt > now)) return;
      updated = { ...item, status: 'pending', deliveryUncertain: item.deliveryUncertain === true, leaseOwner: undefined, leaseExpiresAt: undefined, lastError: undefined, updatedAt: new Date(now).toISOString() };
      store.put(updated);
    };
    tx.oncomplete = () => { db.close(); resolve(updated); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function reactivateAuthRequired(userId: string) {
  const db = await open();
  let changed = 0;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.getAll();
    request.onsuccess = () => { for (const item of request.result as ExpenseOutboxItem[]) if (item.userId === userId && item.status === 'auth-required') { store.put({ ...item, status: 'pending', lastError: undefined, updatedAt: new Date().toISOString() }); changed += 1; } };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
  return changed;
}

export async function markOutboxAuthRequired(userId: string, lastError: ExpenseOutboxItem['lastError']) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.getAll();
    request.onsuccess = () => { for (const item of request.result as ExpenseOutboxItem[]) if (item.userId === userId && item.status === 'pending') store.put({ ...item, status: 'auth-required', lastError, updatedAt: new Date().toISOString() }); };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function reconcileOutboxItems(userId: string, groupId: string, expenses: Expense[], generation = captureSessionGeneration()) {
  assertSessionGeneration(generation);
  const operations = new Set(expenses.filter((expense) => expense.groupId === groupId && expense.createdBy === userId && expense.clientOperationId).map((expense) => expense.clientOperationId));
  if (!operations.size) return 0;
  const db = await open();
  let removed = 0;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.getAll();
    request.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
      for (const item of request.result as ExpenseOutboxItem[]) if (item.userId === userId && item.groupId === groupId && operations.has(item.clientOperationId)) { store.delete(item.clientOperationId); removed += 1; }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
  return removed;
}
