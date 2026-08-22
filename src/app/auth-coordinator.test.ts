import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, coordinateAuthBootstrap, getAuthLifecycle, getVerifiedClerkUserId, getVerifiedUserId, isIncompleteLoadedSignedInEvidence } from './api';
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

  it('does not unauthenticate loaded signed-in evidence when its session ID is missing and /me returns 401', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'AUTH_REQUIRED' } }, 401)));
    const deadline = coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-incomplete' }, { startupFallbackMs: 50 });
    await expect(api('/me')).rejects.toMatchObject({ status: 401, code: 'IDENTITY_MISMATCH' });
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
});
