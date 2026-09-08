import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as idb from './idb';
import { clearCachedData, DB_NAME, claimOutboxItem, discardOutboxIfIdle, listOutbox, readGroups, readOutboxItem, removeOutboxIfOwned, recoverStaleSyncing, saveGroups, saveOfflineTrust, saveOutboxItem, saveVerifiedIdentity, updateOutboxIfOwned } from './idb';
import { getOutboxSnapshot, OUTBOX_IDB_DEADLINE_MS, OUTBOX_LEASE_MS, OUTBOX_LOGOUT_DEADLINE_MS, OutboxBusyError, OutboxDeliveryUncertainError, cancelScheduledRetry, discardOutboxItem, enqueueExpense, flushOutbox, handleAuthenticatedUser, refreshOutbox, recoverConnection, retryDelay, retryOutboxItem, setRetrySchedulerForTests } from './outbox';
import { clearEverythingForLogout, coordinateAuthBootstrap, getAuthEpoch, getAuthLifecycle, initializeAuthLifecycle, resetForClerkSessionChange } from './api';
import { clearSessionLogout } from './session';

const operation = (id: string) => ({ description: 'Lunch', amount_minor: 100, currency: 'USD' as const, date: '2026-01-01', payers: [{ person_id: 'person-a', amount_minor: 100 }], splits: [{ person_id: 'person-a', amount_minor: 100 }], client_operation_id: id });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'user-a', 'X-BillSplit-Clerk-User-Id': 'clerk-a' } });

beforeEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(DB_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => resolve(); });
  clearSessionLogout();
  await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
  vi.stubGlobal('fetch', vi.fn(async () => response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' })));
     await initializeAuthLifecycle({ networkOnly: true, clerkUserId: 'clerk-a' });
  await handleAuthenticatedUser('user-a');
});
afterEach(() => { cancelScheduledRetry(); vi.useRealTimers(); });

