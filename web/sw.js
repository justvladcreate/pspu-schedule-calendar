'use strict';

// Меняй версию, когда правишь статику, чтобы старый кэш сбросился.
const CACHE = 'pspu-schedule-v3';

// Статика, которую кэшируем сразу при установке.
// data.json и old_data.json сюда НЕ кладём — они меняются, кэшируются лениво.
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
  './js/readme.js',
  './js/markdown.js',
  './js/toast.js',
  './js/changes.js',
  './js/changes-modal.js',
  './js/update-banner.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  // Не ждём закрытия всех вкладок, чтобы новый SW активировался сразу.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // JSON — network-first: онлайн всегда свежий, офлайн — из кэша.
  // Ключ кэша — только pathname (без query string), иначе cache-bust
  // в виде ?t=... создаст бесконечные дубликаты.
  if (url.pathname.endsWith('/data.json') || url.pathname.endsWith('/old_data.json')) {
    event.respondWith(networkFirstJson(req, url.pathname));
    return;
  }

  // Всё остальное — cache-first: статика с версиями через ?v=...
  event.respondWith(cacheFirst(req));
});

async function networkFirstJson(request, cacheKey) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (e) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
  }
  return response;
}