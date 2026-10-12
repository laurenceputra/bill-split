import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalBalanceSnapshot } from '../shared/types';
import { clearCachedData, readGroupSnapshot, savePersonalBalance } from './idb';
import { acceptPersonalBalance, clearPersonalBalances, getPersonalBalance, hydratePersonalBalance, stalePersonalBalances } from './personal-balances';
import { captureSessionGeneration } from './session';
import { configureResource, getResourceSnapshot, invalidateForMutation, receiveBalanceHint, resetResourceIdentity, resourceKeys, seedResource, setResourceAuthLifecycleReady, setResourceIdentity, trackVisibleResource } from './resource-cache';

const snapshot = (ledgerRevision: number, balances: PersonalBalanceSnapshot['balances'] = [{ currency: 'USD', netMinor: 500 }]): PersonalBalanceSnapshot => ({ groupId: 'sample', personId: 'demo', ledgerRevision, defaultCurrency: 'USD', balances });
describe('canonical personal balances', () => {
  afterEach(() => { resetResourceIdentity(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  beforeEach(async () => { clearPersonalBalances(); await clearCachedData(); });
  it('rejects reversed revisions and replaces the complete map, including zero and removed currencies', () => {
    acceptPersonalBalance('a', snapshot(3, [{ currency: 'EUR', netMinor: 100 }, { currency: 'USD', netMinor: 500 }]));
    acceptPersonalBalance('a', snapshot(4, [{ currency: 'USD', netMinor: 0 }]));
    expect(acceptPersonalBalance('a', snapshot(2))).toBe(false);
    expect(getPersonalBalance('a', 'sample')?.snapshot.balances).toEqual([{ currency: 'USD', netMinor: 0 }]);
    stalePersonalBalances('a', 'sample');
    acceptPersonalBalance('a', snapshot(4, []));
    expect(getPersonalBalance('a', 'sample')?.stale).toBe(false);
    expect(getPersonalBalance('a', 'sample')?.snapshot.balances).toEqual([]);
  });
  it('compares and writes revisions transactionally and hydrates without borrowing another account', async () => {
    const generation = captureSessionGeneration();
    await savePersonalBalance('a', snapshot(8, []), 0, generation);
    await savePersonalBalance('a', snapshot(2), 0, generation);
    expect((await readGroupSnapshot('a', 'sample'))?.personalBalance).toEqual(snapshot(8, []));
    await hydratePersonalBalance('b', 'sample');
    expect(getPersonalBalance('b', 'sample')).toBeUndefined();
    await hydratePersonalBalance('a', 'sample');
    expect(getPersonalBalance('a', 'sample')?.snapshot.balances).toEqual([]);
    await expect(savePersonalBalance('a', snapshot(9), 1, generation)).resolves.toBeUndefined();
    expect((await readGroupSnapshot('a', 'sample'))?.personalBalance?.ledgerRevision).toBe(8);
  });
  it('does not turn legacy metadata into a complete snapshot', async () => {
    await hydratePersonalBalance('a', 'sample');
    expect(getPersonalBalance('a', 'sample')).toBeUndefined();
    expect(acceptPersonalBalance('a', undefined)).toBe(false);
  });
  it('stales persisted balances before the post-mutation visible loader starts', async () => {
    setResourceIdentity('a');
    setResourceAuthLifecycleReady(true);
    await savePersonalBalance('a', snapshot(4), 0);
    const key = resourceKeys.balances('a', 'sample');
    seedResource(key, 'a', { balances: {} });
    let loaded: Promise<void> | undefined;
    const loader = vi.fn(() => {
      loaded = readGroupSnapshot('a', 'sample').then((row) => { expect(row?.personalBalanceFetchedAt).toBe(new Date(0).toISOString()); expect(row?.cachedAtByResource?.balances).toBe(new Date(0).toISOString()); });
      return loaded.then(() => ({ balances: {} }));
    });
    configureResource(key, 'a', loader);
    const stop = trackVisibleResource(key, 'a');
    await invalidateForMutation.expenseChanged('sample', undefined, 'a');
    await loaded;
    expect(loader).toHaveBeenCalledOnce();
    stop();
  });
  it('polls subscribed balance sources, never identity, and stops on auth loss', async () => {
    vi.useFakeTimers();
    setResourceIdentity('a'); setResourceAuthLifecycleReady(true);
    const loader = vi.fn(async () => ({ balances: {} }));
    const identity = vi.fn(async () => ({ id: 'a' }));
    configureResource(resourceKeys.identity(), 'identity', identity);
    const key = resourceKeys.balances('a', 'sample');
    configureResource(key, 'a', loader);
    const stop = trackVisibleResource(key, 'a');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(loader).toHaveBeenCalledOnce(); expect(identity).not.toHaveBeenCalled();
    setResourceAuthLifecycleReady(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loader).toHaveBeenCalledOnce();
    expect(getResourceSnapshot(key, 'a').data).toEqual({ balances: {} });
    stop(); setResourceAuthLifecycleReady(true);
  });
  it('isolates and deduplicates remote hints and defers hidden refreshes', async () => {
    setResourceIdentity('a'); setResourceAuthLifecycleReady(true);
    const key = resourceKeys.balances('a', 'sample');
    const loader = vi.fn(async () => ({ balances: {} }));
    configureResource(key, 'a', loader);
    seedResource(key, 'a', { balances: {} });
    const stop = trackVisibleResource(key, 'a');
    receiveBalanceHint({ id: 'other-user', userId: 'b', groupId: 'sample' });
    receiveBalanceHint({ id: 'other-group', userId: 'a', groupId: 'different' });
    expect(loader).not.toHaveBeenCalled();
    receiveBalanceHint({ id: 'remote-once', userId: 'a', groupId: 'sample' });
    await Promise.resolve(); await Promise.resolve();
    receiveBalanceHint({ id: 'remote-once', userId: 'a', groupId: 'sample' });
    expect(loader).toHaveBeenCalledOnce();
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    receiveBalanceHint({ id: 'remote-hidden', userId: 'a', groupId: 'sample' });
    expect(loader).toHaveBeenCalledOnce();
    expect(getResourceSnapshot(key, 'a').stale).toBe(true);
    stop();
  });
});
