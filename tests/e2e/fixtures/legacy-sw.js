// Minimal old-worker lifecycle from 53bda1d, deliberately NOT the modern
// worker: navigation shell cache, explicit uncoordinated SKIP_WAITING, claim.
const CACHE = 'bill-split-shell-historical-fixture';
self.addEventListener('install', (event) => event.waitUntil((async () => {
  const response = await fetch('/', { cache: 'no-store' });
  const html = await response.clone().text();
  const cache = await caches.open(CACHE);
  const assets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((match) => match[1]);
  await cache.addAll(assets);
  await cache.put('/', response.clone());
  await cache.put('/index.html', response);
  if (!self.registration.active) await self.skipWaiting();
})()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') event.respondWith(caches.open(CACHE).then(async (cache) => await cache.match('/') || fetch(event.request)));
});
