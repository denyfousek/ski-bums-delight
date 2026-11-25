// Service worker for Ski Bum's Delight: makes the app installable and keeps the app's own
// files for a start on a bad connection. Fully offline the map still cannot start: CesiumJS
// and all tiles come from other servers and are not stored here. It only handles the app's own files (same origin, GET):
//   network first, so an update is picked up on the next load,
//   cache as fallback, so the shell opens offline.
// Map tiles, the bulletin, stations and forecasts are other origins and are never touched;
// the local proxy (/proxy/) is left alone as well.
const CACHE = 'sbd-shell-v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon-192.png',
  'js/main.js', 'js/ui.js', 'js/config.js', 'js/areas.js', 'js/bulletin.js', 'js/forest.js',
  'js/gpx.js', 'js/proj.js', 'js/sentinel.js', 'js/shade.js', 'js/slope.js', 'js/snowline.js',
  'js/snowlook.js', 'js/stations.js', 'js/sun.js', 'js/weather.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/proxy/')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
