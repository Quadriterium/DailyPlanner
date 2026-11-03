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
  if (request.mode === 'navigate') {
    // Legal pages are standalone documents, not the application shell.
    const page = LEGAL_PAGES.includes(url.pathname) ? `${url.pathname}.html` : '/index.html';
    event.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match(page)) ?? fetch(request),
    ));
  } else if (FILES.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match(url.pathname)) ?? fetch(request),
    ));
  }
});
