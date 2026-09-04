const CACHE = '__BILLSPLIT_CACHE_VERSION__';
// Vite serves files from public/ unchanged during development. Keep the
// source worker parseable there; the production finalizer replaces both
// placeholder references with the exact generated shell list.
const DEV_SHELL_FILES = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];
const SHELL_FILES = typeof __BILLSPLIT_SHELL_ASSETS__ === 'undefined' ? DEV_SHELL_FILES : __BILLSPLIT_SHELL_ASSETS__;
const MAX_ASSETS = 80;
const NAVIGATION_TIMEOUT_MS = 3000;
const ASSET_TIMEOUT_MS = 5000;
const BACKGROUND_TIMEOUT_MS = 1500;
const CACHE_TIMEOUT_MS = 1000;
const INSTALL_TIMEOUT_MS = 5000;
const assetPattern = /^\/assets\/[a-zA-Z0-9._-]+\.(?:js|css|svg|png|webp|woff2?)$/;
const isPrivatePath = (pathname) => pathname === '/api' || pathname.startsWith('/api/') || pathname === '/auth' || pathname.startsWith('/auth/') || pathname === '/cdn' || pathname.startsWith('/cdn/') || pathname === '/cdn-cgi' || pathname.startsWith('/cdn-cgi/') || pathname === '/sign-in' || pathname.startsWith('/sign-in/') || pathname === '/sign-up' || pathname.startsWith('/sign-up/');
const notificationStateDatabase = 'bill-split-notification-state';
const notificationStateStore = 'identity';
const notificationBadgeStore = 'badge';
const notificationRoute = (value) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || /^(?:\/api(?:\/|$)|\/auth(?:\/|$)|\/cdn(?:\/|$)|\/cdn-cgi(?:\/|$)|\/sign-in(?:\/|$)|\/sign-up(?:\/|$))/i.test(url.pathname)) return '/';
    if (!/^\/(?:groups(?:\/|$)|expenses(?:\/|$)|expense(?:\/|$)|activity(?:\/|$)|settings(?:\/|$))/.test(url.pathname) && url.pathname !== '/') return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return '/'; }
};
const boundedText = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value : undefined;
const parseNotificationPayload = (event) => {
  let value;
  try { value = event.data?.json(); } catch { try { value = JSON.parse(event.data?.text?.() || ''); } catch { return undefined; } }
  if (!value || typeof value !== 'object') return undefined;
  const data = value.data;
  if (!data || typeof data !== 'object') return undefined;
  const eventId = boundedText(data.eventId, 128);
  const recipientUserId = boundedText(data.recipientUserId, 128);
  const route = notificationRoute(data.route);
  if (!eventId || !recipientUserId || typeof data.route !== 'string') return undefined;
  const title = boundedText(value.title, 120) || 'BillSplit activity';
  const body = boundedText(value.body, 240) || 'A group has new activity.';
  const tag = boundedText(value.tag, 100) || `billsplit-${eventId}`;
  return { title, body, tag, data: { eventId, recipientUserId, route } };
};
const openNotificationState = () => {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; resolve(value); };
    const timer = setTimeout(() => finish(undefined), 500);
    try {
      const request = indexedDB.open(notificationStateDatabase, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(notificationStateStore)) request.result.createObjectStore(notificationStateStore, { keyPath: 'key' });
        if (!request.result.objectStoreNames.contains(notificationBadgeStore)) request.result.createObjectStore(notificationBadgeStore, { keyPath: 'key' });
      };
      request.onsuccess = () => { clearTimeout(timer); finish(request.result); };
      request.onerror = () => { clearTimeout(timer); finish(undefined); };
      request.onblocked = () => { clearTimeout(timer); finish(undefined); };
    } catch { clearTimeout(timer); finish(undefined); }
  });
};
const currentNotificationIdentity = async () => {
  const db = await openNotificationState();
  if (!db) return { available: false };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); try { db.close(); } catch {} resolve(value); };
    const timer = setTimeout(() => finish({ available: false }), 500);
    try {
      const tx = db.transaction(notificationStateStore, 'readonly');
      const request = tx.objectStore(notificationStateStore).get('current');
      request.onsuccess = () => finish({ available: true, marker: request.result });
      tx.onerror = () => finish({ available: false });
      tx.onabort = () => finish({ available: false });
    } catch { finish({ available: false }); }
  });
};
const changeNotificationBadge = async (clear = false) => {
  const db = await openNotificationState();
  const badgeApi = self.registration && self.registration;
  if (!db) return undefined;
  let nextCount = 0;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(notificationBadgeStore, 'readwrite');
      const store = tx.objectStore(notificationBadgeStore);
      if (clear) store.put({ key: 'current', count: 0 });
      else {
        const read = store.get('current');
        read.onsuccess = () => { nextCount = Math.min(99, Math.max(0, Number(read.result?.count) || 0) + 1); store.put({ key: 'current', count: nextCount }); };
      }
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); resolve(); };
    } catch { db.close(); resolve(); }
  });
  try {
    if (clear && typeof badgeApi?.clearAppBadge === 'function') await badgeApi.clearAppBadge();
    else if (!clear && typeof badgeApi?.setAppBadge === 'function') await badgeApi.setAppBadge(nextCount);
  } catch { /* Badging is progressive enhancement. */ }
  return clear ? 0 : nextCount;
};
const notificationIdentityAllows = async (recipientUserId) => {
  const result = await currentNotificationIdentity();
  if (!result.available) return false;
  const marker = result.marker;
  // Storage reads and missing markers both fail closed. Enrollment writes the
  // marker before creating the browser subscription, so a valid first device
  // is still fenced before it can receive a push.
  if (marker === undefined) return false;
  if (!marker || marker.key !== 'current' || typeof marker.revoked !== 'boolean' || !Number.isSafeInteger(marker.revision) || marker.revision < 1 || typeof marker.updatedAt !== 'string' || marker.updatedAt.length > 128 || !Number.isFinite(Date.parse(marker.updatedAt))) return false;
  return marker.revoked !== true && marker.userId === recipientUserId && typeof marker.userId === 'string' && marker.userId.length > 0;
};
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
  const removable = keys.filter((request) => !SHELL_FILES.includes(new URL(request.url).pathname));
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
const boundedCacheMatch = (request) => bounded(Promise.resolve().then(() => caches.match(request)), CACHE_TIMEOUT_MS, undefined).catch(() => undefined);
const boundedCacheOpen = () => bounded(caches.open(CACHE), CACHE_TIMEOUT_MS, undefined);

