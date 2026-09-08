"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { estimateEconomy } = require("../web/shipping.js");
const app = require("../web/app.js");

const parcel = {
  weightKg: 0.5,
  lengthCm: 20,
  widthCm: 15,
  heightCm: 10,
  region: "US48",
  declaredValueUsd: 100,
};

function quote(overrides = {}) {
  return estimateEconomy({ ...parcel, ...overrides });
}

test("uses the verified US48 brackets for actual and volumetric weight", () => {
  assert.equal(quote().shippingJpy, 2060);
  assert.equal(quote({ lengthCm: 40, widthCm: 20, heightCm: 20 }).shippingJpy, 5245);
  assert.equal(quote({ weightKg: 0.5001 }).baseJpy, 2222);
  assert.equal(quote({ weightKg: 1.1 }).baseJpy, 3136);
});

test("charges the oversize fee once across edge and volume triggers", () => {
  assert.equal(quote({ weightKg: 0.5, lengthCm: 56, widthCm: 10, heightCm: 10 }).oversizeJpy, 2475);
  assert.equal(quote({ weightKg: 0.5, lengthCm: 56, widthCm: 32, heightCm: 32 }).oversizeJpy, 2475);
  assert.equal(quote({ weightKg: 0.5, lengthCm: 55.88, widthCm: 31.3, heightCm: 31.3 }).oversizeJpy, 0);
  assert.equal(quote({ weightKg: 0.5, lengthCm: 55, widthCm: 40, heightCm: 25 }).oversizeJpy, 0);
  assert.equal(quote({ weightKg: 0.5, lengthCm: 55, widthCm: 40, heightCm: 25.001 }).oversizeJpy, 2475);
});

test("accepts exact service boundaries and rejects values beyond them", () => {
  assert.equal(quote({ weightKg: 25, lengthCm: 50, widthCm: 20, heightCm: 20 }).ok, true);
  assert.equal(quote({ weightKg: 25.001 }).ok, false);
  assert.equal(quote({ lengthCm: 66, widthCm: 52, heightCm: 52 }).ok, true);
  assert.equal(quote({ lengthCm: 66.001 }).ok, false);
  assert.equal(quote({ lengthCm: 66, widthCm: 52.001, heightCm: 52 }).ok, false);
  assert.equal(quote({ declaredValueUsd: 1300 }).ok, true);
  assert.equal(quote({ declaredValueUsd: 1300.01 }).ok, false);
});

test("rejects missing, malformed, non-positive and unsupported inputs", () => {
  for (const weightKg of ["", null, false, "1e-1", "1kg", 0, -1, Infinity]) {
    assert.equal(quote({ weightKg }).ok, false, `weight ${String(weightKg)}`);
  }
  assert.equal(quote({ lengthCm: 67 }).ok, false);
  assert.equal(quote({ declaredValueUsd: 0 }).ok, false);
  assert.equal(quote({ region: "OTHER" }).ok, false);
  const invalid = quote({ widthCm: "" });
  assert.equal(invalid.shippingJpy, null);
  assert.equal(invalid.baseJpy, null);
  assert.ok(invalid.errors.length > 0);
});

test("rotating the same parcel produces identical results", () => {
  const first = quote({ lengthCm: 56, widthCm: 20, heightCm: 15 });
  const rotated = quote({ lengthCm: 15, widthCm: 56, heightCm: 20 });
  assert.deepEqual(rotated, first);
});

test("returns the documented separate fee fields and reference metadata", () => {
  const result = quote();
  assert.equal(result.shippingJpy, result.baseJpy + result.oversizeJpy);
  assert.equal(result.clearanceJpy, 245);
  assert.equal(result.dutyProcessingRate, 0.021);
  assert.equal(result.effectiveDate, "2026-03-25");
  assert.equal(result.sourceUrl, "https://static.orangeconnex.com/capricorn/selfQuery/1141130239112384512.pdf");
});

function product() {
  return app.normalizeProduct({
    part_number: "25550-5SA0A",
    price_median_usd: 100,
    sales_auto_verified: true,
    sales_confidence: "high",
    sales_observed_days: 35,
    sold_90d_decision: 7,
    competition_known: true,
    market_score: 80,
    demand_ratio: 0.7,
    country_of_origin: "JP",
    auto_costs: {
      procurement_jpy: 3500,
      domestic_shipping_jpy: 0,
      international_shipping_jpy: 2800,
      packaging_jpy: 150,
      tariff_rate: 0.15,
    },
  });
}

