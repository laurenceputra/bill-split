const CACHE = 'bill-split-shell-v6';
const SHELL_FILES = ['/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];
const MAX_ASSETS = 80;
const assetPattern = /^\/assets\/[a-zA-Z0-9._-]+\.(?:js|css|svg|png|webp|woff2?)$/;
const isAccessPath = (pathname) => pathname.startsWith('/api') || pathname.startsWith('/cdn-cgi/') || pathname.startsWith('/access');
const isAllowedAsset = (url) => url.origin === self.location.origin && !isAccessPath(url.pathname) && (SHELL_FILES.includes(url.pathname) || assetPattern.test(url.pathname));
const cacheControlAllowsStorage = (response) => !/(?:^|,)\s*(?:private|no-store)(?:\s*(?:,|$)|=)/i.test(response.headers.get('cache-control') || '');
const sameOriginFinal = (response, expectedPath) => response.ok && !response.redirected && (() => { try { const url = new URL(response.url); return url.origin === self.location.origin && (!expectedPath || url.pathname === expectedPath) && !isAccessPath(url.pathname); } catch { return false; } })();
const htmlType = (response) => response.headers.get('content-type')?.toLowerCase().includes('text/html');
const assetType = (path, response) => { const type = response.headers.get('content-type')?.toLowerCase() || ''; if (path.endsWith('.js')) return type.includes('javascript') || type.includes('ecmascript'); if (path.endsWith('.css')) return type.includes('text/css'); if (path.endsWith('.svg')) return type.includes('svg'); if (path.endsWith('.png')) return type.includes('png'); if (path.endsWith('.webp')) return type.includes('webp'); return type.includes('font'); };
const extractAssets = (html) => [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)].map((match) => match[1]).map((value) => { try { return new URL(value, self.location.origin); } catch { return undefined; } }).filter((url) => url && url.origin === self.location.origin && assetPattern.test(url.pathname)).map((url) => url.pathname).filter((path, index, all) => all.indexOf(path) === index);
const validShellHtml = (response, html, requestedPath = '/index.html') => {
  try {
    const url = new URL(response.url);
    return response.ok && !response.redirected && url.origin === self.location.origin && !isAccessPath(url.pathname) && [requestedPath, '/', '/index.html'].includes(url.pathname) && htmlType(response) && cacheControlAllowsStorage(response) && /id=["']root["']/.test(html) && extractAssets(html).length > 0;
  } catch { return false; }
};
const trimAssets = async (cache) => { const requests = await cache.keys(); const removable = requests.filter((request) => !SHELL_FILES.includes(new URL(request.url).pathname) && new URL(request.url).pathname !== '/'); if (removable.length > MAX_ASSETS) await Promise.all(removable.slice(0, removable.length - MAX_ASSETS).map((request) => cache.delete(request))); };

const replaceShell = async (cache, response) => {
  const previousIndex = await cache.match('/index.html');
  const previousRoot = await cache.match('/');
  try {
    await Promise.all([cache.put('/index.html', response.clone()), cache.put('/', response.clone())]);
  } catch (error) {
    await Promise.all([
      previousIndex ? cache.put('/index.html', previousIndex.clone()) : cache.delete('/index.html'),
      previousRoot ? cache.put('/', previousRoot.clone()) : cache.delete('/'),
    ]);
    throw error;
  }
};

async function refreshCompleteShell(navigationResponse, requestedPath) {
  const html = await navigationResponse.clone().text();
  if (!validShellHtml(navigationResponse, html, requestedPath)) throw new Error('The current app shell is not safe to cache.');
  const assets = extractAssets(html);
  const cache = await caches.open(CACHE);
  const staticResponses = await Promise.all(SHELL_FILES.slice(1).map(async (path) => ({ path, response: await fetch(new Request(path, { cache: 'no-store' })) })));
  for (const { path, response } of staticResponses) {
    const expectedType = path.endsWith('.webmanifest') ? response.headers.get('content-type')?.toLowerCase().includes('json') : path.endsWith('.svg') ? response.headers.get('content-type')?.toLowerCase().includes('svg') : response.headers.get('content-type')?.toLowerCase().includes('png');
    if (!sameOriginFinal(response, path) || !expectedType || !cacheControlAllowsStorage(response)) throw new Error(`Unsafe shell asset: ${path}`);
  }
  const assetResponses = await Promise.all(assets.map(async (path) => ({ path, response: await fetch(new Request(path, { cache: 'no-store' })) })));
  for (const { path, response } of assetResponses) if (!sameOriginFinal(response, path) || !assetType(path, response) || !cacheControlAllowsStorage(response)) throw new Error(`Unsafe app asset: ${path}`);

  // Populate every current dependency before replacing either shell entry. If
  // any fetch or validation fails, the old index/root pair remains untouched.
  for (const { path, response } of [...staticResponses, ...assetResponses]) await cache.put(path, response.clone());
  await replaceShell(cache, navigationResponse);
  await trimAssets(cache);
}

async function installCompleteShell() {
  const indexResponse = await fetch(new Request('/index.html', { cache: 'no-store' }));
  const html = await indexResponse.clone().text();
  if (!validShellHtml(indexResponse, html)) throw new Error('The current app shell is not safe to cache.');
  await refreshCompleteShell(indexResponse, '/index.html');
}

self.addEventListener('install', (event) => event.waitUntil(installCompleteShell().then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())
));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || isAccessPath(url.pathname)) return;
  if (event.request.mode === 'navigate') {
    const networkResponse = fetch(event.request);
    event.waitUntil(networkResponse.then((response) => refreshCompleteShell(response, url.pathname)).catch(() => undefined));
    event.respondWith(networkResponse.catch(() => caches.match(event.request).then((response) => response || caches.match('/index.html') || caches.match('/'))));
    return;
  }
  if (!isAllowedAsset(url)) return;
  event.respondWith(fetch(event.request).then(async (response) => {
    if (sameOriginFinal(response, url.pathname) && cacheControlAllowsStorage(response) && assetType(url.pathname, response)) { const cache = await caches.open(CACHE); await cache.put(event.request, response.clone()); await trimAssets(cache); }
    return response;
  }).catch(() => caches.match(event.request)));
});