const replaceShell = async (cache, response) => {
  const previousIndex = await requiredOperation(cache.match('/index.html'), CACHE_TIMEOUT_MS);
  const previousRoot = await requiredOperation(cache.match('/'), CACHE_TIMEOUT_MS);
  try {
    await requiredOperation(Promise.all([cache.put('/index.html', response.clone()), cache.put('/', response.clone())]), CACHE_TIMEOUT_MS);
  } catch (error) {
    await bounded(Promise.all([
      previousIndex ? cache.put('/index.html', previousIndex.clone()) : cache.delete('/index.html'),
      previousRoot ? cache.put('/', previousRoot.clone()) : cache.delete('/'),
    ]), CACHE_TIMEOUT_MS, undefined);
    throw error;
  }
};

async function refreshCompleteShell(navigationResponse, requestedPath) {
  const html = await requiredOperation(navigationResponse.clone().text(), INSTALL_TIMEOUT_MS);
  if (!validShellHtml(navigationResponse, html, requestedPath)) throw new Error('The current app shell is not safe to cache.');
  const assets = extractAssets(html);
  const cache = await requiredOperation(caches.open(CACHE), CACHE_TIMEOUT_MS);
  const staticResponses = await Promise.all(SHELL_FILES.filter((path) => path !== '/' && path !== '/index.html' && !path.startsWith('/assets/')).map(async (path) => ({ path, response: await requiredFetch(new Request(path, { cache: 'no-store' }), INSTALL_TIMEOUT_MS) })));
  for (const { path, response } of staticResponses) {
    const expectedType = path.endsWith('.webmanifest') ? response.headers.get('content-type')?.toLowerCase().includes('json') : path.endsWith('.svg') ? response.headers.get('content-type')?.toLowerCase().includes('svg') : response.headers.get('content-type')?.toLowerCase().includes('png');
    if (!sameOriginFinal(response, path) || !expectedType || !cacheControlAllowsStorage(response)) throw new Error(`Unsafe shell asset: ${path}`);
  }
  const assetResponses = await Promise.all(assets.map(async (path) => ({ path, response: await requiredFetch(new Request(path, { cache: 'no-store' }), INSTALL_TIMEOUT_MS) })));
  for (const { path, response } of assetResponses) if (!sameOriginFinal(response, path) || !assetType(path, response) || !cacheControlAllowsStorage(response)) throw new Error(`Unsafe app asset: ${path}`);

  // Populate every current dependency before replacing either shell entry. If
  // any fetch or validation fails, the old index/root pair remains untouched.
  for (const { path, response } of [...staticResponses, ...assetResponses]) await requiredOperation(cache.put(path, response.clone()), CACHE_TIMEOUT_MS);
  await trimAssets(cache, true);
  // Keep the shell swap last: a failed dependency write or maintenance pass
  // therefore cannot expose a partially updated navigation response.
  await replaceShell(cache, navigationResponse);
}

