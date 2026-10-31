/* Service Worker: App offline verfügbar machen, Kartenkacheln zwischenspeichern,
 * geteilte Texte/Chat-Exporte (Web Share Target) entgegennehmen. */
const VERSION = 'sr-v7';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'core.js', 'data.js', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('sr-v') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(tile(e.request));
  } else if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(e.request));
  }
});

// App-Dateien: frisch vom Server, bei schlechtem Netz aus dem Cache
function networkFirst(req) {
  return caches.open(VERSION).then(cache => {
    const net = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise(resolve => setTimeout(resolve, 3000));
    return Promise.race([net, timeout.then(() => cache.match(req, { ignoreSearch: true }))])
      .then(res => res || net)
      .catch(() => cache.match(req, { ignoreSearch: true }));
  });
}

// Kartenkacheln: Cache zuerst, sonst laden und merken
function tile(req) {
  return caches.open('sr-tiles').then(cache => cache.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  })));
}

async function receiveShare(req) {
  const form = await req.formData();
  const cache = await caches.open('share');
  // Dateien unverändert ablegen (TXT oder ZIP); die App packt sie aus.
  const files = form.getAll('file').filter(f => f && typeof f.arrayBuffer === 'function');
  for (let i = 0; i < files.length; i++) await cache.put('shared-file-' + i, new Response(files[i]));
  const text = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join('\n');
  await cache.put('shared', new Response(JSON.stringify({ text, files: files.length }), { headers: { 'Content-Type': 'application/json' } }));
  return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
}
