"use strict";

const assert = require("node:assert/strict");
const app = require("../web/app.js");

const {
  state,
  DEFAULT_SETTINGS,
  normalizePartNumber,
  isPlausiblePartNumber,
  extractPartNumbers,
  calculateProfit,
  combinedJudgment,
  nextAction,
  marketScore,
  percentile,
  tariffScenario,
  internationalFeeRate,
  feeProfile,
  effectiveExchangeRate,
  isSalesAutoVerified,
  normalizeProduct,
  setupPresentation,
  observationProgress,
} = app;

function resetState() {
  state.settings = { ...DEFAULT_SETTINGS, includePayoneerAnnualFee: false };
  state.costs = {};
  state.apiPayload = {
    cost_defaults: { exchange_rate: { rate: 150 } },
    products: [],
  };
  state.setupStatus = {
    ready: true,
    status: "ready",
    links: {},
    message: "connected",
    details: {},
  };
}

function baseProduct(overrides = {}) {
  return normalizeProduct({
    part_number: "25550-5SA0A",
    brand: "Nissan",
    title: "Nissan genuine switch 25550-5SA0A",
    category_path: "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Switches & Controls",
    price_median_usd: 120,
    price_p25_usd: 110,
    price_p75_usd: 130,
    sold_90d_est: 12,
    sold_90d_low: 7,
    sold_90d_high: 18,
    sold_90d_decision: 7,
    sales_confidence: "high",
    sales_quality: "observed_delta_30d",
    sales_observed_days: 35,
    sales_observed_delta: 5,
    sales_tracked_listings: 4,
    sales_auto_verified: true,
    active_competition: 10,
    competition_known: true,
    competition_confidence: "high",
    demand_ratio: 0.7,
    market_score: 80,
    market_judgment: "有望",
    country_of_origin: "JP",
    tariff: { rate: 0.15, screening_only: true },
    auto_costs: {
      procurement_jpy: 3500,
      domestic_shipping_jpy: 0,
      international_shipping_jpy: 2200,
      packaging_jpy: 150,
      tariff_rate: 0.15,
    },
    rakuten: { enabled: false, items: [] },
    ...overrides,
  });
}

resetState();

assert.equal(normalizePartNumber(" 25550 – 5sa0a "), "25550-5SA0A");
assert.equal(isPlausiblePartNumber("25550-5SA0A"), true);
assert.equal(isPlausiblePartNumber("12-VOLT"), false);
assert.deepEqual(extractPartNumbers("Nissan 25550-5SA0A / Toyota 90915-YZZF2"), ["25550-5SA0A", "90915-YZZF2"]);

assert.ok(marketScore(20, 10, [80, 82, 85]) > marketScore(1, 100, [20, 60, 100]));
assert.equal(percentile([10, 20, 30, 40], 0.25), 17.5);
assert.equal(tariffScenario("JP").rate, 15);
assert.equal(tariffScenario("").rate, 25);
assert.equal(internationalFeeRate(0), 1.35);
assert.equal(internationalFeeRate(100000), 0.4);
assert.equal(feeProfile({ ...DEFAULT_SETTINGS, sellerPlan: "no_store_or_starter" }, {}).rate, 13.6);
assert.equal(feeProfile({ ...DEFAULT_SETTINGS, sellerPlan: "basic_plus" }, { category_path: "Wheels, Tires & Parts > Tires" }).rate, 9.5);

assert.equal(effectiveExchangeRate(), 150);
state.apiPayload.cost_defaults.exchange_rate.rate = 148.25;
assert.equal(effectiveExchangeRate(), 148.25);

const verified = baseProduct();
assert.equal(isSalesAutoVerified(verified), true);
const verifiedProfit = calculateProfit(verified);
assert.ok(verifiedProfit.ebayFee > 0);
assert.ok(verifiedProfit.payoneerFee > 0);
assert.ok(verifiedProfit.tariff > 0);
assert.equal(verifiedProfit.decisionSold, 7);
assert.equal(combinedJudgment(verified, verifiedProfit), "概算候補");
assert.equal(nextAction(verified, verifiedProfit), "仕入先で価格・在庫・送料を確認");

state.costs[verified.part_number] = {
  supplierConfirmed: true,
  tariffConfirmed: true,
};
const confirmedProfit = calculateProfit(verified);
assert.equal(confirmedProfit.passes, true);
assert.equal(combinedJudgment(verified, confirmedProfit), "購入候補");

resetState();
const learning = baseProduct({
  sold_90d_est: 150,
  sold_90d_low: 0,
  sold_90d_high: 0,
  sold_90d_decision: 0,
  sales_confidence: "learning",
  sales_quality: "tracking_not_ready",
  sales_observed_days: 2,
  sales_lifetime_reference: 150,
  sales_auto_verified: false,
});
const learningProfit = calculateProfit(learning);
assert.equal(learningProfit.decisionSold, 0);
assert.equal(learningProfit.salesVerified, false);
assert.equal(combinedJudgment(learning, learningProfit), "自動観測中");
assert.equal(nextAction(learning, learningProfit), "操作不要。販売差分を自動観測中");
assert.ok(learningProfit.operationalFailed.includes("販売ペース下限"));

const progress = observationProgress(learning);
assert.equal(progress.days, 2);
assert.equal(progress.remainingDays, 28);
assert.equal(progress.complete, false);
assert.ok(progress.percent > 6 && progress.percent < 7);

const setupMissing = setupPresentation({ status: "missing_secrets", ready: false, links: {} });
assert.equal(setupMissing.action, "APIキーを登録");
assert.ok(setupMissing.href.includes("settings/secrets/actions"));
const setupDenied = setupPresentation({ status: "browse_access_denied", ready: false, links: {} });
assert.ok(setupDenied.title.includes("Browse API"));
const setupReady = setupPresentation({ status: "ready", ready: true, links: {}, message: "ok" });
assert.equal(setupReady.tone, "good");

resetState();
const noSetupAction = nextAction(verified, calculateProfit(verified), { status: "missing_secrets", ready: false, links: {} });
assert.equal(noSetupAction, "APIキーを登録");

console.log("web core tests passed");
