"use strict";

const assert = require("node:assert/strict");
const { stableCacheUrl, isDynamicDataUrl } = require("../web/sw_core.js");

const base = "https://example.github.io/ebay-parts-bot/";
const results = `${base}data/results.json?t=1723942800123`;
const setup = `${base}data/setup_status.json?t=1723942800456`;

assert.equal(stableCacheUrl(results), `${base}data/results.json`);
assert.equal(stableCacheUrl(setup), `${base}data/setup_status.json`);
assert.equal(isDynamicDataUrl(results), true);
assert.equal(isDynamicDataUrl(setup), true);
assert.equal(isDynamicDataUrl(`${base}app.js?t=1`), false);

console.log("service-worker core tests passed");
