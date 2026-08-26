// Service Worker — offline support for מעקב משמרות
const CACHE = 'mishmarot-v3';

// Everything needed to boot the app with no network
// preact/hooks/htm are inlined in index.html now, so nothing to fetch for them
const PRECACHE = [
  './',
  './index.html',
  './icon.jpg',
  'https://cdn.tailwindcss.com'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll fails atomically if any request fails; cache each one independently instead
      .then(c => Promise.all(PRECACHE.map(u =>
        // cache:'reload' skips the HTTP cache so a stale copy is never re-precached
        fetch(u, { mode: 'no-cors', cache: 'reload' }).then(r => c.put(u, r)).catch(() => {})
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

// ── Web Push: show the notification the server sent ──────────
self.addEventListener('push', e => {
  let d = { title: 'מעקב משמרות', body: '' };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (_) {
    try { d.body = e.data.text(); } catch (_) {}
  }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: './icon.jpg',
    badge: './icon.jpg',
    tag: d.tag || 'mishmarot',
    data: { url: d.url || './' }
  }));
});

// Tapping the notification focuses the app if it's open, otherwise opens it
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(target);
    })
  );
});

// A page that boots faster than the background check would miss the pushed
// notice, so the flag is kept and the page can ask for it once it is listening.
let updatePending = false;
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'query-update' && updatePending && e.source) {
    e.source.postMessage({ type: 'update-ready' });
  }
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache Google API/auth traffic — it must be live, and failing offline is expected
  if (/googleapis\.com|accounts\.google\.com|gstatic\.com/.test(url.hostname)) return;

  // Navigations: serve the cached shell immediately so the app opens at once,
  // then check the network in the background. Network-first meant every single
  // open waited on a full download of index.html before painting anything.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match('./index.html');
      // Read the old copy before handing it to the page - a body can only be read once
      const oldText = cached ? await cached.clone().text() : null;

      const fromNetwork = fetch(req).then(async r => {
        // Only trust a good response; a Pages deploy can briefly serve errors,
        // and caching one would strand every client on it
        if (!r || !r.ok) return r;
        // Read the body exactly once and rebuild from the text. Cloning a
        // response and leaving a branch unread stalls the others once the tee
        // buffer fills, which silently blocked the cache write.
        const freshText = await r.text();
        const mk = () => new Response(freshText, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
        await cache.put('./index.html', mk());
        if (oldText !== null && oldText !== freshText) {
          updatePending = true;
          const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          for (const c of list) c.postMessage({ type: 'update-ready' });
        } else {
          // Served copy already matches the network - clear the flag, or the
          // next page would be told about an update it is already running
          updatePending = false;
        }
        return mk();
      }).catch(() => null);

      if (cached) {
        e.waitUntil(fromNetwork);   // keep the worker alive for the background check
        return cached;
      }
      // Nothing cached yet (first ever visit) - the network is all we have
      return (await fromNetwork) || (await cache.match('./')) || Response.error();
    })());
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
