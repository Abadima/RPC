// The page has no dynamic data, so the static shell is cached once for
// offline use. Paths are relative to this worker so they hold under any
// site base (the Pages deploy serves from /RPC/).
const CACHE_NAME = "parousia-pwa-shell-v3";
const SHELL_FILES = [
  "./",
  "./pwa.css",
  "./manifest.webmanifest",
  "./fonts/poppins-400.woff2",
  "./fonts/poppins-600.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
});
