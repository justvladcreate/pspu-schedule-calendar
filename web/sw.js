'use strict';

const CACHE = 'pspu-schedule-v9';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/base.css',
  './css/toolbar.css',
  './css/filter.css',
  './css/calendar.css',
  './css/popover.css',
  './css/modals.css',
  './css/mobile.css',
  './css/export-toast.css',
  './css/changes.css',
  './js/main.js',
  './js/state.js',
  './js/config.js',
  './js/utils.js',
  './js/data.js',
  './js/render.js',
  './js/layout.js',
  './js/navigation.js',
  './js/datepicker.js',
  './js/filters.js',
  './js/popover.js',
  './js/gestures.js',
  './js/export.js',
  './js/version.js',
  './js/online.js',
  './js/readme.js',
  './js/markdown.js',
  './js/toast.js',
  './js/changes.js',
  './js/changes-modal.js',
  './js/update-banner.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const SW_LOCATION = self.location.href;
const INDEX_URL   = new URL('./index.html', SW_LOCATION).href;
const ROOT_URL    = new URL('./',           SW_LOCATION).href;

/* ---------- install ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    // Сначала — самое важное: HTML-фоллбэк.
    // Отдельно, с прямым try/catch, чтобы видеть в логах, если падает.
    try {
      await cache.add(ROOT_URL);
    } catch (e) {
      console.warn('[SW] Не удалось закэшировать /:', e);
    }
    try {
      await cache.add(INDEX_URL);
    } catch (e) {
      console.warn('[SW] Не удалось закэшировать index.html:', e);
    }

    // Остальное — параллельно, падение не роняет install.
    const rest = STATIC_ASSETS.filter(
      (u) => u !== './' && u !== './index.html'
    );
    const results = await Promise.all(
      rest.map(async (url) => {
        try {
          await cache.add(url);
          return { url, ok: true };
        } catch (err) {
          return { url, ok: false, err: String(err) };
        }
      })
    );

    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      console.warn(
        `[SW] Не закэшировано ${failed.length} из ${rest.length}:`,
        failed.map((f) => f.url)
      );
    }
  })());

  self.skipWaiting();
});

/* ---------- activate ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
    console.info('[SW] activate: кэш', CACHE, 'готов');
  })());
});

/* ---------- fetch ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/data.json') ||
      url.pathname.endsWith('/old_data.json')) {
    event.respondWith(networkFirstJson(req, url.pathname));
    return;
  }

  event.respondWith(cacheFirst(req));
});

async function networkFirstJson(request, cacheKey) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(cacheKey, response.clone());
    return response;
  } catch (e) {
    const cached =
      (await cache.match(cacheKey)) ||
      (await cache.match(cacheKey, { ignoreSearch: true }));
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  let cached = await caches.match(request);
  if (cached) return cached;

  cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    if (request.mode === 'navigate') {
      const fallback =
        (await caches.match(INDEX_URL)) ||
        (await caches.match(ROOT_URL)) ||
        (await caches.match(INDEX_URL, { ignoreSearch: true })) ||
        (await caches.match(ROOT_URL,  { ignoreSearch: true }));
      if (fallback) return fallback;
    }
    throw e;
  }
}