beforeEach(() => {
  app.state.settings = { ...app.DEFAULT_SETTINGS, includePayoneerAnnualFee: false, feesConfirmed: true };
  app.state.apiPayload = { cost_defaults: { exchange_rate: {
    rate: 150, fallback: false, date: new Date().toISOString().slice(0, 10),
  } } };
  app.state.setupStatus = { ready: true };
  app.state.costs = {};
});

test("manual shipping stays stored while automatic shipping updates from parcel edits", () => {
  const item = product();
  app.state.costs[item.part_number] = {
    shippingMethod: "manual",
    internationalShippingJpy: "4321",
  };
  assert.equal(app.getCostValues(item).internationalShippingJpy, "4321");

  app.updateCostValue(item, "shippingMethod", "speedpak_economy_us");
  for (const [key, value] of Object.entries({
    parcelWeightKg: "0.5", parcelLengthCm: "20", parcelWidthCm: "15", parcelHeightCm: "10", shippingRegion: "US48",
  })) app.updateCostValue(item, key, value);
  assert.equal(app.getCostValues(item).internationalShippingJpy, 2060);

  app.updateCostValue(item, "parcelLengthCm", "40");
  app.updateCostValue(item, "parcelWidthCm", "20");
  app.updateCostValue(item, "parcelHeightCm", "20");
  assert.equal(app.getCostValues(item).internationalShippingJpy, 5245);

  app.updateCostValue(item, "shippingMethod", "manual");
  assert.equal(app.getCostValues(item).internationalShippingJpy, "4321");
});

test("automatic parcel scalars survive backup restore and re-derive the shipping amount", () => {
  const rows = new Map();
  const localStorage = {
    getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, String(value)),
    removeItem: key => rows.delete(key),
  };
  const context = vm.createContext({
    module: { exports: {} }, require, localStorage, structuredClone, console, URL, Date,
    setTimeout: () => 1, clearTimeout: () => {}, PartScoutShipping: require("../web/shipping.js"),
    PartScoutPersistence: require("../web/persistence.js"),
  });
  vm.runInContext(fs.readFileSync(require.resolve("../web/app.js"), "utf8"), context);
  const storedApp = context.module.exports;
  const item = storedApp.normalizeProduct(product());
  storedApp.state.costs[item.part_number] = {
    shippingMethod: "speedpak_economy_us",
    parcelWeightKg: "0.5",
    parcelLengthCm: "20",
    parcelWidthCm: "15",
    parcelHeightCm: "10",
    shippingRegion: "US48",
  };
  const backup = storedApp.makeBackup();
  storedApp.state.costs = {};
  storedApp.restoreBackup(backup);
  assert.equal(storedApp.getCostValues(item).internationalShippingJpy, 2060);
  for (const value of Object.values(storedApp.state.costs[item.part_number])) {
    assert.notEqual(typeof value, "object");
  }
});

test("parcel and method edits invalidate both confirmations", () => {
  const item = product();
  app.state.costs[item.part_number] = {
    supplierConfirmed: true,
    tariffConfirmed: true,
    supplierConfirmedAt: new Date().toISOString(),
    tariffConfirmedAt: new Date().toISOString(),
    tariffPolicyReview: "2026-09-08",
    tariffSalePriceUsd: 100,
  };
  for (const key of ["shippingMethod", "parcelWeightKg", "parcelLengthCm", "parcelWidthCm", "parcelHeightCm", "shippingRegion"]) {
    app.state.costs[item.part_number].supplierConfirmed = true;
    app.state.costs[item.part_number].tariffConfirmed = true;
    app.updateCostValue(item, key, key === "shippingMethod" ? "speedpak_economy_us" : "1");
    assert.equal(app.state.costs[item.part_number].supplierConfirmed, false, key);
    assert.equal(app.state.costs[item.part_number].tariffConfirmed, false, key);
  }
});

test("automatic clearance and duty processing are included exactly once", () => {
  const item = product();
  const common = {
    procurementJpy: 3500,
    domesticShippingJpy: 0,
    packagingJpy: 150,
    customsFixedJpy: 50,
    dutyQuoteJpy: 1000,
    tariffRate: 15,
  };
  app.state.costs[item.part_number] = { ...common, shippingMethod: "manual", internationalShippingJpy: 2060 };
  const manual = app.calculateProfit(item);
  app.state.costs[item.part_number] = {
    ...common,
    shippingMethod: "speedpak_economy_us",
    speedpakOtherCustomsJpy: 50,
    internationalShippingJpy: 9999,
    parcelWeightKg: "0.5",
    parcelLengthCm: "20",
    parcelWidthCm: "15",
    parcelHeightCm: "10",
    shippingRegion: "US48",
  };
  const automatic = app.calculateProfit(item);
  assert.equal(automatic.values.internationalShippingJpy, 2060);
  assert.equal(automatic.speedpakFees, 245 + 1000 * 0.021);
  assert.equal(automatic.totalCost - manual.totalCost, 245 + 1000 * 0.021);
  assert.equal(Number.isFinite(automatic.totalCost), true);
});

