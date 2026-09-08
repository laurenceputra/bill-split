import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-BillSplit-User-Id': 'user-a', 'X-BillSplit-Clerk-User-Id': 'clerk-a' } });

describe('profile update orchestration', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
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
});
