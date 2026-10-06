const CACHE = '__BILLSPLIT_CACHE_VERSION__';
// Vite serves files from public/ unchanged during development. Keep the
// source worker parseable there; the production finalizer replaces both
// placeholder references with the exact generated shell list.
const DEV_SHELL_FILES = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-16.png', '/icons/icon-32.png', '/icons/logo-400.png', '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png'];
const SHELL_FILES = typeof __BILLSPLIT_SHELL_ASSETS__ === 'undefined' ? DEV_SHELL_FILES : __BILLSPLIT_SHELL_ASSETS__;
const ENTRY_ASSETS = typeof __BILLSPLIT_ENTRY_ASSETS__ === 'undefined' ? undefined : __BILLSPLIT_ENTRY_ASSETS__;
const SHELL_INTEGRITY = typeof __BILLSPLIT_SHELL_INTEGRITY__ === 'undefined' ? undefined : __BILLSPLIT_SHELL_INTEGRITY__;
const CACHE_PREFIX = 'bill-split-shell-';
const CACHE_METADATA = '/__billsplit_shell_metadata__';
const CLIENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ASSETS = 80;
const NAVIGATION_TIMEOUT_MS = 3000;
const ASSET_TIMEOUT_MS = 5000;
const BACKGROUND_TIMEOUT_MS = 1500;
const CACHE_TIMEOUT_MS = 1000;
const INSTALL_TIMEOUT_MS = 5000;
const assetPattern = /^\/assets\/[a-zA-Z0-9._-]+\.(?:js|css|svg|png|webp|woff2?)$/;
const isPrivatePath = (pathname) => pathname === '/api' || pathname.startsWith('/api/') || pathname === '/auth' || pathname.startsWith('/auth/') || pathname === '/cdn' || pathname.startsWith('/cdn/') || pathname === '/cdn-cgi' || pathname.startsWith('/cdn-cgi/') || pathname === '/sign-in' || pathname.startsWith('/sign-in/') || pathname === '/sign-up' || pathname.startsWith('/sign-up/');
const isAllowedAsset = (url) => url.origin === self.location.origin && !isPrivatePath(url.pathname) && (SHELL_FILES.includes(url.pathname) || assetPattern.test(url.pathname));
const cacheControlAllowsStorage = (response) => !/(?:^|,)\s*(?:private|no-store)(?:\s*(?:,|$)|=)/i.test(response.headers.get('cache-control') || '');
const sameOriginFinal = (response, expectedPath) => response.ok && !response.redirected && (() => { try { const url = new URL(response.url); return url.origin === self.location.origin && (!expectedPath || url.pathname === expectedPath) && !isPrivatePath(url.pathname); } catch { return false; } })();
const htmlType = (response) => response.headers.get('content-type')?.toLowerCase().includes('text/html');
const assetType = (path, response) => { const type = response.headers.get('content-type')?.toLowerCase() || ''; if (path.endsWith('.js')) return type.includes('javascript') || type.includes('ecmascript'); if (path.endsWith('.css')) return type.includes('text/css'); if (path.endsWith('.svg')) return type.includes('svg'); if (path.endsWith('.png')) return type.includes('png'); if (path.endsWith('.webp')) return type.includes('webp'); return type.includes('font'); };
const extractAssets = (html) => [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)].map((match) => match[1]).map((value) => { try { return new URL(value, self.location.origin); } catch { return undefined; } }).filter((url) => url && url.origin === self.location.origin && assetPattern.test(url.pathname)).map((url) => url.pathname).filter((path, index, all) => all.indexOf(path) === index);
const validShellHtml = (response, html, requestedPath = '/index.html') => {
  try {
    const url = new URL(response.url);
    return response.ok && !response.redirected && url.origin === self.location.origin && !isPrivatePath(url.pathname) && [requestedPath, '/', '/index.html'].includes(url.pathname) && htmlType(response) && cacheControlAllowsStorage(response) && /id=["']root["']/.test(html) && extractAssets(html).length > 0;
  } catch { return false; }
};
const trimAssets = async (cache, required = false) => {
  const keys = required ? await requiredOperation(cache.keys(), CACHE_TIMEOUT_MS) : await bounded(cache.keys(), CACHE_TIMEOUT_MS, []);
  const removable = keys.filter((request) => { const path = new URL(request.url).pathname; return path !== CACHE_METADATA && !SHELL_FILES.includes(path); });
  if (removable.length > MAX_ASSETS) {
    const deletions = removable.slice(0, removable.length - MAX_ASSETS).map((request) => cache.delete(request));
    if (required) await requiredOperation(Promise.all(deletions), CACHE_TIMEOUT_MS);
    else void bounded(Promise.all(deletions), BACKGROUND_TIMEOUT_MS, undefined);
  }
};

const consume = (promise) => { void promise.catch(() => undefined); return promise; };
const TIMEOUT = Symbol('service-worker-timeout');
const bounded = (promise, timeoutMs, fallback) => {
  let timer;
  consume(promise);
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
};
const requiredOperation = async (promise, timeoutMs) => {
  const result = await bounded(promise, timeoutMs, TIMEOUT);
  if (result === TIMEOUT) throw new Error('Service-worker operation timed out.');
  return result;
};
const installWrites = new Set();
const installOperation = (promise) => {
  installWrites.add(promise);
  promise.then(() => installWrites.delete(promise), () => installWrites.delete(promise));
  return requiredOperation(promise, CACHE_TIMEOUT_MS);
};
async function verifyShellBytes(path, response) {
  if (!SHELL_INTEGRITY) return; // Unfinalized Vite development worker only.
  const expected = SHELL_INTEGRITY[path];
  if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256) || !self.crypto?.subtle) throw new Error(`Missing shell fingerprint: ${path}`);
  const reader = response.clone().body?.getReader();
  const work = (async () => {
    const chunks = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > expected.bytes) throw new Error(`Shell fingerprint mismatch: ${path}`);
        chunks.push(value);
      }
    }
    if (size !== expected.bytes) throw new Error(`Shell fingerprint mismatch: ${path}`);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = await self.crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== expected.sha256) throw new Error(`Shell fingerprint mismatch: ${path}`);
  })();
  try { await requiredOperation(work, INSTALL_TIMEOUT_MS); }
  catch (error) {
    try { consume(Promise.allSettled([reader?.cancel(), response.body?.cancel()])); } catch { /* A locked/closed body is already bounded by the failed verification. */ }
    throw error;
  }
}
const timedFetch = (request, timeoutMs) => {
  const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
  let fetchPromise;
  try { fetchPromise = controller ? fetch(request, { signal: controller.signal }) : fetch(request); }
  catch { return Promise.resolve(undefined); }
  consume(fetchPromise);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { controller?.abort(); resolve(undefined); }, timeoutMs);
  });
  return Promise.race([fetchPromise, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
};
const boundedFetch = (request, timeoutMs) => timedFetch(request, timeoutMs);
const requiredFetch = async (request, timeoutMs) => {
  const response = await timedFetch(request, timeoutMs);
  if (!response) throw new Error('Service-worker fetch timed out.');
  return response;
};
// Navigation must never select another application's cache or an older shell.
const boundedCacheMatch = (request) => bounded(Promise.resolve().then(async () => (await caches.open(CACHE)).match(request)), CACHE_TIMEOUT_MS, undefined).catch(() => undefined);
const boundedAssetMatch = async (request) => {
  const current = await boundedCacheMatch(request);
  if (current) return current;
  // Old tabs can still request lazy chunks from their loaded HTML generation.
  // Bound the entire fallback scan, not each cache multiplied by its count.
  return bounded((async () => {
    const keys = await caches.keys();
    for (const key of keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).reverse()) {
      const response = await caches.match(request, { cacheName: key }); // Never recreate a concurrently reclaimed cache.
      if (response) return response;
    }
    return undefined;
  })(), CACHE_TIMEOUT_MS, undefined).catch(() => undefined);
};
const boundedCacheOpen = () => bounded(caches.open(CACHE), CACHE_TIMEOUT_MS, undefined);

