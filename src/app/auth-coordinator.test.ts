import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, authRouteCacheKey, clearAuthRequired, clearEverythingForLogout, coordinateAuthBootstrap, getAuthLifecycle, getMe, getVerifiedClerkUserId, getVerifiedUserId, isIncompleteLoadedSignedInEvidence, isPrivateCacheRouteCurrent, isRetryableAuthFailure, recoverAfterClerkSignOutFailure, requestAuthProbe, resumeAuthVerification, scheduleAuthVerification, setForegroundRetrySchedulerForTests, signalConnectionChecking, subscribeAuthLifecycle } from './api';
import { DB_NAME, listOutbox, readOfflineTrust, revokeOfflineTrust, saveActivity, saveCategories, saveOfflineTrust, updateGroupSnapshot } from './idb';
import * as idb from './idb';
import { getResourceSnapshot, resourceKeys } from './resource-cache';
import { clearSessionLogout } from './session';
import { enqueueExpense, flushOutbox, getOutboxSnapshot } from './outbox';
import { transactionFilterKey } from './transaction-filters';

const json = (body: unknown, status = 200, userId?: string, clerkUserId?: string) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    ...(userId ? { 'X-BillSplit-User-Id': userId } : {}),
    ...(clerkUserId ? { 'X-BillSplit-Clerk-User-Id': clerkUserId } : {}),
  },
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

