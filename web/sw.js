"use strict";
importScripts("./sw_core.js");

const CACHE_NAME = "part-scout-shell-v11";
const DATA_CACHE = "part-scout-data-v1";
const DATA_PATHS = ["data/results.json", "data/setup_status.json"];
const SHELL = ["./", "./index.html", "./styles.css", "./persistence.js", "./shipping.js", "./app.js", "./shipping-calculator.html", "./shipping-calculator.js", "./part-parcel.js", "./part-lookup-ui.js", "./sw_core.js", "./manifest.webmanifest", "./icons/icon-512.png"];
const { stableCacheUrl, isDynamicDataUrl } = self.PartScoutSWCore;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(migrateLegacyData().then(() => self.clients.claim()));
});

function isLegacyCache(key) {
  return key.startsWith("part-scout-shell-") && key !== CACHE_NAME;
}

async function cachedTimestamp(response) {
  if (!response) return -1;
  try {
    const value = await response.clone().json();
    return Date.parse(value.generated_at || value.checked_at) || 0;
  } catch (_) { return 0; }
}

async function migrateLegacyData() {
  try {
    const keys = (await caches.keys()).filter(isLegacyCache);
    const destination = await caches.open(DATA_CACHE);
    for (const key of keys) {
      try {
        const source = await caches.open(key);
        for (const path of DATA_PATHS) {
          const url = new URL(path, self.registration.scope).href;
          const previous = await source.match(url);
          const current = await destination.match(url);
          if (previous && (!current || await cachedTimestamp(previous) > await cachedTimestamp(current))) {
            await destination.put(url, previous.clone());
          }
        }
        await caches.delete(key);
      } catch (_) { /* Keep the old data accessible if migration fails, including quota errors. */ }
    }
  } catch (_) { /* Never delete legacy caches when the destination is unavailable. */ }
}

async function savedData(url) {
  let latest;
  const keys = [DATA_CACHE, ...(await caches.keys()).filter(isLegacyCache)];
  for (const key of keys) {
    try {
      const cache = await caches.open(key);
      const candidate = await cache.match(url);
      if (candidate && (!latest || await cachedTimestamp(candidate) > await cachedTimestamp(latest))) latest = candidate;
    } catch (_) { /* Try the remaining saved copies. */ }
  }
  return latest;
}

async function dynamicResponse(request) {
  const url = stableCacheUrl(request.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(request, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("HTTP error");
    try {
      const cache = await caches.open(DATA_CACHE);
      await cache.put(url, response.clone());
    } catch (_) { /* A full cache must not discard a successful network response. */ }
    return response;
  } catch (_) {
    try {
      const cached = await savedData(url);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("X-Part-Scout-Offline", "1");
        return new Response(cached.body, { status: cached.status, headers });
      }
    } catch (_) { /* The app also holds the last valid result locally. */ }
    return new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
  } finally { clearTimeout(timeout); }
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  if (isDynamicDataUrl(url.href)) {
    event.respondWith(dynamicResponse(event.request));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try { return await fetch(event.request); }
    catch (_) {
      if (event.request.mode === "navigate") {
        const shell = await cache.match(new URL("index.html", self.registration.scope).href);
        if (shell) return shell;
      }
      return new Response("Offline", { status: 503 });
    }
  })());
});