const replaceShell = async (cache, response) => {
  const previousIndex = await requiredOperation(cache.match('/index.html'), CACHE_TIMEOUT_MS);
  const previousRoot = await requiredOperation(cache.match('/'), CACHE_TIMEOUT_MS);
  try {
    await installOperation(Promise.all([cache.put('/index.html', response.clone()), cache.put('/', response.clone())]));
  } catch (error) {
    const rollback = Promise.all([
      previousIndex ? cache.put('/index.html', previousIndex.clone()) : cache.delete('/index.html'),
      previousRoot ? cache.put('/', previousRoot.clone()) : cache.delete('/'),
    ]);
    await bounded(installOperation(rollback), CACHE_TIMEOUT_MS, undefined).catch(() => undefined);
    throw error;
  }
};

async function refreshCompleteShell(navigationResponse, requestedPath) {
  await verifyShellBytes('/', navigationResponse);
  const html = await requiredOperation(navigationResponse.clone().text(), INSTALL_TIMEOUT_MS);
  if (!validShellHtml(navigationResponse, html, requestedPath)) throw new Error('The current app shell is not safe to cache.');
  const entryAssets = extractAssets(html);
  if (ENTRY_ASSETS && (entryAssets.length !== ENTRY_ASSETS.length || entryAssets.some((path) => !ENTRY_ASSETS.includes(path)))) throw new Error('The deployed shell does not match this worker build.');
  const assets = ENTRY_ASSETS ? SHELL_FILES.filter((path) => path.startsWith('/assets/')) : entryAssets;
  const staticResponses = await Promise.all(SHELL_FILES.filter((path) => path !== '/' && path !== '/index.html' && !path.startsWith('/assets/')).map(async (path) => ({ path, response: await requiredFetch(new Request(path, { cache: 'no-store' }), INSTALL_TIMEOUT_MS) })));
  for (const { path, response } of staticResponses) {
    const expectedType = path.endsWith('.webmanifest') ? response.headers.get('content-type')?.toLowerCase().includes('json') : path.endsWith('.svg') ? response.headers.get('content-type')?.toLowerCase().includes('svg') : response.headers.get('content-type')?.toLowerCase().includes('png');
    if (!sameOriginFinal(response, path) || !expectedType || !cacheControlAllowsStorage(response)) throw new Error(`Unsafe shell asset: ${path}`);
    await verifyShellBytes(path, response);
  }
  const assetResponses = await Promise.all(assets.map(async (path) => ({ path, response: await requiredFetch(new Request(path, { cache: 'no-store' }), INSTALL_TIMEOUT_MS) })));
  for (const { path, response } of assetResponses) {
    if (!sameOriginFinal(response, path) || !assetType(path, response) || !cacheControlAllowsStorage(response)) throw new Error(`Unsafe app asset: ${path}`);
    await verifyShellBytes(path, response);
  }

  // Populate every current dependency before replacing either shell entry. If
  // any fetch or validation fails, the old index/root pair remains untouched.
  const cache = await installOperation(caches.open(CACHE));
  await installOperation(cache.put(CACHE_METADATA, new Response(JSON.stringify({ version: CACHE, created: Date.now(), complete: false, clients: {} }))));
  for (const { path, response } of [...staticResponses, ...assetResponses]) await installOperation(cache.put(path, response.clone()));
  await trimAssets(cache, true);
  // Keep the shell swap last: a failed dependency write or maintenance pass
  // therefore cannot expose a partially updated navigation response.
  await replaceShell(cache, navigationResponse);
  await installOperation(cache.put(CACHE_METADATA, new Response(JSON.stringify({ version: CACHE, created: Date.now(), complete: true, clients: {} }))));
}

