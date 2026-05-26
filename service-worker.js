// Bump this when shipping changes so clients pick up the new shell.
const CACHE_VERSION = "v14";
const CACHE_NAME = `can-scan-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Don't fail install if a single optional asset 404s.
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn("SW precache miss:", url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache POSTs (sync calls)

  const url = new URL(req.url);

  // Never cache the Apps Script endpoint — must hit network so the sheet is live.
  if (url.hostname.endsWith("script.google.com")) return;

  // Cache-first for app shell + library, falling back to network and updating cache.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && (url.origin === self.location.origin || url.hostname === "unpkg.com")) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached); // offline + uncached — give up
    })
  );
});
