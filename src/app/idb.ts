import type { Activity, Balances, Expense, Group, GroupMember, HistoricalParticipant, Settlement, Transaction } from '../shared/types';
import { supportedCurrencies, type ExpenseInput } from '../shared/schemas';
import { assertSessionGeneration, captureSessionGeneration, isSessionGenerationCurrent } from './session';

export const DB_NAME = 'bill-split-local';
export const DB_VERSION = 10;

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

/**
 * The only record which can establish identity during an offline start.
 * `identities` and `clerkIdentities` are retained as inert legacy stores so
 * old databases can be cleared safely, but are never consulted for trust.
 */
export interface OfflineTrustRecord {
  key: 'current';
  state: 'active' | 'revoked';
  /** Monotonic CAS token. Revocation always advances it. */
  revision: number;
  userId: string;
  email: string;
  personId: string;
  clerkUserId: string;
  verifiedAt: string;
}

export const OFFLINE_TRUST_KEY = 'current' as const;
export const OFFLINE_TRUST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const normalizeOfflineTrust = (value: OfflineTrustRecord | undefined): OfflineTrustRecord | undefined => {
  if (!value) return undefined;
  const revision = Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0;
  return { ...value, revision };
};

export function isOfflineTrustUsable(record: OfflineTrustRecord | undefined, now = Date.now()) {
  if (!record || record.state !== 'active') return false;
  if (![record.userId, record.email, record.personId, record.clerkUserId].every((value) => typeof value === 'string' && value.trim().length > 0)) return false;
  const verifiedAt = Date.parse(record.verifiedAt);
  return Number.isFinite(verifiedAt) && now < verifiedAt + OFFLINE_TRUST_MAX_AGE_MS;
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
  historicalParticipants?: HistoricalParticipant[];
  expenses?: Expense[];
  balances?: Record<string, Balances>;
  settlements?: Settlement[];
  transactions?: Transaction[];
  transactionsNextCursor?: string;
  transactionsLimit?: number;
  cachedAt: string;
  cachedAtByResource?: Partial<Record<'group' | 'members' | 'expenses' | 'balances' | 'settlements' | 'transactions', string>>;
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
export interface CachedCategories { userId: string; categories: string[]; fetchedAt: string }

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
    if (!isActivityType(row.type) || !validActivityEntityId(row.id) || row.type.endsWith('_deleted')) return [];
    const settlement = row.type.startsWith('settlement');
    const amountValue = row.amountMinor ?? row.amount_minor ?? row.amount;
    const amount = typeof amountValue === 'number' && Number.isSafeInteger(amountValue) && amountValue >= 0 ? amountValue : null;
    const rawCurrency = typeof row.currency === 'string' && (supportedCurrencies as readonly string[]).includes(row.currency) ? row.currency : null;
    const labelValue = row.label ?? row.description ?? row.note;
    const explicitEntityId = row.entityId ?? row.entity_id;
    const entityId = validActivityEntityId(explicitEntityId) ? explicitEntityId.trim() : row.type === 'expense' ? row.id.trim() : '';
    const parsedEntityActive = activityEntityActive(row.entityActive ?? row.entity_active);
    const expenseEntity = row.type === 'expense' || row.type === 'expense_revision';
    // A revision with an explicit inactive parent belongs to a transaction
    // which has since been deleted. Do not let an old cache resurrect it.
    if (row.type === 'expense_revision' && parsedEntityActive === false) return [];
    // A legacy direct expense row already represents the current entity, so its
    // event ID is a safe fallback for display/refetch. It is not an eligibility
    // assertion: only an explicit active flag can make an expense linkable.
    const entityActive = parsedEntityActive === undefined ? undefined : parsedEntityActive === true && !validActivityEntityId(entityId) ? undefined : Boolean(expenseEntity && parsedEntityActive);
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
      ...(typeof (row.groupId ?? row.group_id) === 'string' ? { groupId: String(row.groupId ?? row.group_id) } : {}),
      ...(typeof (row.groupName ?? row.group_name) === 'string' ? { groupName: String(row.groupName ?? row.group_name) } : {}),
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
  /** Auth epoch which was current when this operation was queued. */
  authEpoch?: number;
}

