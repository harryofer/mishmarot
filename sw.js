// Service Worker — offline support for מעקב משמרות
const CACHE = 'mishmarot-v1';

// Everything needed to boot the app with no network
const PRECACHE = [
  './',
  './index.html',
  './icon.jpg',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/preact@10/dist/preact.umd.js',
  'https://unpkg.com/preact@10/hooks/dist/hooks.umd.js',
  'https://unpkg.com/htm/dist/htm.umd.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll fails atomically if any request fails; cache each one independently instead
      .then(c => Promise.all(PRECACHE.map(u =>
        fetch(u, { mode: 'no-cors' }).then(r => c.put(u, r)).catch(() => {})
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache Google API/auth traffic — it must be live, and failing offline is expected
  if (/googleapis\.com|accounts\.google\.com|gstatic\.com/.test(url.hostname)) return;

  // Navigations: network-first so updates land, falling back to the cached shell offline
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
          return r;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Assets: cache-first, and refresh the cache in the background when online
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(r => {
        if (r && (r.ok || r.type === 'opaque')) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
