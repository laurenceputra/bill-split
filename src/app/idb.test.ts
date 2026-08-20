import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB_NAME, DB_VERSION, listOutbox, readGroupSnapshot, readRecent, recoverStaleSyncing, saveGroups, saveOutboxItem, saveRecent, saveVerifiedIdentity, updateGroupSnapshot } from './idb';

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
    await new Promise<void>((resolve, reject) => { upgraded.onsuccess = () => { expect(upgraded.result.objectStoreNames.contains('expenseOutbox')).toBe(true); upgraded.result.close(); resolve(); }; upgraded.onerror = () => reject(upgraded.error); });
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
});
