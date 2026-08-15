"use strict";

const CACHE_NAME = "part-scout-shell-v6";
const RESULTS_CACHE_URL = new URL("./data/results.json", self.location.href).href;
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app-01.js",
  "./app-02.js",
  "./app-03.js",
  "./manifest.webmanifest",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.pathname.endsWith("/data/results.json")) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(RESULTS_CACHE_URL, response.clone());
          }
          return response;
        })
        .catch(() => caches.match(RESULTS_CACHE_URL))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    }))
  );
});
