import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, changeScheduledExpenseStatus, clearAuthRequired, clearEverythingForLogout, createScheduledExpense, getActivity, getAuthLifecycle, getAuthState, getConnectionState, getExpenseDetails, getExpenses, getGroups, getScheduledExpenses, getTrustedOfflineClerkUserId, initializeAuthLifecycle, isDefinitivelySignedOut, isMeaningfulClerkSessionTransition, recoverAfterClerkSignOutFailure, resetForClerkSessionChange, revokeForClerkSessionChange, sanitizeReturnTo, shouldRevokeForOfflineClerkUser, shouldReverifyTrustedOffline, shouldStartAuthCheck, subscribeAuthState } from './api';
import { enqueueExpense } from './outbox';
import { DB_NAME, listOutbox, readActivity, readCategories, readExpenseDetails, readGroups, readLastVerifiedClerkUserId, readResourceFreshness, saveActivity, saveCategories, saveGroups, saveLastVerifiedClerkUserId, saveVerifiedIdentity } from './idb';
import { getResourceSnapshot, invalidateForMutation, seedResource } from './resource-cache';
import { adoptSessionGeneration, captureSessionGeneration, clearSessionLogout, getSessionLogoutInProgress } from './session';
import { isMutationBarrierActive, releaseMutationBarrier } from './mutation-quiescence';

const json = (body: unknown, status = 200, userId?: string) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(userId ? { 'X-BillSplit-User-Id': userId } : {}) } });

beforeEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(DB_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => resolve(); });
});

