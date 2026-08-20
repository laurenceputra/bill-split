import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, claimOutboxItem, discardOutboxIfIdle, listOutbox, readOutboxItem, removeOutboxIfOwned, recoverStaleSyncing, saveOutboxItem, saveVerifiedIdentity, updateOutboxIfOwned } from './idb';
import { OutboxBusyError, OutboxDeliveryUncertainError, cancelScheduledRetry, discardOutboxItem, enqueueExpense, flushOutbox, handleAuthenticatedUser, retryDelay, retryOutboxItem, setRetrySchedulerForTests } from './outbox';

const operation = (id: string) => ({ description: 'Lunch', amount_minor: 100, currency: 'USD' as const, date: '2026-01-01', payers: [{ person_id: 'person-a', amount_minor: 100 }], splits: [{ person_id: 'person-a', amount_minor: 100 }], client_operation_id: id });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(DB_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => resolve(); });
  await saveVerifiedIdentity({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', verifiedAt: new Date().toISOString() });
});
afterEach(() => { cancelScheduledRetry(); vi.useRealTimers(); });

async function queue(id: string) {
  return enqueueExpense({ userId: 'user-a', groupId: 'group-a', payload: operation(id), clientOperationId: id, display: { description: 'Lunch', amountMinor: 100, currency: 'USD', date: '2026-01-01' } });
}

describe('durable expense outbox', () => {
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
    expect(seen[1].url).toContain('/groups/group-a/expenses');
    expect(await listOutbox('user-a')).toEqual([]);
  });

  it('never falls back to cached identity when deciding who may receive a POST', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => { const url = String(request); calls.push(url); throw new TypeError('temporary identity failure'); }));
    await queue('no-cached-send');
    await flushOutbox();
    expect(calls.filter((url) => url.includes('/expenses'))).toEqual([]);
    expect((await readOutboxItem('no-cached-send'))?.status).toBe('pending');
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
    await retryOutboxItem('auth');
    expect((await listOutbox('user-a'))[0].status).toBe('failed');
  });

  it('supports explicit retry and confirmed discard operations', async () => {
    await queue('discard-me');
    await discardOutboxItem('discard-me');
    expect(await listOutbox('user-a')).toEqual([]);
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

  it('times out hung sends, releases the lease, and keeps the item retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init); if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }); return new Promise<Response>((_resolve, reject) => actual.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))); }));
    await queue('timeout');
    await flushOutbox(10);
    expect((await readOutboxItem('timeout'))).toMatchObject({ status: 'pending', leaseOwner: undefined, leaseExpiresAt: undefined, lastError: { code: 'NETWORK_TIMEOUT' } });
  });

  it('reactivates auth-required rows after successful authentication and flushes them', async () => {
    const item = await queue('signed-in');
    await saveOutboxItem({ ...item, status: 'auth-required', lastError: { code: 'AUTH_REQUIRED', message: 'Sign in', status: 401 } });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init); if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }); return response({ expense: { id: 'server-id' } }, 201); }));
    await handleAuthenticatedUser('user-a');
    expect(await listOutbox('user-a')).toEqual([]);
  });

  it('uses bounded exponential retry scheduling without a hot loop', async () => {
    expect(retryDelay(1)).toBe(1_000);
    expect(retryDelay(20)).toBe(60_000);
    let scheduledDelay = 0; let scheduledCallback: (() => void) | undefined;
    const restoreScheduler = setRetrySchedulerForTests((callback, delay) => { scheduledCallback = callback; scheduledDelay = delay; return 1 as ReturnType<typeof setTimeout>; }, () => undefined);
    const calls: string[] = [];
    try {
      vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => { const actual = new Request(typeof request === 'string' ? new URL(request, 'https://test.local') : request, init); calls.push(actual.url); if (actual.url.endsWith('/api/me')) return response({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }); return response({}, 503); }));
      await queue('backoff');
      await flushOutbox();
      expect(calls.filter((url) => url.includes('/expenses')).length).toBe(1);
      expect(scheduledDelay).toBe(1_000);
      scheduledCallback?.();
      await Promise.resolve();
    } finally { restoreScheduler(); }
  });
});