async function installCompleteShell() {
  // ASSETS can canonicalize /index.html to /. Fetch the canonical navigation
  // URL so a strict redirect check cannot strand a newly installed worker.
  const shellResponse = await requiredFetch(new Request('/', { cache: 'no-store' }), INSTALL_TIMEOUT_MS);
  const html = await requiredOperation(shellResponse.clone().text(), INSTALL_TIMEOUT_MS);
  if (!validShellHtml(shellResponse, html, '/')) throw new Error('The current app shell is not safe to cache.');
  await refreshCompleteShell(shellResponse, '/');
}

self.addEventListener('install', (event) => event.waitUntil(installCompleteShell().then(() => {
  // The first worker takes control immediately. Updates stay waiting until
  // the page explicitly applies them, so an active form is never interrupted.
  if (!self.registration?.active) return self.skipWaiting();
  return undefined;
})));
self.addEventListener('activate', (event) => event.waitUntil(
  requiredOperation(caches.keys(), CACHE_TIMEOUT_MS).then((keys) => requiredOperation(Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))), CACHE_TIMEOUT_MS)).then(() => requiredOperation(self.clients.claim(), CACHE_TIMEOUT_MS))
));

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'SKIP_WAITING' && event.data?.type !== 'CLEAR_NOTIFICATION_BADGE') return;
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil?.(self.skipWaiting());
  if (event.data?.type === 'CLEAR_NOTIFICATION_BADGE') event.waitUntil?.(changeNotificationBadge(true));
});

self.addEventListener('push', (event) => {
  const payload = parseNotificationPayload(event);
  if (!payload) return;
  event.waitUntil((async () => {
    if (!(await notificationIdentityAllows(payload.data.recipientUserId))) return;
    if (typeof self.registration?.showNotification !== 'function') return;
    await self.registration.showNotification(payload.title, { body: payload.body, tag: payload.tag, data: payload.data, renotify: false });
    const badgeCount = await changeNotificationBadge(false);
    const clients = await self.clients?.matchAll?.({ type: 'window', includeUncontrolled: true }) || [];
    for (const client of clients) { try { client.postMessage?.({ type: 'BILLSPLIT_NOTIFICATION_RECEIVED', count: badgeCount }); } catch { /* Optional client hint. */ } }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification?.close?.();
  const route = notificationRoute(event.notification?.data?.route);
  event.waitUntil((async () => {
    const recipientUserId = event.notification?.data?.recipientUserId;
    if (typeof recipientUserId !== 'string' || !(await notificationIdentityAllows(recipientUserId))) return;
    const windows = await self.clients?.matchAll?.({ type: 'window', includeUncontrolled: true }) || [];
    const existing = windows.find((client) => { try { return new URL(client.url).origin === self.location.origin; } catch { return false; } });
    if (existing) {
      try { await existing.focus?.(); } catch { /* Continue with navigation. */ }
      try { await existing.navigate?.(route); } catch { /* The current route remains safe. */ }
      return;
    }
    try { await self.clients?.openWindow?.(route); } catch { /* The browser may block a new window. */ }
  })());
});

// Push providers can rotate a subscription while the app is asleep. The
// foreground owns authenticated reconciliation; this event only wakes a
// client with a best-effort hint and never stores or sends a token itself.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil?.((async () => {
    const clients = await self.clients?.matchAll?.({ type: 'window', includeUncontrolled: true }) || [];
    for (const client of clients) {
      try { client.postMessage?.({ type: 'PUSH_SUBSCRIPTION_CHANGED' }); } catch { /* Optional client hint. */ }
    }
  })());
});

// Background Sync is deliberately a notification to the foreground, not a
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
  event.respondWith(boundedCacheMatch(event.request).then(async (cached) => {
    if (cached) return cached;
    const response = await boundedFetch(event.request, ASSET_TIMEOUT_MS);
    if (!response) return boundedCacheMatch(event.request).then((fallback) => fallback || Response.error());
    if (sameOriginFinal(response, url.pathname) && cacheControlAllowsStorage(response) && assetType(url.pathname, response)) {
      const persist = (async () => { const cache = await requiredOperation(caches.open(CACHE), CACHE_TIMEOUT_MS); await requiredOperation(cache.put(event.request, response.clone()), CACHE_TIMEOUT_MS); await trimAssets(cache, true); })();
      event.waitUntil(bounded(persist, BACKGROUND_TIMEOUT_MS, undefined).catch(() => undefined));
    }
    return response;
  }));
});
