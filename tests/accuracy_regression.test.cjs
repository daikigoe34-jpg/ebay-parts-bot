"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const app = require("../web/app.js");
const { state, DEFAULT_SETTINGS, calculateProfit, normalizeProduct } = app;
let product;
beforeEach(() => {
  state.settings = { ...DEFAULT_SETTINGS, includePayoneerAnnualFee: false, feesConfirmed: true };
  state.apiPayload = { generated_at: new Date().toISOString(), cost_defaults: { exchange_rate: {
    rate: 150, source: "ECB reference rate", date: new Date().toISOString().slice(0, 10), fallback: false,
  } } };
  state.setupStatus = { ready: true };
  product = normalizeProduct({ part_number: "25550-5SA0A", price_median_usd: 120,
    sales_auto_verified: true, sales_confidence: "high", sales_observed_days: 35,
    sold_90d_decision: 7, competition_known: true, market_score: 80, demand_ratio: .7,
    country_of_origin: "JP", auto_costs: { procurement_jpy: 3500, domestic_shipping_jpy: 0,
      international_shipping_jpy: 2200, packaging_jpy: 150, tariff_rate: .15 } });
  state.costs = { [product.part_number]: { supplierConfirmed: true, tariffConfirmed: true,
    supplierConfirmedAt: new Date().toISOString(), tariffConfirmedAt: new Date().toISOString(),
    htsus: "8708998180", dutyQuoteJpy: 2700, tariffSalePriceUsd: 120, tariffPolicyReview: "2026-09-08" } };
});

test("hand-calculated sale excludes buyer tax from revenue and includes it in eBay fee base", () => {
  const result = calculateProfit(product);
  assert.ok(Math.abs(result.ebayFee - 3233.307) < .00001);
  assert.ok(Math.abs(result.payoneerFee - 443.00079) < .00001);
  assert.ok(Math.abs(result.profit - 5233.69221) < .00001);
  assert.equal(result.passes, true);
});
test("blank, negative and non-finite costs cannot create a purchase candidate", () => {
  for (const value of ["", "-", -5000, Infinity, "NaN"]) {
    state.costs[product.part_number].packagingJpy = value;
    assert.equal(calculateProfit(product).passes, false, String(value));
  }
});
test("fallback or old exchange rate cannot authorize a purchase", () => {
  state.apiPayload.cost_defaults.exchange_rate.fallback = true;
  assert.equal(calculateProfit(product).passes, false);
  state.apiPayload.cost_defaults.exchange_rate.fallback = false;
  state.apiPayload.cost_defaults.exchange_rate.date = "2020-01-01";
  assert.equal(calculateProfit(product).passes, false);
});
test("confirmation flags alone cannot bypass missing customs evidence", () => {
  state.costs[product.part_number].htsus = "";
  assert.equal(calculateProfit(product).passes, false);
});
test("unconfirmed account fees and expired quotes block purchase", () => {
  state.settings.feesConfirmed = false;
  assert.equal(calculateProfit(product).passes, false);
  state.settings.feesConfirmed = true;
  state.costs[product.part_number].supplierConfirmedAt = "2020-01-01";
  assert.equal(calculateProfit(product).passes, false);
});
test("an explicit duty quote replaces rather than adds to estimated duty", () => {
  state.costs[product.part_number].dutyQuoteJpy = 1000;
  assert.equal(calculateProfit(product).tariff, 1000);
});
test("international fee discount is not assumed from sales volume alone", () => {
  state.settings.monthlySalesUsd = 100000;
  state.settings.internationalDiscountConfirmed = false;
  assert.equal(calculateProfit(product).internationalRate, 1.35);
});
test("zero costs remain visibly zero and active decimal input is not overwritten", () => {
  const zero = { type: "number", dataset: { cost: "packagingJpy" }, value: "123" };
  app.applyCostValuesToControls([zero], { packagingJpy: 0 });
  assert.equal(String(zero.value), "0");
  const focused = { type: "number", dataset: { cost: "salePriceUsd" }, value: "12." };
  app.applyCostValuesToControls([focused], { salePriceUsd: 12 }, focused);
  assert.equal(focused.value, "12.");
});

test("malformed results are rejected without crashing the saved-data recovery path", () => {
  for (const products of [null, {}, "broken", [null]]) {
    assert.equal(app.usablePayload({ generated_at: new Date().toISOString(), products }), false);
  }
});

test("changing a confirmed cost invalidates its confirmation", () => {
  app.updateCostValue(product, "procurementJpy", "4000");
  assert.equal(state.costs[product.part_number].supplierConfirmed, false);
  app.updateCostValue(product, "dutyQuoteJpy", "900");
  assert.equal(state.costs[product.part_number].tariffConfirmed, false);
});

test("confirmation never turns the current selling median into a permanent override", () => {
  app.updateCostValue(product, "supplierConfirmed", true);
  app.updateCostValue(product, "tariffConfirmed", true);
  product.price_median_usd = 60;
  const result = calculateProfit(product);
  assert.equal(result.salePriceUsd, 60);
  assert.equal(result.passes, false);
  assert.equal(result.values.tariffConfirmed, false);
});

test("expired quotes appear unchecked so the user can reconfirm in one tap", () => {
  state.costs[product.part_number].supplierConfirmedAt = "2020-01-01";
  assert.equal(app.getCostValues(product).supplierConfirmed, false);
});

test("quotes confirmed under an earlier tariff policy require a fresh check", () => {
  state.costs[product.part_number].tariffPolicyReview = "2026-02-01";
  const result = calculateProfit(product);
  assert.equal(result.values.tariffConfirmed, false);
  assert.equal(result.passes, false);
  assert.ok(result.confirmationFailed.includes("原産国・関税"));
});
