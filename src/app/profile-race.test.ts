import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'user-a', 'X-BillSplit-Clerk-User-Id': 'clerk-a' } });

describe('profile update orchestration', () => {
  afterEach(async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('bill-split-local');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });

  it('does not let an older rename completion overwrite a newer cross-tab profile', async () => {
    const values = new Map<string, string>();
    class FakeChannel {
      static instances: FakeChannel[] = [];
      listener?: (event: MessageEvent) => void;
      constructor() { FakeChannel.instances.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listener = listener; }
      postMessage() { /* Sender delivery is excluded by owner. */ }
      emit(data: unknown) { this.listener?.({ data } as MessageEvent); }
    }
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    vi.stubGlobal('document', { visibilityState: 'visible', cookie: '', addEventListener: vi.fn() });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('BroadcastChannel', FakeChannel);

    let resolveRename!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request), 'https://billsplit.test');
      if (url.pathname === '/api/me' && init?.method === 'PUT') return new Promise<Response>((resolve) => { resolveRename = resolve; });
      return json({ id: 'user-a', email: 'a@example.com', personId: 'person-a', name: 'Before', profileRevision: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
    }));

    const api = await import('./api');
    const resourceCache = await import('./resource-cache');
    const session = await import('./session');
    await api.initializeAuthLifecycle({ clerkUserId: 'clerk-a' });

    const realProfileChanged = resourceCache.invalidateForMutation.profileChanged;
    let firstProfileChange = true;
    let releaseProfileChange!: () => void;
    const profileChangePaused = new Promise<void>((resolve) => { releaseProfileChange = resolve; });
    vi.spyOn(resourceCache.invalidateForMutation, 'profileChanged').mockImplementation(async (...args: Parameters<typeof realProfileChanged>) => {
      if (!firstProfileChange) return realProfileChanged(...args);
      firstProfileChange = false;
      const pending = realProfileChanged(...args);
      await profileChangePaused;
      return pending;
    });

    const rename = api.updateDisplayName('Older rename');
    await vi.waitFor(() => expect(resolveRename).toBeTypeOf('function'));
    resolveRename(json({ user: { id: 'user-a', email: 'a@example.com', personId: 'person-a', name: 'Older rename', profileRevision: 2, updatedAt: '2026-01-02T00:00:00.000Z' } }));
    await vi.waitFor(() => expect(firstProfileChange).toBe(false));

    FakeChannel.instances[0].emit({ type: 'profile-changed', userId: 'user-a', personId: 'person-a', name: 'Newer profile', profileRevision: 3, updatedAt: '2026-01-03T00:00:00.000Z', generation: session.captureSessionGeneration(), nonce: 'newer-profile', owner: 'other-tab' });
    releaseProfileChange();
    await expect(rename).resolves.toEqual({ user: { id: 'user-a', email: 'a@example.com', personId: 'person-a', name: 'Newer profile', profileRevision: 3, updatedAt: '2026-01-03T00:00:00.000Z' }, superseded: true });

    expect(resourceCache.getResourceSnapshot('identity').data).toMatchObject({ id: 'user-a', name: 'Newer profile', profileRevision: 3 });
  });

  it('seeds trusted settings identity metadata and rejects a delayed older cross-tab profile', async () => {
    const values = new Map<string, string>();
    class FakeChannel {
      static instances: FakeChannel[] = [];
      listener?: (event: MessageEvent) => void;
      constructor() { FakeChannel.instances.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listener = listener; }
      postMessage() { /* Sender delivery is excluded by owner. */ }
      emit(data: unknown) { this.listener?.({ data } as MessageEvent); }
    }
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    vi.stubGlobal('document', { visibilityState: 'visible', cookie: '', addEventListener: vi.fn() });
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    vi.stubGlobal('fetch', vi.fn());

    const api = await import('./api');
    const idb = await import('./idb');
    const resourceCache = await import('./resource-cache');
    const session = await import('./session');
    await idb.saveOfflineTrust({ userId: 'settings-user', email: 'settings@example.com', personId: 'settings-person', name: 'Trusted name', profileRevision: 8, updatedAt: '2026-01-08T00:00:00.000Z', clerkUserId: 'clerk-settings', verifiedAt: new Date().toISOString() });

    await expect(api.initializeAuthLifecycle({ clerkUserId: 'clerk-settings', route: { pathname: '/settings' } })).resolves.toMatchObject({ status: 'trusted-offline' });
    expect(resourceCache.getResourceSnapshot('identity').data).toMatchObject({ id: 'settings-user', name: 'Trusted name', profileRevision: 8, updatedAt: '2026-01-08T00:00:00.000Z' });

    FakeChannel.instances[0].emit({ type: 'profile-changed', userId: 'settings-user', personId: 'settings-person', name: 'Older name', profileRevision: 7, updatedAt: '2026-01-07T00:00:00.000Z', generation: session.captureSessionGeneration(), nonce: 'delayed-older-profile', owner: 'other-tab' });
    expect(api.getVerifiedUserId()).toBe('settings-user');
    expect(resourceCache.getResourceSnapshot('identity').data).toMatchObject({ id: 'settings-user', name: 'Trusted name', profileRevision: 8, updatedAt: '2026-01-08T00:00:00.000Z' });
  });

  it('does not seed stale trusted settings identity when coordination already has a newer revision', async () => {
    const values = new Map<string, string>();
    class FakeChannel {
      static instances: FakeChannel[] = [];
      listener?: (event: MessageEvent) => void;
      constructor() { FakeChannel.instances.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listener = listener; }
      postMessage() { /* Sender delivery is excluded by owner. */ }
      emit(data: unknown) { this.listener?.({ data } as MessageEvent); }
    }
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    vi.stubGlobal('document', { visibilityState: 'visible', cookie: '', addEventListener: vi.fn() });
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    vi.stubGlobal('fetch', vi.fn());

    const api = await import('./api');
    const idb = await import('./idb');
    const resourceCache = await import('./resource-cache');
    const session = await import('./session');
    await idb.saveOfflineTrust({ userId: 'settings-user', email: 'settings@example.com', personId: 'settings-person', name: 'Stale trusted name', profileRevision: 8, updatedAt: '2026-01-08T00:00:00.000Z', clerkUserId: 'clerk-settings', verifiedAt: new Date().toISOString() });
    const generation = session.captureSessionGeneration();
    expect(session.recordProfileRevision('settings-user', generation, 9)).toBe(true);

    await api.initializeAuthLifecycle({ clerkUserId: 'clerk-settings', route: { pathname: '/settings' } });

    expect(api.getVerifiedUserId()).toBeUndefined();
    expect(resourceCache.getResourceSnapshot('identity').data).toBeUndefined();
  });
});
