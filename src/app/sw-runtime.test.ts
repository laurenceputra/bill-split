import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Node types are not shipped to the browser build.
import { readFileSync } from 'node:fs';
// @ts-expect-error Node types are not shipped to the browser build.
import vm from 'node:vm';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')
  .replace("'__BILLSPLIT_CACHE_VERSION__'", "'test-cache'")
  .replaceAll('__BILLSPLIT_SHELL_ASSETS__', "['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-16.png', '/icons/icon-32.png', '/icons/logo-400.png', '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png', '/assets/app-123.js']");

function workerHarness(cacheMatch: (request: Request | string) => Promise<Response | undefined>, networkFetch: (request?: Request) => Promise<Response> = async () => { throw new Error('unexpected network request'); }, cachePut = () => new Promise<void>(() => undefined)) {
  const handlers = new Map<string, (event: any) => void>();
  const waitUntilPromises: Promise<unknown>[] = [];
  const cache = { match: cacheMatch, put: cachePut, keys: async () => [], delete: async () => true };
  const caches = { match: cacheMatch, open: async () => cache, keys: async () => [], delete: async () => true };
  const windows: Array<{ url: string; focus: () => Promise<void>; navigate: (path: string) => Promise<void>; postMessage: () => void }> = [];
  const self = { location: { origin: 'https://split.test' }, registration: {}, addEventListener: (type: string, listener: (event: any) => void) => handlers.set(type, listener), skipWaiting: async () => undefined, clients: { claim: async () => undefined, matchAll: async () => windows, openWindow: async (path: string) => { windows.push({ url: `https://split.test${path}`, focus: async () => undefined, navigate: async () => undefined, postMessage: () => undefined }); } } };
  class WorkerRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === 'string' && input.startsWith('/') ? new URL(input, 'https://split.test').toString() : input, init); }
  }
  const context = { self, caches, fetch: networkFetch, Request: WorkerRequest, Response, URL, Promise, AbortController, Symbol, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  return { fetchHandler: handlers.get('fetch')!, installHandler: handlers.get('install')!, syncHandler: handlers.get('sync')!, messageHandler: handlers.get('message')!, waitUntilPromises, windows };
}

describe('service-worker runtime policy', () => {
  it('parses the unfinalized worker served by Vite development', () => {
    expect(() => new vm.Script(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'))).not.toThrow();
  });

  it('awaits exact navigation, root, then index cache lookups sequentially', async () => {
    const calls: string[] = [];
    const root = new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
    const harness = workerHarness(async (request) => {
      const path = typeof request === 'string' ? request : new URL(request.url).pathname;
      calls.push(path);
      return path === '/' ? root : undefined;
    });
    let responsePromise!: Promise<Response>;
    harness.fetchHandler({ request: { method: 'GET', mode: 'navigate', url: 'https://split.test/groups/g-1' }, respondWith: (response: Promise<Response>) => { responsePromise = response; }, waitUntil: () => undefined });
    await expect(responsePromise).resolves.toBe(root);
    expect(calls).toEqual(['/groups/g-1', '/']);
  });

  it('returns a network asset before a never-settling background cache write', async () => {
    const network = Object.defineProperties(new Response('app', { headers: { 'Content-Type': 'text/javascript' } }), { url: { value: 'https://split.test/assets/app-123.js' } });
    const harness = workerHarness(async () => undefined, async () => network);
    let responsePromise!: Promise<Response>;
    harness.fetchHandler({ request: new Request('https://split.test/assets/app-123.js'), respondWith: (response: Promise<Response>) => { responsePromise = response; }, waitUntil: (promise: Promise<unknown>) => harness.waitUntilPromises.push(promise) });
    await expect(Promise.race([responsePromise, new Promise((_, reject) => setTimeout(() => reject(new Error('response blocked')), 100))])).resolves.toBe(network);
    expect(harness.waitUntilPromises).toHaveLength(1);
  });

  it('does not intercept private or authentication paths', () => {
    const harness = workerHarness(async () => undefined);
    for (const path of ['/api', '/api/me', '/cdn-cgi', '/cdn-cgi/trace', '/sign-in', '/sign-in/callback', '/sign-up', '/sign-up/finish']) {
      let responded = false;
      harness.fetchHandler({ request: new Request(`https://split.test${path}`), respondWith: () => { responded = true; }, waitUntil: () => undefined });
      expect(responded, path).toBe(false);
    }
  });

  it('bounds sequential hanging navigation cache reads before using the network', async () => {
    vi.useFakeTimers();
    try {
      const network = Object.defineProperties(new Response('<html>network</html>', { headers: { 'Content-Type': 'text/html' } }), { url: { value: 'https://split.test/groups/g-1' } });
      const harness = workerHarness(() => new Promise<Response | undefined>(() => undefined), async () => network);
      let responsePromise!: Promise<Response>;
      harness.fetchHandler({ request: { method: 'GET', mode: 'navigate', url: 'https://split.test/groups/g-1' }, respondWith: (response: Promise<Response>) => { responsePromise = response; }, waitUntil: () => undefined });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(responsePromise).resolves.toBe(network);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a hanging install fetch without replacing the active worker and consumes a late rejection', async () => {
    vi.useFakeTimers();
    try {
      let rejectFetch!: (error: Error) => void;
      const harness = workerHarness(async () => undefined, async () => new Promise<Response>((_resolve, reject) => { rejectFetch = reject; }));
      let installPromise!: Promise<unknown>;
      harness.installHandler({ waitUntil: (promise: Promise<unknown>) => { installPromise = promise; } });
      const rejected = expect(installPromise).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      rejectFetch(new Error('late network failure'));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses Background Sync only as a foreground flush hint', async () => {
    const harness = workerHarness(async () => undefined);
    const postMessage = vi.fn();
    harness.windows.push({ url: 'https://split.test/', focus: async () => undefined, navigate: async () => undefined, postMessage });
    let syncPromise!: Promise<unknown>;
    harness.syncHandler({ tag: 'billsplit-expense-outbox', waitUntil: (promise: Promise<unknown>) => { syncPromise = promise; } });
    await syncPromise;
    expect(postMessage).toHaveBeenCalledWith({ type: 'BILLSPLIT_OUTBOX_SYNC_HINT' });
  });

});
