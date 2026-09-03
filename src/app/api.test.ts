import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptInvitation, ApiError, api, changeScheduledExpenseStatus, clearAuthRequired, clearEverythingForLogout, completePendingAccountDeletion, coordinateAuthBootstrap, createGroupInvitation, createTargetedGroupInvitation, createScheduledExpense, deleteAccount, deleteClerkUserIfSupported, deleteGroup, discardInvalidPendingAccountDeletion, finalizeSuccessfulClerkSignOut, finishLocalCleanupAfterExternalProviderDeletion, getActivity, getActivityPage, getAuditPage, getAuthEpoch, getAuthLifecycle, getAuthState, getCategorySuggestion, getConnectionState, getExpenseDetails, getExpensePage, getExpenses, getGlobalTransactionPage, getGroup, getGroupSettlementCsvExportPage, getGroups, getGroupSplitDefaultSuggestion, getOwnerInvitations, getPendingInvitations, getScheduledExpensePage, getScheduledExpenses, getSettlementPage, getTrustedOfflineClerkUserId, hasPendingAccountDeletion, hydrateTransactionOverview, hydrateTransactions, initializeAuthLifecycle, isDefinitivelySignedOut, isMeaningfulClerkSessionTransition, leaveGroup, markAccountDeletionPending, recoverAfterClerkSignOutFailure, recordSessionActivity, rejectInvitation, removeGroupMember, resetForClerkSessionChange, restoreExpense, restoreSettlement, revokeForClerkSessionChange, sanitizeReturnTo, shouldRevokeForOfflineClerkUser, shouldReverifyTrustedOffline, shouldStartAuthCheck, signalConnectionChecking, subscribeAuthLifecycle, subscribeAuthState, subscribeConnectionState, transferGroupOwnership, updateGroup } from './api';
import { getTransactionPage, getTransactions } from './api';
import { enqueueExpense } from './outbox';
import { DB_NAME, listOutbox, readActivity, readCategories, readExpenseDetails, readGroups, readLastVerifiedClerkUserId, readOfflineTrust, readResourceFreshness, saveActivity, saveCategories, saveGroups, saveLastVerifiedClerkUserId, saveOfflineTrust, saveVerifiedIdentity } from './idb';
import { readGroupSnapshot, updateGroupSnapshot } from './idb';
import { configureResource, getResourceSnapshot, invalidateForMutation, revalidate, resourceKeys, seedResource } from './resource-cache';
import { adoptSessionGeneration, captureSessionGeneration, clearSessionLogout, getSessionLogoutInProgress } from './session';
import { isMutationBarrierActive, releaseMutationBarrier } from './mutation-quiescence';

const markerKey = 'billsplit-pending-account-deletion';
const storageFor = (values: Map<string, string>, setItem: (key: string, value: string) => void = (key, value) => { values.set(key, value); }) => ({
  getItem: (key: string) => values.get(key) || null,
  setItem,
  removeItem: (key: string) => values.delete(key),
});

const json = (body: unknown, status = 200, userId?: string, clerkUserId?: string) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(userId ? { 'X-BillSplit-User-Id': userId } : {}), ...(clerkUserId ? { 'X-BillSplit-Clerk-User-Id': clerkUserId } : {}) } });

const establishAuthenticatedMutationSession = async (clerkUserId = 'clerk-original') => {
  clearSessionLogout();
  clearAuthRequired();
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'mutation-user', email: 'mutation@example.com', personId: 'mutation-person' }, 200, 'mutation-user', clerkUserId)));
  await initializeAuthLifecycle({ clerkUserId });
};

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(DB_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => resolve(); });
});

