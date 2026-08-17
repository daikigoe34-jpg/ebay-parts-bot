"use strict";

const assert = require("node:assert/strict");
const { isPayloadFresh, selectRenderableProducts } = require("../web/app.js");

const now = Date.parse("2026-08-18T00:00:00Z");
const setup = { ready: true };
const product = { title: "Nissan genuine switch", source: "ebay_production_browse_daily_delta" };

const fresh = {
  generated_at: "2026-08-17T12:00:00Z",
  automation: { production_api: { status: "ready" } },
  products: [product],
};
const stale = {
  generated_at: "2026-08-14T00:00:00Z",
  automation: { production_api: { status: "ready" } },
  products: [product],
};
const missingTimestamp = {
  automation: { production_api: { status: "ready" } },
  products: [product],
};

assert.equal(isPayloadFresh(fresh, now), true);
assert.equal(isPayloadFresh(stale, now), false);
assert.equal(isPayloadFresh(missingTimestamp, now), false);
assert.equal(selectRenderableProducts(setup, fresh, now).length, 1);
assert.deepEqual(selectRenderableProducts(setup, stale, now), []);
assert.deepEqual(selectRenderableProducts(setup, missingTimestamp, now), []);
assert.deepEqual(selectRenderableProducts({ ready: false }, fresh, now), []);

console.log("payload freshness tests passed");
