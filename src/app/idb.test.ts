import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { APPLICATION_SESSION_IDLE_MS } from '../shared/session-policy';
import { claimOutboxItem, clearAllPrivateData, clearCachedData, DB_NAME, DB_VERSION, invalidateCachedGroups, isOfflineTrustUsable, listOutbox, OFFLINE_TRUST_MAX_AGE_MS, readActivity, readCategories, readExpenseDetails, readGroupSnapshot, readGroups, readLastVerifiedClerkUserId, readMutationGeneration, readOfflineTrust, readRecent, readResourceFreshness, recoverStaleSyncing, removeOutboxIfOwned, revokeOfflineTrust, saveActivity, saveCategories, saveExpenseDetails, saveExpenseDetailsIfGenerationMatches, saveGroups, saveGroupsIfGenerationMatches, saveLastVerifiedClerkUserId, saveOfflineTrust, saveOutboxItem, saveRecent, saveVerifiedIdentity, updateGroupSnapshot, updateGroupSnapshotIfGenerationMatches } from './idb';
import { hydrateActivity, hydrateTransactions } from './api';

const user = (userId: string) => ({ userId, email: `${userId}@example.com`, personId: `person-${userId}`, verifiedAt: new Date().toISOString() });
const expense = (operation: string, userId = 'user-a') => ({ clientOperationId: operation, userId, groupId: 'group-a', payload: { description: 'Lunch', amount_minor: 100, currency: 'USD' as const, date: '2026-01-01', payers: [{ person_id: 'person-a', amount_minor: 100 }], splits: [{ person_id: 'person-a', amount_minor: 100 }], client_operation_id: operation }, display: { description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'syncing' as const, attempts: 1 });

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(DB_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => resolve(); });
});

