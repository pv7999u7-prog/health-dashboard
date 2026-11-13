// 只快取 App 外殼；健康資料不經過 service worker 快取
const VERSION = 'hc-v5';
const SHELL = ['./', 'index.html', 'style.css?v=4', 'info.js?v=3', 'app.js?v=5', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('hc-') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // 網路優先，離線才用快取
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone();
    caches.open(VERSION).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: false }).then(r => r || caches.match('index.html'))));
});
