import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, clearAuthRequired, getAuthState, getExpenses, getGroups, subscribeAuthState } from './api';
import { enqueueExpense } from './outbox';
import { DB_NAME, listOutbox, readGroups, saveGroups, saveVerifiedIdentity } from './idb';

const json = (body: unknown, status = 200, userId?: string) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(userId ? { 'X-BillSplit-User-Id': userId } : {}) } });

beforeEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(DB_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => resolve(); });
});

describe('frontend API errors and cache fallback', () => {
  it('marks API calls as AJAX requests and publishes auth-required state', async () => {
    const listener = vi.fn();
    const authEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: authEvent });
    const unsubscribe = subscribeAuthState(listener);
    vi.stubGlobal('fetch', vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => { expect(new Headers(init?.headers).get('X-Requested-With')).toBe('XMLHttpRequest'); return json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in' } }, 401); }));
    await expect(api('/me')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(getAuthState()).toEqual({ required: true, code: 'AUTH_REQUIRED' });
    expect(listener).toHaveBeenCalled();
    expect(authEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'billsplit-auth-required' }));
    unsubscribe();
    clearAuthRequired();
    vi.unstubAllGlobals();
  });

  it.each(['plain text', 'Access HTML'])('treats %s 401 responses as auth-required', async (kind) => {
    clearAuthRequired();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(kind === 'plain text' ? 'Unauthorized' : '<html><body>Sign in</body></html>', { status: 401, headers: { 'Content-Type': kind === 'plain text' ? 'text/plain' : 'text/html' } })));
    await expect(api('/me')).rejects.toMatchObject({ status: 401 });
    expect(getAuthState()).toMatchObject({ required: true, code: 'AUTH_REQUIRED' });
    clearAuthRequired();
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
    await enqueueExpense({ userId: 'user-a', groupId: 'group-a', clientOperationId: 'op-1', payload: { description: 'Lunch', amount_minor: 100, currency: 'USD', date: '2026-01-01', payers: [{ person_id: 'person-a', amount_minor: 100 }], splits: [{ person_id: 'person-a', amount_minor: 100 }], client_operation_id: 'op-1' }, display: { description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01' } });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me') ? json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a') : json({ expenses: [{ id: 'server', groupId: 'group-a', createdBy: 'user-a', clientOperationId: 'op-1' }] }, 200, 'user-a')));
    await getExpenses('group-a');
    expect(await listOutbox('user-a')).toEqual([]);
  });
});
