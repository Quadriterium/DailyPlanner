const CACHE = 'a-table-shell-__VERSION__';
const FILES = __PRECACHE__;
const LEGAL_PAGES = ['/confidentialite', '/conditions-utilisation'];
let forcedActivation = false;

self.addEventListener('install', event => {
  // Installation is atomic; a failed refresh leaves the previous app available.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('a-table-shell-') && key !== CACHE).map(key => caches.delete(key)));
    if (forcedActivation) await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') {
    forcedActivation = true;
    event.waitUntil(self.skipWaiting());
  } else if (event.data?.type === 'REFRESH_SHELL' && event.ports[0]) {
    event.waitUntil((async () => {
      try {
        // Download everything before touching the working offline cache.
        const responses = await Promise.all(FILES.map(async file => {
          const response = await fetch(file, { cache: 'reload', signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(`Download failed: ${file} (${response.status})`);
          await response.clone().arrayBuffer();
          return response;
        }));
        const cache = await caches.open(CACHE);
        await Promise.all(FILES.map((file, index) => cache.put(file, responses[index])));
        event.ports[0].postMessage({ ok: true });
      } catch (error) {
        console.error('App shell refresh:', error);
        event.ports[0].postMessage({ ok: false });
      }
    })());
  }
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname.startsWith('/api/') || /^\/admin(?:\/|$)/.test(url.pathname)) return;
  if (request.mode === 'navigate' && LEGAL_PAGES.includes(url.pathname)) {
    // Legal pages are rendered by the server from the admin-managed details: network first, last copy offline.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(url.pathname, response.clone());
        return response;
      } catch (error) {
        return (await cache.match(url.pathname)) ?? Response.error();
      }
    })());
  } else if (request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match('/index.html')) ?? fetch(request),
    ));
  } else if (FILES.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match(url.pathname)) ?? fetch(request),
    ));
  }
});

// ---------- Web Push ----------

function samePath(value) {
  return typeof value === 'string' && /^\/(?!\/)/.test(value) ? value : '/';
}

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { data = { body: event.data?.text() ?? '' }; }
  const title = typeof data.title === 'string' && data.title ? data.title : 'À table !';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    lang: 'fr',
    data: { url: samePath(data.url) },
    ...(typeof data.tag === 'string' && data.tag ? { tag: data.tag, renotify: true } : {}),
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(samePath(event.notification.data?.url), self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).pathname === target.pathname) ??
      windows.find(client => new URL(client.url).origin === target.origin && target.pathname === '/');
    if (existing) {
      await existing.focus();
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

// The browser may rotate the subscription; tell the server so notifications keep arriving.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const oldEndpoint = event.oldSubscription?.endpoint;
    if (!oldEndpoint) return;
    let subscription = event.newSubscription;
    if (!subscription) {
      const info = await fetch('/api/push', { credentials: 'same-origin' }).then(response => response.json());
      if (!info.publicKey) return;
      const key = Uint8Array.from(atob(info.publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
      subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    await fetch('/api/push/renew', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldEndpoint, subscription: subscription.toJSON() }),
    });
  })().catch(error => console.error('Push subscription renewal:', error)));
});
