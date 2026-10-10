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

function Consumer({ resourceKey, loader, hydrate, capture, options }: { resourceKey: string | null; loader: ResourceLoader<string>; hydrate?: ResourceHydrator<string>; capture: (snapshot: ResourceSnapshot<string>) => void; options?: ResourceOptions }) {
  capture(useResource(resourceKey, 'user-a', loader, undefined, hydrate, options));
  return null;
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('disabled resource consumers', () => {
  it('loads after a shared hydration miss when its initiating consumer disables', async () => {
    const hydration = deferred<{ data: string } | undefined>();
    const hydrate = vi.fn(() => hydration.promise);
    const loader = vi.fn(async () => 'server');
    let first!: ResourceSnapshot<string>;
    let second!: ResourceSnapshot<string>;
    const captureFirst = (snapshot: ResourceSnapshot<string>) => { first = snapshot; };
    const captureSecond = (snapshot: ResourceSnapshot<string>) => { second = snapshot; };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Consumer resourceKey="shared-hydration" loader={loader} hydrate={hydrate} capture={captureFirst} />); });
    renderers.push(renderer);
    const view = (enabled: boolean) => <><Consumer resourceKey={enabled ? 'shared-hydration' : null} loader={loader} hydrate={hydrate} capture={captureFirst} /><Consumer resourceKey="shared-hydration" loader={loader} hydrate={hydrate} capture={captureSecond} /></>;
    await act(async () => { renderer.update(view(true)); });
    expect(hydrate).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.update(view(false)); });
    await act(async () => { hydration.resolve(undefined); });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(first.data).toBeUndefined();
    expect(second.data).toBe('server');
  });

  it('fences pending hydration on account change without exposing old data on re-enable', async () => {
    const hydration = deferred<{ data: string } | undefined>();
    const hydrate = vi.fn(() => hydration.promise);
    const loader = vi.fn(async () => 'server');
    let current!: ResourceSnapshot<string>;
    const capture = (snapshot: ResourceSnapshot<string>) => { current = snapshot; };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Consumer resourceKey="account-hydration" loader={loader} hydrate={hydrate} capture={capture} />); });
    renderers.push(renderer);
    await act(async () => { renderer.update(<Consumer resourceKey={null} loader={loader} capture={capture} />); });
    await act(async () => { setResourceIdentity('user-b'); hydration.resolve({ data: 'old private cache' }); });
    expect(current.data).toBeUndefined();
    expect(getResourceSnapshot('account-hydration', 'user-a').data).toBeUndefined();
    // Keep the new account's identity pending so the old account cannot load.
    getResourceSnapshot('identity');
    await act(async () => { renderer.update(<Consumer resourceKey="account-hydration" loader={loader} capture={capture} />); });
    expect(current.data).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  });

  it('preserves offline hydration and skipWhenOffline across disable/re-enable and cold retries', async () => {
    const loader = vi.fn(async () => 'server');
    const hydrate = vi.fn(async () => ({ data: 'offline cached', offline: true }));
    const options = { skipWhenOffline: true };
    let current!: ResourceSnapshot<string>;
    const capture = (snapshot: ResourceSnapshot<string>) => { current = snapshot; };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Consumer resourceKey={null} loader={loader} hydrate={hydrate} options={options} capture={capture} />); });
    renderers.push(renderer);
    await act(async () => { await revalidate('offline-optional', 'user-a', { force: true, reason: 'route' }); });
    expect(loader).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: false });
    const view = (enabled: boolean) => <Consumer resourceKey={enabled ? 'offline-optional' : null} loader={loader} hydrate={hydrate} options={options} capture={capture} />;
    await act(async () => { renderer.update(view(true)); });
    expect(current.data).toBe('offline cached');
    expect(current.offline).toBe(true);
    await act(async () => { renderer.update(view(false)); });
    expect(current.data).toBeUndefined();
    await act(async () => { await revalidate('offline-optional', 'user-a', { force: true, reason: 'route' }); renderer.update(view(true)); });
    expect(current.data).toBe('offline cached');
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(loader).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: true });
    await act(async () => { renderer.update(<Consumer resourceKey="offline-optional" loader={loader} options={{ skipWhenOffline: false }} capture={capture} />); });
    await act(async () => { await revalidate('offline-optional', 'user-a', { force: true, reason: 'route' }); });
    expect(current.data).toBe('server');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('does not load, hydrate, or refresh while disabled, and hydrates when enabled', async () => {
    const loader = vi.fn(async () => 'server');
    const hydrate = vi.fn(async () => ({ data: 'cached', fetchedAt: Date.now() }));
    let current!: ResourceSnapshot<string>;
    const capture = (snapshot: ResourceSnapshot<string>) => { current = snapshot; };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Consumer resourceKey={null} loader={loader} hydrate={hydrate} capture={capture} />); });
    renderers.push(renderer);
    const disabled = current;
    await act(async () => {
      invalidateResource('optional', 'user-a');
      await refreshVisiblePrivateResources();
      renderer.update(<Consumer resourceKey={null} loader={loader} hydrate={hydrate} capture={capture} />);
    });
    expect(current).toBe(disabled);
    expect(current).toMatchObject({ status: 'idle', loading: false, revalidating: false });
    expect(current.data).toBeUndefined();
    expect(resourceViewState(current)).not.toBe('ready');
    expect(loader).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    await act(async () => { renderer.update(<Consumer resourceKey="optional" loader={loader} hydrate={hydrate} capture={capture} />); });
    expect(current.data).toBe('cached');
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(loader).not.toHaveBeenCalled();
  });

  it('hides an in-flight result immediately on disable and reuses its cache on re-enable', async () => {
    const request = deferred<string>();
    const loader = vi.fn(() => request.promise);
    let current!: ResourceSnapshot<string>;
    const capture = (snapshot: ResourceSnapshot<string>) => { current = snapshot; };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Consumer resourceKey="in-flight" loader={loader} capture={capture} />); });
    renderers.push(renderer);
    expect(current.loading).toBe(true);
    await act(async () => { renderer.update(<Consumer resourceKey={null} loader={loader} capture={capture} />); });
    await act(async () => { request.resolve('completed'); });
    expect(current.data).toBeUndefined();
    expect(current.status).toBe('idle');
    await act(async () => {
      invalidateResource('in-flight', 'user-a', { revalidate: false });
      await refreshVisiblePrivateResources();
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.update(<Consumer resourceKey="in-flight" loader={loader} capture={capture} />); });
    expect(current.data).toBe('completed');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite or unsubscribe an enabled shared consumer', async () => {
    const enabledLoader = vi.fn(async () => 'enabled');
    const disabledLoader = vi.fn(async () => 'disabled');
    let first!: ResourceSnapshot<string>;
    let second!: ResourceSnapshot<string>;
    const captureFirst = (snapshot: ResourceSnapshot<string>) => { first = snapshot; };
    const captureSecond = (snapshot: ResourceSnapshot<string>) => { second = snapshot; };
    const view = (enabled: boolean) => <><Consumer resourceKey="shared" loader={enabledLoader} capture={captureFirst} /><Consumer resourceKey={enabled ? 'shared' : null} loader={disabledLoader} capture={captureSecond} /></>;
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(view(false)); });
    renderers.push(renderer);
    expect(first.data).toBe('enabled');
    expect(second.data).toBeUndefined();
    expect(disabledLoader).not.toHaveBeenCalled();
    await act(async () => { renderer.update(view(true)); });
    expect(second.data).toBe(first.data);
    await act(async () => { renderer.update(view(false)); });
    await act(async () => { invalidateResource('shared', 'user-a'); });
    expect(enabledLoader).toHaveBeenCalledTimes(2);
    expect(disabledLoader).not.toHaveBeenCalled();
    expect(second.data).toBeUndefined();
  });

  it('does not start a loader after disabled hydration misses, but recovers on re-enable', async () => {
    const hydration = deferred<{ data: string } | undefined>();
    const hydrate = vi.fn(() => hydration.promise);
    const loader = vi.fn(async () => 'server');
    let current!: ResourceSnapshot<string>;
    const capture = (snapshot: ResourceSnapshot<string>) => { current = snapshot; };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Consumer resourceKey="hydration-miss" loader={loader} hydrate={hydrate} capture={capture} />); });
    renderers.push(renderer);
    await act(async () => { renderer.update(<Consumer resourceKey={null} loader={loader} hydrate={hydrate} capture={capture} />); });
    await act(async () => { hydration.resolve(undefined); await refreshVisiblePrivateResources(); });
    expect(loader).not.toHaveBeenCalled();
    expect(current.data).toBeUndefined();
    await act(async () => { renderer.update(<Consumer resourceKey="hydration-miss" loader={loader} hydrate={hydrate} capture={capture} />); });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(current.data).toBe('server');
  });

  it('keeps late hydration out of the current key and fences a disabled request on account change', async () => {
    const hydration = deferred<{ data: string } | undefined>();
    const request = deferred<string>();
    const loader = vi.fn(() => request.promise);
    let current!: ResourceSnapshot<string>;
    const capture = (snapshot: ResourceSnapshot<string>) => { current = snapshot; };
    seedResource('next', 'user-a', 'next cached');
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Consumer resourceKey="hydrating" loader={loader} hydrate={() => hydration.promise} capture={capture} />); });
    renderers.push(renderer);
    await act(async () => { renderer.update(<Consumer resourceKey="next" loader={loader} capture={capture} />); hydration.resolve({ data: 'old cached' }); });
    expect(current.data).toBe('next cached');
    expect(loader).not.toHaveBeenCalled();
    await act(async () => { renderer.update(<Consumer resourceKey="account-request" loader={loader} capture={capture} />); });
    await act(async () => { renderer.update(<Consumer resourceKey={null} loader={loader} capture={capture} />); setResourceIdentity('user-b'); request.resolve('private old result'); });
    expect(current.data).toBeUndefined();
    expect(getResourceSnapshot('account-request', 'user-a').data).toBeUndefined();
  });
});