export interface OutboxOperationScope {
  userId: string;
  expectedAuthEpoch?: number;
  /** Explicit user action may move an auth-required row to the current epoch. */
  rebindAuthEpoch?: number;
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
    request.onupgradeneeded = (event) => {
      const database = request.result;
      // Keep this store and its legacy key intact. Older builds wrote `form` here.
      if (!database.objectStoreNames.contains('recent')) database.createObjectStore('recent');
      if (!database.objectStoreNames.contains('identities')) database.createObjectStore('identities', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('clerkIdentities')) database.createObjectStore('clerkIdentities', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('offlineTrust')) database.createObjectStore('offlineTrust', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('groups')) database.createObjectStore('groups', { keyPath: 'userId' });
      if (!database.objectStoreNames.contains('groupSnapshots')) database.createObjectStore('groupSnapshots', { keyPath: ['userId', 'groupId'] });
      if (!database.objectStoreNames.contains('resourceFreshness')) database.createObjectStore('resourceFreshness', { keyPath: ['userId', 'resourceKey'] });
      if (!database.objectStoreNames.contains('mutationGenerations')) database.createObjectStore('mutationGenerations', { keyPath: 'userId' });
      if (!database.objectStoreNames.contains('activity')) database.createObjectStore('activity', { keyPath: ['userId', 'groupId'] });
      if (!database.objectStoreNames.contains('expenseDetails')) database.createObjectStore('expenseDetails', { keyPath: ['userId', 'expenseId'] });
      if (!database.objectStoreNames.contains('categories')) database.createObjectStore('categories', { keyPath: 'userId' });
      if (!database.objectStoreNames.contains('expenseOutbox')) {
        const store = database.createObjectStore('expenseOutbox', { keyPath: ['userId', 'clientOperationId'] });
        store.createIndex('userId', 'userId', { unique: false });
        store.createIndex('groupId', 'groupId', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      } else if (event.oldVersion < 10) {
        // v9 keyed rows only by operation ID. That allowed an account B row to
        // replace account A's row when a client operation ID was reused. Move
        // the rows to the user-scoped key without dropping pending work.
        const oldStore = request.transaction!.objectStore('expenseOutbox');
        const rows = oldStore.getAll();
        database.deleteObjectStore('expenseOutbox');
        const store = database.createObjectStore('expenseOutbox', { keyPath: ['userId', 'clientOperationId'] });
        store.createIndex('userId', 'userId', { unique: false });
        store.createIndex('groupId', 'groupId', { unique: false });
        store.createIndex('status', 'status', { unique: false });
        rows.onsuccess = () => {
          for (const row of rows.result as ExpenseOutboxItem[]) store.put(row);
        };
      }
      if ((event as IDBVersionChangeEvent).oldVersion < 8 && database.objectStoreNames.contains('activity')) {
        const store = request.transaction?.objectStore('activity');
        const cachedRows = store?.getAll();
        if (store && cachedRows) cachedRows.onsuccess = () => {
          for (const row of cachedRows.result as CachedActivity[]) {
            const activity = normalizeActivity(row.activity);
            if (activity.length) store.put({ ...row, activity });
            else store.delete([row.userId, row.groupId]);
          }
        };
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

/**
 * Persist the complete trust tuple using the revision observed before /me.
 * The read and conditional write are in one readwrite transaction, so a late
 * authoritative response cannot resurrect trust revoked by another tab.
 */
export function saveOfflineTrust(value: Omit<OfflineTrustRecord, 'key' | 'state' | 'revision'>, generation = captureSessionGeneration(), allowed: () => boolean = () => true, expectedRevision = 0) {
  assertSessionGeneration(generation);
  return new Promise<boolean>((resolve, reject) => {
    void open().then((db) => {
      const tx = db.transaction('offlineTrust', 'readwrite');
      const store = tx.objectStore('offlineTrust');
      const current = store.get(OFFLINE_TRUST_KEY);
      let saved = false;
      current.onsuccess = () => {
        const record = normalizeOfflineTrust(current.result as OfflineTrustRecord | undefined);
        if (!isSessionGenerationCurrent(generation) || !allowed() || (record?.revision ?? 0) !== expectedRevision) return;
         store.put({ ...value, key: OFFLINE_TRUST_KEY, state: 'active', revision: expectedRevision + 1 } satisfies OfflineTrustRecord);
        saved = true;
      };
      tx.oncomplete = () => { db.close(); resolve(saved && allowed() && isSessionGenerationCurrent(generation)); };
      tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
      tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    }).catch(reject);
  });
}

export const readOfflineTrust = () => transaction<OfflineTrustRecord>('offlineTrust', 'readonly', (tx) => tx.objectStore('offlineTrust').get(OFFLINE_TRUST_KEY)).then(normalizeOfflineTrust);

/** Revocation intentionally does not use the session-generation guard. */
export function revokeOfflineTrust() {
  return new Promise<boolean>((resolve, reject) => {
    void (async () => {
      const db = await open();
      const tx = db.transaction('offlineTrust', 'readwrite');
      const store = tx.objectStore('offlineTrust');
      const current = store.get(OFFLINE_TRUST_KEY);
      let nextRevision = 1;
      current.onsuccess = () => {
        nextRevision = (normalizeOfflineTrust(current.result as OfflineTrustRecord | undefined)?.revision ?? 0) + 1;
        store.put({ key: OFFLINE_TRUST_KEY, state: 'revoked', revision: nextRevision, userId: '', email: '', personId: '', clerkUserId: '', verifiedAt: new Date().toISOString() } satisfies OfflineTrustRecord);
      };
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
      tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    })().catch(reject);
  });
}

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
export async function invalidateCachedGroups(userId: string, generation = captureSessionGeneration(), options: { activity?: boolean; categories?: boolean; groups?: boolean; groupId?: string; transactions?: boolean; transactionGroupId?: string } = {}) {
  assertSessionGeneration(generation);
  const staleAt = new Date(0).toISOString();
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const stores = [...(options.groups === false ? [] : ['groups', 'resourceFreshness']), ...(options.groupId || options.transactions ? ['groupSnapshots', 'resourceFreshness'] : []), ...(options.groupId ? ['expenseDetails'] : []), 'mutationGenerations', ...(options.activity ? ['activity'] : []), ...(options.categories ? ['categories'] : [])].filter((store, index, all) => all.indexOf(store) === index);
    const tx = db.transaction(stores, 'readwrite');
    const generations = tx.objectStore('mutationGenerations');
    const current = generations.get(userId);
    current.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
      const nextGeneration = ((current.result as MutationGeneration | undefined)?.generation ?? 0) + 1;
      generations.put({ userId, generation: nextGeneration });
      if (options.groups !== false) {
        const groups = tx.objectStore('groups');
        const cached = groups.get(userId);
        cached.onsuccess = () => {
          if (cached.result) {
            const current = cached.result as CachedGroups;
            const groupsValue = options.groupId ? current.groups.filter((group) => group.id !== options.groupId) : current.groups;
            groups.put({ ...current, groups: groupsValue, cachedAt: staleAt });
          }
        };
        tx.objectStore('resourceFreshness').put({ userId, resource: 'groups', resourceKey: 'groups', fetchedAt: staleAt });
      }
      if (options.activity) {
        const activity = tx.objectStore('activity');
        const allActivity = activity.getAll();
        allActivity.onsuccess = () => {
          for (const row of allActivity.result as CachedActivity[]) if (row.userId === userId) activity.delete([row.userId, row.groupId]);
        };
      }
      if (options.categories) tx.objectStore('categories').delete(userId);
      if (options.groupId) {
        tx.objectStore('groupSnapshots').delete([userId, options.groupId]);
        const freshness = tx.objectStore('resourceFreshness').getAll();
        freshness.onsuccess = () => { for (const row of freshness.result as ResourceFreshness[]) if (row.userId === userId && row.resourceKey.startsWith(`group:${options.groupId}:`)) tx.objectStore('resourceFreshness').delete([row.userId, row.resourceKey]); };
        const details = tx.objectStore('expenseDetails').getAll();
        details.onsuccess = () => { for (const row of details.result as CachedExpenseDetails[]) if (row.userId === userId && row.expense?.groupId === options.groupId) tx.objectStore('expenseDetails').delete([row.userId, row.expenseId]); };
      }
      if (options.transactions) {
        const snapshots = tx.objectStore('groupSnapshots').getAll();
        snapshots.onsuccess = () => {
          for (const row of snapshots.result as GroupSnapshot[]) {
            if (row.userId !== userId || (options.transactionGroupId && row.groupId !== options.transactionGroupId)) continue;
            const next = { ...row, transactions: undefined, transactionsNextCursor: undefined, transactionsLimit: undefined, cachedAtByResource: { ...row.cachedAtByResource, transactions: staleAt } };
            tx.objectStore('groupSnapshots').put(next);
            tx.objectStore('resourceFreshness').put({ userId, resource: 'transactions', resourceKey: `group:${row.groupId}:transactions`, fetchedAt: staleAt });
          }
        };
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

type GroupSnapshotPatch = Omit<Partial<GroupSnapshot>, 'userId' | 'groupId' | 'cachedAt'> & { cachedAt?: string };
const transactionResourceNames = ['group', 'members', 'expenses', 'balances', 'settlements', 'transactions'] as const;
const preserveLargerTransactionPage = (current: GroupSnapshot | undefined, patch: GroupSnapshotPatch) => {
  const currentLimit = current?.transactionsLimit;
  const incomingLimit = patch.transactionsLimit;
  return patch.transactions !== undefined && currentLimit !== undefined
    && (incomingLimit === undefined || incomingLimit < currentLimit);
};
const mergeGroupSnapshotPatch = (current: GroupSnapshot | undefined, patch: GroupSnapshotPatch): { patch: Partial<GroupSnapshot>; transactionChanged: boolean } => {
  if (!preserveLargerTransactionPage(current, patch)) return { patch, transactionChanged: patch.transactions !== undefined };
  const { transactions: _transactions, transactionsNextCursor: _transactionsNextCursor, transactionsLimit: _transactionsLimit, ...rest } = patch;
  return { patch: rest, transactionChanged: false };
};

export async function updateGroupSnapshot(userId: string, groupId: string, patch: GroupSnapshotPatch, generation = captureSessionGeneration()) {
  assertSessionGeneration(generation);
  const db = await open();
  return new Promise<GroupSnapshot>((resolve, reject) => {
    const tx = db.transaction(['groupSnapshots', 'resourceFreshness'], 'readwrite');
    const store = tx.objectStore('groupSnapshots');
    const request = store.get([userId, groupId]);
    let next: GroupSnapshot;
    request.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
      const merged = mergeGroupSnapshotPatch(request.result as GroupSnapshot | undefined, patch);
      const resources = transactionResourceNames.filter((resource) => merged.patch[resource] !== undefined && (resource !== 'transactions' || merged.transactionChanged));
      const fetchedAt = patch.cachedAt || new Date().toISOString();
      next = { ...(request.result as GroupSnapshot | undefined), ...merged.patch, userId, groupId, cachedAt: fetchedAt, cachedAtByResource: { ...(request.result as GroupSnapshot | undefined)?.cachedAtByResource, ...Object.fromEntries(resources.map((resource) => [resource, fetchedAt])) } };
      store.put(next);
      for (const resource of resources) tx.objectStore('resourceFreshness').put({ userId, resource, resourceKey: `group:${groupId}:${resource}`, fetchedAt });
    };
    tx.oncomplete = () => { db.close(); resolve(next); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

/**
 * Persist a response only when no mutation invalidated the resource after the
 * request started. The generation read and snapshot write share one
 * readwrite transaction, so an invalidation either wins before this check or
 * runs after this write and removes the stale snapshot.
 */
export async function updateGroupSnapshotIfGenerationMatches(userId: string, groupId: string, patch: GroupSnapshotPatch, mutationGeneration: number, generation = captureSessionGeneration()) {
  if (!isSessionGenerationCurrent(generation)) return false;
  const db = await open();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(['groupSnapshots', 'resourceFreshness', 'mutationGenerations'], 'readwrite');
    const currentGeneration = tx.objectStore('mutationGenerations').get(userId);
    const snapshots = tx.objectStore('groupSnapshots');
    let saved = false;
    currentGeneration.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation) || ((currentGeneration.result as MutationGeneration | undefined)?.generation ?? 0) !== mutationGeneration) return;
      const currentSnapshot = snapshots.get([userId, groupId]);
      currentSnapshot.onsuccess = () => {
        if (!isSessionGenerationCurrent(generation)) return;
        const merged = mergeGroupSnapshotPatch(currentSnapshot.result as GroupSnapshot | undefined, patch);
        const resources = transactionResourceNames.filter((resource) => merged.patch[resource] !== undefined && (resource !== 'transactions' || merged.transactionChanged));
        const fetchedAt = patch.cachedAt || new Date().toISOString();
        const next = { ...(currentSnapshot.result as GroupSnapshot | undefined), ...merged.patch, userId, groupId, cachedAt: fetchedAt, cachedAtByResource: { ...(currentSnapshot.result as GroupSnapshot | undefined)?.cachedAtByResource, ...Object.fromEntries(resources.map((resource) => [resource, fetchedAt])) } } satisfies GroupSnapshot;
        snapshots.put(next);
        for (const resource of resources) tx.objectStore('resourceFreshness').put({ userId, resource, resourceKey: `group:${groupId}:${resource}`, fetchedAt });
        saved = true;
      };
    };
    tx.oncomplete = () => { db.close(); resolve(saved); };
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

export const saveActivity = (value: CachedActivity, generation = captureSessionGeneration(), mutationGeneration?: number) => {
  assertSessionGeneration(generation);
  if (mutationGeneration === undefined) return transaction('activity', 'readwrite', (tx) => { if (isSessionGenerationCurrent(generation)) tx.objectStore('activity').put({ ...value, activity: normalizeActivity(value.activity) }); });
  return new Promise<boolean>((resolve, reject) => {
    void open().then((db) => {
      const tx = db.transaction(['activity', 'mutationGenerations'], 'readwrite');
      const current = tx.objectStore('mutationGenerations').get(value.userId);
      let saved = false;
      current.onsuccess = () => {
        if (!isSessionGenerationCurrent(generation) || ((current.result as MutationGeneration | undefined)?.generation ?? 0) !== mutationGeneration) return;
        tx.objectStore('activity').put({ ...value, activity: normalizeActivity(value.activity) });
        saved = true;
      };
      tx.oncomplete = () => { db.close(); resolve(saved); };
      tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
      tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    }).catch(reject);
  });
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
export const saveCategories = (value: CachedCategories, generation = captureSessionGeneration(), mutationGeneration?: number) => {
  assertSessionGeneration(generation);
  if (mutationGeneration === undefined) return transaction('categories', 'readwrite', (tx) => { if (isSessionGenerationCurrent(generation)) tx.objectStore('categories').put(value); });
  return new Promise<boolean>((resolve, reject) => {
    void open().then((db) => {
      const tx = db.transaction(['categories', 'mutationGenerations'], 'readwrite');
      const current = tx.objectStore('mutationGenerations').get(value.userId);
      let saved = false;
      current.onsuccess = () => {
        if (!isSessionGenerationCurrent(generation) || ((current.result as MutationGeneration | undefined)?.generation ?? 0) !== mutationGeneration) return;
        tx.objectStore('categories').put(value);
        saved = true;
      };
      tx.oncomplete = () => { db.close(); resolve(saved); };
      tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
      tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    }).catch(reject);
  });
};
export const readCategories = (userId: string) => transaction<CachedCategories>('categories', 'readonly', (tx) => tx.objectStore('categories').get(userId));

/** Remove private cached data without touching the durable expense outbox. */
export async function clearCachedData() {
  await transaction(['recent', 'identities', 'clerkIdentities', 'offlineTrust', 'groups', 'groupSnapshots', 'resourceFreshness', 'mutationGenerations', 'activity', 'expenseDetails', 'categories'], 'readwrite', (tx) => {
    for (const storeName of ['recent', 'identities', 'clerkIdentities', 'offlineTrust', 'groups', 'groupSnapshots', 'resourceFreshness', 'mutationGenerations', 'activity', 'expenseDetails', 'categories']) tx.objectStore(storeName).clear();
  });
}

/** Remove every private record, including expenses waiting to sync. */
export async function clearAllPrivateData() {
  await transaction(['recent', 'identities', 'clerkIdentities', 'offlineTrust', 'groups', 'groupSnapshots', 'resourceFreshness', 'mutationGenerations', 'activity', 'expenseDetails', 'categories', 'expenseOutbox'], 'readwrite', (tx) => {
    for (const storeName of ['recent', 'identities', 'clerkIdentities', 'offlineTrust', 'groups', 'groupSnapshots', 'resourceFreshness', 'mutationGenerations', 'activity', 'expenseDetails', 'categories', 'expenseOutbox']) tx.objectStore(storeName).clear();
  });
}

export const saveOutboxItem = async (item: ExpenseOutboxItem, generation = captureSessionGeneration(), expectedAuthEpoch?: number, allowed: () => boolean = () => true) => {
  assertSessionGeneration(generation);
  let saved = false;
  await transaction('expenseOutbox', 'readwrite', (tx) => { if (isSessionGenerationCurrent(generation) && allowed() && (expectedAuthEpoch === undefined || item.authEpoch === expectedAuthEpoch)) { tx.objectStore('expenseOutbox').put({ ...item, authEpoch: item.authEpoch ?? 0 }); saved = true; } });
  return saved;
};
export async function readOutboxItem(clientOperationId: string, scope?: OutboxOperationScope): Promise<ExpenseOutboxItem | undefined> {
  if (scope) {
    const item = await transaction<ExpenseOutboxItem>('expenseOutbox', 'readonly', (tx) => tx.objectStore('expenseOutbox').get([scope.userId, clientOperationId]));
    return item && (scope.expectedAuthEpoch === undefined || item.authEpoch === scope.expectedAuthEpoch) ? item : undefined;
  }
  // Compatibility for callers which predate user-scoped operation keys. New
  // mutation paths always pass a scope and therefore cannot read another user.
  const all = await transaction<ExpenseOutboxItem[]>('expenseOutbox', 'readonly', (tx) => tx.objectStore('expenseOutbox').getAll());
  return (all || []).find((item) => item.clientOperationId === clientOperationId);
}

export async function listOutbox(userId?: string): Promise<ExpenseOutboxItem[]> {
  const all = await transaction<ExpenseOutboxItem[]>('expenseOutbox', 'readonly', (tx) => tx.objectStore('expenseOutbox').getAll());
  return (all || []).filter((item) => !userId || item.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}


export async function recoverStaleSyncing(userId?: string, expectedAuthEpoch?: number, rebindAuthEpoch?: number, allowed: () => boolean = () => true) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.getAll();
      request.onsuccess = () => {
        if (!allowed()) return;
        const now = Date.now();
        for (const item of request.result as ExpenseOutboxItem[]) {
          if ((!userId || item.userId === userId) && (expectedAuthEpoch === undefined || item.authEpoch === expectedAuthEpoch) && item.status === 'syncing' && (!item.leaseExpiresAt || item.leaseExpiresAt <= now)) store.put({ ...item, ...(rebindAuthEpoch === undefined ? {} : { authEpoch: rebindAuthEpoch }), status: 'pending', leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: new Date().toISOString() });
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

/** Atomically claims a pending or expired-syncing row for one browser tab. */
export async function claimOutboxItem(clientOperationId: string, owner: string, now = Date.now(), leaseMs = 30_000, generation = captureSessionGeneration(), scope?: OutboxOperationScope): Promise<ExpenseOutboxItem | undefined> {
  assertSessionGeneration(generation);
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
     const request = scope ? store.get([scope.userId, clientOperationId]) : store.getAll();
    let claimed: ExpenseOutboxItem | undefined;
    request.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
       const item = (scope ? request.result : (request.result as ExpenseOutboxItem[] | undefined)?.find((candidate) => candidate.clientOperationId === clientOperationId)) as ExpenseOutboxItem | undefined;
       if (scope && (!item || item.userId !== scope.userId || (scope.expectedAuthEpoch !== undefined && item.authEpoch !== scope.expectedAuthEpoch))) return;
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

export async function updateOutboxIfOwned(clientOperationId: string, owner: string, patch: Partial<ExpenseOutboxItem>, now = Date.now(), generation = captureSessionGeneration(), scope?: OutboxOperationScope): Promise<ExpenseOutboxItem | undefined> {
  assertSessionGeneration(generation);
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
     const request = scope ? store.get([scope.userId, clientOperationId]) : store.getAll();
    let updated: ExpenseOutboxItem | undefined;
    request.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
       const item = (scope ? request.result : (request.result as ExpenseOutboxItem[] | undefined)?.find((candidate) => candidate.clientOperationId === clientOperationId)) as ExpenseOutboxItem | undefined;
       if (!item || (scope && (item.userId !== scope.userId || (scope.expectedAuthEpoch !== undefined && item.authEpoch !== scope.expectedAuthEpoch))) || item.leaseOwner !== owner || (item.leaseExpiresAt !== undefined && item.leaseExpiresAt <= now)) return;
       updated = { ...item, ...(scope?.rebindAuthEpoch === undefined ? {} : { authEpoch: scope.rebindAuthEpoch }), ...patch, updatedAt: new Date(now).toISOString() };
      store.put(updated);
    };
    tx.oncomplete = () => { db.close(); resolve(updated); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

/** Release a claim only when it is still the exact lease which was claimed. */
export async function releaseOutboxClaimIfOwned(clientOperationId: string, owner: string, leaseExpiresAt: number, attempts: number, now = Date.now(), generation = captureSessionGeneration(), scope?: OutboxOperationScope): Promise<ExpenseOutboxItem | undefined> {
  assertSessionGeneration(generation);
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = scope ? store.get([scope.userId, clientOperationId]) : store.getAll();
    let released: ExpenseOutboxItem | undefined;
    request.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
      const item = (scope ? request.result : (request.result as ExpenseOutboxItem[] | undefined)?.find((candidate) => candidate.clientOperationId === clientOperationId)) as ExpenseOutboxItem | undefined;
      if (!item || (scope && (item.userId !== scope.userId || (scope.expectedAuthEpoch !== undefined && item.authEpoch !== scope.expectedAuthEpoch))) || item.status !== 'syncing' || item.leaseOwner !== owner || item.leaseExpiresAt !== leaseExpiresAt || item.attempts !== attempts || leaseExpiresAt <= now) return;
       released = { ...item, ...(scope?.rebindAuthEpoch === undefined ? {} : { authEpoch: scope.rebindAuthEpoch }), status: 'pending', leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: new Date(now).toISOString() };
      store.put(released);
    };
    tx.oncomplete = () => { db.close(); resolve(released); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function removeOutboxIfOwned(clientOperationId: string, owner: string, now = Date.now(), generation = captureSessionGeneration(), scope?: OutboxOperationScope): Promise<boolean> {
  assertSessionGeneration(generation);
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
     const request = scope ? store.get([scope.userId, clientOperationId]) : store.getAll();
    let removed = false;
    request.onsuccess = () => {
      if (!isSessionGenerationCurrent(generation)) return;
       const item = (scope ? request.result : (request.result as ExpenseOutboxItem[] | undefined)?.find((candidate) => candidate.clientOperationId === clientOperationId)) as ExpenseOutboxItem | undefined;
       if (!item || (scope && (item.userId !== scope.userId || (scope.expectedAuthEpoch !== undefined && item.authEpoch !== scope.expectedAuthEpoch))) || item.leaseOwner !== owner || (item.leaseExpiresAt !== undefined && item.leaseExpiresAt <= now)) return;
       store.delete([item.userId, item.clientOperationId]); removed = true;
    };
    tx.oncomplete = () => { db.close(); resolve(removed); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function discardOutboxIfIdle(clientOperationId: string, now = Date.now(), scope?: OutboxOperationScope): Promise<boolean> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
     const request = scope ? store.get([scope.userId, clientOperationId]) : store.getAll();
    let removed = false;
    request.onsuccess = () => {
       const item = (scope ? request.result : (request.result as ExpenseOutboxItem[] | undefined)?.find((candidate) => candidate.clientOperationId === clientOperationId)) as ExpenseOutboxItem | undefined;
       if (!item || (scope && (item.userId !== scope.userId || (scope.expectedAuthEpoch !== undefined && item.authEpoch !== scope.expectedAuthEpoch))) || item.deliveryUncertain || (item.status === 'syncing' && item.leaseExpiresAt !== undefined && item.leaseExpiresAt > now)) return;
       store.delete([item.userId, item.clientOperationId]); removed = true;
    };
    tx.oncomplete = () => { db.close(); resolve(removed); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function resetOutboxIfIdle(clientOperationId: string, now = Date.now(), scope?: OutboxOperationScope): Promise<ExpenseOutboxItem | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
     const request = scope ? store.get([scope.userId, clientOperationId]) : store.getAll();
    let updated: ExpenseOutboxItem | undefined;
    request.onsuccess = () => {
       const item = (scope ? request.result : (request.result as ExpenseOutboxItem[] | undefined)?.find((candidate) => candidate.clientOperationId === clientOperationId)) as ExpenseOutboxItem | undefined;
       if (!item || (scope && (item.userId !== scope.userId || (scope.expectedAuthEpoch !== undefined && item.authEpoch !== scope.expectedAuthEpoch))) || (item.status === 'syncing' && item.leaseExpiresAt !== undefined && item.leaseExpiresAt > now)) return;
       updated = { ...item, ...(scope?.rebindAuthEpoch === undefined ? {} : { authEpoch: scope.rebindAuthEpoch }), status: 'pending', deliveryUncertain: item.deliveryUncertain === true, leaseOwner: undefined, leaseExpiresAt: undefined, lastError: undefined, updatedAt: new Date(now).toISOString() };
      store.put(updated);
    };
    tx.oncomplete = () => { db.close(); resolve(updated); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function reactivateAuthRequired(userId: string, allowed: () => boolean = () => true, authEpoch?: number) {
  const db = await open();
  let changed = 0;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.getAll();
     request.onsuccess = () => { if (!allowed()) return; for (const item of request.result as ExpenseOutboxItem[]) if (item.userId === userId && item.status === 'auth-required') { store.put({ ...item, authEpoch: authEpoch ?? item.authEpoch ?? 0, status: 'pending', lastError: undefined, updatedAt: new Date().toISOString() }); changed += 1; } };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
  return changed;
}

/** Rebind durable unsent work to a newly verified auth epoch. Active leases
 * remain untouched; their existing lease/expiry rules own stale syncing rows. */
export async function rebindOutboxAuthEpoch(userId: string, authEpoch: number, allowed: () => boolean = () => true) {
  const db = await open();
  let changed = 0;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.getAll();
    request.onsuccess = () => {
      if (!allowed()) return;
      for (const item of request.result as ExpenseOutboxItem[]) {
        if (item.userId !== userId || (item.status !== 'pending' && item.status !== 'auth-required' && item.status !== 'failed') || item.authEpoch === authEpoch) continue;
        store.put({ ...item, authEpoch, updatedAt: new Date().toISOString() });
        changed += 1;
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
  return changed;
}

export async function markOutboxAuthRequired(userId: string, lastError: ExpenseOutboxItem['lastError'], expectedAuthEpoch?: number) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.getAll();
     request.onsuccess = () => { for (const item of request.result as ExpenseOutboxItem[]) if (item.userId === userId && item.status === 'pending' && (expectedAuthEpoch === undefined || item.authEpoch === expectedAuthEpoch)) store.put({ ...item, status: 'auth-required', lastError, updatedAt: new Date().toISOString() }); };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export async function reconcileOutboxItems(userId: string, groupId: string, expenses: Array<Pick<Expense, 'groupId' | 'createdBy'> & { clientOperationId?: string | null }>, generation = captureSessionGeneration(), expectedAuthEpoch?: number) {
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
       for (const item of request.result as ExpenseOutboxItem[]) if (item.userId === userId && item.groupId === groupId && operations.has(item.clientOperationId) && (expectedAuthEpoch === undefined || item.authEpoch === expectedAuthEpoch)) { store.delete([item.userId, item.clientOperationId]); removed += 1; }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
  return removed;
}
