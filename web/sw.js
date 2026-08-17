"use strict";

importScripts("./sw_core.js");

const CACHE_NAME = "part-scout-shell-v8";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./sw_core.js",
  "./manifest.webmanifest",
  "./icons/icon-512.png",
];

const { stableCacheUrl, isDynamicDataUrl } = self.PartScoutSWCore;

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

  if (isDynamicDataUrl(event.request.url)) {
    const stableUrl = stableCacheUrl(event.request.url);
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(stableUrl, response.clone());
          }
          return response;
        })
        .catch(() => caches.match(stableUrl))
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