describe('frontend API errors and cache fallback', () => {
  it('fences an in-flight group GET when a split default mutation patches memory and IDB', async () => {
    const userId = 'split-default-race-user';
    const groupId = 'split-default-race-group';
    const key = resourceKeys.group(userId, groupId);
    const oldDefault = { method: 'equal' as const, personIds: ['person-a'], values: [] };
    const newDefault = { method: 'shares' as const, personIds: ['person-a'], values: [1] };
    await updateGroupSnapshot(userId, groupId, { splitDefault: oldDefault });
    seedResource(key, userId, { group: { id: groupId }, members: [], splitDefault: oldDefault });
    let resolveStale!: (value: unknown) => void;
    configureResource(key, userId, () => new Promise((resolve) => { resolveStale = resolve; }));
    const staleGet = revalidate(key, userId, { force: true, reason: 'route' });
    await vi.waitFor(() => expect(resolveStale).toBeTypeOf('function'));

    await invalidateForMutation.splitDefaultChanged(groupId, newDefault, userId, captureSessionGeneration());
    resolveStale({ group: { id: groupId }, members: [], splitDefault: oldDefault });
    await staleGet;

    expect(getResourceSnapshot(key, userId).data).toMatchObject({ splitDefault: newDefault });
    expect((await readGroupSnapshot(userId, groupId))?.splitDefault).toEqual(newDefault);
  });

  it('allows trusted offline startup before Clerk has loaded but gates online startup', () => {
    expect(shouldStartAuthCheck(false, false)).toBe(true);
    expect(shouldStartAuthCheck(false, true)).toBe(true);
    expect(shouldStartAuthCheck(true, false)).toBe(true);
    expect(shouldStartAuthCheck(true, true)).toBe(true);
  });
  it('keeps a restoring Clerk session on the checking shell instead of showing login', () => {
    expect(isDefinitivelySignedOut(false, false)).toBe(false);
    expect(isDefinitivelySignedOut(true, undefined)).toBe(false);
    expect(isDefinitivelySignedOut(true, false)).toBe(true);
  });
  it('does not treat Clerk provider loading as a session transition during trusted offline startup', () => {
    expect(isMeaningfulClerkSessionTransition(undefined, 'user-a:session-a')).toBe(false);
    expect(isMeaningfulClerkSessionTransition('user-a:session-a', 'user-a:session-a')).toBe(false);
    expect(isMeaningfulClerkSessionTransition('user-a:session-a', 'user-b:session-b')).toBe(true);
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-a', 'clerk-a')).toBe(false);
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-b', 'clerk-a')).toBe(true);
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-a', undefined)).toBe(true);
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-b', undefined, false)).toBe(false);
    expect(shouldReverifyTrustedOffline(false, true, true, 'trusted-offline')).toBe(false);
    expect(shouldReverifyTrustedOffline(true, true, true, 'trusted-offline')).toBe(true);
  });
  it('does not turn a CSRF failure into account or group auth revocation', async () => {
    await establishAuthenticatedMutationSession();
    const epoch = getAuthEpoch();
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'CSRF_FORBIDDEN', message: 'csrf mismatch' } }, 403)));

    await expect(api('/groups', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 403, code: 'CSRF_FORBIDDEN' });
    expect(getAuthEpoch()).toBe(epoch);
    expect(getAuthLifecycle().status).toBe('authenticated');
  });
  it('does not let a failed session activity request clear a concurrent connection failure', async () => {
    await establishAuthenticatedMutationSession();
    const resolvers = new Map<string, (response: Response) => void>();
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => new Promise<Response>((resolve) => {
      resolvers.set(new URL(String(request), 'https://billsplit.test').pathname, resolve);
    })));

    const activity = recordSessionActivity();
    const groups = api('/groups');
    await vi.waitFor(() => expect(resolvers.size).toBe(2));
    resolvers.get('/api/groups')!(json({ error: { code: 'UPSTREAM_UNAVAILABLE' } }, 503));
    await expect(groups).rejects.toMatchObject({ status: 503 });
    expect(getConnectionState()).toMatchObject({ status: 'connection-issue', reconnectRequired: true });

    resolvers.get('/api/session/activity')!(json({ error: { code: 'CSRF_FORBIDDEN', message: 'csrf mismatch' } }, 403));
    await expect(activity).rejects.toMatchObject({ status: 403, code: 'CSRF_FORBIDDEN' });
    expect(getConnectionState()).toMatchObject({ status: 'connection-issue', reconnectRequired: true });
  });
  it('does not revoke a fast Clerk load while last Clerk ID hydration is pending', () => {
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-fast', undefined, false)).toBe(false);
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-fast', undefined, true)).toBe(true);
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-fast', 'clerk-fast', true)).toBe(false);
  });
  it('filters revision rows from the activity cache without losing current rows', async () => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me')
      ? json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a')
      : json({ activity: [{ type: 'expense_revision', id: 'revision-1', entityId: 'expense-1', entity_active: 1, amountMinor: 1250, currency: 'USD', transactionDate: '2026-01-02', label: 'Lunch', createdAt: '2026-01-03T00:00:00Z' }] }, 200, 'user-a')));
    const result = await getActivity('group-a');
    expect(result.activity).toEqual([]);
    expect((await readActivity('user-a', 'group-a'))?.activity).toEqual([]);
  });

  it('does not display deleted or revision activity from an API response', async () => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me')
      ? json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a')
      : json({ activity: [
        { type: 'expense', id: 'expense-1', entityId: 'expense-1', entityActive: true, label: 'Current' },
        { type: 'expense_deleted', id: 'deleted-1', entityId: 'expense-1', entityActive: false, label: 'Deleted' },
        { type: 'expense_revision', id: 'revision-deleted', entityId: 'expense-1', entityActive: false, label: 'Old edit' },
      ] }, 200, 'user-a')));

    const result = await getActivity('group-a');
    expect(result.activity.map((item) => item.id)).toEqual(['expense-1']);
    expect((await readActivity('user-a', 'group-a'))?.activity.map((item) => item.id)).toEqual(['expense-1']);
  });

  it('normalizes activity pages without losing a server cursor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ activity: [{ type: 'expense_deleted', id: 'deleted-1' }, { type: 'settlement_revision', id: 'revision-1', entityId: 'settlement-1', entityActive: false, fromName: 'A', toName: 'B' }], nextCursor: 'next-page' })));
    const page = await getActivityPage(undefined, { limit: 1 });
    expect(page.activity).toEqual([]);
    expect(page.nextCursor).toBe('next-page');
  });

  it('uses the backend cursor contracts for invitations, transactions, audit, and restore', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request), 'https://billsplit.test'); calls.push({ path: url.pathname + url.search, method: init?.method || 'GET' });
      if (url.pathname === '/api/invitations') return json({ invitations: [] });
      if (url.pathname.endsWith('/invitations')) return json({ invitations: [] });
      if (url.pathname === '/api/activity') return json({ activity: [], nextCursor: 'activity-cursor' });
      if (url.pathname.endsWith('/expenses')) return json({ expenses: [], nextCursor: 'expense-cursor' });
      if (url.pathname.endsWith('/settlements')) return json({ settlements: [], nextCursor: 'settlement-cursor' });
      if (url.pathname.endsWith('/audit')) return json({ audit: [], nextCursor: 'audit-cursor' });
      if (url.pathname.endsWith('/restore')) return json({ expense: {}, settlement: {} });
      return new Response(null, { status: 204 });
    }));
    await getPendingInvitations(); await getOwnerInvitations('group-a'); await getExpensePage('group-a', { cursor: 'e1' }); await getSettlementPage('group-a', { cursor: 's1' }); await getActivityPage('group-a', { cursor: 'a1' }); await getAuditPage('group-a', { cursor: 'u1' });
     await createGroupInvitation('group-a', 'person@example.com'); await acceptInvitation('invite-a'); await rejectInvitation('invite-a'); await removeGroupMember('group-a', 'person-a'); await transferGroupOwnership('group-a', 'person-b'); await leaveGroup('group-a'); await restoreExpense('expense-a', 2); await restoreSettlement('settlement-a', 2);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/api/groups/group-a/expenses?limit=50&cursor=e1', method: 'GET' }),
      expect.objectContaining({ path: '/api/groups/group-a/audit?limit=50&cursor=u1', method: 'GET' }),
      expect.objectContaining({ path: '/api/expenses/expense-a/restore', method: 'POST' }),
       expect.objectContaining({ path: '/api/settlements/settlement-a/restore', method: 'POST' }),
       expect.objectContaining({ path: '/api/groups/group-a/transfer-ownership', method: 'POST' }),
       expect.objectContaining({ path: '/api/groups/group-a/leave', method: 'POST' }),
     ]));
  });

  it('constructs expense filters and preserves them for cursor pagination', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => { calls.push(new URL(String(request), 'https://billsplit.test').search); return json({ expenses: [], nextCursor: 'next' }); }));
    const filters = { q: 'dinner', person: 'person-a', category: 'Dining', from: '2026-01-01', to: '2026-01-31', currency: 'USD' as const };
    await getExpensePage('group-a', { ...filters });
    await getExpensePage('group-a', { ...filters, cursor: 'next' });
    expect(calls).toEqual([
      '?limit=50&q=dinner&person=person-a&category=Dining&from=2026-01-01&to=2026-01-31&currency=USD',
      '?limit=50&cursor=next&q=dinner&person=person-a&category=Dining&from=2026-01-01&to=2026-01-31&currency=USD',
    ]);
  });

  it('requests the separate paged settlement CSV endpoint', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => { calls.push(new URL(String(request), 'https://billsplit.test').pathname + new URL(String(request), 'https://billsplit.test').search); return new Response('date,from_person,to_person,amount_minor,currency,note\n', { headers: { 'Content-Type': 'text/csv', 'X-Next-Cursor': 'next' } }); }));
    const page = await getGroupSettlementCsvExportPage('group-a', { cursor: 'cursor-a' });
    expect(page.nextCursor).toBe('next');
    expect(calls).toEqual(['/api/groups/group-a/settlements.csv?limit=100&cursor=cursor-a']);
  });

  it('requests the group-scoped split default suggestion without persisting it', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => { calls.push(String(request)); return json({ suggestion: { method: 'equal', personIds: ['person-a'] } }); }));
    await expect(getGroupSplitDefaultSuggestion('group-a')).resolves.toEqual({ suggestion: { method: 'equal', personIds: ['person-a'] } });
    expect(calls).toEqual(['/api/groups/group-a/split-default-suggestion']);
  });

  it('uses the owner group settings mutation endpoints', async () => {
    const calls: Array<{ path: string; method: string; body?: string; expectedClerkUserId?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const url = new URL(String(request), 'https://billsplit.test'); calls.push({ path: url.pathname, method: init?.method || 'GET', body: init?.body as string | undefined }); return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ group: {} }); }));
    await updateGroup('group-a', { name: 'Renamed', currency: 'EUR' });
    await deleteGroup('group-a');
    expect(calls).toEqual([{ path: '/api/groups/group-a', method: 'PUT', body: JSON.stringify({ name: 'Renamed', currency: 'EUR' }) }, { path: '/api/groups/group-a', method: 'DELETE' }]);
  });

  it('binds every authenticated mutation to the verified internal user', async () => {
    await establishAuthenticatedMutationSession('clerk-bound');
    const fetchSpy = vi.fn(async () => json({ ok: true }, 200, 'mutation-user'));
    vi.stubGlobal('fetch', fetchSpy);

    await api('/groups', { method: 'POST', body: '{}' });

    const call = ((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [RequestInfo, RequestInit?] | undefined);
    expect(new Headers(call?.[1]?.headers).get('X-BillSplit-Expected-User-Id')).toBe('mutation-user');
  });

  it('uses the typed account deletion endpoint and keeps Clerk deletion capability explicit', async () => {
     const calls: Array<{ path: string; method: string; body?: string; expectedClerkUserId?: string }> = [];
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
     vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const url = new URL(String(request), 'https://billsplit.test'); calls.push({ path: url.pathname, method: init?.method || 'GET', body: init?.body as string | undefined, expectedClerkUserId: new Headers(init?.headers).get('X-BillSplit-Expected-Clerk-User-Id') || undefined }); return new Response(null, { status: 204 }); }));
     await deleteAccount('clerk-original');
     expect(calls).toEqual([{ path: '/api/account', method: 'DELETE', body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }), expectedClerkUserId: 'clerk-original' }]);
    expect(storage.get('billsplit-pending-account-deletion')).toContain('clerk-original');
    await expect(deleteClerkUserIfSupported(undefined)).resolves.toBe('unsupported');
    const deleteUser = vi.fn(async () => undefined);
    await expect(deleteClerkUserIfSupported({ delete: deleteUser })).resolves.toBe('deleted');
     expect(deleteUser).toHaveBeenCalledOnce();
  });

  it('treats successful Clerk deletion as complete when the provider marker write fails', async () => {
    const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'server-deleted', clerkUserId: 'clerk-original' })]]);
    vi.stubGlobal('localStorage', storageFor(storage, (key, value) => {
      if (key === markerKey && JSON.parse(value).phase === 'provider-deleted') throw new Error('provider marker write failed');
      storage.set(key, value);
    }));
    const providerDelete = vi.fn(async () => undefined);
    await expect(completePendingAccountDeletion({ id: 'clerk-original', delete: providerDelete }, vi.fn(async () => undefined), { clearLocal: vi.fn(async () => undefined), clerkEvidence: { isLoaded: true, isSignedIn: true, userId: 'clerk-original' } })).resolves.toEqual({ clerkStatus: 'deleted' });
    expect(providerDelete).toHaveBeenCalledOnce();
    expect(storage.has(markerKey)).toBe(false);
  });

  it('clears the nonblocking marker when Clerk deletion is unsupported', async () => {
    const storage = new Map([[markerKey, JSON.stringify({ version: 1, phase: 'local-cleared', clerkUserId: 'clerk-original' })]]);
    vi.stubGlobal('localStorage', storageFor(storage));
    const signOut = vi.fn(async () => undefined);
    await expect(completePendingAccountDeletion({ id: 'clerk-original' }, signOut, { clerkEvidence: { isLoaded: true, isSignedIn: true, userId: 'clerk-original' } })).resolves.toEqual({ clerkStatus: 'unsupported' });
    expect(signOut).toHaveBeenCalledOnce();
    expect(storage.has(markerKey)).toBe(false);
  });

  it('resumes provider deletion after a first local cleanup failure without repeating server deletion', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    storage.set('billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'server-deleted', clerkUserId: 'clerk-original' }));
    expect(hasPendingAccountDeletion()).toBe(true);
    const clearLocal = vi.fn().mockRejectedValueOnce(new Error('storage temporarily unavailable')).mockResolvedValue(undefined);
    await expect(completePendingAccountDeletion({ id: 'clerk-original', delete: vi.fn() }, vi.fn(async () => undefined), { clearLocal })).rejects.toThrow('storage temporarily unavailable');
    const providerDelete = vi.fn(async () => undefined);
    await expect(completePendingAccountDeletion({ id: 'clerk-original', delete: providerDelete }, vi.fn(async () => undefined), { clearLocal })).resolves.toEqual({ clerkStatus: 'deleted' });
    expect(providerDelete).toHaveBeenCalledOnce();
    expect(hasPendingAccountDeletion()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('retries a pending server deletion and never calls provider deletion after network uncertainty', async () => {
    const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'server-pending', clerkUserId: 'clerk-original' })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('network unavailable'));
    vi.stubGlobal('fetch', fetchSpy);
   const providerDelete = vi.fn(async () => undefined);
   await expect(completePendingAccountDeletion({ id: 'clerk-original', delete: providerDelete }, vi.fn(async () => undefined))).rejects.toThrow('Connection issue');
   expect(fetchSpy).toHaveBeenCalledOnce();
   expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('X-BillSplit-Expected-Clerk-User-Id')).toBe('clerk-original');
   expect(providerDelete).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('recovers when the server committed before the phase marker update', async () => {
     await establishAuthenticatedMutationSession();
     const storage = new Map<string, string>();
    let phaseWriteCount = 0;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => {
        phaseWriteCount += 1;
        if (phaseWriteCount === 2) throw new Error('crash after server commit');
        storage.set(key, value);
      },
      removeItem: (key: string) => storage.delete(key),
    });
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(deleteAccount('clerk-original')).rejects.toThrow('crash after server commit');
    expect(storage.get('billsplit-pending-account-deletion')).toContain('server-pending');
    const providerDelete = vi.fn(async () => undefined);
    await expect(completePendingAccountDeletion({ id: 'clerk-original', delete: providerDelete }, vi.fn(async () => undefined), { clearLocal: vi.fn(async () => undefined) })).resolves.toEqual({ clerkStatus: 'deleted' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(providerDelete).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('keeps cleanup blocked when a retry fails before the server commit, then completes on a later retry', async () => {
     await establishAuthenticatedMutationSession();
     const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'server-pending', clerkUserId: 'clerk-original' })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'ACCOUNT_DELETION_BLOCKED', message: 'owned group' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    const providerDelete = vi.fn(async () => undefined);
    await expect(completePendingAccountDeletion({ id: 'clerk-original', delete: providerDelete }, vi.fn(async () => undefined), { clearLocal: vi.fn(async () => undefined) })).rejects.toThrow('owned group');
    expect(providerDelete).not.toHaveBeenCalled();
    await expect(completePendingAccountDeletion({ id: 'clerk-original', delete: providerDelete }, vi.fn(async () => undefined), { clearLocal: vi.fn(async () => undefined) })).resolves.toEqual({ clerkStatus: 'deleted' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(providerDelete).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('does not retry a pending marker under an unrelated provider identity', async () => {
    const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'server-pending', clerkUserId: 'clerk-original' })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const providerDelete = vi.fn(async () => undefined);
    await expect(completePendingAccountDeletion({ id: 'clerk-unrelated', delete: providerDelete }, vi.fn(async () => undefined), { clearLocal: vi.fn(async () => undefined) })).rejects.toThrow('provider identity changed');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(providerDelete).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('fails closed for an unbound marker and only discards it explicitly', async () => {
    const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'server-pending' })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const clearLocal = vi.fn(async () => undefined);
    const providerDelete = vi.fn(async () => undefined);
    expect(hasPendingAccountDeletion()).toBe(true);
    await expect(completePendingAccountDeletion({ id: 'clerk-current', delete: providerDelete }, vi.fn(async () => undefined), { clearLocal })).rejects.toThrow('marker is invalid');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(clearLocal).not.toHaveBeenCalled();
    expect(providerDelete).not.toHaveBeenCalled();
    expect(discardInvalidPendingAccountDeletion()).toBe(true);
    expect(hasPendingAccountDeletion()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('fails closed for a malformed marker without binding it to the current user', async () => {
    const storage = new Map<string, string>([['billsplit-pending-account-deletion', '{not-json']]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(completePendingAccountDeletion({ id: 'clerk-current', delete: vi.fn() }, vi.fn(async () => undefined))).rejects.toThrow('marker is invalid');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(discardInvalidPendingAccountDeletion()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('recovers a marker only for the exact current Clerk user', async () => {
    const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'server-deleted', clerkUserId: 'clerk-original' })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const clearLocal = vi.fn(async () => undefined);
    const providerDelete = vi.fn(async () => undefined);
    await expect(completePendingAccountDeletion({ id: 'clerk-original', delete: providerDelete }, vi.fn(async () => undefined), { clearLocal })).resolves.toEqual({ clerkStatus: 'deleted' });
    expect(clearLocal).toHaveBeenCalledOnce();
    expect(providerDelete).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

   it('retains local-cleared recovery after reload when Clerk is authoritatively signed out', async () => {
    const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'local-cleared', clerkUserId: 'clerk-original' })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const signOut = vi.fn(async () => undefined);
    await expect(completePendingAccountDeletion(undefined, signOut, { clerkEvidence: { isLoaded: true, isSignedIn: false } })).resolves.toEqual({ clerkStatus: 'signed-out' });
    expect(signOut).not.toHaveBeenCalled();
     expect(hasPendingAccountDeletion()).toBe(true);
    vi.unstubAllGlobals();
  });

   it('retains server-deleted recovery after local cleanup when Clerk is signed out', async () => {
    const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'server-deleted', clerkUserId: 'clerk-original' })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const clearLocal = vi.fn(async () => undefined);
    const signOut = vi.fn(async () => undefined);
    await expect(completePendingAccountDeletion(undefined, signOut, { clearLocal, clerkEvidence: { isLoaded: true, isSignedIn: false } })).resolves.toEqual({ clerkStatus: 'signed-out' });
    expect(clearLocal).toHaveBeenCalledOnce();
    expect(signOut).not.toHaveBeenCalled();
     expect(hasPendingAccountDeletion()).toBe(true);
    vi.unstubAllGlobals();
   });

   it('allows confirmed local cleanup after external provider deletion', async () => {
     const storage = new Map([[markerKey, JSON.stringify({ version: 1, phase: 'server-deleted', clerkUserId: 'clerk-original' })]]);
     vi.stubGlobal('localStorage', storageFor(storage));
     const clearLocal = vi.fn(async () => undefined);
     await expect(finishLocalCleanupAfterExternalProviderDeletion({ confirmed: true, clearLocal, clerkEvidence: { isLoaded: true, isSignedIn: false } })).resolves.toEqual({ clerkStatus: 'externally-deleted' });
     expect(clearLocal).toHaveBeenCalledOnce();
     expect(storage.has(markerKey)).toBe(false);
   });

   it('does not allow the local cleanup escape for an unconfirmed server deletion', async () => {
     const storage = new Map([[markerKey, JSON.stringify({ version: 1, phase: 'server-pending', clerkUserId: 'clerk-original' })]]);
     vi.stubGlobal('localStorage', storageFor(storage));
     const clearLocal = vi.fn(async () => undefined);
     await expect(finishLocalCleanupAfterExternalProviderDeletion({ confirmed: true, clearLocal, clerkEvidence: { isLoaded: true, isSignedIn: false } })).rejects.toThrow('server-confirmed');
     expect(clearLocal).not.toHaveBeenCalled();
     expect(storage.has(markerKey)).toBe(true);
   });

   it('completes retained local-cleared recovery after the original Clerk account signs in', async () => {
     const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'local-cleared', clerkUserId: 'clerk-original' })]]);
     vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
     const providerDelete = vi.fn(async () => undefined);
     await expect(completePendingAccountDeletion({ id: 'clerk-original', delete: providerDelete }, vi.fn(async () => undefined), { clerkEvidence: { isLoaded: true, isSignedIn: true, userId: 'clerk-original' } })).resolves.toEqual({ clerkStatus: 'deleted' });
     expect(providerDelete).toHaveBeenCalledOnce();
     expect(hasPendingAccountDeletion()).toBe(false);
     vi.unstubAllGlobals();
   });

   it('keeps the marker when provider deletion fails during a session expiry', async () => {
     const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'local-cleared', clerkUserId: 'clerk-original' })]]);
     vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
     const providerDelete = vi.fn(async () => { throw new Error('session expired'); });
     const signOut = vi.fn(async () => undefined);
     await expect(completePendingAccountDeletion({ id: 'clerk-original', delete: providerDelete }, signOut, { clerkEvidence: { isLoaded: true, isSignedIn: true, userId: 'clerk-original' } })).resolves.toEqual({ clerkStatus: 'unsupported' });
     expect(signOut).toHaveBeenCalledOnce();
     expect(hasPendingAccountDeletion()).toBe(true);
     vi.unstubAllGlobals();
   });

  it('finishes provider-deleted recovery after reload without a Clerk user', async () => {
    const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'provider-deleted', clerkUserId: 'clerk-original' })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    await expect(completePendingAccountDeletion(undefined, vi.fn(async () => undefined), { clerkEvidence: { isLoaded: true, isSignedIn: false } })).resolves.toEqual({ clerkStatus: 'deleted' });
    expect(hasPendingAccountDeletion()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('denies server-pending recovery while Clerk is authoritatively signed out', async () => {
    const storage = new Map<string, string>([['billsplit-pending-account-deletion', JSON.stringify({ version: 1, phase: 'server-pending', clerkUserId: 'clerk-original' })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const clearLocal = vi.fn(async () => undefined);
    await expect(completePendingAccountDeletion(undefined, vi.fn(async () => undefined), { clearLocal, clerkEvidence: { isLoaded: true, isSignedIn: false } })).rejects.toThrow('loaded Clerk user ID');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(clearLocal).not.toHaveBeenCalled();
    expect(hasPendingAccountDeletion()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('aborts before DELETE when the pre-mutation marker cannot be persisted', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('marker storage failed'); }, removeItem: () => undefined });
    await expect(deleteAccount('clerk-original')).rejects.toThrow('marker storage failed');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('requires a loaded Clerk user ID before marking or starting deletion', async () => {
    expect(() => markAccountDeletionPending('')).toThrow('loaded Clerk user ID');
    await expect(deleteAccount('')).rejects.toThrow('loaded Clerk user ID');
  });

  it('retains the separately authorized historical participant list in group responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const path = new URL(String(request), 'https://billsplit.test').pathname;
      if (path === '/api/me') return json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a');
      return json({ group: { id: 'group-a', name: 'Trip', currency: 'USD', createdAt: '', updatedAt: '' }, members: [{ personId: 'person-a', name: 'A', joinedAt: '', role: 'owner' }], historicalParticipants: [{ personId: 'person-a', name: 'A', joinedAt: '', role: 'owner', status: 'active' }, { personId: 'person-removed', name: 'Former', joinedAt: '', role: 'member', status: 'removed' }] }, 200, 'user-a');
    }));
    const result = await getGroup('group-a');
    expect(result.historicalParticipants).toEqual(expect.arrayContaining([expect.objectContaining({ personId: 'person-removed', status: 'removed' })]));
  });

  it('uses the group-scoped current person and persists it with the cached group', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const path = new URL(String(request), 'https://billsplit.test').pathname;
      if (path === '/api/me') return json({ id: 'user-a', email: 'a@example.com', personId: 'person-global' }, 200, 'user-a');
      return json({ group: { id: 'group-a', name: 'Trip', currency: 'USD', createdAt: '', updatedAt: '' }, members: [{ personId: 'person-target', name: 'A', joinedAt: '', role: 'member', linked: true }], historicalParticipants: [], splitDefault: null, currentPersonId: 'person-target' }, 200, 'user-a');
    }));

    const result = await getGroup('group-a');
    expect(result.currentPersonId).toBe('person-target');
    expect((await readGroupSnapshot('user-a', 'group-a'))?.currentPersonId).toBe('person-target');
  });

  it('fails closed for a legacy cached group when the authenticated person is absent', async () => {
    await updateGroupSnapshot('user-a', 'group-a', {
      group: { id: 'group-a', name: 'Trip', currency: 'USD', createdAt: '', updatedAt: '' },
      members: [
        { personId: 'person-other-a', name: 'Other A', joinedAt: '', role: 'member', linked: true },
        { personId: 'person-other-b', name: 'Other B', joinedAt: '', role: 'member', linked: true },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const path = new URL(String(request), 'https://billsplit.test').pathname;
      if (path === '/api/me') return json({ id: 'user-a', email: 'a@example.com', personId: 'person-missing' }, 200, 'user-a');
      throw new TypeError('offline');
    }));

    const result = await getGroup('group-a');
    expect(result.currentPersonId).toBeNull();
    await establishAuthenticatedMutationSession();
  });

  it('sends targeted invitations to the owner-only participant endpoint', async () => {
    await establishAuthenticatedMutationSession();
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request), 'https://billsplit.test');
      calls.push({ path: url.pathname, method: init?.method || 'GET', body: init?.body as string | undefined });
      return json({ invitation: { id: 'inv-1' } }, 201, 'user-a');
    }));
    await expect(createTargetedGroupInvitation('group-a', 'person-a', 'new@example.com')).resolves.toEqual({ invitation: { id: 'inv-1' } });
    expect(calls).toEqual([{ path: '/api/groups/group-a/members/person-a/invitation', method: 'POST', body: JSON.stringify({ email: 'new@example.com' }) }]);
  });

  it('uses scheduled expense routes online without entering the expense outbox', async () => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    const calls: Array<{ path: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(request), 'https://billsplit.test').pathname;
      calls.push({ path, method: init?.method || 'GET' });
      if (path === '/api/me') return json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a');
      if (path.endsWith('/scheduled-expenses')) return json({ scheduledExpenses: [] }, 200, 'user-a');
      return json({ scheduledExpense: { id: 'schedule-1', version: 2 } }, 200, 'user-a');
    }));
    await expect(getScheduledExpenses('group-a')).resolves.toEqual({ scheduledExpenses: [] });
    await createScheduledExpense('group-a', { description: 'Rent', amount_minor: 100, currency: 'USD', start_date: '2026-01-01', end_date: null, frequency: 'monthly', interval: 1, weekdays: [], timezone: 'UTC', payers: [{ person_id: 'person-a', amount_minor: 100 }], splits: [{ person_id: 'person-a', amount_minor: 100 }], client_operation_id: 'schedule-1' });
    await changeScheduledExpenseStatus('schedule-1', 'pause', 1);
    expect(calls.map((call) => [call.path, call.method])).toEqual([
      ['/api/groups/group-a/scheduled-expenses', 'GET'],
      ['/api/groups/group-a/scheduled-expenses', 'POST'], ['/api/scheduled-expenses/schedule-1/pause', 'POST'],
    ]);
  });
  it('uses the authenticated category suggestion route', async () => {
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request), 'https://billsplit.test');
      calls.push({ path: url.pathname, method: init?.method || 'GET', body: init?.body as string | undefined });
      return json({ category: 'Dining' }, 200, 'user-a');
    }));
    await expect(getCategorySuggestion('  Dinner  ')).resolves.toEqual({ category: 'Dining' });
    expect(calls).toEqual([{ path: '/api/category-suggestion', method: 'POST', body: JSON.stringify({ description: '  Dinner  ' }) }]);
  });

  it('loads only the first scheduled-expense page and leaves the cursor for Load more', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(String(request), 'https://billsplit.test');
      calls.push(url.search);
      const cursor = url.searchParams.get('cursor');
      const count = cursor ? 2 : 100;
      return json({ scheduledExpenses: Array.from({ length: count }, (_, index) => ({ id: `schedule-${cursor ? 100 + index : index}` })), ...(cursor ? {} : { nextCursor: 'scheduled-cursor' }) }, 200, 'user-a');
    }));
    const result = await getScheduledExpenses('group-a');
    expect(result.scheduledExpenses).toHaveLength(100);
    expect(result.nextCursor).toBe('scheduled-cursor');
    expect(calls).toEqual(['?limit=100']);
  });

  it('loads a scheduled-expense continuation only when given its cursor', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(String(request), 'https://billsplit.test');
      return json({ scheduledExpenses: [{ id: 'schedule-next' }], nextCursor: undefined }, 200, 'user-a');
    }));
    await expect(getScheduledExpensePage('group-a', { cursor: 'scheduled-cursor' })).resolves.toEqual({ scheduledExpenses: [{ id: 'schedule-next' }], nextCursor: undefined });
    expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('cursor=scheduled-cursor');
  });

  it('publishes auth-required state for API calls', async () => {
    const listener = vi.fn();
    const authEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: authEvent });
    const unsubscribe = subscribeAuthState(listener);
    vi.stubGlobal('fetch', vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => { expect(new Headers(init?.headers).get('X-Requested-With')).toBeNull(); expect(init?.credentials).toBe('same-origin'); return json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in' } }, 401); }));
    await expect(api('/me')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(getAuthState()).toEqual({ required: true, code: 'AUTH_REQUIRED' });
    expect(listener).toHaveBeenCalled();
    expect(authEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'billsplit-auth-required' }));
    unsubscribe();
    clearAuthRequired();
    vi.unstubAllGlobals();
  });

  it.each(['plain text', 'Clerk HTML'])('treats %s 401 responses as auth-required', async (kind) => {
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(kind === 'plain text' ? 'Unauthorized' : '<html><body>Sign in</body></html>', { status: 401, headers: { 'Content-Type': kind === 'plain text' ? 'text/plain' : 'text/html' } })));
    await expect(api('/me')).rejects.toMatchObject({ status: 401 });
    expect(getAuthState()).toMatchObject({ required: true, code: 'AUTH_REQUIRED' });
    clearAuthRequired();
  });

  it('treats a redirected API response as auth-required', async () => {
    clearAuthRequired();
    const response = Object.defineProperties(new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), { redirected: { value: true }, url: { value: 'https://split.test/sign-in' } });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(api('/groups')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(getAuthState()).toMatchObject({ required: true, code: 'AUTH_REQUIRED' });
  });

  it('treats invalid JSON 2xx as a protocol/session-check response, not confirmed auth', async () => {
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await expect(api('/groups')).rejects.toMatchObject({ status: 200, code: 'PROTOCOL_ERROR', reconnectRequired: true });
    expect(getAuthState().required).toBe(false);
    expect(getConnectionState()).toMatchObject({ status: 'connection-issue', reconnectRequired: true });
  });

  it('treats an HTML 2xx response as a protocol/session-check response', async () => {
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>unexpected</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));
    await expect(api('/groups')).rejects.toMatchObject({ status: 200, code: 'PROTOCOL_ERROR', reconnectRequired: true });
    expect(getAuthState().required).toBe(false);
  });

  it('surfaces an online network failure as reconnect guidance without changing auth state', async () => {
    clearAuthRequired();
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connection reset'); }));
    await expect(api('/groups')).rejects.toMatchObject({ networkFailure: true, reconnectRequired: true });
    expect(getAuthState().required).toBe(false);
    expect(getConnectionState()).toMatchObject({ status: 'connection-issue', reconnectRequired: true });
  });

  it('distinguishes browser offline, transport issues, reachable auth errors, and success', async () => {
    clearAuthRequired();
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(api('/groups')).rejects.toMatchObject({ networkFailure: true, reconnectRequired: false });
    expect(getConnectionState().status).toBe('offline');

    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('reset'); }));
    await expect(api('/groups')).rejects.toMatchObject({ networkFailure: true, reconnectRequired: true });
    expect(getConnectionState().status).toBe('connection-issue');

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in' } }, 401)));
    await expect(api('/groups')).rejects.toMatchObject({ status: 401 });
    expect(getConnectionState().status).toBe('connected');
    clearAuthRequired();

    vi.stubGlobal('fetch', vi.fn(async () => json({ groups: [] })));
    await expect(api('/groups')).resolves.toEqual({ groups: [] });
    expect(getConnectionState().status).toBe('connected');
  });

  it('keeps an HTML 503 as a retryable server failure rather than auth-required', async () => {
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>upstream unavailable</body></html>', { status: 503, headers: { 'Content-Type': 'text/html' } })));
    await expect(api('/groups')).rejects.toMatchObject({ status: 503, code: 'SERVER_ERROR', networkFailure: false });
    expect(getAuthState().required).toBe(false);
  });

  it('retains an authenticated lifecycle across a temporary 503', async () => {
    resetForClerkSessionChange();
    clearSessionLogout();
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'stable-user', email: 'stable@example.com', personId: 'stable-person' }, 200, 'stable-user', 'clerk-stable')));
    await expect(initializeAuthLifecycle({ networkOnly: true, clerkUserId: 'clerk-stable' })).resolves.toMatchObject({ status: 'authenticated' });

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'UPSTREAM_UNAVAILABLE' } }, 503)));
    await expect(initializeAuthLifecycle({ networkOnly: true, clerkUserId: 'clerk-stable' })).resolves.toMatchObject({ status: 'authenticated' });
    expect(getAuthLifecycle()).toMatchObject({ status: 'authenticated' });
    expect(getConnectionState()).toMatchObject({ status: 'connection-issue', reconnectRequired: true });
    expect(getAuthState().required).toBe(false);
    clearSessionLogout();
  });

  it.each(['html', 'redirect'])('treats a %s /me response as verification transport failure, not logout', async (kind) => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'portal-user', email: 'portal@example.com', personId: 'portal-person', clerkUserId: 'clerk-stable', verifiedAt: new Date().toISOString() });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => {
      const response = kind === 'html'
        ? new Response('<html><body>Sign in to Wi-Fi</body></html>', { status: 503, headers: { 'Content-Type': 'text/html' } })
        : new Response('<html><body>Sign in to Wi-Fi</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      if (kind === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
      return response;
    }));

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-stable', sessionId: 'session-portal' }, { networkOnly: true })).resolves.toMatchObject({ status: 'trusted-offline' });
    expect(getAuthState().required).toBe(false);
  });

  it('fails closed instead of using trust when a protocol failure follows a Clerk account change', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'old-portal-user', email: 'old@example.com', personId: 'old-person', clerkUserId: 'clerk-old-portal', verifiedAt: new Date().toISOString() });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>Sign in to Wi-Fi</body></html>', { status: 503, headers: { 'Content-Type': 'text/html' } })));

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-new-portal', sessionId: 'session-new-portal' }, { networkOnly: true })).resolves.toMatchObject({ status: 'verification-unavailable' });
    expect(getAuthLifecycle().status).toBe('verification-unavailable');
    expect((await readOfflineTrust())?.state).toBe('revoked');
    recoverAfterClerkSignOutFailure();
    clearSessionLogout();
  });

  it('authoritatively revalidates an authenticated session entering checking and settles after a failed probe', async () => {
    resetForClerkSessionChange();
    clearSessionLogout();
    clearAuthRequired();
    vi.stubGlobal('navigator', { onLine: true });
    let meCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) {
        meCalls += 1;
        return json({ id: 'checking-user', email: 'checking@example.com', personId: 'checking-person' }, 200, 'checking-user', 'clerk-checking');
      }
      return json({ groups: [] }, 200, 'checking-user');
    }));
    await initializeAuthLifecycle({ networkOnly: true, clerkUserId: 'clerk-checking' });
    await vi.waitFor(() => expect(getAuthLifecycle().status).toBe('authenticated'));

    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) { meCalls += 1; throw new TypeError('probe unavailable'); }
      return json({ groups: [] }, 200, 'checking-user');
    }));
    signalConnectionChecking();
    await vi.waitFor(() => expect(getConnectionState().status).toBe('connection-issue'));
    expect(getAuthLifecycle().status).toBe('trusted-offline');
    expect(getConnectionState().status).not.toBe('checking');

    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) { meCalls += 1; return json({ id: 'checking-user', email: 'checking@example.com', personId: 'checking-person' }, 200, 'checking-user', 'clerk-checking'); }
      return json({ groups: [] }, 200, 'checking-user');
    }));
    signalConnectionChecking();
    await vi.waitFor(() => expect(getConnectionState().status).toBe('connected'));
    await vi.waitFor(() => expect(getAuthLifecycle().status).toBe('authenticated'));
    expect(meCalls).toBe(3);
  });

  it('settles failed reconnect verification before publishing the connection error and does not re-enter reverifying', async () => {
    resetForClerkSessionChange();
    clearSessionLogout();
    clearAuthRequired();
    vi.stubGlobal('navigator', { onLine: true });
    let meCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) {
        meCalls += 1;
        if (meCalls > 1) throw new TypeError('probe unavailable');
        return json({ id: 'ordered-user', email: 'ordered@example.com', personId: 'ordered-person' }, 200, 'ordered-user', 'clerk-ordered');
      }
      return json({ groups: [] }, 200, 'ordered-user');
    }));
    await initializeAuthLifecycle({ networkOnly: true, clerkUserId: 'clerk-ordered' });
    const events: string[] = [];
    const stopAuth = subscribeAuthLifecycle(() => events.push(`auth:${getAuthLifecycle().status}`));
    const stopConnection = subscribeConnectionState(() => events.push(`connection:${getConnectionState().status}`));

    signalConnectionChecking();
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-ordered', sessionId: 'session-ordered' }, { networkOnly: true });
    stopAuth();
    stopConnection();

    expect(getAuthLifecycle().status).toBe('trusted-offline');
    expect(getConnectionState().status).toBe('connection-issue');
    expect(meCalls).toBe(2);
    expect(events.indexOf('auth:trusted-offline')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('auth:trusted-offline')).toBeLessThan(events.indexOf('connection:connection-issue'));
    expect(events.filter((event) => event === 'auth:reverifying')).toHaveLength(1);
  });

  it('retains stable server details and distinguishes network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'GROUP_NOT_FOUND', message: 'No such group' } }, 404)));
    await expect(api('/groups/missing')).rejects.toMatchObject({ status: 404, code: 'GROUP_NOT_FOUND', serverMessage: 'No such group', networkFailure: false });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const failure = await api('/groups').catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: 'NETWORK_ERROR', networkFailure: true, isNetworkError: true });
  });

  it('does not authorize groups from legacy split identity records when the network fails', async () => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    await saveGroups({ userId: 'user-a', groups: [{ id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '' }], cachedAt: new Date().toISOString() });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(getGroups()).rejects.toMatchObject({ networkFailure: true });
    await saveVerifiedIdentity({ userId: 'user-b', email: 'b@example.com', personId: 'person-b', verifiedAt: new Date().toISOString() });
    await expect(getGroups()).rejects.toMatchObject({ networkFailure: true });
  });

  it('persists user-scoped home balance summaries and leaves legacy rows unavailable', async () => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me')
      ? json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a')
      : json({ groups: [
        { id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '', balanceSummaries: [{ currency: 'USD', netMinor: 500 }] },
        { id: 'legacy', name: 'Legacy', currency: 'EUR', createdAt: '', updatedAt: '' },
      ] }, 200, 'user-a')));
    const result = await getGroups();
    expect(result.groups[0].balanceSummaries).toEqual([{ currency: 'USD', netMinor: 500 }]);
    expect(result.groups[1].balanceSummaries).toBeUndefined();
    expect((await readGroups('user-a'))?.groups[0].balanceSummaries).toEqual([{ currency: 'USD', netMinor: 500 }]);
  });

  it('does not let an in-flight groups response undo a persisted mutation invalidation', async () => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    await saveGroups({ userId: 'user-a', groups: [{ id: 'old', name: 'Old', currency: 'USD', createdAt: '', updatedAt: '' }], cachedAt: 'old' });
    let resolveGroups!: (response: Response) => void;
    let groupsStarted!: () => void;
    const started = new Promise<void>((resolve) => { groupsStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) return json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a');
      groupsStarted();
      return new Promise<Response>((resolve) => { resolveGroups = resolve; });
    }));

    const request = getGroups();
    await started;
    await invalidateForMutation.expenseChanged('group-a', undefined, 'user-a');
    resolveGroups(json({ groups: [{ id: 'stale', name: 'Stale', currency: 'USD', createdAt: '', updatedAt: '' }] }, 200, 'user-a'));

    await expect(request).resolves.toMatchObject({ groups: [{ id: 'stale' }], stale: true });
    expect((await readGroups('user-a'))?.groups[0].id).toBe('old');
    expect((await readGroups('user-a'))?.cachedAt).toBe('1970-01-01T00:00:00.000Z');
    expect((await readResourceFreshness('user-a', 'groups'))?.fetchedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it.each([
    ['leave', (groupId: string, userId: string) => invalidateForMutation.groupLeft(groupId, userId)],
    ['delete', (groupId: string, userId: string) => invalidateForMutation.groupDeleted(groupId, userId)],
    ['access revocation', (groupId: string, userId: string) => invalidateForMutation.groupAccessRevoked(groupId, userId)],
  ])('does not let an in-flight transaction response repopulate after %s', async (_name, invalidate) => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    await updateGroupSnapshot('user-a', 'group-a', { transactions: [] });
    let resolveTransactions!: (response: Response) => void;
    let transactionsStarted!: () => void;
    const started = new Promise<void>((resolve) => { transactionsStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) return json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a');
      transactionsStarted();
      return new Promise<Response>((resolve) => { resolveTransactions = resolve; });
    }));

    const request = getTransactions('group-a');
    await started;
    await invalidate('group-a', 'user-a');
    resolveTransactions(json({ transactions: [{ kind: 'expense', id: 'late', groupId: 'group-a', description: 'Late', amountMinor: 100, currency: 'USD', date: '2026-01-01', category: null, notes: null, createdBy: 'user-a', createdAt: '2026-01-01T00:00:00.000Z', clientOperationId: null }] }, 200, 'user-a'));

    await expect(request).resolves.toMatchObject({ transactions: [{ id: 'late' }], stale: true });
    expect(await readGroupSnapshot('user-a', 'group-a')).toBeUndefined();
  });

  it('does not persist an in-flight paged transaction response after mutation invalidation', async () => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    await updateGroupSnapshot('user-a', 'group-a', { transactions: [] });
    let resolveTransactions!: (response: Response) => void;
    let transactionsStarted!: () => void;
    const started = new Promise<void>((resolve) => { transactionsStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      transactionsStarted();
      return new Promise<Response>((resolve) => { resolveTransactions = resolve; });
    }));

    const request = getTransactionPage('group-a');
    await started;
    await invalidateForMutation.expenseChanged('group-a', undefined, 'user-a');
    resolveTransactions(json({ transactions: [{ kind: 'expense', id: 'late-page', groupId: 'group-a', description: 'Late', amountMinor: 100, currency: 'USD', date: '2026-01-01', category: null, notes: null, createdBy: 'user-a', createdAt: '2026-01-01T00:00:00.000Z', clientOperationId: null }] }, 200, 'user-a'));

    await expect(request).resolves.toMatchObject({ transactions: [{ id: 'late-page' }], stale: true });
    expect((await readGroupSnapshot('user-a', 'group-a'))?.transactions).toBeUndefined();
    expect((await readResourceFreshness('user-a', 'group:group-a:transactions'))?.fetchedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('keeps filtered transaction requests on the API path instead of using the unfiltered cache', async () => {
    await updateGroupSnapshot('user-a', 'group-a', { transactions: [] });
    const fetchSpy = vi.fn(async (_request: RequestInfo | URL) => { throw new TypeError('network unavailable'); });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(getTransactionPage('group-a', { q: 'dinner', kind: 'expense' })).rejects.toThrow('Connection issue');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/groups/group-a/transactions?limit=25&kind=expense&q=dinner');
    await expect(getTransactionPage('group-a', { category: 'Dining' })).rejects.toThrow('Connection issue');
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain('/api/groups/group-a/transactions?limit=25&category=Dining');
    await expect(getTransactionPage('group-a', { kind: 'settlement', category: 'Dining' })).rejects.toThrow('Connection issue');
    expect(String(fetchSpy.mock.calls[2]?.[0])).toContain('/api/groups/group-a/transactions?limit=25&kind=settlement');
    expect(String(fetchSpy.mock.calls[2]?.[0])).not.toContain('category=');
    await expect(getTransactions('group-a', undefined, { q: 'dinner' })).rejects.toThrow();
  });

  it('persists a successful unfiltered transaction first page for overview restore', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      transactions: [{ kind: 'expense', id: 'cached-transaction', groupId: 'group-a', description: 'Dinner', amountMinor: 1200, currency: 'USD', date: '2026-08-24', category: null, notes: null, createdBy: 'user-a', createdAt: '2026-08-24T00:00:00.000Z', clientOperationId: null }],
      nextCursor: 'next-page',
    }, 200, 'user-a')));

    const page = await getTransactionPage('group-a', { limit: 5 });

    expect(page).toMatchObject({ transactions: [{ id: 'cached-transaction' }], nextCursor: 'next-page' });
    expect(await readGroupSnapshot('user-a', 'group-a')).toMatchObject({
      transactions: [{ id: 'cached-transaction' }],
      transactionsNextCursor: 'next-page',
      transactionsLimit: 5,
    });
  });

  it('preserves a canonical history page when the overview fetches five rows afterward', async () => {
    const transaction = (id: string) => ({ kind: 'expense', id, groupId: 'group-a', description: id, amountMinor: 100, currency: 'USD', date: '2026-08-24', category: null, notes: null, createdBy: 'user-a', createdAt: '2026-08-24T00:00:00.000Z', clientOperationId: null });
    const history = Array.from({ length: 25 }, (_, index) => transaction(`history-${index}`));
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(String(request), 'https://billsplit.test');
      if (url.pathname.endsWith('/me')) return json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a');
      return url.searchParams.get('limit') === '5'
        ? json({ transactions: history.slice(0, 5), nextCursor: 'overview-next' }, 200, 'user-a')
        : json({ transactions: history, nextCursor: 'history-next' }, 200, 'user-a');
    }));

    await getTransactions('group-a');
    await getTransactionPage('group-a', { limit: 5 });

    const snapshot = await readGroupSnapshot('user-a', 'group-a');
    expect(snapshot?.transactions).toHaveLength(25);
    expect(snapshot?.transactionsLimit).toBe(25);
    expect(snapshot?.transactionsNextCursor).toBe('history-next');
    await expect(hydrateTransactions('user-a', 'group-a')).resolves.toMatchObject({ data: { transactions: expect.arrayContaining([expect.objectContaining({ id: 'history-24' })]) } });
  });

  it('allows overview hydration from an overview-only cache without hydrating incomplete history', async () => {
    const transactions = Array.from({ length: 5 }, (_, index) => ({ kind: 'expense', id: `overview-${index}`, groupId: 'group-a', description: `Overview ${index}`, amountMinor: 100, currency: 'USD', date: '2026-08-24', category: null, notes: null, createdBy: 'user-a', createdAt: '2026-08-24T00:00:00.000Z', clientOperationId: null }));
    vi.stubGlobal('fetch', vi.fn(async () => json({ transactions, nextCursor: 'overview-next' }, 200, 'user-a')));

    await getTransactionPage('group-a', { limit: 5 });

    await expect(hydrateTransactionOverview('user-a', 'group-a')).resolves.toMatchObject({ data: { transactions: [{ id: 'overview-0' }, { id: 'overview-1' }, { id: 'overview-2' }, { id: 'overview-3' }, { id: 'overview-4' }] } });
    await expect(hydrateTransactions('user-a', 'group-a')).resolves.toBeUndefined();
  });

  it('removes persisted global activity and categories after an expense mutation', async () => {
    await saveGroups({ userId: 'user-a', groups: [], cachedAt: new Date().toISOString() });
    await saveActivity({ userId: 'user-a', groupId: 'all', activity: [], fetchedAt: new Date().toISOString() });
    await saveCategories({ userId: 'user-a', categories: ['Dining'], fetchedAt: new Date().toISOString() });

    await invalidateForMutation.expenseChanged('group-a', 'expense-a', 'user-a');

    expect(await readActivity('user-a', 'all')).toBeUndefined();
    expect(await readCategories('user-a')).toBeUndefined();
  });

  it('invalidates in-memory and persisted categories after a scheduled-expense mutation', async () => {
    await saveCategories({ userId: 'user-a', categories: ['Custom rent'], fetchedAt: new Date().toISOString() });
    seedResource('categories:user-a', 'user-a', { categories: ['Custom rent'] });

    await invalidateForMutation.scheduledExpenseChanged('group-a', 'user-a', 'schedule-a');

    expect(getResourceSnapshot('categories:user-a', 'user-a').stale).toBe(true);
    expect(await readCategories('user-a')).toBeUndefined();
  });

  it('does not label a resource with cached identity after a transient /me failure', async () => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    await saveGroups({ userId: 'user-a', groups: [{ id: 'old', name: 'Old', currency: 'USD', createdAt: '', updatedAt: '' }], cachedAt: 'old' });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => { const path = String(request); if (path.endsWith('/me')) throw new TypeError('temporary'); return json({ groups: [{ id: 'new', name: 'New', currency: 'USD', createdAt: '', updatedAt: '' }] }); }));
    await expect(getGroups()).resolves.toMatchObject({ groups: [{ id: 'new' }] });
    expect((await readGroups('user-a'))?.groups[0].id).toBe('old');
  });

  it('writes account-switched resources only under the newly verified user', async () => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    await saveGroups({ userId: 'user-a', groups: [{ id: 'old', name: 'Old', currency: 'USD', createdAt: '', updatedAt: '' }], cachedAt: 'old' });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me') ? json({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }, 200, 'user-b') : json({ groups: [{ id: 'new', name: 'New', currency: 'USD', createdAt: '', updatedAt: '' }] }, 200, 'user-b')));
    await getGroups();
    expect((await readGroups('user-a'))?.groups[0].id).toBe('old');
    expect((await readGroups('user-b'))?.groups[0].id).toBe('new');
  });

  it('reconciles a server expense carrying the normalized operation id', async () => {
    resetForClerkSessionChange();
    clearSessionLogout();
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a', 'clerk-a')));
    await initializeAuthLifecycle({ networkOnly: true, clerkUserId: 'clerk-a' });
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    await saveGroups({ userId: 'user-a', groups: [{ id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '' }], cachedAt: new Date().toISOString() });
    await enqueueExpense({ userId: 'user-a', groupId: 'group-a', clientOperationId: 'op-1', payload: { description: 'Lunch', amount_minor: 100, currency: 'USD', date: '2026-01-01', payers: [{ person_id: 'person-a', amount_minor: 100 }], splits: [{ person_id: 'person-a', amount_minor: 100 }], client_operation_id: 'op-1' }, display: { description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01' } });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me') ? json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a') : json({ expenses: [{ id: 'server', groupId: 'group-a', createdBy: 'user-a', clientOperationId: 'op-1' }] }, 200, 'user-a')));
    await getExpenses('group-a');
    expect(await listOutbox('user-a')).toEqual([]);
    expect((await readGroups('user-a'))?.cachedAt).toBe('1970-01-01T00:00:00.000Z');
    expect((await readResourceFreshness('user-a', 'groups'))?.fetchedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('reconciles committed expenses from every authorized group in global transactions', async () => {
    resetForClerkSessionChange();
    clearSessionLogout();
    const identity = { id: 'user-a', email: 'a@example.com', personId: 'person-a' };
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me') ? json(identity, 200, 'user-a', 'clerk-a') : json({ transactions: [] }, 200, 'user-a', 'clerk-a')));
    await initializeAuthLifecycle({ networkOnly: true, clerkUserId: 'clerk-a' });
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    const queue = (groupId: string, clientOperationId: string) => enqueueExpense({ userId: 'user-a', groupId, clientOperationId, payload: { description: 'Lunch', amount_minor: 100, currency: 'USD', date: '2026-01-01', payers: [{ person_id: 'person-a', amount_minor: 100 }], splits: [{ person_id: 'person-a', amount_minor: 100 }], client_operation_id: clientOperationId }, display: { description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01' } });
    await queue('group-a', 'op-a');
    await queue('group-b', 'op-b');
    await queue('group-not-returned', 'op-not-returned');
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) return json(identity, 200, 'user-a', 'clerk-a');
      const expense = (groupId: string, clientOperationId: string) => ({ kind: 'expense', id: `server-${clientOperationId}`, groupId, description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01', category: null, notes: null, createdBy: 'user-a', createdAt: '2026-01-01T00:00:00.000Z', clientOperationId });
      return json({ transactions: [expense('group-a', 'op-a'), expense('group-b', 'op-b')] }, 200, 'user-a', 'clerk-a');
    }));

    await getGlobalTransactionPage(undefined);

    expect((await listOutbox('user-a')).map((item) => item.clientOperationId)).toEqual(['op-not-returned']);
  });

  it('does not hammer identity after an auth failure blocks the gate', async () => {
    clearAuthRequired();
    let meCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) { meCalls += 1; return json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in' } }, 401); }
      return json({ groups: [] });
    }));
    await expect(getGroups()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(getGroups()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(meCalls).toBe(1);
    clearAuthRequired();
  });

  it('keeps Clerk destinations relative and rejects protected paths', () => {
    expect(sanitizeReturnTo('/groups/g-1?tab=activity#ledger')).toBe('/groups/g-1?tab=activity#ledger');
    expect(sanitizeReturnTo('https://evil.test/')).toBe('/');
    expect(sanitizeReturnTo('/api/me')).toBe('/');
  });

  it('publishes the authenticated lifecycle only after a verified identity response', async () => {
    await clearEverythingForLogout(false);
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'user-auth', email: 'auth@example.com', personId: 'person-auth' }, 200, 'user-auth', 'clerk-auth')));
    await initializeAuthLifecycle({ clerkUserId: 'clerk-auth' });
    expect(getAuthLifecycle()).toEqual({ status: 'authenticated' });
    expect(await readOfflineTrust()).toMatchObject({ state: 'active', clerkUserId: 'clerk-auth', userId: 'user-auth' });
    await clearEverythingForLogout(false);
    expect(getAuthLifecycle().status).toBe('unauthenticated');
  });

  it('recovers a missing application session without invalidating complete Clerk evidence', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    vi.stubGlobal('navigator', { onLine: true });
    const calls: Array<{ path: string; method: string }> = [];
    let epochAtInitialFailure: number | undefined;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request), 'https://billsplit.test');
      calls.push({ path: url.pathname, method: init?.method || 'GET' });
      if (url.pathname === '/api/me' && calls.filter((call) => call.path === '/api/me').length === 1) {
        epochAtInitialFailure = getAuthEpoch();
        return json({ error: { code: 'AUTH_REQUIRED', message: 'Application session required' } }, 401);
      }
      if (url.pathname === '/api/session/bootstrap') return json({ idleExpiresAt: '2026-09-29T00:00:00.000Z' });
      return json({ id: 'recovered-user', email: 'recovered@example.com', personId: 'recovered-person' }, 200, 'recovered-user', 'clerk-session-recovery');
    }));

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-session-recovery', sessionId: 'session-session-recovery' }, { networkOnly: true })).resolves.toMatchObject({ status: 'authenticated' });

    expect(calls).toEqual([
      { path: '/api/me', method: 'GET' },
      { path: '/api/session/bootstrap', method: 'POST' },
      { path: '/api/me', method: 'GET' },
    ]);
    expect(getAuthEpoch()).toBe(epochAtInitialFailure);
    expect(getAuthState().required).toBe(false);
    expect(getAuthLifecycle().status).toBe('authenticated');
  });

  it('does not create trust from a client-only Clerk pairing', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'user-auth', email: 'auth@example.com', personId: 'person-auth' }, 200, 'user-auth')));
    await expect(initializeAuthLifecycle({ clerkUserId: 'clerk-auth', startupFallbackMs: 10 })).resolves.toMatchObject({ status: 'verification-unavailable' });
    expect(await readOfflineTrust()).not.toMatchObject({ state: 'active' });
  });

  it('lets a newer Clerk account win over a late completion from account A', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    let resolveA!: (value: Response) => void;
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Promise<Response>((resolve) => { resolveA = resolve; });
      return json({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }, 200, 'user-b', 'clerk-b');
    }));
    const initA = initializeAuthLifecycle({ clerkUserId: 'clerk-a', startupFallbackMs: 100 });
    await vi.waitFor(() => expect(calls).toBe(1));
    resetForClerkSessionChange();
    const initB = initializeAuthLifecycle({ clerkUserId: 'clerk-b', startupFallbackMs: 100 });
    resolveA(json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a', 'clerk-a'));
    await Promise.all([initA, initB]);
    expect(getAuthLifecycle()).toMatchObject({ status: 'authenticated' });
    expect((await readOfflineTrust())?.clerkUserId).toBe('clerk-b');
    expect((await readOfflineTrust())?.userId).toBe('user-b');
  });

  it('ignores a late old-epoch 401 after the new account is authenticated', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    let resolveOld!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/api/me')) return json({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }, 200, 'user-b', 'clerk-b');
      return new Promise<Response>((resolve) => { resolveOld = resolve; });
    }));
    const oldEpoch = getAuthEpoch();
    const oldRequest = api('/groups', undefined, oldEpoch);
    resetForClerkSessionChange();
    await initializeAuthLifecycle({ clerkUserId: 'clerk-b', startupFallbackMs: 100 });
    resolveOld(json({ error: { code: 'AUTH_REQUIRED', message: 'old session' } }, 401));
    await expect(oldRequest).rejects.toMatchObject({ status: 401 });
    expect(getAuthLifecycle()).toMatchObject({ status: 'authenticated' });
    expect(getAuthState().required).toBe(false);
  });

  it('does not persist a Clerk user ID when /api/me is not verified', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in' } }, 401)));
    await expect(initializeAuthLifecycle({ clerkUserId: 'clerk-unverified' })).resolves.toMatchObject({ status: 'unauthenticated' });
    expect(await readLastVerifiedClerkUserId()).toBeUndefined();
    expect(getTrustedOfflineClerkUserId()).toBeUndefined();
  });

  it('only uses a timed-out identity cache when the persisted Clerk ID matches', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'cached-user', email: 'cached@example.com', personId: 'cached-person', clerkUserId: 'clerk-a', verifiedAt: new Date().toISOString() });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
    })));

    await expect(initializeAuthLifecycle({ clerkUserId: 'clerk-a', startupFallbackMs: 1 })).resolves.toMatchObject({ status: 'trusted-offline' });
    expect(getResourceSnapshot('identity').data).toMatchObject({ id: 'cached-user' });
    expect(getConnectionState()).toMatchObject({ status: 'connection-issue', reconnectRequired: true });
  });

  it.each([
    { label: 'a mismatching Clerk ID', clerkUserId: 'clerk-b' },
    { label: 'an absent persisted Clerk association', clerkUserId: 'clerk-a', omitPersistedClerkId: true },
    { label: 'an absent current Clerk ID', clerkUserId: undefined },
  ])('does not use cached identity after timeout with $label', async ({ clerkUserId, omitPersistedClerkId }) => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    if (!omitPersistedClerkId && clerkUserId !== undefined) await saveOfflineTrust({ userId: 'cached-user', email: 'cached@example.com', personId: 'cached-person', clerkUserId: 'clerk-a', verifiedAt: new Date().toISOString() });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
    })));

    await expect(initializeAuthLifecycle({ ...(clerkUserId === undefined ? {} : { clerkUserId }), startupFallbackMs: 1 })).resolves.toMatchObject({ status: 'verification-unavailable' });
    expect(getResourceSnapshot('identity').data).toBeUndefined();
  });

  it('preserves trusted offline state until connectivity returns, then supports explicit revalidation', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'offline-user', email: 'offline@example.com', personId: 'offline-person', clerkUserId: 'clerk-a', verifiedAt: new Date().toISOString() });
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(initializeAuthLifecycle()).resolves.toMatchObject({ status: 'trusted-offline' });
    expect(getAuthLifecycle().status).toBe('trusted-offline');
    expect(getConnectionState().status).toBe('offline');
    expect(getTrustedOfflineClerkUserId()).toBe('clerk-a');
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-a', getTrustedOfflineClerkUserId())).toBe(false);
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-b', getTrustedOfflineClerkUserId())).toBe(true);
    revokeForClerkSessionChange();
    expect(getAuthLifecycle().status).toBe('verification-unavailable');
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'offline-user', email: 'offline@example.com', personId: 'offline-person' }, 200, 'offline-user')));
    await expect(initializeAuthLifecycle({ networkOnly: true })).resolves.toMatchObject({ status: 'authenticated' });
    await clearEverythingForLogout(false);
    expect(await readLastVerifiedClerkUserId()).toBeUndefined();
    expect(getTrustedOfflineClerkUserId()).toBeUndefined();
  });

  it('automatically resolves a cleaned logout barrier on definitive signed-out evidence', async () => {
    finalizeSuccessfulClerkSignOut();
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'old-user', email: 'old@example.com', personId: 'old-person' }, 200, 'old-user', 'old-clerk')));
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'old-clerk', sessionId: 'old-session' });
    await clearEverythingForLogout(false);
    expect(getSessionLogoutInProgress()).toBe(true);
    expect(isMutationBarrierActive()).toBe(true);
    const before = captureSessionGeneration();
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'old-clerk', sessionId: 'old-session' });
    expect(getSessionLogoutInProgress()).toBe(true);
    expect(isMutationBarrierActive()).toBe(true);
    expect(captureSessionGeneration()).toBe(before);
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: false });
    expect(getSessionLogoutInProgress()).toBe(false);
    expect(isMutationBarrierActive()).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'retry-user', email: 'retry@example.com', personId: 'retry-person' }, 200, 'retry-user', 'retry-clerk')));
    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'retry-clerk', sessionId: 'retry-session' })).resolves.toMatchObject({ status: 'authenticated' });
    await clearEverythingForLogout(false);
  });

  it('explicitly broadcasts logout-clear after successful local cleanup', async () => {
    await clearEverythingForLogout(false);
    expect(getSessionLogoutInProgress()).toBe(true);
    expect(finalizeSuccessfulClerkSignOut()).toBe(true);
    expect(getSessionLogoutInProgress()).toBe(false);
    expect(isMutationBarrierActive()).toBe(false);
  });

  it('releases only its own barrier when Clerk sign-out fails after local cleanup', async () => {
    await establishAuthenticatedMutationSession('clerk-local-logout');
    await clearEverythingForLogout(false);
    expect(getSessionLogoutInProgress()).toBe(true);

    recoverAfterClerkSignOutFailure(new Error('provider unavailable'));

    expect(getSessionLogoutInProgress()).toBe(false);
    expect(isMutationBarrierActive()).toBe(false);
    expect(getAuthState()).toMatchObject({ required: true, code: 'AUTH_REQUIRED' });
    expect(getAuthLifecycle()).toMatchObject({ status: 'unauthenticated' });
  });

  it('keeps the old wake blocked but automatically recovers for a complete new Clerk session', async () => {
    clearSessionLogout();
    clearAuthRequired();
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'rotation-user', email: 'rotation@example.com', personId: 'rotation-person' }, 200, 'rotation-user', 'clerk-rotation')));
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-rotation', sessionId: 'logout-session-old' });
    await clearEverythingForLogout(false);

    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-rotation', sessionId: 'logout-session-old' });
    expect(getSessionLogoutInProgress()).toBe(true);

    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-rotation', sessionId: 'logout-session-new' });
    expect(getSessionLogoutInProgress()).toBe(false);
    expect(isMutationBarrierActive()).toBe(false);
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-rotation', sessionId: 'logout-session-new' });
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: false });
  });

  it('invalidates prior identity memory before re-verifying a changed Clerk session', async () => {
    await clearEverythingForLogout(false);
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a')));
    await initializeAuthLifecycle();
    resetForClerkSessionChange();
    expect(getAuthLifecycle().status).toBe('checking');
    expect(getAuthState()).toMatchObject({ required: false });
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }, 200, 'user-b')));
    await expect(initializeAuthLifecycle()).resolves.toMatchObject({ status: 'authenticated' });
    await clearEverythingForLogout(false);
  });

  it('rejects delayed groups, activity, and detail responses after logout before any cache write', async () => {
    await clearEverythingForLogout(false);
    clearAuthRequired();
    await saveVerifiedIdentity({ userId: 'race-user', email: 'race@example.com', personId: 'race-person', verifiedAt: new Date().toISOString() });
    const resolvers = new Map<string, (response: Response) => void>();
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const path = String(request);
      if (path.endsWith('/me')) return json({ id: 'race-user', email: 'race@example.com', personId: 'race-person' }, 200, 'race-user');
      const key = path.includes('/activity') ? 'activity' : path.includes('/expenses/') ? 'detail' : 'groups';
      return new Promise<Response>((resolve) => resolvers.set(key, resolve));
    }));
    const requests = [getGroups(), getActivity('group-race'), getExpenseDetails('expense-race')];
    await vi.waitFor(() => expect(resolvers.size).toBe(3));
    await clearEverythingForLogout(false);
    for (const [key, resolve] of resolvers) resolve(key === 'groups' ? json({ groups: [] }, 200, 'race-user') : key === 'activity' ? json({ activity: [] }, 200, 'race-user') : json({ expense: {}, history: [] }, 200, 'race-user'));
    const settled = await Promise.allSettled(requests);
    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    expect(await readGroups('race-user')).toBeUndefined();
    expect(await readActivity('race-user', 'group-race')).toBeUndefined();
    expect(await readExpenseDetails('race-user', 'expense-race')).toBeUndefined();
  });

  it('revokes private memory on a Clerk 403 and does not fall back to cached data', async () => {
    await clearEverythingForLogout(false);
    clearAuthRequired();
    await saveVerifiedIdentity({ userId: 'revoked-user', email: 'revoked@example.com', personId: 'revoked-person', verifiedAt: new Date().toISOString() });
    seedResource('groups:revoked-user', 'revoked-user', { groups: [{ id: 'cached-group', name: 'Cached', currency: 'USD', createdAt: '', updatedAt: '' }] });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me')
      ? json({ id: 'revoked-user', email: 'revoked@example.com', personId: 'revoked-person' }, 200, 'revoked-user')
       : json({ error: { code: 'CLERK_FORBIDDEN', message: 'Clerk denied the session' } }, 403)));
    await expect(getGroups()).rejects.toMatchObject({ status: 403, code: 'AUTH_REQUIRED' });
    expect(getResourceSnapshot('groups:revoked-user', 'revoked-user').data).toBeUndefined();
    await expect(getGroups()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('waits for a foreground mutation to settle after abort before logout clears data', async () => {
     await establishAuthenticatedMutationSession('clerk-mutation');
     clearAuthRequired();
    let started!: () => void;
    let resolveMutation!: (response: Response) => void;
    let aborted = false;
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      resolveMutation = resolve;
      started();
      init?.signal?.addEventListener('abort', () => { aborted = true; });
    })));
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const mutation = api('/groups', { method: 'POST', signal: controller.signal, body: '{}' });
    await startedPromise;
    const logout = clearEverythingForLogout(false);
    controller.abort();
    await vi.waitFor(() => expect(aborted).toBe(true));
    let logoutSettled = false;
    void logout.finally(() => { logoutSettled = true; });
    await Promise.resolve();
    expect(logoutSettled).toBe(false);
    resolveMutation(json({ group: { id: 'committed-after-abort' } }, 201));
    await mutation;
    await logout;
  });

  it('rejects a stale /me commit after an adopted logout fences trust and identity', async () => {
    clearSessionLogout();
    clearAuthRequired();
    let resolveMe!: (result: Response) => void;
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me')
      ? new Promise<Response>((resolve) => { resolveMe = resolve; })
      : json({})));
    const probe = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-stale', sessionId: 'stale-session' }, { force: true });
    await vi.waitFor(() => expect(resolveMe).toBeTypeOf('function'));
    const adoptedGeneration = captureSessionGeneration() + 1;
    adoptSessionGeneration(adoptedGeneration);
    resolveMe(json({ id: 'stale-user', email: 'stale@example.com', personId: 'stale-person' }, 200, 'stale-user', 'clerk-stale'));
    await probe;
    expect(getResourceSnapshot('identity').data).toBeUndefined();
    expect(getSessionLogoutInProgress()).toBe(true);
    clearSessionLogout(adoptedGeneration, true, true);
    releaseMutationBarrier(adoptedGeneration);
  });

  it('blocks a new mutation after a cross-tab logout barrier is adopted', async () => {
    const fetch = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    adoptSessionGeneration(captureSessionGeneration() + 1);
    await expect(api('/groups', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'LOGOUT_IN_PROGRESS' });
    expect(fetch).not.toHaveBeenCalled();
    recoverAfterClerkSignOutFailure(new Error('local sign-out callback raced a remote barrier'));
    expect(getSessionLogoutInProgress()).toBe(true);
    clearSessionLogout(captureSessionGeneration(), true, true);
    releaseMutationBarrier();
  });
});