async function queue(id: string) {
  return enqueueExpense({ userId: 'user-a', groupId: 'group-a', payload: operation(id), clientOperationId: id, display: { description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01' } });
}

describe('durable expense outbox', () => {
  it('does not flush before the authenticated /api/me lifecycle completes', async () => {
    await queue('auth-gated');
    resetForClerkSessionChange();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => { calls.push(String(request)); return response({ expense: { id: 'should-not-send' } }, 201); }));
    await flushOutbox();
    expect(calls).toEqual([]);
    expect(await readOutboxItem('auth-gated')).toMatchObject({ status: 'pending' });
  });

  it('keeps queued work pending while a matching Clerk session is reverified', async () => {
    await queue('reverify-gated');
    const calls: string[] = [];
    let resolveMe!: (result: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      calls.push(String(request));
      if (String(request).endsWith('/me')) return new Promise<Response>((resolve) => { resolveMe = resolve; });
      return response({ expense: { id: 'should-not-send' } }, 201);
    }));
    const reverify = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-a', sessionId: 'rotated-session' });
    await vi.waitFor(() => expect(calls.some((url) => url.endsWith('/me'))).toBe(true));
    expect(getAuthLifecycle().status).toBe('reverifying');
    await flushOutbox();
    expect(calls.filter((url) => url.includes('/expenses'))).toEqual([]);
    expect((await readOutboxItem('reverify-gated'))?.status).toBe('pending');
    resolveMe(response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200));
    await reverify;
  });

  it('persists before sending and removes only after success, replaying the exact operation', async () => {
    const seen: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init); seen.push(actual);
      if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expect((await listOutbox('user-a')).map((item) => item.clientOperationId)).toContain('operation-1');
      expect(await actual.json()).toEqual(operation('operation-1'));
      expect(actual.headers.get('X-BillSplit-Expected-User-Id')).toBe('user-a');
      return response({ expense: { id: 'server-id' } }, 201);
    }));
    await queue('operation-1');
    await flushOutbox();
    expect(seen[0].url).toContain('/groups/group-a/expenses');
    expect(await listOutbox('user-a')).toEqual([]);
  });

  it('expires the persisted home summary when an expense enters the outbox', async () => {
    await saveGroups({ userId: 'user-a', groups: [{ id: 'group-a', name: 'A', currency: 'USD', createdAt: '', updatedAt: '' }], cachedAt: new Date().toISOString() });
    await queue('invalidate-on-enqueue');
    expect((await readGroups('user-a'))?.cachedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('uses the current authoritative session rather than a cleared cached identity for a POST', async () => {
    await clearCachedData();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => { calls.push(String(request)); throw new TypeError('unexpected send'); }));
    await queue('no-cached-send');
    await flushOutbox();
    expect(calls.filter((url) => url.includes('/expenses'))).toHaveLength(1);
    expect((await readOutboxItem('no-cached-send'))?.status).toBe('pending');
  });

  it('keeps an online connection failure pending and retryable', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connection reset'); }));
    await queue('online-network-failure');
    await flushOutbox();
    expect(await readOutboxItem('online-network-failure')).toMatchObject({ status: 'pending' });
    expect((await readOutboxItem('online-network-failure'))?.status).not.toBe('failed');
  });

  it('reverifies and flushes after a connection issue without an online event', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    let expenseAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expenseAttempts += 1;
      if (expenseAttempts === 1) throw new TypeError('connection reset');
      return response({ expense: { id: 'recovered' } }, 201);
    }));
    await queue('reverify-without-event');
    await flushOutbox();
    expect((await readOutboxItem('reverify-without-event'))?.status).toBe('pending');

    await recoverConnection();
    expect(expenseAttempts).toBe(2);
    expect(await readOutboxItem('reverify-without-event')).toBeUndefined();
  });

  it('reloads the durable queue after a failed probe and recovers on a later probe without an online event', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    await queue('failed-probe-recovery');
    let probeAttempts = 0;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      calls.push(url);
      if (url.endsWith('/api/me')) {
        probeAttempts += 1;
        if (probeAttempts === 1) throw new TypeError('probe unavailable');
        return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      }
      return response({ expense: { id: 'recovered-after-probe' } }, 201);
    }));

    await initializeAuthLifecycle({ networkOnly: true, clerkUserId: 'clerk-a', startupFallbackMs: 10 });
    expect(getAuthLifecycle().status).toBe('authenticated');
    expect(calls.filter((url) => url.includes('/expenses'))).toEqual([]);

    await recoverConnection();
    expect(probeAttempts).toBe(2);
    expect(calls.filter((url) => url.includes('/expenses'))).toHaveLength(1);
    expect(await readOutboxItem('failed-probe-recovery')).toBeUndefined();
  });

  it('keeps an HTML 503 response pending instead of requiring auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/api/me') ? response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }) : new Response('<html>temporarily unavailable</html>', { status: 503, headers: { 'Content-Type': 'text/html' } })));
    await queue('html-server-error');
    await flushOutbox();
    expect(await readOutboxItem('html-server-error')).toMatchObject({ status: 'pending', deliveryUncertain: true, lastError: { status: 503, code: 'SERVER_ERROR' } });
  });

  it.each(['network', 'server', 408, 429])('keeps %s failures pending', async (kind) => {
      const status = typeof kind === 'number' ? kind : kind === 'server' ? 503 : 500;
      vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init); if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }); if (kind === 'network') throw new TypeError('offline'); return response({}, status); }));
    await queue('retry');
    await flushOutbox();
    expect((await listOutbox('user-a'))[0]).toMatchObject({ status: 'pending', deliveryUncertain: true });
  });

  it('marks auth failures for sign-in and non-retryable 4xx failures as failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init); if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }); return response({ error: { code: 'AUTH_REQUIRED', message: 'Sign in' } }, 401); }));
    await queue('auth'); await flushOutbox();
    expect((await listOutbox('user-a'))[0].status).toBe('auth-required');
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init); if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }); return response({ error: { code: 'INVALID_MEMBER', message: 'Bad member' } }, 400); }));
     await initializeAuthLifecycle({ networkOnly: true, clerkUserId: 'clerk-a' });
     await retryOutboxItem('auth');
     expect((await listOutbox('user-a'))[0].status).toBe('failed');
  });

  it('rebinds failed rows on same-user rotation but sends them only after explicit retry', async () => {
    await queue('failed-rotation');
    const oldEpoch = getAuthEpoch();
    await saveOutboxItem({ ...(await readOutboxItem('failed-rotation'))!, status: 'failed', authEpoch: oldEpoch });

    resetForClerkSessionChange();
    await initializeAuthLifecycle({ networkOnly: true, clerkUserId: 'clerk-a' });
    const currentEpoch = getAuthEpoch();
    await handleAuthenticatedUser('user-a', currentEpoch);

    expect(await readOutboxItem('failed-rotation')).toMatchObject({ status: 'failed', authEpoch: currentEpoch });
    const expenseCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expenseCalls.push(url);
      return response({ error: { code: 'INVALID_MEMBER', message: 'Bad member' } }, 400);
    }));
    await flushOutbox();
    expect(expenseCalls).toEqual([]);

    await retryOutboxItem('failed-rotation');
    expect(expenseCalls).toHaveLength(1);
    expect(await readOutboxItem('failed-rotation')).toMatchObject({ status: 'failed', authEpoch: currentEpoch });
  });

  it('supports explicit retry and confirmed discard operations', async () => {
    await queue('discard-me');
    await discardOutboxItem('discard-me');
    expect(await listOutbox('user-a')).toEqual([]);
  });

  it('keeps the current authoritative user queue visible after cached identity is cleared', async () => {
    await queue('shared-cache');
    await refreshOutbox();
    expect(getOutboxSnapshot().map((item) => item.clientOperationId)).toContain('shared-cache');
    await clearCachedData();
    await refreshOutbox();
    expect(getOutboxSnapshot().map((item) => item.clientOperationId)).toContain('shared-cache');
  });

  it('does not expose or send account A rows after authenticated account B wins', async () => {
    await queue('account-a-row');
    resetForClerkSessionChange();
    let expenseCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const actual = new URL(String(request), 'https://test.local');
      if (actual.pathname.endsWith('/api/me')) return new Response(JSON.stringify({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'user-b', 'X-BillSplit-Clerk-User-Id': 'clerk-b' } });
      expenseCalls += 1;
      return response({ expense: { id: 'wrong-account' } }, 201);
    }));
    await initializeAuthLifecycle({ networkOnly: true, clerkUserId: 'clerk-b' });
    await refreshOutbox();
    expect(getOutboxSnapshot().some((item) => item.userId === 'user-a')).toBe(false);
    await flushOutbox();
    expect(expenseCalls).toBe(0);
    expect(await readOutboxItem('account-a-row')).toMatchObject({ userId: 'user-a', status: 'pending' });
  });

  it('atomically leases an item and only recovers expired leases', async () => {
    await queue('lease');
    const first = await claimOutboxItem('lease', 'tab-a', 1_000, 100);
    expect(first?.leaseOwner).toBe('tab-a');
    expect(await claimOutboxItem('lease', 'tab-b', 1_050, 100)).toBeUndefined();
    expect((await readOutboxItem('lease'))?.status).toBe('syncing');
    await recoverStaleSyncing();
    expect((await readOutboxItem('lease'))?.status).toBe('pending');
    const second = await claimOutboxItem('lease', 'tab-b', 2_000, 100);
    expect(second?.leaseOwner).toBe('tab-b');
  });

  it('rejects discard during an active lease and ignores stale completion', async () => {
    await queue('busy');
    await claimOutboxItem('busy', 'tab-a', Date.now(), 30_000);
    await expect(discardOutboxItem('busy')).rejects.toBeInstanceOf(OutboxBusyError);
    expect(await discardOutboxIfIdle('busy', Date.now())).toBe(false);
    expect(await removeOutboxIfOwned('busy', 'tab-a')).toBe(true);
    expect(await updateOutboxIfOwned('busy', 'tab-a', { status: 'failed' })).toBeUndefined();
    expect(await listOutbox('user-a')).toEqual([]);
  });

  it('does not permit discard after an ambiguous delivery', async () => {
    const item = await queue('uncertain');
    await saveOutboxItem({ ...item, deliveryUncertain: true });
    await expect(discardOutboxItem('uncertain')).rejects.toBeInstanceOf(OutboxDeliveryUncertainError);
    expect(await listOutbox('user-a')).toHaveLength(1);
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init); if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }); return response({}, 503); }));
    await retryOutboxItem('uncertain');
    expect((await readOutboxItem('uncertain'))?.deliveryUncertain).toBe(true);
    await expect(discardOutboxItem('uncertain')).rejects.toBeInstanceOf(OutboxDeliveryUncertainError);
  });

  it('times out hung sends without releasing the delivery-uncertain lease', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init); if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }); return new Promise<Response>((_resolve, reject) => actual.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))); }));
    await queue('timeout');
    await flushOutbox(10);
    expect((await readOutboxItem('timeout'))).toMatchObject({ status: 'syncing', deliveryUncertain: true, lastError: { code: 'NETWORK_TIMEOUT' } });
    expect(await claimOutboxItem('timeout', 'second-tab')).toBeUndefined();
  });

  it('reconciles a claim which completes after the 500ms storage deadline and flushes it', async () => {
    let releaseClaim!: () => void;
    let claimStarted!: () => void;
    const claimStartedPromise = new Promise<void>((resolve) => { claimStarted = resolve; });
    const realClaim = idb.claimOutboxItem;
    vi.spyOn(idb, 'claimOutboxItem').mockImplementationOnce(async (...args) => {
      const claimed = await realClaim(...args);
      claimStarted();
      return new Promise((resolve) => { releaseClaim = () => resolve(claimed); });
    });
    let expenseCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).includes('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expenseCalls += 1;
      return response({ expense: { id: 'late-claim-server-id' } }, 201);
    }));
    await queue('late-claim');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flush = flushOutbox();
    await claimStartedPromise;
    await vi.advanceTimersByTimeAsync(OUTBOX_IDB_DEADLINE_MS + 25);
    await flush;
    expect(await readOutboxItem('late-claim')).toMatchObject({ status: 'syncing', leaseOwner: expect.any(String) });

    releaseClaim();
    await vi.waitFor(async () => expect(await listOutbox('user-a')).toEqual([]));
    expect(expenseCalls).toBe(1);
  });

  it('bounds logout quiescence when an aborted transport never settles', async () => {
    let expenseCalls = 0;
    let abortObserved = false;
    let transportStarted!: () => void;
    const transportStartedPromise = new Promise<void>((resolve) => { transportStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init);
      if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expenseCalls += 1;
      transportStarted();
      actual.signal?.addEventListener('abort', () => { abortObserved = true; });
      return new Promise<Response>(() => undefined);
    }));
    await queue('never-settles');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flush = flushOutbox(1_000);
    await transportStartedPromise;
    const logout = clearEverythingForLogout(false);
    await vi.waitFor(() => expect(abortObserved).toBe(true));
    await vi.advanceTimersByTimeAsync(OUTBOX_IDB_DEADLINE_MS + OUTBOX_LOGOUT_DEADLINE_MS);
    await expect(logout).resolves.toBeUndefined();
    expect(abortObserved).toBe(true);
    await flush;
  });

  it('keeps an expired trust record queue visible and sends under the live verified session', async () => {
    await saveOfflineTrust({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', clerkUserId: 'clerk-a', verifiedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() });
    await queue('expired-trust');
    await refreshOutbox();
    expect(getOutboxSnapshot().map((item) => item.clientOperationId)).toContain('expired-trust');
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/api/me') ? response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }) : response({ expense: { id: 'server-id' } }, 201)));
    await flushOutbox();
    expect(await readOutboxItem('expired-trust')).toBeUndefined();
  });

  it('reactivates auth-required rows after successful authentication and flushes them', async () => {
    const item = await queue('signed-in');
    await saveOutboxItem({ ...item, status: 'auth-required', lastError: { code: 'AUTH_REQUIRED', message: 'Sign in', status: 401 } });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init); if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }); return response({ expense: { id: 'server-id' } }, 201); }));
    await handleAuthenticatedUser('user-a');
    expect(await listOutbox('user-a')).toEqual([]);
  });

  it('rebinds a network-failed pending row across same-user session rotation and sends it once', async () => {
    await queue('rotated-pending');
    let expenseCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expenseCalls += 1;
      throw new TypeError('temporary network failure');
    }));
    await flushOutbox();
    const beforeRotation = await readOutboxItem('rotated-pending');
    expect(beforeRotation?.status).toBe('pending');
    const previousEpoch = beforeRotation?.authEpoch;

    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expenseCalls += 1;
      return response({ expense: { id: 'rotated-server-id' } }, 201);
    }));
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-a', sessionId: 'rotated-session' }, { networkOnly: true });
    const rotatedEpoch = getAuthEpoch();
    expect(rotatedEpoch).not.toBe(previousEpoch);
    await handleAuthenticatedUser('user-a', rotatedEpoch);
    expect(expenseCalls).toBe(2);
    expect(await readOutboxItem('rotated-pending')).toBeUndefined();
    await handleAuthenticatedUser('user-a', rotatedEpoch);
    expect(expenseCalls).toBe(2);
  });

  it('rebinds a late in-flight completion to the current same-user epoch before retrying once', async () => {
    await queue('rotated-inflight');
    let resolveOldSend!: (response: Response) => void;
    let expenseCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init);
      if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expenseCalls += 1;
      return new Promise<Response>((resolve) => {
        resolveOldSend = resolve;
        actual.signal?.addEventListener('abort', () => { /* The old transport may settle after rotation. */ });
      });
    }));
    const oldFlush = flushOutbox(5_000);
    await vi.waitFor(() => expect(expenseCalls).toBe(1));
    const oldItem = await readOutboxItem('rotated-inflight');
    const oldEpoch = oldItem?.authEpoch;

    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expenseCalls += 1;
      return response({ expense: { id: 'rotated-inflight-server-id' } }, 201);
    }));
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-a', sessionId: 'rotated-inflight-session' }, { networkOnly: true });
    const currentEpoch = getAuthEpoch();
    expect(currentEpoch).not.toBe(oldEpoch);

    resolveOldSend(response({ expense: { id: 'late-old-response' } }, 201));
    await oldFlush;
    await vi.waitFor(async () => expect(await readOutboxItem('rotated-inflight')).toBeUndefined());
    expect(expenseCalls).toBe(2);
    expect(await readOutboxItem('rotated-inflight')).toBeUndefined();
  });

  it('starts the first outbox flush from confirmed authentication and recovers an expired lease', async () => {
    const item = await queue('startup-flush');
    await saveOutboxItem({ ...item, status: 'syncing', leaseOwner: 'old-tab', leaseExpiresAt: Date.now() - 1 });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request);
      return actual.url.endsWith('/api/me') ? response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }) : response({ expense: { id: 'startup-server-id' } }, 201);
    }));
    await handleAuthenticatedUser('user-a');
    expect(await listOutbox('user-a')).toEqual([]);
  });

  it('uses bounded exponential retry scheduling without a hot loop', async () => {
    expect(retryDelay(1)).toBe(1_000);
    expect(retryDelay(20)).toBe(60_000);
    let scheduledDelay = 0;
    const restoreScheduler = setRetrySchedulerForTests((_callback, delay) => { scheduledDelay = delay; return 1 as ReturnType<typeof setTimeout>; }, () => undefined);
    const calls: string[] = [];
    try {
      vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init); calls.push(actual.url); if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }); return response({}, 503); }));
      await queue('backoff');
       await flushOutbox();
       expect(calls.filter((url) => url.includes('/expenses')).length).toBe(1);
       expect(scheduledDelay).toBe(1_000);
       const firstAttempt = await readOutboxItem('backoff');
       expect(firstAttempt?.attempts).toBe(1);
       expect(retryDelay((firstAttempt?.attempts || 0) + 1)).toBe(2_000);
       await saveOutboxItem({ ...firstAttempt!, status: 'pending', leaseOwner: undefined, leaseExpiresAt: undefined });
       const secondClaim = await idb.claimOutboxItem('backoff', 'retry-tab');
       expect(secondClaim?.attempts).toBe(2);
       expect(retryDelay((secondClaim?.attempts || 0) + 1)).toBe(4_000);
     } finally { restoreScheduler(); }
   });

  it('recovers a timed-out syncing lease at its expiry without a reload', async () => {
    let scheduledCallback: (() => void) | undefined;
    let scheduledDelay = 0;
    const restoreScheduler = setRetrySchedulerForTests((callback, delay) => { scheduledCallback = callback; scheduledDelay = delay; return 1 as ReturnType<typeof setTimeout>; }, () => undefined);
    try {
      vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init);
        if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
        return new Promise<Response>((_resolve, reject) => actual.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      }));
      await queue('lease-expiry-timer');
      await flushOutbox(10);
      expect((await readOutboxItem('lease-expiry-timer'))?.status).toBe('syncing');
      expect(scheduledDelay).toBeGreaterThanOrEqual(OUTBOX_LEASE_MS - 100);
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + OUTBOX_LEASE_MS + 10);
      scheduledCallback?.();
      await vi.waitFor(async () => expect((await readOutboxItem('lease-expiry-timer'))?.status).toBe('pending'));
    } finally { restoreScheduler(); }
  });

  it('rebinds an expired syncing lease to the rotated auth epoch before sending once', async () => {
    let scheduledCallback: (() => void) | undefined;
    const restoreScheduler = setRetrySchedulerForTests((callback) => { scheduledCallback = callback; return 1 as ReturnType<typeof setTimeout>; }, () => undefined);
    try {
      await queue('rotated-expired-lease');
      let expenseAttempts = 0;
      vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init);
        if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
        expenseAttempts += 1;
        return new Promise<Response>((_resolve, reject) => actual.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      }));
      await flushOutbox(10);
      const beforeRotation = await readOutboxItem('rotated-expired-lease');
      expect(beforeRotation?.status).toBe('syncing');
      const oldEpoch = beforeRotation?.authEpoch;

      vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => String(request).endsWith('/me')
        ? response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' })
        : response({ expense: { id: 'rotated-expired-server-id' } }, 201)));
      await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-a', sessionId: 'rotated-expired-session' }, { networkOnly: true });
      const rotatedEpoch = getAuthEpoch();
      expect(rotatedEpoch).not.toBe(oldEpoch);

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + OUTBOX_LEASE_MS + 10);
      scheduledCallback?.();
      await vi.waitFor(async () => expect(await readOutboxItem('rotated-expired-lease')).toBeUndefined());
      expect(expenseAttempts).toBe(1);
    } finally { restoreScheduler(); }
  });

  it('orders resume reactivation before one shared refresh and flush', async () => {
    const item = await queue('resume-order');
    await saveOutboxItem({ ...item, status: 'auth-required', lastError: { code: 'AUTH_REQUIRED', message: 'Sign in', status: 401 } });
    const originalReactivate = idb.reactivateAuthRequired;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(idb, 'reactivateAuthRequired').mockImplementation(async (...args) => { await gate; return originalReactivate(...args); });
    let expenseCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expenseCalls += 1;
      return response({ expense: { id: 'resume-order-server-id' } }, 201);
    }));
    const first = handleAuthenticatedUser('user-a', undefined, 700);
    await vi.waitFor(() => expect(idb.reactivateAuthRequired).toHaveBeenCalled());
    const second = handleAuthenticatedUser('user-a', undefined, 700);
    release();
    await Promise.all([first, second]);
    expect(expenseCalls).toBe(1);
    expect(await readOutboxItem('resume-order')).toBeUndefined();
  });

  it('waits for late resume reactivation instead of flushing or consuming the resume early', async () => {
    const item = await queue('late-resume-reactivation');
    await saveOutboxItem({ ...item, status: 'auth-required', lastError: { code: 'AUTH_REQUIRED', message: 'Sign in', status: 401 } });
    const originalReactivate = idb.reactivateAuthRequired;
    let release!: () => void;
    let reactivationStarted!: () => void;
    const reactivationStartedPromise = new Promise<void>((resolve) => { reactivationStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(idb, 'reactivateAuthRequired').mockImplementation(async (...args) => { reactivationStarted(); await gate; return originalReactivate(...args); });
    let expenseCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expenseCalls += 1;
      return response({ expense: { id: 'late-resume-server-id' } }, 201);
    }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const recovery = handleAuthenticatedUser('user-a', undefined, 701);
    await reactivationStartedPromise;
    await vi.advanceTimersByTimeAsync(OUTBOX_IDB_DEADLINE_MS + 50);
    expect(expenseCalls).toBe(0);
    expect((await readOutboxItem('late-resume-reactivation'))?.status).toBe('auth-required');
    release();
    await recovery;
    expect(expenseCalls).toBe(1);
    expect(await readOutboxItem('late-resume-reactivation')).toBeUndefined();
  });

  it('quiesces an in-flight sync during logout and does not restart it', async () => {
    let expenseCalls = 0;
    let abortObserved = false;
    let resolveExpense!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init);
      if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      expenseCalls += 1;
      return new Promise<Response>((resolve) => {
        resolveExpense = resolve;
        actual.signal?.addEventListener('abort', () => { abortObserved = true; });
      });
    }));
    await queue('logout-in-flight');
    const flush = flushOutbox();
    await vi.waitFor(() => expect(expenseCalls).toBe(1));
    const logout = clearEverythingForLogout(false);
    await vi.waitFor(() => expect(abortObserved).toBe(true));
    let logoutSettled = false;
    void logout.finally(() => { logoutSettled = true; });
    await Promise.resolve();
    expect(logoutSettled).toBe(false);
    resolveExpense(response({ expense: { id: 'committed-after-abort' } }, 201));
    await logout;
    await flush;
    await flushOutbox();
    expect(abortObserved).toBe(true);
    expect(expenseCalls).toBe(1);
    expect(await listOutbox('user-a')).toHaveLength(1);
  });

  it('does not release an in-flight lease when auth downgrades before transport settles', async () => {
    let started!: () => void;
    let resolveExpense!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init);
      if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' });
      started();
      return new Promise<Response>((resolve) => { resolveExpense = resolve; });
    }));
    await queue('downgrade-lease');
    const flush = flushOutbox();
    await new Promise<void>((resolve) => { started = resolve; });
    await vi.waitFor(async () => expect((await readOutboxItem('downgrade-lease'))?.status).toBe('syncing'));
    resetForClerkSessionChange();
    expect(await claimOutboxItem('downgrade-lease', 'second-tab', Date.now(), 30_000)).toBeUndefined();
    resolveExpense(response({ expense: { id: 'late' } }, 201));
    await flush;
    expect((await claimOutboxItem('downgrade-lease', 'second-tab', Date.now(), 30_000))?.leaseOwner).toBe('second-tab');
  });
});