async function installCompleteShell() {
  const existing = await requiredOperation(caches.keys(), CACHE_TIMEOUT_MS);
  const created = !existing.includes(CACHE);
  // ASSETS can canonicalize /index.html to /. Fetch the canonical navigation
  // URL so a strict redirect check cannot strand a newly installed worker.
  try {
    const shellResponse = await requiredFetch(new Request('/', { cache: 'no-store' }), INSTALL_TIMEOUT_MS);
    await refreshCompleteShell(shellResponse, '/');
  } catch (error) {
    // A timeout does not finish an underlying Cache write/open. Delete only
    // after those settle, and never remove a pre-existing/active generation.
    if (created) {
      const cleanup = Promise.allSettled([...installWrites]).then(() => caches.delete(CACHE));
      consume(cleanup);
      await bounded(cleanup, CACHE_TIMEOUT_MS, undefined).catch(() => undefined);
    }
    throw error;
  }
}

self.addEventListener('install', (event) => event.waitUntil(installCompleteShell().then(() => {
  // The first worker takes control immediately. Updates stay waiting until
  // the page explicitly applies them, so an active form is never interrupted.
  if (!self.registration?.active) return self.skipWaiting();
  return undefined;
})));
self.addEventListener('activate', (event) => event.waitUntil(
  requiredOperation(self.clients.claim(), CACHE_TIMEOUT_MS).then(() => pruneShellCaches())
));

