import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { clearResourceCache, getResourceSnapshot, invalidateResource, refreshVisiblePrivateResources, resetResourceIdentity, resourceViewState, revalidate, seedResource, setResourceAuthLifecycleReady, setResourceIdentity, useResource, type ResourceHydrator, type ResourceLoader, type ResourceOptions, type ResourceSnapshot } from './resource-cache';

const renderers: ReactTestRenderer[] = [];
beforeEach(() => {
  setResourceAuthLifecycleReady(true);
  setResourceIdentity('user-a');
  seedResource('identity', 'identity', { id: 'user-a' });
});
afterEach(() => {
  act(() => { for (const renderer of renderers.splice(0)) renderer.unmount(); });
  resetResourceIdentity();
  clearResourceCache();
  vi.unstubAllGlobals();
});

type ConsumerProps = { resourceKey: string | null; loader: ResourceLoader<string>; hydrate?: ResourceHydrator<string>; options?: ResourceOptions };
async function mountConsumer(props: ConsumerProps, peer?: ConsumerProps) {
  const snapshots: ResourceSnapshot<string>[] = [];
  function Consumer({ index, resourceKey, loader, hydrate, options }: ConsumerProps & { index: number }) {
    snapshots[index] = useResource(resourceKey, 'user-a', loader, undefined, hydrate, options);
    return null;
  }
  const view = () => <><Consumer index={0} {...props} />{peer && <Consumer index={1} {...peer} />}</>;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(view()); });
  renderers.push(renderer);
  return {
    get current() { return snapshots[0]; },
    get peer() { return snapshots[1]; },
    update: async (changes: Partial<ConsumerProps>) => {
      props = { ...props, ...changes };
      await act(async () => { renderer.update(view()); });
    },
  };
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('disabled resource consumers', () => {
  it.each([false, true])('handles a disabled hydration miss with enabled peer: %s', async (hasPeer) => {
    const hydration = deferred<{ data: string } | undefined>();
    const hydrate = vi.fn(() => hydration.promise);
    const loader = vi.fn(async () => 'server');
    const props = { resourceKey: 'hydration-miss', loader, hydrate };
    const consumer = await mountConsumer(props, hasPeer ? props : undefined);
    expect(hydrate).toHaveBeenCalledTimes(1);
    await consumer.update({ resourceKey: null });
    await act(async () => { hydration.resolve(undefined); });
    expect(loader).toHaveBeenCalledTimes(hasPeer ? 1 : 0);
    expect(consumer.current.data).toBeUndefined();
    if (hasPeer) expect(consumer.peer.data).toBe('server');
    else {
      await act(async () => { await refreshVisiblePrivateResources(); });
      expect(loader).not.toHaveBeenCalled();
    }
    await consumer.update({ resourceKey: 'hydration-miss' });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(consumer.current.data).toBe('server');
  });

  it('fences pending hydration on account change without exposing old data on re-enable', async () => {
    const hydration = deferred<{ data: string } | undefined>();
    const loader = vi.fn(async () => 'server');
    const consumer = await mountConsumer({ resourceKey: 'account-hydration', loader, hydrate: () => hydration.promise });
    await consumer.update({ resourceKey: null, hydrate: undefined });
    await act(async () => { setResourceIdentity('user-b'); hydration.resolve({ data: 'old private cache' }); });
    expect(consumer.current.data).toBeUndefined();
    expect(getResourceSnapshot('account-hydration', 'user-a').data).toBeUndefined();
    // Keep the new account's identity pending so the old account cannot load.
    getResourceSnapshot('identity');
    await consumer.update({ resourceKey: 'account-hydration' });
    expect(consumer.current.data).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  });

  it('preserves offline hydration and skipWhenOffline across disable/re-enable and cold retries', async () => {
    const loader = vi.fn(async () => 'server');
    const hydrate = vi.fn(async () => ({ data: 'offline cached', offline: true }));
    const consumer = await mountConsumer({ resourceKey: null, loader, hydrate, options: { skipWhenOffline: true } });
    await act(async () => { await revalidate('offline-optional', 'user-a', { force: true, reason: 'route' }); });
    expect(loader).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: false });
    await consumer.update({ resourceKey: 'offline-optional' });
    expect(consumer.current.data).toBe('offline cached');
    expect(consumer.current.offline).toBe(true);
    await consumer.update({ resourceKey: null });
    expect(consumer.current.data).toBeUndefined();
    await act(async () => { await revalidate('offline-optional', 'user-a', { force: true, reason: 'route' }); });
    await consumer.update({ resourceKey: 'offline-optional' });
    expect(consumer.current.data).toBe('offline cached');
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(loader).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: true });
    await consumer.update({ hydrate: undefined, options: { skipWhenOffline: false } });
    await act(async () => { await revalidate('offline-optional', 'user-a', { force: true, reason: 'route' }); });
    expect(consumer.current.data).toBe('server');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('does not load, hydrate, register, or refresh while disabled, and hydrates when enabled', async () => {
    const loader = vi.fn(async () => 'server');
    const hydrate = vi.fn(async () => ({ data: 'cached', fetchedAt: Date.now() }));
    const consumer = await mountConsumer({ resourceKey: null, loader, hydrate });
    const disabled = consumer.current;
    await act(async () => { invalidateResource('optional', 'user-a'); await refreshVisiblePrivateResources(); });
    await consumer.update({ resourceKey: null });
    expect(consumer.current).toBe(disabled);
    expect(consumer.current).toMatchObject({ status: 'idle', loading: false, revalidating: false });
    expect(consumer.current.data).toBeUndefined();
    expect(resourceViewState(consumer.current)).not.toBe('ready');
    expect(loader).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    await consumer.update({ resourceKey: 'optional' });
    expect(consumer.current.data).toBe('cached');
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(loader).not.toHaveBeenCalled();
  });

  it('hides an in-flight result immediately on disable and reuses its cache on re-enable', async () => {
    const request = deferred<string>();
    const loader = vi.fn(() => request.promise);
    const consumer = await mountConsumer({ resourceKey: 'in-flight', loader });
    expect(consumer.current.loading).toBe(true);
    await consumer.update({ resourceKey: null });
    expect(consumer.current.data).toBeUndefined();
    expect(consumer.current.status).toBe('idle');
    await act(async () => { request.resolve('completed'); });
    expect(consumer.current.data).toBeUndefined();
    await act(async () => { invalidateResource('in-flight', 'user-a', { revalidate: false }); await refreshVisiblePrivateResources(); });
    expect(loader).toHaveBeenCalledTimes(1);
    await consumer.update({ resourceKey: 'in-flight' });
    expect(consumer.current.data).toBe('completed');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite or unsubscribe an enabled shared consumer', async () => {
    const enabledLoader = vi.fn(async () => 'enabled');
    const disabledLoader = vi.fn(async () => 'disabled');
    const consumer = await mountConsumer({ resourceKey: null, loader: disabledLoader }, { resourceKey: 'shared', loader: enabledLoader });
    expect(consumer.peer.data).toBe('enabled');
    expect(consumer.current.data).toBeUndefined();
    expect(disabledLoader).not.toHaveBeenCalled();
    await consumer.update({ resourceKey: 'shared' });
    expect(consumer.current.data).toBe(consumer.peer.data);
    await consumer.update({ resourceKey: null });
    await act(async () => { invalidateResource('shared', 'user-a'); });
    expect(enabledLoader).toHaveBeenCalledTimes(2);
    expect(disabledLoader).not.toHaveBeenCalled();
    expect(consumer.current.data).toBeUndefined();
  });

  it('keeps late hydration out of the current key and fences a disabled request on account change', async () => {
    const hydration = deferred<{ data: string } | undefined>();
    const request = deferred<string>();
    const loader = vi.fn(() => request.promise);
    seedResource('next', 'user-a', 'next cached');
    const consumer = await mountConsumer({ resourceKey: 'hydrating', loader, hydrate: () => hydration.promise });
    await consumer.update({ resourceKey: 'next', hydrate: undefined });
    await act(async () => { hydration.resolve({ data: 'old cached' }); });
    expect(consumer.current.data).toBe('next cached');
    expect(loader).not.toHaveBeenCalled();
    await consumer.update({ resourceKey: 'account-request' });
    await consumer.update({ resourceKey: null });
    await act(async () => { setResourceIdentity('user-b'); request.resolve('private old result'); });
    expect(consumer.current.data).toBeUndefined();
    expect(getResourceSnapshot('account-request', 'user-a').data).toBeUndefined();
  });
});
