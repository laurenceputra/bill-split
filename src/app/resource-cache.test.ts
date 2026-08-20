import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockResourceIdentity, clearResourceCache, configureResource, getResourceIdentityEpoch, getResourceSnapshot, initializeForegroundCoordinator, isResourceFresh, MIN_RESOURCE_FRESHNESS_MS, revalidate, resourceKeys, resetResourceIdentity, seedResource, setResourceIdentity, trackVisibleResource } from './resource-cache';

afterEach(() => { resetResourceIdentity(); clearResourceCache(); vi.unstubAllGlobals(); });

describe('resource cache', () => {
  it('emits a cached value before a delayed refresh resolves', async () => {
    let resolve!: (value: string) => void;
    const request = new Promise<string>((done) => { resolve = done; });
    const key = `test-cached-${crypto.randomUUID()}`;
    seedResource(key, 'user-a', 'old', Date.now() - MIN_RESOURCE_FRESHNESS_MS - 1);
    configureResource(key, 'user-a', () => request);
    const initial = getResourceSnapshot<string>(key, 'user-a');
    const refresh = revalidate<string>(key, 'user-a');
    expect(getResourceSnapshot<string>(key, 'user-a').data).toBe('old');
    expect(getResourceSnapshot<string>(key, 'user-a').revalidating).toBe(true);
    resolve('new');
    await refresh;
    expect(getResourceSnapshot<string>(key, 'user-a').data).toBe('new');
    expect(initial).not.toBe(getResourceSnapshot<string>(key, 'user-a'));
  });

  it('deduplicates requests and keeps snapshots stable when nothing changes', async () => {
    let calls = 0;
    let resolve!: (value: number) => void;
    const request = new Promise<number>((done) => { resolve = done; });
    const key = `test-dedupe-${crypto.randomUUID()}`;
    configureResource(key, 'user-a', () => { calls += 1; return request; });
    const idle = getResourceSnapshot<number>(key, 'user-a');
    const first = revalidate<number>(key, 'user-a');
    const loading = getResourceSnapshot<number>(key, 'user-a');
    expect(getResourceSnapshot<number>(key, 'user-a')).toBe(loading);
    const second = revalidate<number>(key, 'user-a');
    expect(calls).toBe(1);
    resolve(42);
    await Promise.all([first, second]);
    expect(idle).not.toBe(getResourceSnapshot<number>(key, 'user-a'));
  });

  it('does not fetch while hidden and refreshes stale data when visible', async () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    let calls = 0;
    const key = `test-hidden-${crypto.randomUUID()}`;
    seedResource(key, 'user-a', 'cached', Date.now() - MIN_RESOURCE_FRESHNESS_MS - 1);
    configureResource(key, 'user-a', async () => { calls += 1; return 'server'; });
    await revalidate(key, 'user-a');
    expect(calls).toBe(0);
    vi.stubGlobal('document', { visibilityState: 'visible' });
    await revalidate(key, 'user-a');
    expect(calls).toBe(1);
  });

  it('enforces the thirty-second minimum freshness window', () => {
    const snapshot = getResourceSnapshot('test-fresh', 'user-a');
    expect(isResourceFresh(snapshot, 1)).toBe(false);
    seedResource('test-fresh', 'user-a', 'value', Date.now() - MIN_RESOURCE_FRESHNESS_MS + 100);
    expect(isResourceFresh(getResourceSnapshot('test-fresh', 'user-a'), 1)).toBe(true);
  });

  it('suppresses a loader for a fresh snapshot unless a mutation forces it', async () => {
    let calls = 0;
    const key = `test-fresh-loader-${crypto.randomUUID()}`;
    seedResource(key, 'user-a', 'cached');
    configureResource(key, 'user-a', async () => { calls += 1; return 'server'; }, MIN_RESOURCE_FRESHNESS_MS);
    await revalidate(key, 'user-a');
    expect(calls).toBe(0);
    await revalidate(key, 'user-a', { force: true, reason: 'mutation' });
    expect(calls).toBe(1);
  });

  it('builds account-scoped keys consistently and switches active identity', () => {
    expect(resourceKeys.group('user-a', 'group-1')).toBe('group:user-a:group-1');
    expect(resourceKeys.expenseDetail('user-a', 'expense-1')).not.toBe(resourceKeys.expenseDetail('user-b', 'expense-1'));
    const before = getResourceIdentityEpoch();
    setResourceIdentity('user-a');
    expect(getResourceIdentityEpoch()).toBeGreaterThan(before);
    const same = getResourceIdentityEpoch();
    setResourceIdentity('user-a');
    expect(getResourceIdentityEpoch()).toBe(same);
    expect(getResourceSnapshot('identity').userId).toBe('identity');
    setResourceIdentity('user-b');
    expect(getResourceIdentityEpoch()).toBeGreaterThan(same);
    expect(getResourceSnapshot('identity').userId).toBe('identity');
  });

  it('loads the identity bootstrap without requiring a user id on an online cold start', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('document', { visibilityState: 'visible' });
    let calls = 0;
    configureResource('identity', 'identity', async () => { calls += 1; return { id: 'user-a' }; });
    await revalidate('identity', 'identity');
    expect(calls).toBe(1);
    expect(getResourceSnapshot<{ id: string }>('identity').data?.id).toBe('user-a');
  });

  it('allows a deduped foreground identity check without bypassing data TTLs', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('document', { visibilityState: 'visible' });
    let calls = 0;
    seedResource('identity', 'identity', { id: 'user-a' });
    configureResource('identity', 'identity', async () => { calls += 1; return { id: 'user-a' }; });
    await revalidate('identity', 'identity');
    expect(calls).toBe(0);
    await revalidate('identity', 'identity', { reason: 'identity-check' });
    expect(calls).toBe(1);
  });

  it('hydrates an offline identity and waits for visibility before a cold request', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    setResourceIdentity('offline-user');
    seedResource('identity', 'identity', { id: 'offline-user' }, Date.now() - MIN_RESOURCE_FRESHNESS_MS - 1, { offline: true });
    let calls = 0;
    configureResource('identity', 'identity', async () => { calls += 1; return { id: 'server-user' }; });
    await revalidate('identity', 'identity');
    expect(calls).toBe(0);
    expect(getResourceSnapshot<{ id: string }>('identity').data?.id).toBe('offline-user');

    const listeners = new Map<string, () => void>();
    let visibility: 'hidden' | 'visible' = 'hidden';
    vi.stubGlobal('document', { get visibilityState() { return visibility; }, addEventListener: (type: string, listener: () => void) => listeners.set(type, listener) });
    vi.stubGlobal('window', { addEventListener: () => undefined });
    initializeForegroundCoordinator();
    const stop = trackVisibleResource('identity', 'identity');
    vi.stubGlobal('navigator', { onLine: true });
    visibility = 'visible';
    listeners.get('visibilitychange')?.();
    await new Promise((resolve) => setTimeout(resolve, 130));
    stop();
    expect(calls).toBe(1);
  });

  it('blocks repeated identity failures until explicit auth restoration', async () => {
    let calls = 0;
    configureResource('identity', 'identity', async () => { calls += 1; throw new Error('401'); });
    blockResourceIdentity(new Error('AUTH_REQUIRED'));
    await revalidate('identity', 'identity');
    await revalidate('identity', 'identity');
    expect(calls).toBe(0);
    expect(getResourceSnapshot('identity').status).toBe('auth-blocked');
  });
});
