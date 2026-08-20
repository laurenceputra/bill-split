import type { Balances, Expense, Group, GroupMember, Settlement } from '../shared/types';
import type { ExpenseInput } from '../shared/schemas';

export const DB_NAME = 'bill-split-local';
export const DB_VERSION = 3;

export type OutboxStatus = 'pending' | 'syncing' | 'auth-required' | 'failed';

export interface VerifiedIdentity {
  key: 'last';
  userId: string;
  email: string;
  personId: string;
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
      if (!database.objectStoreNames.contains('groups')) database.createObjectStore('groups', { keyPath: 'userId' });
      if (!database.objectStoreNames.contains('groupSnapshots')) database.createObjectStore('groupSnapshots', { keyPath: ['userId', 'groupId'] });
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

export async function saveRecent(value: unknown) {
  await transaction('recent', 'readwrite', (tx) => tx.objectStore('recent').put(value, 'form'));
}

export async function readRecent<T>(): Promise<T | undefined> {
  return transaction<T>('recent', 'readonly', (tx) => tx.objectStore('recent').get('form'));
}

export const saveVerifiedIdentity = (value: Omit<VerifiedIdentity, 'key'>) => transaction('identities', 'readwrite', (tx) => tx.objectStore('identities').put({ ...value, key: 'last' }));
export const readLastVerifiedIdentity = () => transaction<VerifiedIdentity>('identities', 'readonly', (tx) => tx.objectStore('identities').get('last'));

export const saveGroups = (value: CachedGroups) => transaction('groups', 'readwrite', (tx) => tx.objectStore('groups').put(value));
export const readGroups = (userId: string) => transaction<CachedGroups>('groups', 'readonly', (tx) => tx.objectStore('groups').get(userId));

export async function updateGroupSnapshot(userId: string, groupId: string, patch: Omit<Partial<GroupSnapshot>, 'userId' | 'groupId' | 'cachedAt'> & { cachedAt?: string }) {
  const db = await open();
  return new Promise<GroupSnapshot>((resolve, reject) => {
    const tx = db.transaction('groupSnapshots', 'readwrite');
    const store = tx.objectStore('groupSnapshots');
    const request = store.get([userId, groupId]);
    let next: GroupSnapshot;
    request.onsuccess = () => {
      next = { ...(request.result as GroupSnapshot | undefined), ...patch, userId, groupId, cachedAt: patch.cachedAt || new Date().toISOString() };
      store.put(next);
    };
    tx.oncomplete = () => { db.close(); resolve(next); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
}

export const readGroupSnapshot = (userId: string, groupId: string) => transaction<GroupSnapshot>('groupSnapshots', 'readonly', (tx) => tx.objectStore('groupSnapshots').get([userId, groupId]));

export const saveOutboxItem = (item: ExpenseOutboxItem) => transaction('expenseOutbox', 'readwrite', (tx) => tx.objectStore('expenseOutbox').put(item));
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
export async function claimOutboxItem(clientOperationId: string, owner: string, now = Date.now(), leaseMs = 30_000): Promise<ExpenseOutboxItem | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.get(clientOperationId);
    let claimed: ExpenseOutboxItem | undefined;
    request.onsuccess = () => {
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

export async function updateOutboxIfOwned(clientOperationId: string, owner: string, patch: Partial<ExpenseOutboxItem>, now = Date.now()): Promise<ExpenseOutboxItem | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.get(clientOperationId);
    let updated: ExpenseOutboxItem | undefined;
    request.onsuccess = () => {
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

export async function removeOutboxIfOwned(clientOperationId: string, owner: string, now = Date.now()): Promise<boolean> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.get(clientOperationId);
    let removed = false;
    request.onsuccess = () => {
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

export async function reconcileOutboxItems(userId: string, groupId: string, expenses: Expense[]) {
  const operations = new Set(expenses.filter((expense) => expense.groupId === groupId && expense.createdBy === userId && expense.clientOperationId).map((expense) => expense.clientOperationId));
  if (!operations.size) return 0;
  const db = await open();
  let removed = 0;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('expenseOutbox', 'readwrite');
    const store = tx.objectStore('expenseOutbox');
    const request = store.getAll();
    request.onsuccess = () => {
      for (const item of request.result as ExpenseOutboxItem[]) if (item.userId === userId && item.groupId === groupId && operations.has(item.clientOperationId)) { store.delete(item.clientOperationId); removed += 1; }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
    tx.onabort = () => { db.close(); reject(tx.error || new IndexedDBUnavailableError()); };
  });
  return removed;
}
