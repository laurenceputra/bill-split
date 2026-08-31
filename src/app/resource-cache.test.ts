import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockResourceIdentity, clearResourceCache, configureResource, getResourceIdentityEpoch, getResourceSnapshot, initializeForegroundCoordinator, invalidateForMutation, invalidateResource, isResourceFresh, MIN_RESOURCE_FRESHNESS_MS, revalidate, refreshVisiblePrivateResources, resourceKeys, resourceViewState, resetResourceIdentity, seedResource, setResourceAuthLifecycleReady, setResourceIdentity, trackVisibleResource } from './resource-cache';

afterEach(() => { setResourceAuthLifecycleReady(true); resetResourceIdentity(); clearResourceCache(); vi.unstubAllGlobals(); });

describe('resource cache', () => {
  it('distinguishes cold loading, no-data errors, and cached data', () => {
    expect(resourceViewState(getResourceSnapshot('view-state-cold', 'user-a'))).toBe('loading');
    const key = 'view-state-error';
    configureResource(key, 'user-a', async () => { throw new Error('failed'); });
    return revalidate(key, 'user-a').catch(() => undefined).then(() => {
      expect(resourceViewState(getResourceSnapshot(key, 'user-a'))).toBe('error');
      seedResource(key, 'user-a', { value: [] });
      expect(resourceViewState(getResourceSnapshot(key, 'user-a'))).toBe('ready');
    });
  });

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

  it('makes an invalidated expense detail immediately eligible for recovery refresh', async () => {
    const key = resourceKeys.expenseDetail('user-a', 'expense-conflict');
    seedResource(key, 'user-a', { expense: { version: 1 }, history: [] });
    let calls = 0;
    configureResource(key, 'user-a', async () => { calls += 1; return { expense: { version: 2 }, history: [] }; });
    const stop = trackVisibleResource(key, 'user-a');
    invalidateResource(key, 'user-a', { revalidate: false });
    await revalidate(key, 'user-a', { force: true, reason: 'mutation' });
    stop();
    expect(calls).toBe(1);
    expect(getResourceSnapshot<{ expense: { version: number } }>(key, 'user-a').data?.expense.version).toBe(2);
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

  it('force refreshes every visible private resource after auth without refreshing identity', async () => {
    setResourceIdentity('user-a');
    let identityCalls = 0;
    let privateCalls = 0;
    let secondPrivateCalls = 0;
    seedResource('identity', 'identity', { id: 'user-a' });
    configureResource('identity', 'identity', async () => { identityCalls += 1; return { id: 'user-a' }; });
    const key = resourceKeys.groups('user-a');
    seedResource(key, 'user-a', { version: 1 });
    configureResource(key, 'user-a', async () => { privateCalls += 1; return { version: 2 }; });
    const secondKey = resourceKeys.balances('user-a', 'group-1');
    seedResource(secondKey, 'user-a', { version: 1 });
    configureResource(secondKey, 'user-a', async () => { secondPrivateCalls += 1; return { version: 2 }; });
    const stop = trackVisibleResource(key, 'user-a');
    const stopSecond = trackVisibleResource(secondKey, 'user-a');

    await refreshVisiblePrivateResources();
    stop();
    stopSecond();

    expect(privateCalls).toBe(1);
    expect(secondPrivateCalls).toBe(1);
    expect(identityCalls).toBe(0);
    expect(getResourceSnapshot<{ version: number }>(key, 'user-a').data?.version).toBe(2);
  });

  it('does not commit a forced private refresh after the cache identity generation changes', async () => {
    setResourceIdentity('user-a');
    seedResource('identity', 'identity', { id: 'user-a' });
    const key = resourceKeys.groups('user-a');
    seedResource(key, 'user-a', { version: 1 });
    let resolve!: (value: { version: number }) => void;
    configureResource(key, 'user-a', () => new Promise((done) => { resolve = done; }));
    const stop = trackVisibleResource(key, 'user-a');
    const refresh = refreshVisiblePrivateResources();
    setResourceIdentity('user-b');
    resolve({ version: 2 });
    await refresh;
    stop();

    expect(getResourceSnapshot(key, 'user-a').data).toBeUndefined();
  });

  it('blocks focus revalidation until the auth lifecycle is confirmed', async () => {
    const key = `test-auth-gated-focus-${crypto.randomUUID()}`;
    let calls = 0;
    configureResource(key, 'user-a', async () => { calls += 1; return 'server'; });
    setResourceAuthLifecycleReady(false);
    await revalidate(key, 'user-a', { reason: 'focus' });
    expect(calls).toBe(0);
    setResourceAuthLifecycleReady(true);
    await revalidate(key, 'user-a', { reason: 'focus' });
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

  it('does not fetch a cold resource while definitively offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    let calls = 0;
    const key = `test-cold-offline-${crypto.randomUUID()}`;
    configureResource(key, 'user-a', async () => { calls += 1; return 'server'; });

    await revalidate(key, 'user-a');

    expect(calls).toBe(0);
    expect(getResourceSnapshot(key, 'user-a').data).toBeUndefined();
    expect(getResourceSnapshot(key, 'user-a').status).toBe('idle');
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

  it('allows an explicit auth-restored retry to escape the identity block', async () => {
    let calls = 0;
    blockResourceIdentity(new Error('AUTH_REQUIRED'));
    configureResource('identity', 'identity', async () => { calls += 1; return { id: 'user-a' }; });

    await revalidate('identity', '', { force: true, reason: 'auth-restored' });

    expect(calls).toBe(1);
    expect(getResourceSnapshot<{ id: string }>('identity').data?.id).toBe('user-a');
  });

  it('restores the identity block after an explicit network retry fails', async () => {
    let calls = 0;
    blockResourceIdentity(new Error('AUTH_REQUIRED'));
    configureResource('identity', 'identity', async () => {
      calls += 1;
      throw Object.assign(new Error('network failed'), { networkFailure: true });
    });

    await expect(revalidate('identity', '', { force: true, reason: 'auth-restored' })).rejects.toThrow('network failed');
    expect(getResourceSnapshot('identity').status).toBe('auth-blocked');
    await revalidate('identity', 'identity', { reason: 'identity-check' });
    expect(calls).toBe(1);
  });

  it('restores the identity block after an explicit server-error retry fails', async () => {
    let calls = 0;
    blockResourceIdentity(new Error('AUTH_REQUIRED'));
    configureResource('identity', 'identity', async () => {
      calls += 1;
      throw Object.assign(new Error('server failed'), { status: 503 });
    });

    await expect(revalidate('identity', '', { force: true, reason: 'auth-restored' })).rejects.toThrow('server failed');
    expect(getResourceSnapshot('identity').status).toBe('auth-blocked');
    await revalidate('identity', 'identity', { reason: 'identity-check' });
    expect(calls).toBe(1);
  });

  it.each([403, 429])('restores the identity block after an explicit %s retry fails', async (status) => {
    let calls = 0;
    blockResourceIdentity(new Error('AUTH_REQUIRED'));
    configureResource('identity', 'identity', async () => {
      calls += 1;
      throw Object.assign(new Error(`request failed (${status})`), { status });
    });

    await expect(revalidate('identity', '', { force: true, reason: 'auth-restored' })).rejects.toThrow(`request failed (${status})`);
    expect(getResourceSnapshot('identity').status).toBe('auth-blocked');
    await revalidate('identity', 'identity', { reason: 'identity-check' });
    expect(calls).toBe(1);
  });

  it('keeps forced route retries scoped to the authenticated user', async () => {
    const key = resourceKeys.group('user-a', 'group-1');
    let calls = 0;
    seedResource(key, 'user-a', { version: 1 });
    configureResource(key, 'user-a', async () => { calls += 1; return { version: 2 }; });

    await revalidate(key, 'user-a', { force: true, reason: 'route' });

    expect(calls).toBe(1);
    expect(getResourceSnapshot<{ version: number }>(key, 'user-a').data?.version).toBe(2);
    expect(getResourceSnapshot(key, 'user-a').userId).toBe('user-a');
  });

  it('invalidates home summaries with expense and settlement mutations', async () => {
    setResourceIdentity('user-a');
    const keys = [resourceKeys.groups('user-a'), resourceKeys.expenses('user-a', 'group-1'), resourceKeys.settlements('user-a', 'group-1')];
    [resourceKeys.groups('user-a'), resourceKeys.expenses('user-a', 'group-1'), resourceKeys.settlements('user-a', 'group-1'), resourceKeys.balances('user-a', 'group-1'), resourceKeys.activity('user-a', 'group-1')].forEach((key) => seedResource(key, 'user-a', { cached: true }));
    await invalidateForMutation.expenseChanged('group-1', 'expense-1', 'user-a');
    expect(keys.every((key) => getResourceSnapshot(key, 'user-a').stale)).toBe(true);
    [resourceKeys.groups('user-a'), resourceKeys.settlements('user-a', 'group-1'), resourceKeys.balances('user-a', 'group-1'), resourceKeys.activity('user-a', 'group-1')].forEach((key) => seedResource(key, 'user-a', { cached: true }));
    await invalidateForMutation.settlementChanged('group-1', 'user-a');
    expect([resourceKeys.groups('user-a'), resourceKeys.settlements('user-a', 'group-1'), resourceKeys.balances('user-a', 'group-1'), resourceKeys.activity('user-a', 'group-1')].every((key) => getResourceSnapshot(key, 'user-a').stale)).toBe(true);
  });

  it('invalidates the unified transaction resource and filtered variants', async () => {
    setResourceIdentity('user-a');
    const first = resourceKeys.transactions('user-a', 'group-1');
    const filtered = resourceKeys.transactions('user-a', 'group-1', '["expense","dinner"]');
    [first, filtered].forEach((key) => seedResource(key, 'user-a', { cached: true }));
    await invalidateForMutation.settlementChanged('group-1', 'user-a');
    expect(getResourceSnapshot(first, 'user-a').stale).toBe(true);
    expect(getResourceSnapshot(filtered, 'user-a').stale).toBe(true);
  });

  it('invalidates transaction group labels when a group changes', async () => {
    setResourceIdentity('user-a');
    const scoped = resourceKeys.transactions('user-a', 'group-1');
    const global = resourceKeys.transactions('user-a', 'all');
    [scoped, global].forEach((key) => seedResource(key, 'user-a', { cached: true }));

    await invalidateForMutation.groupChanged('group-1', 'user-a');

    expect(getResourceSnapshot(scoped, 'user-a').stale).toBe(true);
    expect(getResourceSnapshot(global, 'user-a').stale).toBe(true);
  });

  it('invalidates every filtered expense resource for the mutated group', async () => {
    setResourceIdentity('user-a');
    const unfiltered = resourceKeys.expenses('user-a', 'group-1');
    const filtered = resourceKeys.expenses('user-a', 'group-1', 'q:dinner');
    const otherGroup = resourceKeys.expenses('user-a', 'group-2', 'q:dinner');
    [unfiltered, filtered, otherGroup].forEach((key) => seedResource(key, 'user-a', { cached: true }));
    await invalidateForMutation.expenseChanged('group-1', 'expense-1', 'user-a');
    expect(getResourceSnapshot(unfiltered, 'user-a').stale).toBe(true);
    expect(getResourceSnapshot(filtered, 'user-a').stale).toBe(true);
    expect(getResourceSnapshot(otherGroup, 'user-a').stale).toBe(false);
  });

  it('invalidates only schedule resources for schedule mutations', async () => {
    setResourceIdentity('user-a');
    const scheduleKey = resourceKeys.scheduledExpenses('user-a', 'group-1');
    const detailKey = resourceKeys.scheduledExpense('user-a', 'schedule-1');
    const categoriesKey = resourceKeys.categories('user-a');
    const balanceKey = resourceKeys.balances('user-a', 'group-1');
    seedResource(scheduleKey, 'user-a', { scheduledExpenses: [] });
    seedResource(detailKey, 'user-a', { scheduledExpense: { version: 1 } });
    seedResource(categoriesKey, 'user-a', { categories: ['Custom rent'] });
    seedResource(balanceKey, 'user-a', { unchanged: true });
    await invalidateForMutation.scheduledExpenseChanged('group-1', 'user-a', 'schedule-1');
    expect(getResourceSnapshot(scheduleKey, 'user-a').stale).toBe(true);
    expect(getResourceSnapshot(detailKey, 'user-a').stale).toBe(true);
    expect(getResourceSnapshot(categoriesKey, 'user-a').stale).toBe(true);
    expect(getResourceSnapshot(balanceKey, 'user-a').stale).toBe(false);
  });

  it('invalidates schedule lists and loaded details when group membership changes', async () => {
    setResourceIdentity('user-a');
    const listKey = resourceKeys.scheduledExpenses('user-a', 'group-1');
    const detailKey = resourceKeys.scheduledExpense('user-a', 'schedule-1');
    seedResource(listKey, 'user-a', { scheduledExpenses: [] });
    seedResource(detailKey, 'user-a', { scheduledExpense: { id: 'schedule-1', groupId: 'group-1', version: 1 } });

    await invalidateForMutation.groupChanged('group-1', 'user-a');

    expect(getResourceSnapshot(listKey, 'user-a').stale).toBe(true);
    expect(getResourceSnapshot(detailKey, 'user-a').stale).toBe(true);
  });

  it('invalidates all private group resources without revalidating after self-leave', async () => {
    setResourceIdentity('user-a');
    const keys = [resourceKeys.groups('user-a'), resourceKeys.group('user-a', 'group-1'), resourceKeys.expenses('user-a', 'group-1'), resourceKeys.balances('user-a', 'group-1'), resourceKeys.activity('user-a', 'group-1')];
    keys.forEach((key) => seedResource(key, 'user-a', { cached: true }));
    await invalidateForMutation.groupLeft('group-1', 'user-a');
    expect(keys.every((key) => getResourceSnapshot(key, 'user-a').data === undefined)).toBe(true);
    expect(getResourceSnapshot(resourceKeys.group('user-a', 'group-1'), 'user-a').revalidating).toBe(false);
  });

  it('invalidates deleted group resources without revalidating them', async () => {
    setResourceIdentity('user-a');
    const keys = [resourceKeys.group('user-a', 'group-1'), resourceKeys.expenses('user-a', 'group-1'), resourceKeys.expenses('user-a', 'group-1', 'q:dinner')];
    keys.forEach((key) => seedResource(key, 'user-a', { cached: true }));
    await invalidateForMutation.groupDeleted('group-1', 'user-a');
    expect(keys.every((key) => getResourceSnapshot(key, 'user-a').data === undefined)).toBe(true);
    expect(keys.every((key) => getResourceSnapshot(key, 'user-a').revalidating === false)).toBe(true);
  });

  it('hard-evicts revoked group resources and notifies the active route', async () => {
    vi.stubGlobal('window', new EventTarget());
    setResourceIdentity('user-a');
    const keys = [resourceKeys.groups('user-a'), resourceKeys.group('user-a', 'group-1'), resourceKeys.expenses('user-a', 'group-1', '["q"]'), resourceKeys.activity('user-a', 'group-1'), resourceKeys.activity('user-a', 'all')];
    keys.forEach((key) => seedResource(key, 'user-a', { cached: true }));
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<{ groupId: string }>).detail.groupId);
    window.addEventListener('billsplit-group-revoked', listener);
    await invalidateForMutation.groupAccessRevoked('group-1', 'user-a');
    window.removeEventListener('billsplit-group-revoked', listener);
    expect(keys.every((key) => getResourceSnapshot(key, 'user-a').data === undefined)).toBe(true);
    expect(events).toEqual(['group-1']);
  });
});
