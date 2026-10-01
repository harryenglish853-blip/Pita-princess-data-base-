/*
 * Service worker: makes the site installable and lets an already-opened
 * inventory count page reload without Wi-Fi (walk-ins and freezers).
 *  - Static build assets: cache-first (they are content-hashed).
 *  - Count pages (/counts/<id>): network-first, falling back to the last copy.
 *  - Everything else: network only, with an offline notice for page loads.
 * Nothing private is cached except count pages, and the cache is wiped at sign-in/out.
 */
const STATIC = 'pp-static-v1';
const PAGES = 'pp-count-pages-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(['/offline'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => ![STATIC, PAGES].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear-private-cache') event.waitUntil(caches.delete(PAGES));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(STATIC).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  if (req.mode === 'navigate') {
    const isCount = /^\/counts\/[0-9a-f-]{36}$/.test(url.pathname);
    event.respondWith(fetch(req).then((res) => {
      if (isCount && res.ok && !res.redirected) { const copy = res.clone(); caches.open(PAGES).then((c) => c.put(url.pathname, copy)); }
      return res;
    }).catch(async () => (isCount && (await caches.match(url.pathname))) || (await caches.match('/offline')) || Response.error()));
  }
});
