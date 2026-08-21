import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllPrivateData, clearCachedData, DB_NAME, DB_VERSION, invalidateCachedGroups, listOutbox, readActivity, readCategories, readExpenseDetails, readGroupSnapshot, readGroups, readLastVerifiedClerkUserId, readMutationGeneration, readRecent, readResourceFreshness, recoverStaleSyncing, saveActivity, saveCategories, saveExpenseDetails, saveGroups, saveLastVerifiedClerkUserId, saveOutboxItem, saveRecent, saveVerifiedIdentity, updateGroupSnapshot } from './idb';
import { hydrateActivity } from './api';

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
    await new Promise<void>((resolve, reject) => { upgraded.onsuccess = () => { expect(upgraded.result.objectStoreNames.contains('expenseOutbox')).toBe(true); expect(upgraded.result.objectStoreNames.contains('resourceFreshness')).toBe(true); expect(upgraded.result.objectStoreNames.contains('activity')).toBe(true); expect(upgraded.result.objectStoreNames.contains('expenseDetails')).toBe(true); expect(upgraded.result.objectStoreNames.contains('clerkIdentities')).toBe(true); upgraded.result.close(); resolve(); }; upgraded.onerror = () => reject(upgraded.error); });
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

  it('clears the identity and outbox together for destructive logout', async () => {
    await saveVerifiedIdentity(user('user-a'));
    await saveLastVerifiedClerkUserId('clerk-user-a');
    await saveOutboxItem(expense('delete-me'));
    await invalidateCachedGroups('user-a');
    await clearAllPrivateData();
    expect(await readGroups('user-a')).toBeUndefined();
    expect(await readMutationGeneration('user-a')).toBe(0);
    expect(await listOutbox('user-a')).toEqual([]);
    expect(await readLastVerifiedClerkUserId()).toBeUndefined();
  });

  it('preserves resource-specific freshness and persists activity and details', async () => {
    const timestamp = new Date().toISOString();
    await updateGroupSnapshot('user-a', 'group-a', { group: { id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '' }, cachedAt: timestamp });
    await updateGroupSnapshot('user-a', 'group-a', { balances: {}, cachedAt: 'balances-time' });
    expect((await readResourceFreshness('user-a', 'group:group-a:group'))?.fetchedAt).toBe(timestamp);
    expect((await readResourceFreshness('user-a', 'group:group-a:balances'))?.fetchedAt).toBe('balances-time');
    await saveActivity({ userId: 'user-a', groupId: 'group-a', activity: [{ type: 'expense', id: 'e-1', entityId: 'e-1', entityActive: true, amountMinor: 100, currency: 'USD', transactionDate: '2026-01-01', label: 'Lunch', createdAt: timestamp }], fetchedAt: timestamp });
    await saveExpenseDetails({ userId: 'user-a', expenseId: 'e-1', expense: { id: 'e-1', groupId: 'group-a', description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01', createdBy: 'user-a', createdAt: timestamp, updatedAt: timestamp, version: 1, payers: [], splits: [] }, history: [], fetchedAt: timestamp });
    expect((await readActivity('user-a', 'group-a'))?.activity[0].label).toBe('Lunch');
    expect((await readExpenseDetails('user-a', 'e-1'))?.expense.id).toBe('e-1');
  });

  it('persists home balance summaries without requiring an IndexedDB migration', async () => {
    await saveGroups({ userId: 'user-a', groups: [{ id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '', balanceSummaries: [{ currency: 'EUR', netMinor: -250 }] }], cachedAt: 'summary-time' });
    expect((await readGroups('user-a'))?.groups[0].balanceSummaries).toEqual([{ currency: 'EUR', netMinor: -250 }]);
  });

  it('expires persisted home groups without discarding offline summaries', async () => {
    await saveGroups({ userId: 'user-a', groups: [{ id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '', balanceSummaries: [{ currency: 'USD', netMinor: 500 }] }], cachedAt: new Date().toISOString() });
    await invalidateCachedGroups('user-a');
    expect((await readGroups('user-a'))?.groups[0].balanceSummaries).toEqual([{ currency: 'USD', netMinor: 500 }]);
    expect((await readGroups('user-a'))?.cachedAt).toBe('1970-01-01T00:00:00.000Z');
    expect((await readResourceFreshness('user-a', 'groups'))?.fetchedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('deletes persisted activity and category caches when a mutation invalidates them', async () => {
    const timestamp = new Date().toISOString();
    await saveGroups({ userId: 'user-a', groups: [], cachedAt: timestamp });
    await saveActivity({ userId: 'user-a', groupId: 'group-a', activity: [], fetchedAt: timestamp });
    await saveActivity({ userId: 'user-a', groupId: 'all', activity: [], fetchedAt: timestamp });
    await saveCategories({ userId: 'user-a', categories: ['Dining'], fetchedAt: timestamp });

    await invalidateCachedGroups('user-a', undefined, { activity: true, categories: true });

    expect(await readActivity('user-a', 'group-a')).toBeUndefined();
    expect(await readActivity('user-a', 'all')).toBeUndefined();
    expect(await readCategories('user-a')).toBeUndefined();
    expect(await readMutationGeneration('user-a')).toBe(1);
  });

  it('normalizes legacy activity rows without entity fields during cache hydration', async () => {
    const timestamp = new Date().toISOString();
    await saveActivity({ userId: 'user-a', groupId: 'group-a', activity: [{ type: 'expense', id: 'legacy-event', label: 'Old lunch', createdAt: timestamp } as never], fetchedAt: timestamp });
    const cached = await readActivity('user-a', 'group-a');
    expect(cached?.activity[0]).toMatchObject({ id: 'legacy-event', label: 'Old lunch', entityId: 'legacy-event', entityActive: undefined, amountMinor: null, currency: null, transactionDate: '' });
    const hydrated = await hydrateActivity('user-a', 'group-a');
    expect(hydrated?.data.activity[0].entityId).toBe('legacy-event');
    expect(hydrated?.fetchedAt).toBe(0);
  });

  it('normalizes active flags while filtering deleted activity and keeping settlements non-linkable', async () => {
    const timestamp = new Date().toISOString();
    await saveActivity({ userId: 'user-a', groupId: 'group-a', activity: [
      { type: 'expense', id: 'expense-1', entityId: 'expense-1', entityActive: true, amountMinor: 100, currency: 'USD', transactionDate: '', label: 'Current', createdAt: timestamp },
      { type: 'expense_revision', id: 'revision-active', entityId: 'expense-1', entity_active: 1, amountMinor: 100, currency: 'USD', transactionDate: '', label: 'Edited', createdAt: timestamp } as never,
      { type: 'expense_deleted', id: 'revision-deleted', entityId: 'expense-2', entityActive: false, amountMinor: 100, currency: 'USD', transactionDate: '', label: 'Deleted', createdAt: timestamp },
      { type: 'expense_revision', id: 'revision-old', entityId: 'expense-2', entity_active: false, amountMinor: 100, currency: 'USD', transactionDate: '', label: 'Old edit', createdAt: timestamp } as never,
      { type: 'settlement', id: 'settlement-1', entityId: 'settlement-1', entityActive: true, amountMinor: 100, currency: 'USD', transactionDate: '', label: 'Paid', createdAt: timestamp, fromName: 'A', toName: 'B' },
      { type: 'expense_revision', id: 'revision-unknown', entityActive: true, amountMinor: 100, currency: 'USD', transactionDate: '', label: 'Unknown', createdAt: timestamp } as never,
    ], fetchedAt: timestamp });
    expect((await readActivity('user-a', 'group-a'))?.activity.map((item) => [item.entityId, item.entityActive])).toEqual([
      ['expense-1', true], ['expense-1', true], ['settlement-1', false], ['', undefined],
    ]);
  });

  it('removes deleted activity and inactive revisions while upgrading an older cache', async () => {
    const old = indexedDB.open(DB_NAME, 7);
    await new Promise<void>((resolve, reject) => {
      old.onupgradeneeded = () => old.result.createObjectStore('activity', { keyPath: ['userId', 'groupId'] });
      old.onsuccess = () => {
        const tx = old.result.transaction('activity', 'readwrite');
        tx.objectStore('activity').put({ userId: 'user-a', groupId: 'group-a', fetchedAt: 'legacy', activity: [
          { type: 'expense', id: 'expense-1', entityId: 'expense-1', entityActive: true },
          { type: 'expense_deleted', id: 'deleted-1', entityId: 'expense-1' },
          { type: 'expense_revision', id: 'revision-deleted', entityId: 'expense-1', entityActive: false },
        ] });
        tx.oncomplete = () => { old.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      old.onerror = () => reject(old.error);
    });

    expect((await readActivity('user-a', 'group-a'))?.activity.map((item) => item.id)).toEqual(['expense-1']);
  });

  it('never guesses a revision ID as an expense ID in a legacy cache', async () => {
    const timestamp = new Date().toISOString();
    await saveActivity({ userId: 'user-a', groupId: 'group-a', activity: [
      { type: 'expense_revision', id: 'revision-only', label: 'Old edit', createdAt: timestamp } as never,
    ], fetchedAt: timestamp });
    expect((await readActivity('user-a', 'group-a'))?.activity[0]).toMatchObject({ entityId: '', entityActive: undefined });
  });
});
