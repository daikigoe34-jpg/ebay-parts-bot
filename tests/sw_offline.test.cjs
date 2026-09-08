"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function worker(fetcher, failPut = false) {
  const handlers = {}, deleted = [];
  const cached = new Response('{"products":[]}', { headers: { "Content-Type": "application/json" } });
  const cache = { put: async () => { if (failPut) throw new Error("full"); }, addAll: async () => {}, match: async () => cached.clone() };
  const context = vm.createContext({ URL, Response, Headers, AbortController, setTimeout, clearTimeout,
    importScripts: () => {}, fetch: fetcher,
    caches: { open: async () => cache, match: async () => cached.clone(),
      keys: async () => ["part-scout-shell-v9", "part-scout-data-v1", "another-app"],
      delete: async key => { deleted.push(key); return true; } },
    self: { PartScoutSWCore: require("../web/sw_core.js"),
      location: { origin: "https://example.github.io" },
      registration: { scope: "https://example.github.io/ebay-parts-bot/" },
      addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } },
  });
  vm.runInContext(fs.readFileSync(require.resolve("../web/sw.js"), "utf8"), context);
  async function request() {
    let response;
    handlers.fetch({ request: { method: "GET", url: "https://example.github.io/ebay-parts-bot/data/results.json?t=1" },
      respondWith: promise => { response = promise; } });
    return response;
  }
  return { handlers, request, deleted };
}

test("updating the app preserves saved data and other applications' caches", async () => {
  const sw = worker(async () => new Response("{}"));
  let done;
  sw.handlers.activate({ waitUntil: promise => { done = promise; } });
  await done;
  assert.deepEqual(sw.deleted, ["part-scout-shell-v9"]);
});
test("HTTP errors and disconnection return marked last-known data", async () => {
  for (const fetcher of [async () => new Response("error", { status: 503 }), async () => { throw new Error("offline"); }]) {
    const response = await worker(fetcher).request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Part-Scout-Offline"), "1");
    assert.deepEqual(await response.json(), { products: [] });
  }
});
test("failure to cache never discards a successful network response", async () => {
  const response = await worker(async () => new Response('{"fresh":true}'), true).request();
  assert.deepEqual(await response.json(), { fresh: true });
});

test("upgrading v9 migrates its last research data before deleting the combined cache", async () => {
  for (const scenario of ["normal", "quota", "newer"]) {
  const handlers = {}, buckets = new Map();
  const scope = "https://example.github.io/ebay-parts-bot/";
  const open = async name => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    const rows = buckets.get(name);
    return { match: async key => rows.get(String(key))?.clone(), put: async (key, val) => {
      if (scenario === "quota" && name === "part-scout-data-v1") throw new Error("quota exceeded");
      rows.set(String(key), val.clone());
    } };
  };
  const old = await open("part-scout-shell-v9");
  await old.put(scope + "data/results.json", new Response('{"generated_at":"2026-09-08T00:00:00Z","products":[]}'));
  if (scenario === "newer") {
    const current = await open("part-scout-data-v1");
    await current.put(scope + "data/results.json", new Response('{"generated_at":"2026-09-09T00:00:00Z","products":[]}'));
  }
  const context = vm.createContext({ URL, Response, Headers, AbortController, setTimeout, clearTimeout,
    importScripts() {}, fetch: async () => { throw new Error("offline"); },
    caches: { open, keys: async () => [...buckets.keys()], delete: async key => buckets.delete(key) },
    self: { PartScoutSWCore: require("../web/sw_core.js"), location: { origin: "https://example.github.io" },
      registration: { scope }, addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } } });
  vm.runInContext(fs.readFileSync(require.resolve("../web/sw.js"), "utf8"), context);
  let activation;
  handlers.activate({ waitUntil: promise => { activation = promise; } });
  await activation;
  let result;
  handlers.fetch({ request: { method: "GET", url: scope + "data/results.json?t=2" }, respondWith: promise => { result = promise; } });
  const response = await result;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).generated_at, scenario === "newer" ? "2026-09-09T00:00:00Z" : "2026-09-08T00:00:00Z");
  assert.equal(buckets.has("part-scout-shell-v9"), scenario === "quota");
  }
});
