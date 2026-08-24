import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const markerKey = 'billsplit-pending-account-deletion';
const marker = (clerkUserId = 'clerk-original') => JSON.stringify({ version: 1, phase: 'server-pending', clerkUserId });
const storageFor = (values: Map<string, string>, setItem: (key: string, value: string) => void = (key, value) => { values.set(key, value); }) => ({
  getItem: (key: string) => values.get(key) || null,
  setItem,
  removeItem: (key: string) => values.delete(key),
});
const freshApi = async () => {
  vi.resetModules();
  return import('./api');
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fresh-process account deletion recovery', () => {
  it('keeps an uncommitted server-pending retry before provider cleanup', async () => {
    const storage = new Map([[markerKey, marker()]]);
    const first = await freshApi();
    vi.stubGlobal('localStorage', storageFor(storage));
    const firstFetch = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => { throw new TypeError('network unavailable'); });
    vi.stubGlobal('fetch', firstFetch);
    const providerDelete = vi.fn(async () => undefined);
    await expect(first.completePendingAccountDeletion({ id: 'clerk-original', delete: providerDelete }, vi.fn(async () => undefined), { clearLocal: vi.fn(async () => undefined) })).rejects.toThrow('Connection issue');
    expect(firstFetch).toHaveBeenCalledOnce();
    expect(new Headers(firstFetch.mock.calls[0]?.[1]?.headers).get('X-BillSplit-Expected-Clerk-User-Id')).toBe('clerk-original');
    expect(new Headers(firstFetch.mock.calls[0]?.[1]?.headers).get('X-BillSplit-Expected-User-Id')).toBeNull();
    expect(providerDelete).not.toHaveBeenCalled();
    expect(storage.get(markerKey)).toBe(marker());

    const second = await freshApi();
    vi.stubGlobal('localStorage', storageFor(storage));
    const secondFetch = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', secondFetch);
    await expect(second.completePendingAccountDeletion({ id: 'clerk-original', delete: providerDelete }, vi.fn(async () => undefined), { clearLocal: vi.fn(async () => undefined) })).resolves.toEqual({ clerkStatus: 'deleted' });
    expect(secondFetch).toHaveBeenCalledOnce();
    expect(new Headers(secondFetch.mock.calls[0]?.[1]?.headers).get('X-BillSplit-Expected-Clerk-User-Id')).toBe('clerk-original');
    expect(new Headers(secondFetch.mock.calls[0]?.[1]?.headers).get('X-BillSplit-Expected-User-Id')).toBeNull();
    expect(providerDelete).toHaveBeenCalledOnce();
  });

  it('retries a tombstoned account after the response was lost before phase persistence', async () => {
    const storage = new Map([[markerKey, marker()]]);
    const first = await freshApi();
    vi.stubGlobal('localStorage', storageFor(storage, (key, value) => {
      if (key === markerKey) throw new Error('crash after server commit');
      storage.set(key, value);
    }));
    const firstFetch = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', firstFetch);
    await expect(first.completePendingAccountDeletion({ id: 'clerk-original', delete: vi.fn() }, vi.fn(async () => undefined), { clearLocal: vi.fn(async () => undefined) })).rejects.toThrow('crash after server commit');
    expect(firstFetch).toHaveBeenCalledOnce();
    expect(storage.get(markerKey)).toBe(marker());

    const second = await freshApi();
    vi.stubGlobal('localStorage', storageFor(storage));
    const secondFetch = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', secondFetch);
    await expect(second.completePendingAccountDeletion({ id: 'clerk-original', delete: vi.fn(async () => undefined) }, vi.fn(async () => undefined), { clearLocal: vi.fn(async () => undefined) })).resolves.toEqual({ clerkStatus: 'deleted' });
    expect(secondFetch).toHaveBeenCalledOnce();
  });

  it('does not use the recovery exemption for a different Clerk identity', async () => {
    const storage = new Map([[markerKey, marker()]]);
    const api = await freshApi();
    vi.stubGlobal('localStorage', storageFor(storage));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(api.completePendingAccountDeletion({ id: 'clerk-other', delete: vi.fn() }, vi.fn(async () => undefined), { clearLocal: vi.fn(async () => undefined) })).rejects.toThrow('provider identity changed');
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.get(markerKey)).toBe(marker());
  });

  it('does not create a marker merely to qualify for the recovery exemption', async () => {
    const storage = new Map<string, string>();
    const api = await freshApi();
    vi.stubGlobal('localStorage', storageFor(storage));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(api.deleteAccount('clerk-original', { recovery: true })).rejects.toThrow('valid pending marker');
    expect(fetch).not.toHaveBeenCalled();
    expect(storage).toHaveLength(0);
  });
});
