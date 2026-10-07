'use strict';
const PREFIX = 'quietchat-iphone:' + new URL('./', self.location.href).pathname + ':';
const CACHE = PREFIX + '1.0.0';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './crypto-core.js', './crypto-worker.js',
  './vendor/libsodium-sumo.js', './vendor/libsodium-wrappers.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('message', event => { if (event.data?.type === 'ACTIVATE') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  const base = new URL('./', self.location.href);
  const requestURL = new URL(event.request.url);
  if (!requestURL.pathname.startsWith(base.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const matched = await cache.match(event.request, {ignoreSearch: true});
    if (matched) return matched;
    if (event.request.mode === 'navigate') return cache.match('./index.html');
    return fetch(event.request);
  }));
});