test("switching modes never reinterprets a legacy manual customs amount as automatic other customs", () => {
  const item = product();
  app.state.costs[item.part_number] = {
    procurementJpy: 3500,
    domesticShippingJpy: 0,
    internationalShippingJpy: 2060,
    packagingJpy: 150,
    customsFixedJpy: 245,
    dutyQuoteJpy: 1000,
    tariffRate: 15,
    shippingMethod: "manual",
  };
  const manual = app.calculateProfit(item);

  app.updateCostValue(item, "shippingMethod", "speedpak_economy_us");
  for (const [key, value] of Object.entries({
    parcelWeightKg: "0.5", parcelLengthCm: "20", parcelWidthCm: "15", parcelHeightCm: "10", shippingRegion: "US48",
  })) app.updateCostValue(item, key, value);
  let automatic = app.calculateProfit(item);
  assert.equal(automatic.values.customsFixedJpy, 245);
  assert.equal(automatic.values.speedpakOtherCustomsJpy, 0);
  assert.equal(automatic.totalCost - manual.totalCost, 1000 * 0.021);

  app.updateCostValue(item, "speedpakOtherCustomsJpy", "75");
  automatic = app.calculateProfit(item);
  assert.equal(automatic.totalCost - manual.totalCost, 75 + 1000 * 0.021);

  app.updateCostValue(item, "shippingMethod", "manual");
  assert.equal(app.getCostValues(item).customsFixedJpy, 245);
  assert.equal(app.calculateProfit(item).totalCost, manual.totalCost);
  app.updateCostValue(item, "shippingMethod", "speedpak_economy_us");
  assert.equal(app.getCostValues(item).speedpakOtherCustomsJpy, "75");
  assert.equal(app.calculateProfit(item).totalCost - manual.totalCost, 75 + 1000 * 0.021);
});

test("invalid automatic parcels remain unknown and cannot create a purchase candidate", () => {
  const item = product();
  app.state.costs[item.part_number] = {
    shippingMethod: "speedpak_economy_us",
    internationalShippingJpy: 9999,
    parcelWeightKg: "0.5",
    parcelLengthCm: "20",
    parcelWidthCm: "",
    parcelHeightCm: "10",
    shippingRegion: "US48",
    supplierConfirmed: true,
    supplierConfirmedAt: new Date().toISOString(),
  };
  const result = app.calculateProfit(item);
  assert.equal(result.values.internationalShippingJpy, null);
  assert.equal(result.hasCosts, false);
  assert.equal(result.passes, false);
  assert.equal(Number.isFinite(result.totalCost), false);
  assert.ok(result.shippingQuote.errors.length > 0);
});

test("a dated automatic reference quote never satisfies final shipping confirmation", () => {
  const item = product();
  app.state.settings.minimumProfitJpy = 0;
  app.state.settings.minimumMarginRate = 0;
  app.state.costs[item.part_number] = {
    shippingMethod: "speedpak_economy_us",
    parcelWeightKg: "0.5",
    parcelLengthCm: "20",
    parcelWidthCm: "15",
    parcelHeightCm: "10",
    shippingRegion: "US48",
    supplierConfirmed: true,
    supplierConfirmedAt: new Date().toISOString(),
  };
  const result = app.calculateProfit(item);
  assert.equal(result.values.supplierConfirmed, false);
  assert.ok(result.confirmationFailed.includes("仕入条件"));
  assert.equal(app.nextAction(item, result), "CPaSS見積の送料に切替（手入力）して確認");
});

test("automatic controls expose derived shipping as read-only and manual controls remain editable", () => {
  const shipping = { type: "number", tagName: "INPUT", dataset: { cost: "internationalShippingJpy" }, value: "" };
  const method = { type: "select-one", tagName: "SELECT", dataset: { cost: "shippingMethod" }, value: "", options: [
    { value: "manual" }, { value: "speedpak_economy_us" },
  ] };
  app.applyCostValuesToControls([shipping, method], { shippingMethod: "speedpak_economy_us", internationalShippingJpy: 2060 });
  assert.equal(shipping.readOnly, true);
  assert.equal(shipping.value, 2060);
  app.applyCostValuesToControls([shipping, method], { shippingMethod: "manual", internationalShippingJpy: "4321" });
  assert.equal(shipping.readOnly, false);
  assert.equal(shipping.value, "4321");
});
