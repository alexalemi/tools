// Network first, cache as fallback: always fresh when online, still works offline.
const CACHE = 'txtpad-v2';
const FILES = ['./', 'style.css', 'fonts/lato-latin-400.woff2', 'fonts/lato-latin-700.woff2', 'fonts/merriweather-latin-var.woff2', 'fonts/merriweather-latin-300-italic.woff2', 'app.js', 'lib.js', '../turn.js', 'automerge.wasm', 'mathjax/tex-svg-full.js', 'mathjax/ui/safe.js'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request);
      if (res.ok) e.waitUntil(cache.put(e.request, res.clone()));
      return res;
    } catch (err) {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