describe('user-scoped IndexedDB', () => {
  it('stores one atomic trust tuple and rejects split or torn records', async () => {
    await saveVerifiedIdentity(user('legacy'));
    await saveLastVerifiedClerkUserId('clerk-legacy');
    expect(await readOfflineTrust()).toBeUndefined();
    await saveOfflineTrust({ ...user('user-a'), clerkUserId: '' });
    expect(isOfflineTrustUsable(await readOfflineTrust())).toBe(false);
    await saveOfflineTrust({ ...user('user-a'), clerkUserId: 'clerk-a' }, undefined, undefined, (await readOfflineTrust())?.revision ?? 0);
    expect(await readOfflineTrust()).toMatchObject({ state: 'active', userId: 'user-a', clerkUserId: 'clerk-a' });
    await revokeOfflineTrust();
    expect(isOfflineTrustUsable(await readOfflineTrust())).toBe(false);
  });

  it('expires trust exactly at thirty days', async () => {
    const verifiedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    await saveOfflineTrust({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', clerkUserId: 'clerk-a', verifiedAt });
    const record = await readOfflineTrust();
    expect(OFFLINE_TRUST_MAX_AGE_MS).toBe(APPLICATION_SESSION_IDLE_MS);
    expect(isOfflineTrustUsable(record, Date.parse(verifiedAt) + APPLICATION_SESSION_IDLE_MS - 1)).toBe(true);
    expect(isOfflineTrustUsable(record, Date.parse(verifiedAt) + APPLICATION_SESSION_IDLE_MS)).toBe(false);
  });

  it('honors the server-provided application-session idle expiry', async () => {
    const verifiedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const idleExpiresAt = new Date('2026-01-10T00:00:00.000Z').toISOString();
    await saveOfflineTrust({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', clerkUserId: 'clerk-a', verifiedAt, idleExpiresAt });
    const record = await readOfflineTrust();
    expect(isOfflineTrustUsable(record, Date.parse(idleExpiresAt) - 1)).toBe(true);
    expect(isOfflineTrustUsable(record, Date.parse(idleExpiresAt))).toBe(false);
  });

  it('does not let a late active save resurrect trust after revocation', async () => {
    await saveOfflineTrust({ ...user('user-a'), clerkUserId: 'clerk-a' });
    const expectedRevision = (await readOfflineTrust())!.revision;
    await revokeOfflineTrust();
    const lateSave = saveOfflineTrust({ ...user('user-a'), clerkUserId: 'clerk-a' }, undefined, undefined, expectedRevision);
    expect(await lateSave).toBe(false);
    const revoked = await readOfflineTrust();
    expect(revoked).toMatchObject({ state: 'revoked', revision: expectedRevision + 1 });
    expect(isOfflineTrustUsable(revoked)).toBe(false);
  });

  it('allows only one concurrent active writer for a captured trust revision', async () => {
    await saveOfflineTrust({ ...user('user-a'), clerkUserId: 'clerk-a' });
    const expectedRevision = (await readOfflineTrust())!.revision;
    const [first, second] = await Promise.all([
      saveOfflineTrust({ ...user('user-a'), clerkUserId: 'clerk-a' }, undefined, undefined, expectedRevision),
      saveOfflineTrust({ ...user('user-a'), clerkUserId: 'clerk-a' }, undefined, undefined, expectedRevision),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await readOfflineTrust())?.revision).toBe(expectedRevision + 1);
  });

  it('upgrades without losing the legacy recent store', async () => {
    const old = indexedDB.open(DB_NAME, 1);
    await new Promise<void>((resolve, reject) => { old.onupgradeneeded = () => old.result.createObjectStore('recent'); old.onsuccess = () => { const tx = old.result.transaction('recent', 'readwrite'); tx.objectStore('recent').put({ choice: 'USD' }, 'form'); tx.oncomplete = () => { old.result.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; old.onerror = () => reject(old.error); });
    await saveVerifiedIdentity(user('user-a'));
    expect(await readRecent<{ choice: string }>()).toEqual({ choice: 'USD' });
    const upgraded = indexedDB.open(DB_NAME, DB_VERSION);
    await new Promise<void>((resolve, reject) => { upgraded.onsuccess = () => { expect(upgraded.result.objectStoreNames.contains('expenseOutbox')).toBe(true); expect(upgraded.result.objectStoreNames.contains('resourceFreshness')).toBe(true); expect(upgraded.result.objectStoreNames.contains('activity')).toBe(true); expect(upgraded.result.objectStoreNames.contains('expenseDetails')).toBe(true); expect(upgraded.result.objectStoreNames.contains('clerkIdentities')).toBe(true); expect(upgraded.result.objectStoreNames.contains('offlineTrust')).toBe(true); upgraded.result.close(); resolve(); }; upgraded.onerror = () => reject(upgraded.error); });
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

  it('keeps same operation IDs isolated by account and auth epoch', async () => {
    await saveOutboxItem({ ...expense('same-operation', 'user-a'), authEpoch: 11, status: 'pending' });
    await saveOutboxItem({ ...expense('same-operation', 'user-b'), authEpoch: 22, status: 'pending' });
    expect((await listOutbox()).map((item) => item.userId)).toEqual(['user-a', 'user-b']);

    expect(await claimOutboxItem('same-operation', 'tab-a', 1_000, 10_000, undefined, { userId: 'user-a', expectedAuthEpoch: 11 }))
      .toMatchObject({ userId: 'user-a', leaseOwner: 'tab-a' });
    expect(await removeOutboxIfOwned('same-operation', 'tab-a', 1_001, undefined, { userId: 'user-b', expectedAuthEpoch: 22 })).toBe(false);
    expect(await removeOutboxIfOwned('same-operation', 'tab-a', 1_001, undefined, { userId: 'user-a', expectedAuthEpoch: 22 })).toBe(false);
    expect((await listOutbox('user-b'))[0]).toMatchObject({ status: 'pending', userId: 'user-b' });
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
    await updateGroupSnapshot('user-a', 'group-a', { group: { id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '' }, splitDefault: { method: 'percentage', personIds: ['person-a', 'person-b'], values: [2500, 7500] }, cachedAt: timestamp });
    await updateGroupSnapshot('user-a', 'group-a', { balances: {}, cachedAt: 'balances-time' });
    expect((await readResourceFreshness('user-a', 'group:group-a:group'))?.fetchedAt).toBe(timestamp);
    expect((await readResourceFreshness('user-a', 'group:group-a:balances'))?.fetchedAt).toBe('balances-time');
    expect((await readGroupSnapshot('user-a', 'group-a'))?.splitDefault).toEqual({ method: 'percentage', personIds: ['person-a', 'person-b'], values: [2500, 7500] });
    expect((await readResourceFreshness('user-a', 'group:group-a:splitDefault'))?.fetchedAt).toBe(timestamp);
    await saveActivity({ userId: 'user-a', groupId: 'group-a', activity: [{ type: 'expense', id: 'e-1', entityId: 'e-1', entityActive: true, amountMinor: 100, currency: 'USD', transactionDate: '2026-01-01', label: 'Lunch', createdAt: timestamp }], fetchedAt: timestamp });
    await saveExpenseDetails({ userId: 'user-a', expenseId: 'e-1', expense: { id: 'e-1', groupId: 'group-a', description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01', createdBy: 'user-a', createdAt: timestamp, updatedAt: timestamp, version: 1, payers: [], splits: [] }, history: [], fetchedAt: timestamp });
    expect((await readActivity('user-a', 'group-a'))?.activity[0].label).toBe('Lunch');
    expect((await readExpenseDetails('user-a', 'e-1'))?.expense.id).toBe('e-1');
  });

  it('adds the first transaction page without replacing older snapshot fields', async () => {
    await updateGroupSnapshot('user-a', 'group-a', { group: { id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '' }, balances: {} });
    await updateGroupSnapshot('user-a', 'group-a', { transactions: [{ kind: 'settlement', id: 's-1', groupId: 'group-a', amountMinor: 100, currency: 'USD', date: '2026-01-01', note: 'Paid', fromPersonId: 'p-1', toPersonId: 'p-2', fromName: 'Former A', toName: 'Former B', createdAt: '2026-01-01T00:00:00.000Z' }], transactionsNextCursor: 'cursor-1', transactionsLimit: 25 });
    const snapshot = await readGroupSnapshot('user-a', 'group-a');
    expect(snapshot?.group?.id).toBe('group-a');
    expect(snapshot?.balances).toEqual({});
    expect(snapshot?.transactions?.[0]).toMatchObject({ kind: 'settlement', fromName: 'Former A' });
    expect(snapshot?.transactionsNextCursor).toBe('cursor-1');
    expect((await readResourceFreshness('user-a', 'group:group-a:transactions'))?.fetchedAt).toBeTruthy();
  });

  it('hydrates transactions only for the exact user and group scope', async () => {
    const transaction = { kind: 'settlement' as const, id: 's-a', groupId: 'group-a', amountMinor: 100, currency: 'USD' as const, date: '2026-01-01', note: null, fromPersonId: 'p-1', toPersonId: 'p-2', fromName: 'A', toName: 'B', createdAt: '2026-01-01T00:00:00.000Z' };
    await updateGroupSnapshot('user-a', 'group-a', { transactions: [transaction], transactionsNextCursor: 'next-a', transactionsLimit: 25 });
    await updateGroupSnapshot('user-b', 'group-a', { transactions: [{ ...transaction, id: 's-b' }], transactionsLimit: 25 });
    await updateGroupSnapshot('user-a', 'group-b', { transactions: [{ ...transaction, id: 's-other-group', groupId: 'group-b' }] });

    await expect(hydrateTransactions('user-a', 'group-a')).resolves.toMatchObject({ data: { transactions: [{ id: 's-a' }], nextCursor: 'next-a' } });
    await expect(hydrateTransactions('user-b', 'group-a')).resolves.toMatchObject({ data: { transactions: [{ id: 's-b' }] } });
    await expect(hydrateTransactions('user-a', 'group-c')).resolves.toBeUndefined();
  });

  it.each([
    [{ groupId: 'group-a' }, 'group leave/delete/access revocation'],
    [{ transactions: true, transactionGroupId: 'group-a' }, 'expense/settlement mutation invalidation'],
  ] as const)('rejects a transaction response captured before %s and cannot repopulate the deleted snapshot', async (options, _description) => {
    await updateGroupSnapshot('user-a', 'group-a', { transactions: [{ kind: 'settlement', id: 'old', groupId: 'group-a', amountMinor: 100, currency: 'USD', date: '2026-01-01', note: null, fromPersonId: 'p-1', toPersonId: 'p-2', fromName: 'Former A', toName: 'Former B', createdAt: '2026-01-01T00:00:00.000Z' }], transactionsLimit: 25 });
    const requestMutationGeneration = await readMutationGeneration('user-a');
    await invalidateCachedGroups('user-a', undefined, options);
    expect(await updateGroupSnapshotIfGenerationMatches('user-a', 'group-a', { transactions: [{ kind: 'settlement', id: 'late', groupId: 'group-a', amountMinor: 200, currency: 'USD', date: '2026-01-02', note: null, fromPersonId: 'p-1', toPersonId: 'p-2', fromName: 'Former A', toName: 'Former B', createdAt: '2026-01-02T00:00:00.000Z' }], transactionsLimit: 25 }, requestMutationGeneration)).toBe(false);
    const snapshot = await readGroupSnapshot('user-a', 'group-a');
    expect('groupId' in options ? snapshot : snapshot?.transactions).toBeUndefined();
  });

  it('rejects a transaction response after the session generation changes', async () => {
    await updateGroupSnapshot('user-a', 'group-a', { transactions: [] });
    const { captureSessionGeneration, rollbackSessionLogout, startSessionLogout } = await import('./session');
    const requestGeneration = captureSessionGeneration();
    const logoutGeneration = startSessionLogout(false);
    try {
      expect(await updateGroupSnapshotIfGenerationMatches('user-a', 'group-a', { transactions: [{ kind: 'expense', id: 'late', groupId: 'group-a', description: 'Late', amountMinor: 100, currency: 'USD', date: '2026-01-01', category: null, notes: null, createdBy: 'user-a', createdAt: '2026-01-01T00:00:00.000Z', clientOperationId: null }] }, await readMutationGeneration('user-a'), requestGeneration)).toBe(false);
    } finally {
      rollbackSessionLogout(logoutGeneration, false);
    }
    expect(await readGroupSnapshot('user-a', 'group-a')).toBeUndefined();
  });

  it('rejects late groups, ledger snapshots, and detail writes after one mutation generation advances', async () => {
    await saveGroups({ userId: 'user-a', groups: [{ id: 'group-a', name: 'Old', currency: 'USD', createdAt: '', updatedAt: '' }], cachedAt: 'old' });
    await updateGroupSnapshot('user-a', 'group-a', { group: { id: 'group-a', name: 'Old', currency: 'USD', createdAt: '', updatedAt: '' } });
    await saveExpenseDetails({ userId: 'user-a', expenseId: 'expense-a', expense: { id: 'expense-a', groupId: 'group-a', description: 'Old', amountMinor: 100, currency: 'USD', date: '2026-01-01', createdBy: 'user-a', createdAt: '', updatedAt: '', version: 1, payers: [], splits: [] }, history: [], fetchedAt: 'old' });
    const requestGeneration = await readMutationGeneration('user-a');
    await invalidateCachedGroups('user-a', undefined, { groupId: 'group-a' });

    expect(await saveGroupsIfGenerationMatches({ userId: 'user-a', groups: [{ id: 'late', name: 'Late', currency: 'USD', createdAt: '', updatedAt: '' }], cachedAt: 'late' }, requestGeneration)).toBe(false);
    for (const patch of [{ expenses: [] }, { balances: {} }, { settlements: [] }]) {
      expect(await updateGroupSnapshotIfGenerationMatches('user-a', 'group-a', patch, requestGeneration)).toBe(false);
    }
    expect(await saveExpenseDetailsIfGenerationMatches({ userId: 'user-a', expenseId: 'expense-a', expense: { id: 'expense-a', groupId: 'group-a', description: 'Late', amountMinor: 200, currency: 'USD', date: '2026-01-02', createdBy: 'user-a', createdAt: '', updatedAt: '', version: 2, payers: [], splits: [] }, history: [], fetchedAt: 'late' }, requestGeneration)).toBe(false);
    expect((await readGroups('user-a'))?.groups).toEqual([]);
    expect(await readGroupSnapshot('user-a', 'group-a')).toBeUndefined();
    expect(await readExpenseDetails('user-a', 'expense-a')).toBeUndefined();
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

  it('removes a deleted group from the persisted list and snapshot', async () => {
    await saveGroups({ userId: 'user-a', groups: [
      { id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '' },
      { id: 'group-b', name: 'B', currency: 'USD', createdAt: '', updatedAt: '' },
    ], cachedAt: 'groups-time' });
    await updateGroupSnapshot('user-a', 'group-a', { group: { id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '' } });
    await saveExpenseDetails({ userId: 'user-a', expenseId: 'expense-a', expense: { id: 'expense-a', groupId: 'group-a', description: 'Private', amountMinor: 100, currency: 'USD', date: '2026-01-01', createdBy: 'user-a', createdAt: '', updatedAt: '', version: 1, payers: [], splits: [] }, history: [], fetchedAt: 'details-time' });
    await invalidateCachedGroups('user-a', undefined, { groupId: 'group-a' });
    expect((await readGroups('user-a'))?.groups.map((group) => group.id)).toEqual(['group-b']);
    expect(await readGroupSnapshot('user-a', 'group-a')).toBeUndefined();
    expect(await readExpenseDetails('user-a', 'expense-a')).toBeUndefined();
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
      { type: 'settlement_revision', id: 'settlement-revision-1', entityId: 'settlement-1', entityActive: false, amountMinor: 100, currency: 'USD', transactionDate: '', label: 'Edited payment', createdAt: timestamp, fromName: 'A', toName: 'B' },
      { type: 'expense_revision', id: 'revision-unknown', entityActive: true, amountMinor: 100, currency: 'USD', transactionDate: '', label: 'Unknown', createdAt: timestamp } as never,
    ], fetchedAt: timestamp });
    expect((await readActivity('user-a', 'group-a'))?.activity.map((item) => [item.entityId, item.entityActive])).toEqual([
      ['expense-1', true], ['settlement-1', false],
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

  it('filters revision-only rows from a legacy cache', async () => {
    const timestamp = new Date().toISOString();
    await saveActivity({ userId: 'user-a', groupId: 'group-a', activity: [
      { type: 'expense_revision', id: 'revision-only', label: 'Old edit', createdAt: timestamp } as never,
    ], fetchedAt: timestamp });
    expect((await readActivity('user-a', 'group-a'))?.activity).toEqual([]);
  });
});
