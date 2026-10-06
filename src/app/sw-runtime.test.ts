import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Node types are not shipped to the browser build.
import { readFileSync } from 'node:fs';
// @ts-expect-error Node types are not shipped to the browser build.
import vm from 'node:vm';
// @ts-expect-error Node types are not shipped to the browser build.
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')
  .replace("'__BILLSPLIT_CACHE_VERSION__'", "'bill-split-shell-test'")
  .replaceAll('__BILLSPLIT_ENTRY_ASSETS__', "['/assets/app-123.js']")
  .replaceAll('__BILLSPLIT_SHELL_ASSETS__', "['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-16.png', '/icons/icon-32.png', '/icons/logo-400.png', '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png', '/assets/app-123.js']");

function workerHarness(cacheMatch: (request: Request | string) => Promise<Response | undefined>, networkFetch: (request?: Request) => Promise<Response> = async () => { throw new Error('unexpected network request'); }, cachePut = () => new Promise<void>(() => undefined), cacheOverrides = {}, workerSource = source) {
  const handlers = new Map<string, (event: any) => void>();
  const waitUntilPromises: Promise<unknown>[] = [];
  const cache = { match: cacheMatch, put: cachePut, keys: async () => [], delete: async () => true };
  const caches = { match: cacheMatch, open: async () => cache, keys: async () => [], delete: async () => true, ...cacheOverrides };
  const windows: Array<{ id?: string; type?: string; url: string; focus: () => Promise<void>; navigate: (path: string) => Promise<void>; postMessage: (data?: any) => void }> = [];
  const self = { crypto: webcrypto, location: { origin: 'https://split.test' }, registration: { scope: 'https://split.test/' }, addEventListener: (type: string, listener: (event: any) => void) => handlers.set(type, listener), skipWaiting: vi.fn(async () => undefined), clients: { claim: async () => undefined, get: async (id: string) => windows.find((client) => client.id === id), matchAll: async () => [...windows], openWindow: async (path: string) => { windows.push({ url: `https://split.test${path}`, focus: async () => undefined, navigate: async () => undefined, postMessage: () => undefined }); } } };
  class WorkerRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === 'string' && input.startsWith('/') ? new URL(input, 'https://split.test').toString() : input, init); }
  }
  const context = { self, caches, fetch: networkFetch, Request: WorkerRequest, Response, URL, Promise, AbortController, Symbol, Uint8Array, Date, setTimeout, clearTimeout };
  vm.runInNewContext(workerSource, context);
  return { fetchHandler: handlers.get('fetch')!, installHandler: handlers.get('install')!, activateHandler: handlers.get('activate')!, syncHandler: handlers.get('sync')!, messageHandler: handlers.get('message')!, waitUntilPromises, windows, self };
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

  it('never uses global cache lookup for navigations and selects only the current shell', async () => {
    const current = new Response('current shell');
    const old = new Response('old shell');
    const globalMatch = vi.fn(async () => old);
    const open = vi.fn(async (name: string) => ({ match: async () => name === 'bill-split-shell-test' ? current : old }));
    const harness = workerHarness(async () => undefined, undefined, undefined, { match: globalMatch, open });
    let response!: Promise<Response>;
    harness.fetchHandler({ request: { method: 'GET', mode: 'navigate', url: 'https://split.test/groups/g-1' }, respondWith: (promise: Promise<Response>) => { response = promise; } });
    await expect(response).resolves.toBe(current);
    expect(globalMatch).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('bill-split-shell-test');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('serves old hashed assets only from retained app caches, current first', async () => {
    const old = new Response('old lazy chunk');
    const calls: string[] = [];
    const open = async (name: string) => {
      calls.push(name);
      return { match: async () => name === 'bill-split-shell-old' ? old : undefined };
    };
    const match = async (_request: Request | string, options: { cacheName: string }) => { calls.push(options.cacheName); return options.cacheName === 'bill-split-shell-old' ? old : undefined; };
    const harness = workerHarness(async () => undefined, undefined, undefined, { open, match, keys: async () => ['unrelated-cache', 'bill-split-shell-old', 'bill-split-shell-test'] });
    let response!: Promise<Response>;
    harness.fetchHandler({ request: new Request('https://split.test/assets/lazy-old.js'), respondWith: (promise: Promise<Response>) => { response = promise; } });
    await expect(response).resolves.toBe(old);
    expect(calls).toEqual(['bill-split-shell-test', 'bill-split-shell-old']);
  });

  it('does not scan retained caches when the current build contains the asset', async () => {
    const current = new Response('current asset');
    const keys = vi.fn(async () => ['bill-split-shell-old']);
    const harness = workerHarness(async () => current, undefined, undefined, { keys });
    let response!: Promise<Response>;
    harness.fetchHandler({ request: new Request('https://split.test/assets/app-123.js'), respondWith: (promise: Promise<Response>) => { response = promise; } });
    await expect(response).resolves.toBe(current);
    expect(keys).not.toHaveBeenCalled();
  });

  it('bounds a hanging retained-cache scan before returning a network asset', async () => {
    vi.useFakeTimers();
    try {
      const network = Object.defineProperty(new Response('asset', { headers: { 'Content-Type': 'text/javascript' } }), 'url', { value: 'https://split.test/assets/app-123.js' });
      const harness = workerHarness(async () => undefined, async () => network, undefined, { keys: () => new Promise(() => undefined) });
      let response!: Promise<Response>;
      harness.fetchHandler({ request: new Request('https://split.test/assets/app-123.js'), respondWith: (promise: Promise<Response>) => { response = promise; }, waitUntil: () => undefined });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(response).resolves.toBe(network);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves previous builds and unrelated caches on activation', async () => {
    const deleteCache = vi.fn();
    const harness = workerHarness(async () => undefined, undefined, undefined, { keys: async () => ['unrelated-cache', 'bill-split-shell-old', 'bill-split-shell-test'], delete: deleteCache });
    let activation!: Promise<unknown>;
    harness.activateHandler({ waitUntil: (promise: Promise<unknown>) => { activation = promise; } });
    await activation;
    expect(deleteCache).not.toHaveBeenCalled();
  });

  it('rejects a deployment with a different entry manifest before writing any shell', async () => {
    const put = vi.fn(async () => undefined);
    const shell = Object.defineProperty(new Response('<div id="root"></div><script src="/assets/other-456.js"></script>', { headers: { 'Content-Type': 'text/html' } }), 'url', { value: 'https://split.test/' });
    const harness = workerHarness(async () => undefined, async () => shell, put);
    let installation!: Promise<unknown>;
    harness.installHandler({ waitUntil: (promise: Promise<unknown>) => { installation = promise; } });
    await expect(installation).rejects.toThrow('does not match this worker build');
    expect(put).not.toHaveBeenCalled();
  });

  it('fails an incomplete dependency install without writing the navigation shell', async () => {
    const writes: string[] = [];
    const shell = '<div id="root"></div><script src="/assets/app-123.js"></script>';
    const fetchResponse = async (request?: Request) => {
      const path = new URL(request!.url).pathname;
      const type = path === '/' ? 'text/html' : path.endsWith('.webmanifest') ? 'application/json' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : 'text/javascript';
      return Object.defineProperty(new Response(path === '/' ? shell : 'asset', { status: path.endsWith('.js') ? 404 : 200, headers: { 'Content-Type': type } }), 'url', { value: `https://split.test${path}` });
    };
    const harness = workerHarness(async () => undefined, fetchResponse, async (path?: any) => { writes.push(path); });
    let installation!: Promise<unknown>;
    harness.installHandler({ waitUntil: (promise: Promise<unknown>) => { installation = promise; } });
    await expect(installation).rejects.toThrow('Unsafe app asset');
    expect(writes).toEqual([]);
  });

});

describe('waiting-worker update authority', () => {
  const protocol = 'BILLSPLIT_UPDATE_V1';
  const target = 'bill-split-shell-test';
  const attempt = 'update-attempt-123';
  const addClient = (harness: ReturnType<typeof workerHarness>, id: string, respond: (data: any, client: any) => void = () => undefined) => {
    const client = { id, type: 'window', url: 'https://split.test/groups/g-1', focus: async () => undefined, navigate: async () => undefined, postMessage: vi.fn((data: any) => respond(data, client)) };
    harness.windows.push(client);
    return client;
  };
  const ack = (harness: ReturnType<typeof workerHarness>, client: any, data: any, ready = true) => harness.messageHandler({ source: client, data: { protocol, target, attempt: data.attempt, type: 'ACK', round: data.round, ready } });
  const request = (harness: ReturnType<typeof workerHarness>, client: any) => {
    let promise!: Promise<unknown>;
    const waitUntil = vi.fn((work: Promise<unknown>) => { promise = work; });
    harness.messageHandler({ source: client, data: { protocol, target, attempt, type: 'REQUEST' }, waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1); // Must attach synchronously.
    return promise;
  };

  it('ignores legacy SKIP_WAITING and wrong-target requests', async () => {
    const harness = workerHarness(async () => undefined);
    const client = addClient(harness, 'one');
    harness.messageHandler({ source: client, data: { type: 'SKIP_WAITING' }, waitUntil: vi.fn() });
    let work!: Promise<unknown>;
    harness.messageHandler({ source: client, data: { protocol, target: 'bill-split-shell-other', attempt, type: 'REQUEST' }, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
    await work;
    expect(harness.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('requires prepare and final ACKs from every scope window before activating', async () => {
    const harness = workerHarness(async () => undefined);
    const respond = (data: any, client: any) => { if (data.type === 'PREPARE' || data.type === 'VALIDATE') ack(harness, client, data); };
    const one = addClient(harness, 'one', respond);
    const two = addClient(harness, 'two', respond);
    const outside = addClient(harness, 'outside'); outside.url = 'https://other.test/';
    const matchAll = vi.spyOn(harness.self.clients, 'matchAll');
    await request(harness, one);
    expect(harness.self.skipWaiting).toHaveBeenCalledTimes(1);
    expect(matchAll).toHaveBeenCalledTimes(3);
    expect(matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    for (const client of [one, two]) {
      expect(client.postMessage.mock.calls.map(([data]) => data.type)).toEqual(['PREPARE', 'VALIDATE', 'ACTIVATING']);
    }
    expect(outside.postMessage).not.toHaveBeenCalled();
  });

  it('releases uncommitted activation intent when skipWaiting fails', async () => {
    const harness = workerHarness(async () => undefined);
    const one = addClient(harness, 'one', (data, client) => { if (data.type === 'PREPARE' || data.type === 'VALIDATE') ack(harness, client, data); });
    harness.self.skipWaiting.mockRejectedValue(new Error('activation failed'));
    await request(harness, one);
    expect(one.postMessage.mock.calls.map(([data]) => data.type)).toEqual(['PREPARE', 'VALIDATE', 'ACTIVATING', 'RELEASE']);
  });

  it('dirty ACK cancels preparation and releases all held gates', async () => {
    const harness = workerHarness(async () => undefined);
    const one = addClient(harness, 'one', (data, client) => { if (data.type === 'PREPARE') ack(harness, client, data); });
    const two = addClient(harness, 'two', (data, client) => { if (data.type === 'PREPARE') ack(harness, client, data, false); });
    await request(harness, one);
    expect(harness.self.skipWaiting).not.toHaveBeenCalled();
    expect(one.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'RELEASE', attempt, target }));
    expect(two.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'RELEASE' }));
  });

  it('does not send prepare after cancellation or restart a retired attempt', async () => {
    const harness = workerHarness(async () => undefined);
    const one = addClient(harness, 'one', (data, client) => { if (data.type === 'PREPARE') ack(harness, client, data, false); });
    const two = addClient(harness, 'two');
    await request(harness, one);
    expect(two.postMessage.mock.calls.map(([data]) => data.type)).toEqual(['RELEASE']);
    await request(harness, one);
    expect(one.postMessage.mock.calls.filter(([data]) => data.type === 'PREPARE')).toHaveLength(1);
    expect(harness.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('honors cancellation that arrives before request preparation starts', async () => {
    const harness = workerHarness(async () => undefined);
    const one = addClient(harness, 'one', (data, client) => { if (data.type === 'PREPARE' || data.type === 'VALIDATE') ack(harness, client, data); });
    let cancellation!: Promise<unknown>;
    harness.messageHandler({ source: one, data: { protocol, target, attempt, type: 'CANCEL' }, waitUntil: (work: Promise<unknown>) => { cancellation = work; } });
    await cancellation;
    await request(harness, one);
    expect(harness.self.skipWaiting).not.toHaveBeenCalled();
    expect(one.postMessage.mock.calls.map(([data]) => data.type)).toEqual(['RELEASE']);
  });

  it('missing/legacy tabs and spoofed source ACKs block with a bounded timeout', async () => {
    vi.useFakeTimers();
    try {
      const harness = workerHarness(async () => undefined);
      const one = addClient(harness, 'one', (data, client) => {
        if (data.type !== 'PREPARE') return;
        ack(harness, client, data);
        ack(harness, { id: 'spoofed-source' }, data);
        ack(harness, { id: 'two' }, { ...data, attempt: 'stale-attempt' });
      });
      addClient(harness, 'two');
      const work = request(harness, one);
      await vi.advanceTimersByTimeAsync(2500); await work;
      expect(harness.self.skipWaiting).not.toHaveBeenCalled();
      expect(one.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'RELEASE' }));
    } finally { vi.useRealTimers(); }
  });

  it('a newly opened client after final ACKs invalidates membership', async () => {
    const harness = workerHarness(async () => undefined);
    const one = addClient(harness, 'one', (data, client) => {
      if (data.type === 'PREPARE' || data.type === 'VALIDATE') ack(harness, client, data);
      if (data.type === 'VALIDATE') addClient(harness, 'late-tab');
    });
    await request(harness, one);
    expect(harness.self.skipWaiting).not.toHaveBeenCalled();
    expect(one.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'RELEASE' }));
  });

  it('coordinator closure cancels even after all prepare ACKs', async () => {
    const harness = workerHarness(async () => undefined);
    const one = addClient(harness, 'one', (data, client) => { if (data.type === 'PREPARE') ack(harness, client, data); });
    addClient(harness, 'two', (data, client) => {
      if (data.type === 'PREPARE') { ack(harness, client, data); harness.windows.splice(0, 1); }
    });
    await request(harness, one);
    expect(harness.self.skipWaiting).not.toHaveBeenCalled();
    expect(one.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'RELEASE' }));
  });

  it('cancellation during the last asynchronous membership read cannot activate later', async () => {
    const harness = workerHarness(async () => undefined);
    const one = addClient(harness, 'one', (data, client) => { if (data.type === 'PREPARE' || data.type === 'VALIDATE') ack(harness, client, data); });
    let finishMembership!: (clients: typeof harness.windows) => void;
    let count = 0;
    vi.spyOn(harness.self.clients, 'matchAll').mockImplementation(async () => {
      count += 1;
      if (count === 3) return new Promise((resolve) => { finishMembership = resolve; });
      return [...harness.windows];
    });
    const work = request(harness, one);
    for (let index = 0; index < 30 && !finishMembership; index += 1) await Promise.resolve();
    expect(finishMembership).toBeDefined();
    harness.messageHandler({ source: one, data: { protocol, target, attempt, type: 'CANCEL' } });
    finishMembership([...harness.windows]);
    await work;
    expect(harness.self.skipWaiting).not.toHaveBeenCalled();
  });
});

describe('worker byte fingerprints and generation reclamation', () => {
  const metadataPath = '/__billsplit_shell_metadata__';
  const shell = '<div id="root"></div><script src="/assets/app-123.js"></script>';
  const paths = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-16.png', '/icons/icon-32.png', '/icons/logo-400.png', '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png', '/assets/app-123.js'];
  const files = () => new Map(paths.map((path) => [path, path === '/' || path === '/index.html' ? shell : `bytes:${path}`]));
  const network = (bodies: Map<string, string>) => async (request?: Request) => {
    const path = new URL(request!.url).pathname;
    const type = path === '/' ? 'text/html' : path.endsWith('.webmanifest') ? 'application/json' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : 'text/javascript';
    return Object.defineProperty(new Response(bodies.get(path), { headers: { 'Content-Type': type } }), 'url', { value: `https://split.test${path}` });
  };
  const fingerprintedSource = async (bodies: Map<string, string>) => {
    const integrity: Record<string, { bytes: number; sha256: string }> = {};
    for (const [path, body] of bodies) {
      const bytes = new TextEncoder().encode(body);
      const digest = await webcrypto.subtle.digest('SHA-256', bytes);
      integrity[path] = { bytes: bytes.length, sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
    }
    return source.replaceAll('__BILLSPLIT_SHELL_INTEGRITY__', JSON.stringify(integrity));
  };
  const storage = () => {
    const data = new Map<string, Map<string, Response>>();
    const path = (request: Request | string) => typeof request === 'string' ? request : new URL(request.url).pathname;
    const caches = {
      keys: async () => [...data.keys()],
      delete: vi.fn(async (key: string) => data.delete(key)),
      match: async (request: Request | string, options: { cacheName: string }) => data.get(options.cacheName)?.get(path(request))?.clone(),
      open: async (key: string) => {
        if (!data.has(key)) data.set(key, new Map());
        const entries = data.get(key)!;
        return {
          match: async (request: Request | string) => entries.get(path(request))?.clone(),
          put: async (request: Request | string, response: Response) => { entries.set(path(request), response.clone()); },
          keys: async () => [...entries.keys()].map((name) => new Request(`https://split.test${name}`)),
          delete: async (request: Request | string) => entries.delete(path(request)),
        };
      },
    };
    const generation = (number: number) => `bill-split-shell-generation-${number}`;
    const add = async (number: number) => {
      const key = generation(number);
      const cache = await caches.open(key);
      await cache.put(metadataPath, new Response(JSON.stringify({ version: key, created: number * 1000, complete: true, clients: {} })));
      await cache.put('/', new Response(`shell-${number}`));
    };
    return { data, caches, generation, add };
  };
  const activate = (harness: ReturnType<typeof workerHarness>) => {
    let work!: Promise<unknown>;
    harness.activateHandler({ waitUntil: (promise: Promise<unknown>) => { work = promise; } });
    return work;
  };
  const addReportingClient = (harness: ReturnType<typeof workerHarness>, build: string | null, respond = true) => {
    const client = { id: 'persistent-tab', type: 'window', url: 'https://split.test/', focus: async () => undefined, navigate: async () => undefined, postMessage: (data: any) => {
      if (respond && data.type === 'PROBE_BUILD') harness.messageHandler({ source: client, data: { protocol: 'BILLSPLIT_UPDATE_V1', type: 'BUILD_REPORT', target: data.target, scan: data.scan, build } });
    } };
    harness.windows.push(client);
  };

  it.each(['/', '/manifest.webmanifest', '/icons/icon.svg', '/assets/app-123.js'])('rejects changed bytes at %s even when entry filenames are identical', async (changedPath) => {
    const bodies = files();
    const workerSource = await fingerprintedSource(bodies);
    bodies.set(changedPath, `${bodies.get(changedPath)!.slice(0, -1)}X`);
    const store = storage(); await store.add(1);
    const harness = workerHarness(async () => undefined, network(bodies), undefined, store.caches, workerSource);
    let install!: Promise<unknown>;
    harness.installHandler({ waitUntil: (promise: Promise<unknown>) => { install = promise; } });
    await expect(install).rejects.toThrow('fingerprint mismatch');
    expect(store.data.has('bill-split-shell-test')).toBe(false);
    expect(store.data.has(store.generation(1))).toBe(true);
    expect(harness.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('validates every dependency and completes the coherent offline shell', async () => {
    const bodies = files(); const store = storage();
    const harness = workerHarness(async () => undefined, network(bodies), undefined, store.caches, await fingerprintedSource(bodies));
    let install!: Promise<unknown>;
    harness.installHandler({ waitUntil: (promise: Promise<unknown>) => { install = promise; } });
    await install;
    const cache = await store.caches.open('bill-split-shell-test');
    expect(await (await cache.match('/'))!.text()).toBe(shell);
    expect((await (await cache.match(metadataPath))!.json() as { complete: boolean }).complete).toBe(true);
  });

  it('cleans a failed partial installation without deleting the active generation', async () => {
    const bodies = files(); const store = storage(); await store.add(1);
    const open = store.caches.open;
    const overrides = { ...store.caches, open: async (key: string) => {
      const cache = await open(key);
      return { ...cache, put: async (request: Request | string, response: Response) => {
        if (request === '/assets/app-123.js') throw new Error('cache write failed');
        await cache.put(request, response);
      } };
    } };
    const harness = workerHarness(async () => undefined, network(bodies), undefined, overrides, await fingerprintedSource(bodies));
    let install!: Promise<unknown>;
    harness.installHandler({ waitUntil: (promise: Promise<unknown>) => { install = promise; } });
    await expect(install).rejects.toThrow('cache write failed');
    expect(store.data.has('bill-split-shell-test')).toBe(false);
    expect(store.data.has(store.generation(1))).toBe(true);
  });

  it('bounds a never-finishing response body before writing the shell', async () => {
    const workerSource = await fingerprintedSource(files());
    vi.useFakeTimers();
    try {
      const store = storage(); await store.add(1);
      const response = Object.defineProperty(new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/html' } }), 'url', { value: 'https://split.test/' });
      const harness = workerHarness(async () => undefined, async () => response, undefined, store.caches, workerSource);
      let install!: Promise<unknown>;
      harness.installHandler({ waitUntil: (promise: Promise<unknown>) => { install = promise; } });
      const rejected = expect(install).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(5_000); await rejected;
      expect(store.data.has('bill-split-shell-test')).toBe(false);
      expect(store.data.has(store.generation(1))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('waits for late underlying writes before removing a timed-out partial cache', async () => {
    vi.useFakeTimers();
    try {
      const store = storage(); await store.add(1);
      let finish!: () => Promise<void>;
      const open = store.caches.open;
      const overrides = { ...store.caches, open: async (key: string) => {
        const cache = await open(key);
        return { ...cache, put: (request: Request | string, response: Response) => {
          if (request !== '/assets/app-123.js') return cache.put(request, response);
          return new Promise<void>((resolve) => { finish = async () => { await cache.put(request, response); resolve(); }; });
        } };
      } };
      const harness = workerHarness(async () => undefined, network(files()), undefined, overrides);
      let install!: Promise<unknown>;
      harness.installHandler({ waitUntil: (promise: Promise<unknown>) => { install = promise; } });
      const rejected = expect(install).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(2_000); await rejected;
      expect(store.data.has('bill-split-shell-test')).toBe(true);
      expect(finish).toBeDefined();
      await finish();
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(store.data.has('bill-split-shell-test')).toBe(false);
      expect(store.data.has(store.generation(1))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('retains a live old build over repeated generations and reclaims unused builds after the handoff grace', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10 * 24 * 60 * 60 * 1000);
    try {
      const store = storage();
      for (let number = 1; number <= 5; number += 1) await store.add(number);
      await store.caches.open('unrelated-cache');
      await store.caches.open('bill-split-shell-legacy-oldest');
      await store.caches.open('bill-split-shell-legacy-unused');
      const run = async (number: number, live: boolean) => {
        await store.add(number);
        const harness = workerHarness(async () => undefined, undefined, undefined, store.caches, source.replace("'bill-split-shell-test'", JSON.stringify(store.generation(number))));
        if (live) addReportingClient(harness, store.generation(1));
        await activate(harness);
      };
      await run(5, true);
      expect(store.data.has(store.generation(1))).toBe(true);
      expect(store.data.has(store.generation(2))).toBe(false);
      expect(store.data.has(store.generation(3))).toBe(false);
      expect(store.data.has('unrelated-cache')).toBe(true);
      expect(store.data.has('bill-split-shell-legacy-oldest')).toBe(true);
      expect(store.data.has('bill-split-shell-legacy-unused')).toBe(false);
      await run(6, true);
      expect(store.data.has(store.generation(1))).toBe(true);
      expect(store.data.has(store.generation(4))).toBe(false);
      await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
      await run(7, false);
      expect(store.data.has(store.generation(1))).toBe(false);
      expect(store.data.has(store.generation(5))).toBe(false);
      expect(store.data.has(store.generation(6))).toBe(true); // One previous handoff fallback.
    } finally { vi.useRealTimers(); }
  });

  it('freezes unconfirmed legacy candidates instead of retaining every future generation', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10 * 24 * 60 * 60 * 1000);
    try {
      const store = storage(); await store.add(1);
      const run = async (number: number) => {
        await store.add(number);
        const harness = workerHarness(async () => undefined, undefined, undefined, store.caches, source.replace("'bill-split-shell-test'", JSON.stringify(store.generation(number))));
        addReportingClient(harness, null, false);
        const work = activate(harness);
        await vi.advanceTimersByTimeAsync(2000); await work;
      };
      await run(2);
      await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000); // Live unknown identities must not expire like closed clients.
      await run(3); await run(4); await run(5);
      expect(store.data.has(store.generation(1))).toBe(true); // Could belong to the legacy tab.
      expect(store.data.has(store.generation(2))).toBe(true); // Frozen first-observation candidate.
      expect(store.data.has(store.generation(3))).toBe(false); // Never expanded the unknown set.
      expect(store.data.has(store.generation(4))).toBe(true);
      expect(store.data.has(store.generation(5))).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
