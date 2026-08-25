import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('persisted logout coordination', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('hydrates the logout barrier in a new tab before private work can start', async () => {
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.resetModules();
    const first = await import('./session');
    const listener = vi.fn();
    first.subscribeSessionState(listener);

    const generation = first.startSessionLogout(false);
    expect(first.getSessionLogoutInProgress()).toBe(true);
    expect(listener).toHaveBeenCalled();

    vi.resetModules();
    const second = await import('./session');
    expect(second.getSessionLogoutInProgress()).toBe(true);
    expect(second.captureSessionGeneration()).toBe(generation);

    expect(second.rollbackSessionLogout(generation, false)).toBe(false);
    expect(first.rollbackSessionLogout(generation, false)).toBe(true);
    expect(first.getSessionLogoutInProgress()).toBe(false);
    expect(second.getSessionLogoutInProgress()).toBe(false);
  });

  it('deduplicates the same coordination nonce delivered by BroadcastChannel and storage', async () => {
    const values = new Map<string, string>();
    const storageListeners: Array<(event: StorageEvent) => void> = [];
    class FakeChannel {
      static instances: FakeChannel[] = [];
      listener?: (event: MessageEvent) => void;
      constructor() { FakeChannel.instances.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listener = listener; }
      postMessage() { /* The sender's own owner is ignored. */ }
      emit(data: unknown) { this.listener?.({ data } as MessageEvent); }
    }
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    vi.stubGlobal('window', { addEventListener: (type: string, listener: (event: StorageEvent) => void) => { if (type === 'storage') storageListeners.push(listener); } });
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    vi.resetModules();
    const session = await import('./session');
    const listener = vi.fn();
    session.subscribeSessionCoordination(listener);
    const message = { type: 'cache-clear', generation: 0, nonce: 'same-nonce', owner: 'other-tab' };
    FakeChannel.instances[0].emit(message);
    storageListeners.forEach((notify) => notify({ key: 'billsplit-auth-coordination', newValue: JSON.stringify(message) } as StorageEvent));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps a local cleanup mask until the receiver finishes after logout-clear', async () => {
    const storageListeners: Array<(event: StorageEvent) => void> = [];
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('window', { addEventListener: (type: string, listener: (event: StorageEvent) => void) => { if (type === 'storage') storageListeners.push(listener); } });
    vi.resetModules();
    const session = await import('./session');
    const generation = session.startSessionLogout(false);
    expect(session.beginLocalLogoutCleanup(generation)).toBe(true);

    storageListeners.forEach((notify) => notify({ key: session.SESSION_LOGOUT_KEY, newValue: null } as StorageEvent));
    expect(session.getSessionLogoutInProgress()).toBe(true);

    expect(session.completeLocalLogoutCleanup(generation)).toBe(true);
    expect(session.getSessionLogoutInProgress()).toBe(false);
  });

  it('keeps a complete target-user verification alive across a simultaneous account-switch message', async () => {
    const values = new Map<string, string>();
    const channels: Array<{ listener?: (event: MessageEvent) => void; emit: (data: unknown) => void }> = [];
    class FakeChannel {
      listener?: (event: MessageEvent) => void;
      constructor() { channels.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listener = listener; }
      postMessage() { /* Sender delivery is excluded by owner. */ }
      emit(data: unknown) { this.listener?.({ data } as MessageEvent); }
    }
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: () => true });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn() });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public detail?: unknown) {} });
    vi.resetModules();
    const api = await import('./api');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'user-a', email: 'a@example.com', personId: 'person-a' }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'user-a', 'X-BillSplit-Clerk-User-Id': 'clerk-a' } })));
    await api.coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-a', sessionId: 'session-a' });

    let resolveB!: (response: Response) => void;
    let bAborted = false;
    let bSettled = false;
    vi.stubGlobal('fetch', vi.fn((_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      resolveB = resolve;
      init?.signal?.addEventListener('abort', () => { if (!bSettled) bAborted = true; });
    })));
    const bProbe = api.coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-b', sessionId: 'session-b' });
    await vi.waitFor(() => expect(resolveB).toBeTypeOf('function'));
    channels[0].emit({ type: 'auth-invalidation', reason: 'account-switch', previousClerkUserId: 'clerk-a', clerkUserId: 'clerk-b', generation: 0, nonce: 'a-to-b', owner: 'other-tab' });
    bSettled = true;
    resolveB(new Response(JSON.stringify({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'user-b', 'X-BillSplit-Clerk-User-Id': 'clerk-b' } }));
    await expect(bProbe).resolves.toMatchObject({ status: 'authenticated' });
    expect(bAborted).toBe(false);
    expect(api.getVerifiedClerkUserId()).toBe('clerk-b');

    api.revokeForClerkSessionChange(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'user-b', 'X-BillSplit-Clerk-User-Id': 'clerk-b' } })));
    channels[0].emit({ type: 'auth-invalidation', reason: 'account-switch', previousClerkUserId: 'clerk-a', clerkUserId: 'clerk-b', generation: 0, nonce: 'a-to-b-recovery', owner: 'other-tab' });
    await vi.waitFor(() => expect(api.getAuthLifecycle().status).toBe('authenticated'));
    expect(api.getVerifiedClerkUserId()).toBe('clerk-b');
  });

  it('replays a cold account-switch marker for the matching target and consumes it after /me', async () => {
    const values = new Map<string, string>();
    const marker = { type: 'auth-invalidation', reason: 'account-switch', generation: 0, previousClerkUserId: 'clerk-a', clerkUserId: 'clerk-b', nonce: 'cold-target', owner: 'other-tab' };
    values.set('billsplit-auth-coordination', JSON.stringify(marker));
    values.set('billsplit-auth-invalidation', JSON.stringify(marker));
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: () => true });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn() });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public detail?: unknown) {} });
    vi.resetModules();
    const idb = await import('./idb');
    await idb.saveOfflineTrust({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', clerkUserId: 'clerk-a', verifiedAt: new Date().toISOString() });
    const api = await import('./api');
    expect(api.getAuthLifecycle().status).toBe('checking');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'user-b', 'X-BillSplit-Clerk-User-Id': 'clerk-b' } })));

    await expect(api.coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-b', sessionId: 'session-b' })).resolves.toMatchObject({ status: 'authenticated' });
    expect(await idb.readOfflineTrust()).toMatchObject({ userId: 'user-b', clerkUserId: 'clerk-b' });
    expect(values.has('billsplit-auth-invalidation')).toBe(false);
    expect(values.has('billsplit-auth-coordination')).toBe(false);
  });

  it('keeps a cold marker masked on the old account, then recovers automatically for its target', async () => {
    const values = new Map<string, string>();
    const marker = { type: 'auth-invalidation', reason: 'account-switch', generation: 0, previousClerkUserId: 'clerk-a', clerkUserId: 'clerk-b', nonce: 'cold-old', owner: 'other-tab' };
    values.set('billsplit-auth-coordination', JSON.stringify(marker));
    values.set('billsplit-auth-invalidation', JSON.stringify(marker));
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: () => true });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn() });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public detail?: unknown) {} });
    vi.resetModules();
    const idb = await import('./idb');
    await idb.saveOfflineTrust({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', clerkUserId: 'clerk-a', verifiedAt: new Date().toISOString() });
    const api = await import('./api');
    let oldCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { oldCalls += 1; return new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } }); }));
    await expect(api.coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-a', sessionId: 'session-a' })).resolves.toMatchObject({ status: 'verification-unavailable' });
    expect(oldCalls).toBe(0);
    expect(api.getVerifiedUserId()).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'user-b', 'X-BillSplit-Clerk-User-Id': 'clerk-b' } })));
    await expect(api.coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-b', sessionId: 'session-b' })).resolves.toMatchObject({ status: 'authenticated' });
    expect(values.has('billsplit-auth-invalidation')).toBe(false);
  });

  it('keeps incomplete cold Clerk evidence retryable while the shared target marker is pending', async () => {
    const values = new Map<string, string>();
    const marker = { type: 'auth-invalidation', reason: 'account-switch', generation: 0, previousClerkUserId: 'clerk-a', clerkUserId: 'clerk-b', nonce: 'cold-incomplete', owner: 'other-tab' };
    values.set('billsplit-auth-coordination', JSON.stringify(marker));
    values.set('billsplit-auth-invalidation', JSON.stringify(marker));
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: () => true });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn() });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public detail?: unknown) {} });
    vi.resetModules();
    const idb = await import('./idb');
    await idb.saveOfflineTrust({ userId: 'user-a', email: 'a@example.com', personId: 'person-a', clerkUserId: 'clerk-a', verifiedAt: new Date().toISOString() });
    const api = await import('./api');
    const fetch = vi.fn(async () => new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);

    await expect(api.coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-b' }, { startupFallbackMs: 10, force: true })).resolves.toMatchObject({ status: 'checking' });
    expect(fetch).not.toHaveBeenCalled();
    expect(api.getAuthLifecycle().status).toBe('checking');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'user-b', email: 'b@example.com', personId: 'person-b' }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'user-b', 'X-BillSplit-Clerk-User-Id': 'clerk-b' } })));
    await expect(api.coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-b', sessionId: 'session-b' }, { force: true })).resolves.toMatchObject({ status: 'authenticated' });
  });

  it('masks a receiver with a higher local auth epoch for an unseen account invalidation', async () => {
    const values = new Map<string, string>();
    const listeners = new Map<string, Array<(event: Event) => void>>();
    class FakeChannel {
      static instances: FakeChannel[] = [];
      listener?: (event: MessageEvent) => void;
      constructor() { FakeChannel.instances.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listener = listener; }
      postMessage() { /* Sender delivery is excluded by owner. */ }
      emit(data: unknown) { this.listener?.({ data } as MessageEvent); }
    }
    const fakeWindow = {
      addEventListener: (type: string, listener: (event: Event) => void) => { listeners.set(type, [...(listeners.get(type) || []), listener]); },
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: fakeWindow.addEventListener });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public detail?: unknown) {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'receiver-user', email: 'receiver@example.com', personId: 'receiver-person' }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'receiver-user', 'X-BillSplit-Clerk-User-Id': 'clerk-receiver' } })));
    vi.resetModules();
    const api = await import('./api');
    await api.coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-receiver', sessionId: 'session-initial' });
    api.resetForClerkSessionChange(false);
    await api.coordinateAuthBootstrap({ isLoaded: true, isSignedIn: true, userId: 'clerk-receiver', sessionId: 'session-new' });
    expect(api.getVerifiedUserId()).toBe('receiver-user');
    // No sender-local auth epoch is consulted; only shared nonce delivery
    // semantics decide whether this unseen transition is actionable.
    FakeChannel.instances[0].emit({ type: 'auth-invalidation', reason: 'account-switch', generation: 0, clerkUserId: 'clerk-other', nonce: 'unseen-account-switch', owner: 'other-tab' });
    expect(api.getVerifiedUserId()).toBeUndefined();
    expect(api.getAuthLifecycle().status).toBe('verification-unavailable');
  });
});
