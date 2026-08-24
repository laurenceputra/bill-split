import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, coordinateAuthBootstrap, getAuthLifecycle, getMe, getVerifiedClerkUserId, getVerifiedUserId, isIncompleteLoadedSignedInEvidence, scheduleAuthVerification, signalConnectionChecking } from './api';
import { DB_NAME, listOutbox, readOfflineTrust, saveOfflineTrust } from './idb';
import { getResourceSnapshot } from './resource-cache';

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