describe('Clerk auth bootstrap coordinator', () => {
  it('does not issue /me while Clerk is restoring, even when a fast 401 is available', async () => {
    const fetch = vi.fn(async () => json({ error: { code: 'AUTH_REQUIRED' } }, 401));
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', fetch);

    const result = await coordinateAuthBootstrap({ isLoaded: false, isSignedIn: undefined }, { startupFallbackMs: 10, force: true });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.status).toBe('verification-unavailable');
    expect(getAuthLifecycle().status).toBe('verification-unavailable');
    await coordinateAuthBootstrap({ isLoaded: false, isSignedIn: undefined }, { startupFallbackMs: 10 });
    expect(fetch).not.toHaveBeenCalled();
    expect(getAuthLifecycle().status).toBe('verification-unavailable');
  });

  it('activates complete unexpired trust at the restoration deadline while online', async () => {
    await saveOfflineTrust({ userId: 'cached-user', email: 'cached@example.com', personId: 'cached-person', clerkUserId: 'clerk-cached', verifiedAt: new Date().toISOString() });
    const fetch = vi.fn(async () => json({ error: { code: 'AUTH_REQUIRED' } }, 401));
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', fetch);

    const result = await coordinateAuthBootstrap({ isLoaded: false, isSignedIn: undefined }, { startupFallbackMs: 10, force: true });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.status).toBe('trusted-offline');
    expect(await readOfflineTrust()).toMatchObject({ state: 'active', clerkUserId: 'clerk-cached' });
  });

  it('serializes repeated Clerk/foreground events and lets signed-out win without probing', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', fetch);

    const first = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-user', sessionId: 'session-a' });
    const second = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-user', sessionId: 'session-a' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    resolve(json({ id: 'app-user', email: 'user@example.com', personId: 'person-user' }, 200, 'app-user', 'clerk-user'));
    const settled = await Promise.all([first, second]);
    expect(settled.map((value) => value.status)).toEqual(['authenticated', 'authenticated']);

    const beforeSignedOut = fetch.mock.calls.length;
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: false });
    expect(fetch).toHaveBeenCalledTimes(beforeSignedOut);
    expect(getAuthLifecycle().status).toBe('unauthenticated');
  });

  it('settles a loaded identity mismatch as verification-unavailable', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'app-user', email: 'user@example.com', personId: 'person-user' }, 200, 'app-user', 'different-clerk-user')));

    const result = await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-user', sessionId: 'session-b' });

    expect(result.status).toBe('verification-unavailable');
    expect(getAuthLifecycle().status).toBe('verification-unavailable');
  });

  it('lets B win over a late A probe without changing identity, trust, or outbox state', async () => {
    let resolveA!: (value: Response) => void;
    let calls = 0;
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Promise<Response>((resolve) => { resolveA = resolve; });
      return json({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }, 200, 'user-b', 'clerk-b');
    }));

    const probeA = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-a', sessionId: 'session-a' });
    await vi.waitFor(() => expect(calls).toBe(1));
    const probeB = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-b', sessionId: 'session-b' });
    await expect(probeB).resolves.toMatchObject({ status: 'authenticated' });
    resolveA(json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a', 'clerk-a'));
    await probeA;

    expect(getAuthLifecycle().status).toBe('authenticated');
    expect(getVerifiedUserId()).toBe('user-b');
    expect(getVerifiedClerkUserId()).toBe('clerk-b');
    expect(getResourceSnapshot('identity').data).toMatchObject({ id: 'user-b' });
    expect(await readOfflineTrust()).toMatchObject({ userId: 'user-b', clerkUserId: 'clerk-b' });
    expect(await listOutbox('user-a')).toEqual([]);
  });

  it('settles the current unloaded evidence deadline instead of allowing a prior probe to win', async () => {
    let resolveA!: (value: Response) => void;
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveA = resolve; })));

    const probeA = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-a', sessionId: 'session-a' });
    await vi.waitFor(() => expect(resolveA).toBeTypeOf('function'));
    const unloaded = coordinateAuthBootstrap({ isLoaded: false, isSignedIn: undefined }, { startupFallbackMs: 10 });
    await expect(unloaded).resolves.toMatchObject({ status: 'verification-unavailable' });
    resolveA(json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a', 'clerk-a'));
    await probeA;
    expect(getAuthLifecycle().status).toBe('verification-unavailable');
  });

  it('gates /me while loaded signed-in evidence is incomplete', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'AUTH_REQUIRED' } }, 401)));
    const deadline = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-incomplete' }, { startupFallbackMs: 50 });
    await expect(api('/me')).rejects.toMatchObject({ code: 'CLERK_LOADING', networkFailure: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(getAuthLifecycle().status).not.toBe('unauthenticated');
    await expect(deadline).resolves.toMatchObject({ status: 'verification-unavailable' });
  });

  it('keeps incomplete loaded signed-in evidence behind bounded checking before settling', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    expect(isIncompleteLoadedSignedInEvidence(true, true, 'clerk-incomplete-next')).toBe(true);
    expect(isIncompleteLoadedSignedInEvidence(true, true, undefined, 'session-incomplete')).toBe(true);

    const deadline = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-incomplete-next' }, { startupFallbackMs: 20 });

    // The App auth boundary uses this incomplete-evidence state to withhold
    // PrivateRoutes while the coordinator owns the bounded deadline.
    expect(getAuthLifecycle().status).toBe('checking');
    await expect(deadline).resolves.toMatchObject({ status: 'verification-unavailable' });
    expect(getAuthLifecycle().status).toBe('verification-unavailable');
  });

  it('fails closed when Clerk exposes B before B session evidence is complete', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? json({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }, 200, 'user-a', 'clerk-a')
        : json({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }, 200, 'user-b', 'clerk-b');
    }));

    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-a', sessionId: 'session-a' });
    const partialB = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-b' }, { startupFallbackMs: 10 });
    expect(calls).toBe(1);
    expect(getVerifiedUserId()).toBeUndefined();
    expect(getResourceSnapshot('identity').data).toBeUndefined();
    await expect(partialB).resolves.toMatchObject({ status: 'verification-unavailable' });
    expect((await readOfflineTrust())?.state).toBe('revoked');

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-b', sessionId: 'session-b' })).resolves.toMatchObject({ status: 'authenticated' });
    expect(calls).toBe(2);
    expect(getVerifiedUserId()).toBe('user-b');
  });

  it('retains a matching private view while Clerk sleeps and rotates the same user session', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const fetch = vi.fn(async () => json({ id: 'wake-user', email: 'wake@example.com', personId: 'wake-person' }, 200, 'wake-user', 'clerk-wake'));
    vi.stubGlobal('fetch', fetch);

    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-wake', sessionId: 'session-before' });
    const cachedIdentity = getResourceSnapshot('identity').data;
    const restoring = coordinateAuthBootstrap({ isLoaded: false, isSignedIn: undefined });
    expect(getAuthLifecycle().status).toBe('restoring');
    expect(getVerifiedUserId()).toBe('wake-user');
    expect(getResourceSnapshot('identity').data).toBe(cachedIdentity);
    expect(await readOfflineTrust()).toMatchObject({ state: 'active', clerkUserId: 'clerk-wake' });

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-wake', sessionId: 'session-after' })).resolves.toMatchObject({ status: 'authenticated' });
    await restoring;
    expect(getVerifiedClerkUserId()).toBe('clerk-wake');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('deduplicates signal and signal-less /me callers while preserving caller abort', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const initialFetch = vi.fn(async () => json({ id: 'dedupe-user', email: 'dedupe@example.com', personId: 'dedupe-person' }, 200, 'dedupe-user', 'clerk-dedupe'));
    vi.stubGlobal('fetch', initialFetch);
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-dedupe', sessionId: 'session-dedupe' });
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const signalRequest = getMe({ signal: controller.signal, clerkUserId: 'clerk-dedupe' });
    const sharedRequest = getMe({ clerkUserId: 'clerk-dedupe' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(signalRequest).rejects.toMatchObject({ name: 'AbortError' });
    resolve(json({ id: 'dedupe-user', email: 'dedupe@example.com', personId: 'dedupe-person' }, 200, 'dedupe-user', 'clerk-dedupe'));
    await expect(sharedRequest).resolves.toMatchObject({ id: 'dedupe-user' });
  });

  it('coalesces scheduled foreground auth intents into one /me probe', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; return json({ id: 'burst-user', email: 'burst@example.com', personId: 'burst-person' }, 200, 'burst-user', 'clerk-burst'); }));
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-burst' });
    calls = 0;
    await Promise.all([scheduleAuthVerification({ networkOnly: true }), scheduleAuthVerification(), scheduleAuthVerification({ networkOnly: true })]);
    expect(calls).toBe(1);
  });

  it('coalesces foreground events that arrive after the debounce while resume verification is in flight', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; return json({ id: 'resume-user', email: 'resume@example.com', personId: 'resume-person' }, 200, 'resume-user', 'clerk-resume'); }));
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-resume', sessionId: 'session-resume' });
    calls = 0;
    let resolveProbe!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveProbe = resolve; })));
    const started = vi.fn();
    vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
    vi.stubGlobal('window', { dispatchEvent: (event: Event) => { if (event.type === 'billsplit-auth-resume-started') started(event); return true; } });
    const first = scheduleAuthVerification({ networkOnly: true });
    await vi.waitFor(() => expect(resolveProbe).toBeTypeOf('function'));
    const second = scheduleAuthVerification({ networkOnly: true });
    expect(started).toHaveBeenCalledTimes(1);
    expect(resolveProbe).toBeTypeOf('function');
    resolveProbe(json({ id: 'resume-user', email: 'resume@example.com', personId: 'resume-person' }, 200, 'resume-user', 'clerk-resume'));
    await Promise.all([first, second]);
    await Promise.resolve();
    expect(started).toHaveBeenCalledTimes(1);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('CustomEvent', undefined);
  });

  it('retains the live same-user view when wake verification and durable trust are both unavailable, then recovers on foreground resume', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const fetch = vi.fn(async () => json({ id: 'burst-user', email: 'burst@example.com', personId: 'burst-person' }, 200, 'burst-user', 'clerk-burst'));
    vi.stubGlobal('fetch', fetch);
     await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-live-wake' });
     await revokeOfflineTrust();
     const retryDelays: number[] = [];
     let retryCallback!: () => void;
     const restoreRetryScheduler = setForegroundRetrySchedulerForTests((callback, delay) => { retryCallback = callback; retryDelays.push(delay); return 1 as ReturnType<typeof setTimeout>; }, () => undefined);
     fetch.mockImplementation(async () => { throw new TypeError('phone wake transport failure'); });

     await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-live-wake' }, { networkOnly: true })).resolves.toMatchObject({ status: 'authenticated' });
     expect(getVerifiedUserId()).toBe('burst-user');
      expect(retryDelays[0]).toBeGreaterThan(0);
      expect(retryDelays[0]).toBeLessThanOrEqual(250);
     vi.stubGlobal('document', { visibilityState: 'hidden' });
     retryCallback();
     expect(retryDelays).toHaveLength(1);
     vi.stubGlobal('document', undefined);
     restoreRetryScheduler();

     fetch.mockImplementation(async () => json({ id: 'burst-user', email: 'burst@example.com', personId: 'burst-person' }, 200, 'burst-user', 'clerk-burst'));
     await expect(resumeAuthVerification({ networkOnly: true, force: true })).resolves.toMatchObject({ status: 'authenticated' });
     expect(fetch).toHaveBeenCalledTimes(3);
   });

  it('classifies transport restoration for automatic resume but not definitive identity outcomes', () => {
    expect(isRetryableAuthFailure(new ApiError('offline', { networkFailure: true }))).toBe(true);
    expect(isRetryableAuthFailure(new ApiError('mismatch', { code: 'IDENTITY_MISMATCH', status: 401 }))).toBe(false);
    expect(isRetryableAuthFailure(new ApiError('timeout', { code: 'VERIFICATION_TIMEOUT', networkFailure: true }))).toBe(true);
    expect(isRetryableAuthFailure(new ApiError('provider unavailable', { code: 'VERIFICATION_UNAVAILABLE' }))).toBe(false);
  });

  it('keeps the active route contract for route-less foreground probes', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'foreground-route-user', email: 'foreground@example.com', personId: 'foreground-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    await updateGroupSnapshot('foreground-route-user', 'foreground-route', {
      group: { id: 'foreground-route', name: 'Foreground route', currency: 'USD', createdAt: '', updatedAt: '', role: 'member', memberCount: 1 },
      members: [{ personId: 'foreground-person', name: 'Foreground user', joinedAt: '', role: 'member' }],
      balances: {},
      transactions: [],
    });
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn());

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-foreground-route' }, { route: { pathname: '/groups/foreground-route' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: true, privateCacheRouteKey: '/groups/foreground-route' });

    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>captive portal</html>', { status: 503, headers: { 'Content-Type': 'text/html' } })));
    await expect(scheduleAuthVerification({ networkOnly: true })).resolves.toMatchObject({ status: 'trusted-offline', privateCacheRouteKey: '/groups/foreground-route' });
    await expect(requestAuthProbe({ networkOnly: true })).resolves.toMatchObject({ status: 'trusted-offline', privateCacheRouteKey: '/groups/foreground-route' });
  });

  it('renders the active route from trusted cache while authoritative /me is delayed', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'cached-route-user', email: 'cached@example.com', personId: 'cached-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    await updateGroupSnapshot('cached-route-user', 'group-route', {
      group: { id: 'group-route', name: 'Cached trip', currency: 'USD', createdAt: '', updatedAt: '', role: 'member', memberCount: 2 },
      members: [{ personId: 'cached-person', name: 'Cached user', joinedAt: '', role: 'member' }],
      balances: {},
      transactions: [{ kind: 'expense', id: 'transaction-route', groupId: 'group-route', description: 'Cached dinner', amountMinor: 1200, currency: 'USD', date: '2026-08-24', createdBy: 'cached-route-user', createdAt: '' }],
    });
    let resolve!: (response: Response) => void;
    const fetch = vi.fn((request: RequestInfo | URL) => String(request).endsWith('/me')
      ? new Promise<Response>((done) => { resolve = done; })
      : Promise.resolve(json({ ok: true }, 200, 'cached-route-user', 'clerk-burst')));
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', fetch);

    const verification = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-route' }, { route: { pathname: '/groups/group-route' } });
    await vi.waitFor(() => expect(getAuthLifecycle().status).toBe('provisional'));
    expect(fetch).toHaveBeenCalledTimes(1);
    await flushOutbox();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getResourceSnapshot(resourceKeys.group('cached-route-user', 'group-route')).data).toMatchObject({ group: { name: 'Cached trip' } });
    expect(getResourceSnapshot(resourceKeys.transactions('cached-route-user', 'group-route', 'overview')).data).toMatchObject({ transactions: [{ id: 'transaction-route' }] });
    await enqueueExpense({
      userId: 'cached-route-user', groupId: 'group-route', clientOperationId: 'queued-provisional',
      payload: { description: 'Queued offline', amount_minor: 500, currency: 'USD', date: '2026-08-24', payers: [{ person_id: 'cached-person', amount_minor: 500 }], splits: [{ person_id: 'cached-person', amount_minor: 500 }] },
      display: { description: 'Queued offline', amountMinor: 500, currency: 'USD', date: '2026-08-24' },
    });
    expect(getOutboxSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ clientOperationId: 'queued-provisional', status: 'pending' })]));
    await flushOutbox();
    expect(fetch).toHaveBeenCalledTimes(1);

    resolve(json({ id: 'cached-route-user', email: 'cached@example.com', personId: 'cached-person' }, 200, 'cached-route-user', 'clerk-burst'));
    await expect(verification).resolves.toMatchObject({ status: 'authenticated' });
    expect(getResourceSnapshot('identity').data).toMatchObject({ id: 'cached-route-user' });
  });

  it('marks a trusted deep link unavailable when its essential route cache is missing', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'cold-route-user', email: 'cold@example.com', personId: 'cold-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', fetch);

    const verification = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-cold' }, { route: { pathname: '/groups/missing-group' } });
    await vi.waitFor(() => expect(getAuthLifecycle().status).toBe('provisional'));
    expect(getAuthLifecycle().privateCacheAvailable).toBe(false);
    expect(getResourceSnapshot(resourceKeys.group('cold-route-user', 'missing-group')).data).toBeUndefined();

    resolve(json({ id: 'cold-route-user', email: 'cold@example.com', personId: 'cold-person' }, 200, 'cold-route-user', 'clerk-burst'));
    await expect(verification).resolves.toMatchObject({ status: 'authenticated' });
  });

  it('settles a signed-in first-time route as verification-unavailable when /me is unreachable', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('verification unavailable'); }));

    const result = await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-first-time' }, { route: { pathname: '/groups/first-time-group' } });

    expect(result).toMatchObject({ status: 'verification-unavailable' });
    expect(getAuthLifecycle()).toMatchObject({ status: 'verification-unavailable' });
  });

  it('fences a stale first-time route failure while the current route settles terminally', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    let rejectMe!: (error: unknown) => void;
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('/me')) return new Promise<Response>((_resolve, reject) => { rejectMe = reject; });
      return json({}, 200, 'first-time-route-user', 'clerk-burst');
    }));

    const routeA = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-first-time-race' }, { route: { pathname: '/groups/first-time-a' } });
    await vi.waitFor(() => expect(rejectMe).toBeTypeOf('function'));
    const routeB = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-first-time-race' }, { route: { pathname: '/groups/first-time-b' } });
    await vi.waitFor(() => expect(getAuthLifecycle().privateCacheRouteKey).toBe('/groups/first-time-b'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejectMe(new TypeError('verification unavailable'));

    const resultB = await routeB;
    const resultA = await routeA;
    expect({ resultA, resultB }).toMatchObject({ resultA: { status: 'checking' }, resultB: { status: 'verification-unavailable' } });
    expect(getAuthLifecycle()).toMatchObject({ status: 'verification-unavailable' });
  });

  it('keeps a cold offline deep link unavailable instead of promoting it to trusted-offline', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'cold-offline-user', email: 'cold-offline@example.com', personId: 'cold-offline-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    const fetch = vi.fn();
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', fetch);

    const result = await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-cold-offline' }, { route: { pathname: '/groups/missing-offline-group' } });
    expect(result).toMatchObject({ status: 'provisional', privateCacheAvailable: false });
    expect(getAuthLifecycle()).toMatchObject({ status: 'provisional', privateCacheAvailable: false });
    expect(fetch).not.toHaveBeenCalled();
    const retry = await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-cold-offline' }, { route: { pathname: '/groups/missing-offline-group' } });
    expect(retry).toMatchObject({ status: 'provisional', privateCacheAvailable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows identity-only settings to use trusted offline startup without route data', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'settings-offline-user', email: 'settings-offline@example.com', personId: 'settings-offline-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn());

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-settings-offline' }, { route: { pathname: '/settings' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: true });
  });

  it('restores a group-specific expense form from scoped group data without cached home groups', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'expense-form-user', email: 'expense-form@example.com', personId: 'expense-form-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    await updateGroupSnapshot('expense-form-user', 'expense-form-group', {
      group: { id: 'expense-form-group', name: 'Expense form group', currency: 'USD', createdAt: '', updatedAt: '', role: 'member', memberCount: 1 },
      members: [{ personId: 'expense-form-person', name: 'Expense form user', joinedAt: '', role: 'member' }],
    });
    await saveCategories({ userId: 'expense-form-user', categories: ['Dining'], fetchedAt: new Date().toISOString() });
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn());

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-expense-form' }, { route: { pathname: '/groups/expense-form-group/expense/new' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: true });
    expect(getResourceSnapshot(resourceKeys.group('expense-form-user', 'expense-form-group')).data).toMatchObject({ group: { id: 'expense-form-group' } });
    expect(getResourceSnapshot(resourceKeys.categories('expense-form-user')).data).toMatchObject({ categories: ['Dining'] });
    expect(getResourceSnapshot(resourceKeys.groups('expense-form-user')).data).toBeUndefined();

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-expense-form' }, { force: true, route: { pathname: '/expense/new' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: false });
  });

  it('does not call a group overview cache useful until balances and transactions are both persisted', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'overview-contract-user', email: 'overview-contract@example.com', personId: 'overview-contract-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    const base = {
      group: { id: 'overview-contract-group', name: 'Overview contract', currency: 'USD' as const, createdAt: '', updatedAt: '', role: 'member' as const, memberCount: 1 },
      members: [{ personId: 'overview-contract-person', name: 'Overview user', joinedAt: '', role: 'member' as const }],
      transactions: [],
    };
    await updateGroupSnapshot('overview-contract-user', 'overview-contract-group', base);
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn());

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-overview-contract' }, { route: { pathname: '/groups/overview-contract-group' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: false });
    await updateGroupSnapshot('overview-contract-user', 'overview-contract-group', { balances: {} });
    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-overview-contract' }, { force: true, route: { pathname: '/groups/overview-contract-group' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: true });
    expect(getResourceSnapshot(resourceKeys.transactions('overview-contract-user', 'overview-contract-group', 'overview')).data).toMatchObject({ transactions: [] });
  });

  it('does not provision All transactions from a five-row overview cache', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'transactions-route-user', email: 'transactions-route@example.com', personId: 'transactions-route-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    const group = { id: 'transactions-route-group', name: 'Transactions route', currency: 'USD' as const, createdAt: '', updatedAt: '', role: 'member' as const, memberCount: 1 };
    const members = [{ personId: 'transactions-route-person', name: 'Transactions user', joinedAt: '', role: 'member' as const }];
    const transaction = (id: string) => ({ kind: 'expense' as const, id, groupId: 'transactions-route-group', description: id, amountMinor: 100, currency: 'USD' as const, date: '2026-08-24', category: null, notes: null, createdBy: 'transactions-route-user', createdAt: '' });
    await updateGroupSnapshot('transactions-route-user', 'transactions-route-group', { group, members, transactions: Array.from({ length: 5 }, (_, index) => transaction(`overview-${index}`)), transactionsLimit: 5 });
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn());

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-transactions-route' }, { route: { pathname: '/groups/transactions-route-group/transactions' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: false });

    await updateGroupSnapshot('transactions-route-user', 'transactions-route-group', { transactions: Array.from({ length: 25 }, (_, index) => transaction(`history-${index}`)), transactionsLimit: 25 });
    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-transactions-route' }, { force: true, route: { pathname: '/groups/transactions-route-group/transactions' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: true });
    expect(getResourceSnapshot<{ transactions: Array<{ id: string }> }>(resourceKeys.transactions('transactions-route-user', 'transactions-route-group', transactionFilterKey({}))).data?.transactions[0]).toMatchObject({ id: 'history-0' });
  });

  it('fences provisional route A when the active route changes to an uncached then cached route B', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'route-switch-user', email: 'route-switch@example.com', personId: 'route-switch-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    const group = (id: string) => ({
      group: { id, name: id, currency: 'USD' as const, createdAt: '', updatedAt: '', role: 'member' as const, memberCount: 1 },
      members: [{ personId: 'route-switch-person', name: 'Route switch', joinedAt: '', role: 'member' as const }],
      balances: {},
      transactions: [],
    });
    await updateGroupSnapshot('route-switch-user', 'route-a', group('route-a'));
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn());

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-route-switch' }, { route: { pathname: '/groups/route-a' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: true });
    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-route-switch' }, { route: { pathname: '/groups/route-b' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: false });
    expect(getResourceSnapshot(resourceKeys.group('route-switch-user', 'route-b')).data).toBeUndefined();

    await updateGroupSnapshot('route-switch-user', 'route-b', group('route-b'));
    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-route-switch' }, { force: true, route: { pathname: '/groups/route-b' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: true });
    expect(getResourceSnapshot(resourceKeys.group('route-switch-user', 'route-b')).data).toMatchObject({ group: { id: 'route-b' } });
  });

  it('restores legacy group activity links through the canonical activity cache key', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'legacy-activity-user', email: 'legacy-activity@example.com', personId: 'legacy-activity-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    await saveActivity({ userId: 'legacy-activity-user', groupId: 'legacy-group', activity: [{ type: 'expense', id: 'legacy-event', entityId: 'legacy-expense', entityActive: true, amountMinor: 100, currency: 'USD', transactionDate: '2026-08-24', label: 'Lunch', createdAt: '2026-08-24T00:00:00.000Z' }], fetchedAt: new Date().toISOString() });
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn());

    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-legacy-activity' }, { route: { pathname: '/groups/legacy-group/activity' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: true });
    expect(getResourceSnapshot(resourceKeys.activity('legacy-activity-user', 'legacy-group')).data).toMatchObject({ activity: [{ id: 'legacy-event' }] });
  });

  it('only authorizes the exact normalized cached route key synchronously', () => {
    const lifecycle = { privateCacheRouteKey: authRouteCacheKey('/groups/route-a', '?z=2&group=route-a') };
    expect(isPrivateCacheRouteCurrent(lifecycle, '/groups/route-a', '?group=route-a&z=2')).toBe(true);
    expect(isPrivateCacheRouteCurrent(lifecycle, '/groups/route-b', '?group=route-a&z=2')).toBe(false);
    expect(isPrivateCacheRouteCurrent(lifecycle, '/groups/route-a', '?group=route-b&z=2')).toBe(false);
  });

  it('does not let an in-flight route A restore commit after navigation to route B', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'inflight-route-user', email: 'inflight-route@example.com', personId: 'inflight-route-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    await updateGroupSnapshot('inflight-route-user', 'inflight-route-a', {
      group: { id: 'inflight-route-a', name: 'Route A', currency: 'USD', createdAt: '', updatedAt: '', role: 'member', memberCount: 1 },
      members: [{ personId: 'inflight-route-person', name: 'In-flight user', joinedAt: '', role: 'member' }],
      balances: {}, transactions: [],
    });
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const originalReadGroupSnapshot = idb.readGroupSnapshot;
    vi.spyOn(idb, 'readGroupSnapshot').mockImplementation(async (userId, groupId) => {
      if (groupId === 'inflight-route-a') await gateA;
      return originalReadGroupSnapshot(userId, groupId);
    });
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn());

    const routeA = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-inflight-route' }, { route: { pathname: '/groups/inflight-route-a' } });
    await vi.waitFor(() => expect(getAuthLifecycle().privateCacheRouteKey).toBe('/groups/inflight-route-a'));
    const stopAuthLifecycle = subscribeAuthLifecycle(() => undefined);
    const routeB = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-inflight-route' }, { route: { pathname: '/groups/inflight-route-b' } });
    await vi.waitFor(() => expect(getAuthLifecycle().status).toBe('provisional'));
    await expect(routeB).resolves.toMatchObject({ privateCacheRouteKey: '/groups/inflight-route-b' });
    expect(getAuthLifecycle()).toMatchObject({ status: 'provisional', privateCacheAvailable: false, privateCacheRouteKey: '/groups/inflight-route-b' });
    releaseA();
    await routeA;
    expect(getAuthLifecycle()).toMatchObject({ status: 'provisional', privateCacheRouteKey: '/groups/inflight-route-b' });
    stopAuthLifecycle();
    expect(getResourceSnapshot(resourceKeys.group('inflight-route-user', 'inflight-route-a')).data).toBeUndefined();
  });

  it('fails closed on an online-reported network failure for an uncached deep link', async () => {
    await clearEverythingForLogout(false);
    clearSessionLogout();
    recoverAfterClerkSignOutFailure();
    clearAuthRequired();
    await saveOfflineTrust({ userId: 'false-online-user', email: 'false-online@example.com', personId: 'false-online-person', clerkUserId: 'clerk-burst', verifiedAt: new Date().toISOString() });
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('fetch', vi.fn());
    await expect(coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-false-online' }, { route: { pathname: '/groups/false-online-missing' } })).resolves.toMatchObject({ status: 'provisional', privateCacheAvailable: false, privateCacheRouteKey: '/groups/false-online-missing' });

    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('captive portal'); }));
    const result = await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-burst', sessionId: 'session-false-online' }, { networkOnly: true, route: { pathname: '/groups/false-online-missing' } });
    expect(result).toMatchObject({ status: 'provisional', privateCacheAvailable: false, privateCacheRouteKey: '/groups/false-online-missing' });
    expect(getAuthLifecycle().status).not.toBe('trusted-offline');
  });

  it('coalesces a reconnect event with the App checking bootstrap even when /me is fast', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; return json({ id: 'reconnect-user', email: 'reconnect@example.com', personId: 'reconnect-person' }, 200, 'reconnect-user', 'clerk-reconnect'); }));
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-reconnect', sessionId: 'session-reconnect' });
    calls = 0;

    signalConnectionChecking();
    const appEquivalentBootstrap = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-reconnect', sessionId: 'session-reconnect' }, { networkOnly: true });
    await appEquivalentBootstrap;
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(calls).toBe(1);
  });

  it('does not let the connected transition from its own /me start or fail a second probe', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    let calls = 0;
    const fetch = vi.fn(async () => { calls += 1; return json({ id: 'single-probe-user', email: 'single@example.com', personId: 'single-person' }, 200, 'single-probe-user', 'clerk-single-probe'); });
    vi.stubGlobal('fetch', fetch);

    signalConnectionChecking();
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-single-probe', sessionId: 'session-single-probe' }, { networkOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(calls).toBe(1);
    expect(getAuthLifecycle().status).toBe('authenticated');

    fetch.mockImplementation(async () => { calls += 1; throw new TypeError('redundant probe should not run'); });
    await coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-single-probe', sessionId: 'session-single-probe' });
    expect(calls).toBe(1);
    expect(getAuthLifecycle().status).toBe('authenticated');
  });
});