describe('frontend API errors and cache fallback', () => {
  it('allows trusted offline startup before Clerk has loaded but gates online startup', () => {
    expect(shouldStartAuthCheck(false, false)).toBe(true);
    expect(shouldStartAuthCheck(false, true)).toBe(true);
    expect(shouldStartAuthCheck(true, false)).toBe(false);
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
  it('does not revoke a fast Clerk load while last Clerk ID hydration is pending', () => {
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-fast', undefined, false)).toBe(false);
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-fast', undefined, true)).toBe(true);
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-fast', 'clerk-fast', true)).toBe(false);
  });
  it('caches the typed activity payload without losing entity context', async () => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me')
      ? json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a')
      : json({ activity: [{ type: 'expense_revision', id: 'revision-1', entityId: 'expense-1', entity_active: 1, amountMinor: 1250, currency: 'USD', transactionDate: '2026-01-02', label: 'Lunch', createdAt: '2026-01-03T00:00:00Z' }] }, 200, 'user-a')));
    const result = await getActivity('group-a');
    expect(result.activity[0]).toMatchObject({ type: 'expense_revision', id: 'revision-1', entityId: 'expense-1', entityActive: true, amountMinor: 1250 });
    expect((await readActivity('user-a', 'group-a'))?.activity[0].entityId).toBe('expense-1');
  });

  it('does not display deleted activity or inactive cached revisions from an API response', async () => {
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

  it('loads every scheduled-expense page beyond the D1-sized API page', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(String(request), 'https://billsplit.test');
      calls.push(url.search);
      const offset = Number(url.searchParams.get('offset') || 0);
      const count = offset === 0 ? 100 : 2;
      return json({ scheduledExpenses: Array.from({ length: count }, (_, index) => ({ id: `schedule-${offset + index}` })) }, 200, 'user-a');
    }));
    const result = await getScheduledExpenses('group-a');
    expect(result.scheduledExpenses).toHaveLength(102);
    expect(calls).toEqual(['?limit=100&offset=0', '?limit=100&offset=100']);
  });

  it('marks API calls as AJAX requests and publishes auth-required state', async () => {
    const listener = vi.fn();
    const authEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: authEvent });
    const unsubscribe = subscribeAuthState(listener);
    vi.stubGlobal('fetch', vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => { expect(new Headers(init?.headers).get('X-Requested-With')).toBe('XMLHttpRequest'); expect(init?.credentials).toBe('same-origin'); return json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in' } }, 401); }));
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
    expect(getConnectionState()).toEqual({ reconnectRequired: true });
  });

  it('keeps an HTML 503 as a retryable server failure rather than auth-required', async () => {
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>upstream unavailable</body></html>', { status: 503, headers: { 'Content-Type': 'text/html' } })));
    await expect(api('/groups')).rejects.toMatchObject({ status: 503, code: 'SERVER_ERROR', networkFailure: false });
    expect(getAuthState().required).toBe(false);
  });

  it('retains stable server details and distinguishes network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'GROUP_NOT_FOUND', message: 'No such group' } }, 404)));
    await expect(api('/groups/missing')).rejects.toMatchObject({ status: 404, code: 'GROUP_NOT_FOUND', serverMessage: 'No such group', networkFailure: false });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const failure = await api('/groups').catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: 'NETWORK_ERROR', networkFailure: true, isNetworkError: true });
  });

  it('reads only the last verified user’s groups when the network fails', async () => {
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    await saveGroups({ userId: 'user-a', groups: [{ id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '' }], cachedAt: new Date().toISOString() });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(getGroups()).resolves.toMatchObject({ groups: [{ id: 'group-a' }], offline: true, stale: true });
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
    await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
    await saveGroups({ userId: 'user-a', groups: [{ id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '' }], cachedAt: new Date().toISOString() });
    await enqueueExpense({ userId: 'user-a', groupId: 'group-a', clientOperationId: 'op-1', payload: { description: 'Lunch', amount_minor: 100, currency: 'USD', date: '2026-01-01', payers: [{ person_id: 'person-a', amount_minor: 100 }], splits: [{ person_id: 'person-a', amount_minor: 100 }], client_operation_id: 'op-1' }, display: { description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01' } });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me') ? json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a') : json({ expenses: [{ id: 'server', groupId: 'group-a', createdBy: 'user-a', clientOperationId: 'op-1' }] }, 200, 'user-a')));
    await getExpenses('group-a');
    expect(await listOutbox('user-a')).toEqual([]);
    expect((await readGroups('user-a'))?.cachedAt).toBe('1970-01-01T00:00:00.000Z');
    expect((await readResourceFreshness('user-a', 'groups'))?.fetchedAt).toBe('1970-01-01T00:00:00.000Z');
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
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'user-auth', email: 'auth@example.com', personId: 'person-auth' }, 200, 'user-auth')));
    await initializeAuthLifecycle({ clerkUserId: 'clerk-auth' });
    expect(getAuthLifecycle()).toEqual({ status: 'authenticated' });
    expect(await readLastVerifiedClerkUserId()).toMatchObject({ clerkUserId: 'clerk-auth' });
    await clearEverythingForLogout(false);
    expect(getAuthLifecycle().status).toBe('unauthenticated');
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
    await saveVerifiedIdentity({ userId: 'cached-user', email: 'cached@example.com', personId: 'cached-person', verifiedAt: new Date().toISOString() });
    await saveLastVerifiedClerkUserId('clerk-a');
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
    })));

    await expect(initializeAuthLifecycle({ clerkUserId: 'clerk-a', startupFallbackMs: 1 })).resolves.toMatchObject({ status: 'trusted-offline' });
    expect(getResourceSnapshot('identity').data).toMatchObject({ id: 'cached-user' });
  });

  it.each([
    { label: 'a mismatching Clerk ID', clerkUserId: 'clerk-b' },
    { label: 'an absent persisted Clerk association', clerkUserId: 'clerk-a', omitPersistedClerkId: true },
    { label: 'an absent current Clerk ID', clerkUserId: undefined },
  ])('does not use cached identity after timeout with $label', async ({ clerkUserId, omitPersistedClerkId }) => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    await saveVerifiedIdentity({ userId: 'cached-user', email: 'cached@example.com', personId: 'cached-person', verifiedAt: new Date().toISOString() });
    if (!omitPersistedClerkId && clerkUserId !== undefined) await saveLastVerifiedClerkUserId('clerk-a');
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
    })));

    await expect(initializeAuthLifecycle({ ...(clerkUserId === undefined ? {} : { clerkUserId }), startupFallbackMs: 1 })).resolves.toMatchObject({ status: 'unauthenticated' });
    expect(getResourceSnapshot('identity').data).toBeUndefined();
  });

  it('preserves trusted offline state until connectivity returns, then supports explicit revalidation', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    clearAuthRequired();
    await saveVerifiedIdentity({ userId: 'offline-user', email: 'offline@example.com', personId: 'offline-person', verifiedAt: new Date().toISOString() });
    await saveLastVerifiedClerkUserId('clerk-a');
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(initializeAuthLifecycle()).resolves.toMatchObject({ status: 'trusted-offline' });
    expect(getAuthLifecycle().status).toBe('trusted-offline');
    expect(getTrustedOfflineClerkUserId()).toBe('clerk-a');
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-a', getTrustedOfflineClerkUserId())).toBe(false);
    expect(shouldRevokeForOfflineClerkUser(true, true, 'clerk-b', getTrustedOfflineClerkUserId())).toBe(true);
    revokeForClerkSessionChange();
    expect(getAuthLifecycle().status).toBe('unauthenticated');
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'offline-user', email: 'offline@example.com', personId: 'offline-person' }, 200, 'offline-user')));
    await expect(initializeAuthLifecycle({ networkOnly: true })).resolves.toMatchObject({ status: 'authenticated' });
    await clearEverythingForLogout(false);
    expect(await readLastVerifiedClerkUserId()).toBeUndefined();
    expect(getTrustedOfflineClerkUserId()).toBeUndefined();
  });

  it('releases a failed Clerk sign-out barrier without rolling back the protected generation', async () => {
    await clearEverythingForLogout(false);
    expect(getSessionLogoutInProgress()).toBe(true);
    expect(isMutationBarrierActive()).toBe(true);
    const before = captureSessionGeneration();
    recoverAfterClerkSignOutFailure();
    expect(getSessionLogoutInProgress()).toBe(false);
    expect(isMutationBarrierActive()).toBe(false);
    expect(captureSessionGeneration()).toBe(before);
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'retry-user', email: 'retry@example.com', personId: 'retry-person' }, 200, 'retry-user')));
    await expect(initializeAuthLifecycle()).resolves.toMatchObject({ status: 'authenticated' });
    await clearEverythingForLogout(false);
  });

  it('invalidates prior identity memory before re-verifying a changed Clerk session', async () => {
    await clearEverythingForLogout(false);
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a')));
    await initializeAuthLifecycle();
    resetForClerkSessionChange();
    expect(getAuthLifecycle().status).toBe('checking');
    expect(getAuthState()).toMatchObject({ required: true, code: 'AUTH_REQUIRED' });
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

  it('blocks a new mutation after a cross-tab logout barrier is adopted', async () => {
    const fetch = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    adoptSessionGeneration(captureSessionGeneration() + 1);
    await expect(api('/groups', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'LOGOUT_IN_PROGRESS' });
    expect(fetch).not.toHaveBeenCalled();
    releaseMutationBarrier();
  });
});