const UPDATE_PROTOCOL = 'BILLSPLIT_UPDATE_V1';
const UPDATE_ACK_TIMEOUT_MS = 2500;
let updateAttempt;
const retiredUpdateAttempts = new Set();
const retireUpdateAttempt = (id) => {
  retiredUpdateAttempts.add(id);
  if (retiredUpdateAttempts.size > 256) retiredUpdateAttempts.delete(retiredUpdateAttempts.values().next().value);
};
const scopeClient = (client) => {
  try { const url = new URL(client.url); return client.type === 'window' && url.origin === self.location.origin && url.href.startsWith(self.registration.scope); }
  catch { return false; }
};
const updateClients = async () => (await requiredOperation(self.clients.matchAll({ type: 'window', includeUncontrolled: true }), CACHE_TIMEOUT_MS)).filter(scopeClient);
const updateMessage = (client, type, attempt, extra = {}) => {
  try { client.postMessage({ protocol: UPDATE_PROTOCOL, type, attempt, target: CACHE, ...extra }); } catch { /* Missing ACK fails closed. */ }
};
let buildScan;
let prunePromise;
const validBuild = (build) => typeof build === 'string' && build.startsWith(CACHE_PREFIX) && build.length <= 128;
async function pruneShellCaches() {
  if (prunePromise) return prunePromise;
  const scan = { id: self.crypto?.randomUUID?.(), clients: [], reports: new Map(), cancelled: false, resolve: undefined };
  const work = (async () => {
    const keys = (await requiredOperation(caches.keys(), CACHE_TIMEOUT_MS)).filter((key) => key.startsWith(CACHE_PREFIX));
    const metadata = new Map();
    for (const key of keys) {
      try {
        const response = await requiredOperation(caches.match(CACHE_METADATA, { cacheName: key }), CACHE_TIMEOUT_MS);
        const record = response && await requiredOperation(response.json(), CACHE_TIMEOUT_MS);
        if (record?.version === key && Number.isFinite(record.created)) metadata.set(key, record);
      } catch { /* An unreadable generation is treated as unknown, not deleted blindly. */ }
    }
    const current = metadata.get(CACHE);
    if (!current?.complete || scan.cancelled) return;
    scan.clients = await updateClients();
    if (scan.cancelled) return;
    if (scan.clients.length && !scan.id) return;
    buildScan = scan;
    if (scan.clients.length) await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish(), 1500);
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); scan.resolve = undefined; resolve(); };
      scan.resolve = finish;
      for (const client of scan.clients) updateMessage(client, 'PROBE_BUILD', undefined, { scan: scan.id });
    });
    const clients = await updateClients();
    if (scan.cancelled || clients.length !== scan.clients.length || !clients.every((client) => scan.clients.some((previous) => previous.id === client.id))) return;
    const records = Object.create(null);
    const liveIds = new Set(clients.map((client) => client.id));
    // Carry immutable client generation identities across worker restarts and
    // updates. Unknown clients get a frozen candidate set on first observation,
    // so a suspended/legacy tab does not accumulate EVERY future deployment.
    for (const record of metadata.values()) for (const [id, entry] of Object.entries(record.clients || {})) {
      if (!entry || !Number.isFinite(entry.seen) || (!liveIds.has(id) && entry.seen < Date.now() - CLIENT_RETENTION_MS)) continue;
      if (!validBuild(entry.build) && !(Array.isArray(entry.candidates) && entry.candidates.every(validBuild))) continue;
      const previous = records[id];
      if (!previous || (entry.build && !previous.build) || (Boolean(entry.build) === Boolean(previous.build) && entry.seen > previous.seen)) records[id] = entry;
    }
    for (const client of clients) {
      const reported = scan.reports.get(client.id);
      if (validBuild(reported)) records[client.id] = { build: reported, seen: Date.now() };
      else records[client.id] = { ...(records[client.id] || { candidates: keys }), seen: Date.now() };
    }
    const keep = new Set([CACHE]);
    for (const entry of Object.values(records)) {
      if (entry.build) keep.add(entry.build);
      else for (const key of entry.candidates) keep.add(key);
    }
    // One previous complete build is a handoff fallback for the unavoidable
    // new-window race; one oldest metadata-less cache protects legacy unknowns.
    const older = keys.filter((key) => key !== CACHE && metadata.get(key)?.complete && metadata.get(key).created <= current.created).sort((a, b) => metadata.get(b).created - metadata.get(a).created);
    if (older[0]) keep.add(older[0]);
    const oldestUnknown = keys.find((key) => !metadata.has(key));
    if (oldestUnknown) keep.add(oldestUnknown);
    const cache = await requiredOperation(caches.open(CACHE), CACHE_TIMEOUT_MS);
    await requiredOperation(cache.put(CACHE_METADATA, new Response(JSON.stringify({ ...current, clients: records }))), CACHE_TIMEOUT_MS);
    // Recheck after persistence too: no deletion based on stale membership.
    const finalClients = await updateClients();
    if (scan.cancelled || finalClients.length !== clients.length || !finalClients.every((client) => clients.some((previous) => previous.id === client.id))) return;
    for (const key of keys) {
      if (scan.cancelled) return;
      const record = metadata.get(key);
      if (keep.has(key) || (record && (record.created > current.created || (!record.complete && record.created > Date.now() - CLIENT_RETENTION_MS)))) continue; // Waiting/new installs belong to their worker.
      await requiredOperation(caches.delete(key), CACHE_TIMEOUT_MS);
    }
  })();
  prunePromise = bounded(work, 8_000, undefined).catch(() => undefined).finally(() => {
    scan.cancelled = true;
    scan.resolve?.();
    if (buildScan === scan) buildScan = undefined;
    prunePromise = undefined;
  });
  return prunePromise;
}
const cancelUpdate = (attempt, reason) => {
  if (updateAttempt !== attempt) return;
  attempt.cancelled = true;
  retireUpdateAttempt(attempt.id);
  attempt.resolve?.(false);
  for (const client of attempt.clients) updateMessage(client, 'RELEASE', attempt.id, { reason });
  updateAttempt = undefined;
};
const collectReady = (attempt, round) => new Promise((resolve) => {
  attempt.round = round;
  attempt.acks = new Set();
  let settled = false;
  const timer = setTimeout(() => finish(false), UPDATE_ACK_TIMEOUT_MS);
  const finish = (ready) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    attempt.resolve = undefined;
    resolve(ready);
  };
  attempt.resolve = finish;
  for (const client of attempt.clients) {
    if (attempt.cancelled || updateAttempt !== attempt) break;
    updateMessage(client, round === 'prepare' ? 'PREPARE' : 'VALIDATE', attempt.id, { round, leaseMs: 10_000 });
  }
});
const sameMembership = (attempt, clients) => clients.length === attempt.clients.length && clients.some((client) => client.id === attempt.coordinator) && clients.every((client) => attempt.clients.some((member) => member.id === client.id));
async function coordinateUpdate(source, data) {
  if (retiredUpdateAttempts.has(data.attempt)) { updateMessage(source, 'RELEASE', data.attempt, { reason: 'This update attempt has ended' }); return; }
  if (updateAttempt) {
    if (updateAttempt.id === data.attempt && updateAttempt.coordinator === source.id) return;
    retireUpdateAttempt(data.attempt);
    updateMessage(source, 'RELEASE', data.attempt, { reason: 'Another tab is preparing the update' });
    return;
  }
  const attempt = { id: data.attempt, coordinator: source.id, clients: [source], cancelled: false, round: '', acks: new Set(), resolve: undefined };
  updateAttempt = attempt;
  try {
    attempt.clients = await updateClients();
    if (updateAttempt !== attempt || !attempt.clients.some((client) => client.id === source.id)) throw new Error('The requesting tab is no longer available');
    if (!await collectReady(attempt, 'prepare')) throw new Error('Another tab has unsaved changes, is busy, or did not respond');
    const preparedClients = await updateClients();
    if (attempt.cancelled || updateAttempt !== attempt || !sameMembership(attempt, preparedClients)) throw new Error('Open tabs changed; trying again later');
    if (!await collectReady(attempt, 'final')) throw new Error('Another tab is no longer ready');
    const finalClients = await updateClients();
    if (attempt.cancelled || updateAttempt !== attempt || !sameMembership(attempt, finalClients)) throw new Error('Open tabs changed; trying again later');
    // matchAll + skipWaiting cannot be atomic with new window creation. The
    // page also validates its target and local safety before ANY reload, and
    // prior build caches are retained for late/unprepared windows.
    for (const client of attempt.clients) updateMessage(client, 'ACTIVATING', attempt.id);
    await requiredOperation(self.skipWaiting(), CACHE_TIMEOUT_MS);
    retireUpdateAttempt(attempt.id);
    updateAttempt = undefined;
  } catch (error) {
    cancelUpdate(attempt, error?.message || 'Update preparation failed');
  }
}
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.protocol !== UPDATE_PROTOCOL || !event.source?.id) return;
  if (data.type === 'BUILD_REPORT') {
    const scan = buildScan;
    if (data.target !== CACHE || !scan || data.scan !== scan.id || !scan.clients.some((client) => client.id === event.source.id)) return;
    scan.reports.set(event.source.id, validBuild(data.build) ? data.build : null);
    if (scan.reports.size === scan.clients.length) scan.resolve?.();
    return;
  }
  // ACK/CANCEL handling is synchronous; no late waitUntil calls after awaits.
  const attempt = updateAttempt;
  if (data.target === CACHE && attempt && data.attempt === attempt.id && (attempt.coordinator === event.source.id || attempt.clients.some((client) => client.id === event.source.id))) {
    if (data.type === 'CANCEL') { cancelUpdate(attempt, 'A tab is no longer ready'); return; }
    if (data.type === 'ACK' && attempt.clients.some((client) => client.id === event.source.id) && data.round === attempt.round && typeof data.ready === 'boolean') {
      if (!data.ready) cancelUpdate(attempt, 'Another tab has unsaved changes or is busy');
      else { attempt.acks.add(event.source.id); if (attempt.acks.size === attempt.clients.length) attempt.resolve?.(true); }
      return;
    }
  }
  if (data.type !== 'IDENTIFY' && data.type !== 'REQUEST' && data.type !== 'CANCEL') return;
  event.waitUntil?.((async () => {
    const source = await requiredOperation(self.clients.get(event.source.id), CACHE_TIMEOUT_MS);
    if (!source || !scopeClient(source)) return;
    if (data.type === 'IDENTIFY') { updateMessage(source, 'IDENTITY', undefined); return; }
    if (data.target !== CACHE || typeof data.attempt !== 'string' || data.attempt.length < 8 || data.attempt.length > 128) return;
    if (data.type === 'CANCEL') {
      const current = updateAttempt;
      if (current?.id === data.attempt && (current.coordinator === source.id || current.clients.some((client) => client.id === source.id))) cancelUpdate(current, 'A tab cancelled the update');
      else if (!current || current.id !== data.attempt) retireUpdateAttempt(data.attempt);
      return;
    }
    await coordinateUpdate(source, data);
  })().catch(() => undefined));
});

