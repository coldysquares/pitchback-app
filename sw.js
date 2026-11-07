// Offline support: network first with a 3 second timeout, cache as fallback.
// New deploys show up on the next load; everything opened before works with no signal.
const CACHE = 'pitchback-offline-v1';
const SHELL = ['./', './index.html', './script.js', './manifest.webmanifest', './assets/icon-180.png','./assets/icon-192.png','./assets/icon-512.png','./assets/surfwave-mark.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE && x.startsWith('pitchback-offline')).map(x => caches.delete(x)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin || new URL(req.url).pathname.startsWith('/api/')) return;
  const net = fetch(req).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); return caches.open(CACHE).then(c => c.put(req, copy)).then(() => res, () => res); }
    return res;
  });
  e.waitUntil(net.catch(() => {}));
  e.respondWith((async () => {
    const first = await Promise.race([net.catch(() => null), new Promise(r => setTimeout(r, 3000, null))]);
    if (first) return first;
    const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' }) || (req.mode === 'navigate' ? await caches.match('./') || await caches.match('./index.html') : null);
    if (hit) return hit;
    try { return await net; } catch (err) { return Response.error(); }
  })());
});
