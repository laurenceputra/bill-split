import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearCachedData, DB_NAME, DB_VERSION, listOutbox, readActivity, readExpenseDetails, readGroupSnapshot, readRecent, readResourceFreshness, recoverStaleSyncing, saveActivity, saveExpenseDetails, saveGroups, saveOutboxItem, saveRecent, saveVerifiedIdentity, updateGroupSnapshot } from './idb';

const user = (userId: string) => ({ userId, email: `${userId}@example.com`, personId: `person-${userId}`, verifiedAt: new Date().toISOString() });
const expense = (operation: string, userId = 'user-a') => ({ clientOperationId: operation, userId, groupId: 'group-a', payload: { description: 'Lunch', amount_minor: 100, currency: 'USD' as const, date: '2026-01-01', payers: [{ person_id: 'person-a', amount_minor: 100 }], splits: [{ person_id: 'person-a', amount_minor: 100 }], client_operation_id: operation }, display: { description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'syncing' as const, attempts: 1 });

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(DB_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => resolve(); });
});

describe('user-scoped IndexedDB', () => {
  it('upgrades without losing the legacy recent store', async () => {
    const old = indexedDB.open(DB_NAME, 1);
    await new Promise<void>((resolve, reject) => { old.onupgradeneeded = () => old.result.createObjectStore('recent'); old.onsuccess = () => { const tx = old.result.transaction('recent', 'readwrite'); tx.objectStore('recent').put({ choice: 'USD' }, 'form'); tx.oncomplete = () => { old.result.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; old.onerror = () => reject(old.error); });
    await saveVerifiedIdentity(user('user-a'));
    expect(await readRecent<{ choice: string }>()).toEqual({ choice: 'USD' });
    const upgraded = indexedDB.open(DB_NAME, DB_VERSION);
    await new Promise<void>((resolve, reject) => { upgraded.onsuccess = () => { expect(upgraded.result.objectStoreNames.contains('expenseOutbox')).toBe(true); expect(upgraded.result.objectStoreNames.contains('resourceFreshness')).toBe(true); expect(upgraded.result.objectStoreNames.contains('activity')).toBe(true); expect(upgraded.result.objectStoreNames.contains('expenseDetails')).toBe(true); upgraded.result.close(); resolve(); }; upgraded.onerror = () => reject(upgraded.error); });
  });

  it('migrates a version three database without losing an outbox row', async () => {
    const old = indexedDB.open(DB_NAME, 3);
    await new Promise<void>((resolve, reject) => {
      old.onupgradeneeded = () => {
        const database = old.result;
        database.createObjectStore('recent'); database.createObjectStore('identities', { keyPath: 'key' }); database.createObjectStore('groups', { keyPath: 'userId' }); database.createObjectStore('groupSnapshots', { keyPath: ['userId', 'groupId'] });
        const store = database.createObjectStore('expenseOutbox', { keyPath: 'clientOperationId' }); store.createIndex('userId', 'userId'); store.createIndex('groupId', 'groupId'); store.createIndex('status', 'status');
      };
      old.onsuccess = () => { const tx = old.result.transaction('expenseOutbox', 'readwrite'); tx.objectStore('expenseOutbox').put(expense('v3-row')); tx.oncomplete = () => { old.result.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
      old.onerror = () => reject(old.error);
    });
    await saveVerifiedIdentity(user('user-a'));
    expect((await listOutbox('user-a')).map((item) => item.clientOperationId)).toEqual(['v3-row']);
  });

  it('does not return another user’s groups or snapshots', async () => {
    await saveGroups({ userId: 'user-a', groups: [], cachedAt: 'a' });
    await saveGroups({ userId: 'user-b', groups: [{ id: 'group-b', name: 'B', currency: 'USD', createdAt: '', updatedAt: '' }], cachedAt: 'b' });
    await updateGroupSnapshot('user-b', 'group-b', { members: [] });
    expect((await readGroupSnapshot('user-a', 'group-b'))).toBeUndefined();
    expect((await readGroupSnapshot('user-b', 'group-b'))?.groupId).toBe('group-b');
  });

  it('recovers stale syncing items without discarding them', async () => {
    await saveOutboxItem(expense('stale'));
    await recoverStaleSyncing();
    expect((await listOutbox('user-a'))[0].status).toBe('pending');
  });

  it('clears private caches while preserving the outbox', async () => {
    await saveVerifiedIdentity(user('user-a'));
    await saveGroups({ userId: 'user-a', groups: [], cachedAt: 'a' });
    await updateGroupSnapshot('user-a', 'group-a', { members: [] });
    await saveRecent({ choice: 'USD' });
    await saveOutboxItem(expense('keep'));
    await clearCachedData();
    expect(await readRecent()).toBeUndefined();
    expect(await readGroupSnapshot('user-a', 'group-a')).toBeUndefined();
    expect(await listOutbox('user-a')).toHaveLength(1);
  });

  it('preserves resource-specific freshness and persists activity and details', async () => {
    const timestamp = new Date().toISOString();
    await updateGroupSnapshot('user-a', 'group-a', { group: { id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '' }, cachedAt: timestamp });
    await updateGroupSnapshot('user-a', 'group-a', { balances: {}, cachedAt: 'balances-time' });
    expect((await readResourceFreshness('user-a', 'group:group-a:group'))?.fetchedAt).toBe(timestamp);
    expect((await readResourceFreshness('user-a', 'group:group-a:balances'))?.fetchedAt).toBe('balances-time');
    await saveActivity({ userId: 'user-a', groupId: 'group-a', activity: [{ type: 'expense', id: 'e-1', label: 'Lunch', createdAt: timestamp }], fetchedAt: timestamp });
    await saveExpenseDetails({ userId: 'user-a', expenseId: 'e-1', expense: { id: 'e-1', groupId: 'group-a', description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01', createdBy: 'user-a', createdAt: timestamp, updatedAt: timestamp, version: 1, payers: [], splits: [] }, history: [], fetchedAt: timestamp });
    expect((await readActivity('user-a', 'group-a'))?.activity[0].label).toBe('Lunch');
    expect((await readExpenseDetails('user-a', 'e-1'))?.expense.id).toBe('e-1');
  });
});