// Background Sync is deliberately a hint to the foreground, not a
// second expense sender. The foreground replay remains the authoritative path
// because only it can prove the current internal user and application session.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'billsplit-expense-outbox') return;
  event.waitUntil?.((async () => {
    const clients = await self.clients?.matchAll?.({ type: 'window', includeUncontrolled: true }) || [];
    for (const client of clients) { try { client.postMessage?.({ type: 'BILLSPLIT_OUTBOX_SYNC_HINT' }); } catch { /* Optional client hint. */ } }
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || isPrivatePath(url.pathname)) return;
  if (event.request.mode === 'navigate') {
    event.waitUntil?.(pruneShellCaches());
    const cachedNavigation = (async () => {
      const exact = await boundedCacheMatch(event.request);
      if (exact) return exact;
      const root = await boundedCacheMatch('/');
      if (root) return root;
      return boundedCacheMatch('/index.html');
    })();
    const networkFallback = () => boundedFetch(event.request, NAVIGATION_TIMEOUT_MS).catch(() => undefined);
    event.respondWith(cachedNavigation.catch(() => undefined).then((cached) => cached || networkFallback()).then((response) => response || Response.error()));
    return;
  }
  if (!isAllowedAsset(url)) return;
  event.respondWith(boundedAssetMatch(event.request).then(async (cached) => {
    if (cached) return cached;
    const response = await boundedFetch(event.request, ASSET_TIMEOUT_MS);
    if (!response) return boundedAssetMatch(event.request).then((fallback) => fallback || Response.error());
    if (sameOriginFinal(response, url.pathname) && cacheControlAllowsStorage(response) && assetType(url.pathname, response)) {
      if (SHELL_INTEGRITY?.[url.pathname]) { try { await verifyShellBytes(url.pathname, response); } catch { return Response.error(); } }
      const persist = (async () => { const cache = await requiredOperation(caches.open(CACHE), CACHE_TIMEOUT_MS); await requiredOperation(cache.put(event.request, response.clone()), CACHE_TIMEOUT_MS); await trimAssets(cache, true); })();
      event.waitUntil(bounded(persist, BACKGROUND_TIMEOUT_MS, undefined).catch(() => undefined));
    }
    return response;
  }));
});
