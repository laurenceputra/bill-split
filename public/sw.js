const CACHE = 'bill-split-shell-v2';
const STATIC = new Set(['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg']);
const isStatic = (url) => url.origin === self.location.origin &&
  (STATIC.has(url.pathname) || url.pathname.startsWith('/assets/'));
self.addEventListener('install', (event) => event.waitUntil(
  caches.open(CACHE).then((cache) => cache.addAll([...STATIC]))
));
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api') || !isStatic(url)) return;
  event.respondWith(fetch(event.request).then(async (response) => {
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(event.request, response.clone());
    }
    return response;
  }).catch(() => caches.match(event.request).then((response) => response || caches.match('/'))));
});
