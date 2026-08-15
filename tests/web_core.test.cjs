"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = require(path.resolve(__dirname, "../web/app.js"));

{
  const values = app.extractPartNumbers("Fits Nissan 2018-2020 12-VOLT switch 25550-5SA0A");
  assert.deepEqual(values, ["25550-5SA0A"]);
}

{
  const values = app.extractPartNumbers("2WD-4WD 3-PIN 4-DOOR 10X20MM 2-0L 25550-5SA0A");
  assert.deepEqual(values, ["25550-5SA0A"]);
}

{
  const rows = app.parseCsv('Title,MPN\r\n"A ""quoted"" title",25550-5SA0A\r\n');
  assert.equal(rows[1][0], 'A "quoted" title');
  assert.equal(rows[1][1], "25550-5SA0A");
}

{
  const rows = app.parseCsv("Title,MPN\nNo trailing newline,25550-5SA0A");
  assert.deepEqual(rows[1], ["No trailing newline", "25550-5SA0A"]);
}

{
  const sample = fs.readFileSync(path.resolve(__dirname, "../docs/product-research-sample.csv"), "utf8");
  const products = app.importProductResearchCsv(sample);
  const nissan = products.find((product) => product.part_number === "25550-5SA0A");
  const honda = products.find((product) => product.part_number === "72155-S5A-A01");
  assert.ok(nissan);
  assert.ok(honda);
  assert.equal(nissan.sold_90d_est, 10);
  assert.equal(nissan.active_competition, 14);
  assert.equal(nissan.sales_quality, "product_research_csv");
  assert.equal(nissan.sales_auto_verified, true);
}

{
  const product = app.createManualResearchProduct({
    partNumber: "25550-5SA0A",
    sold90d: "12",
    activeCompetition: "8",
    medianPriceUsd: "84.50",
    sellerCount: "5",
    title: "Nissan genuine switch",
  });
  assert.equal(product.part_number, "25550-5SA0A");
  assert.equal(product.sold_90d_est, 12);
  assert.equal(product.active_competition, 8);
  assert.equal(product.sales_quality, "product_research_manual");
  assert.equal(product.sales_auto_verified, true);
  assert.equal(product.brand, "Nissan");
}

{
  assert.equal(app.internationalFeeRate(0), 1.35);
  assert.equal(app.internationalFeeRate(3000), 1.2);
  assert.equal(app.internationalFeeRate(10000), 0.95);
  assert.equal(app.internationalFeeRate(50000), 0.7);
  assert.equal(app.internationalFeeRate(100000), 0.4);
  assert.deepEqual(app.feeProfile({ sellerPlan: "basic_plus" }), {
    rate: 11.5,
    thresholdUsd: 1000,
    aboveRate: 2.35,
    label: "Basic以上・標準P&A",
  });
  assert.equal(app.feeProfile(
    { sellerPlan: "basic_plus" },
    { category_path: "eBay Motors > Parts & Accessories > In-Car Technology, GPS & Security" },
  ).rate, 9.35);
}

{
  app.state.apiPayload = {
    cost_defaults: { exchange_rate: { rate: 151.25 } },
    products: [],
  };
  app.state.settings = {
    ...app.DEFAULT_SETTINGS,
    sellerPlan: "no_store_or_starter",
    monthlySalesUsd: 0,
    autoExchangeRate: true,
    exchangeRate: 140,
    buyerSalesTaxRate: 7,
    promotedRate: 0,
    ebayFeeTaxRate: 10,
    payoneerWithdrawalRate: 3,
    payoneerFixedJpy: 0,
    payoneerAnnualAllocationJpy: 0,
    returnReserveRate: 3,
    additionalFvfRate: 0,
    minimumProfitJpy: 5000,
    minimumMarginRate: 25,
    minimumSold90d: 3,
    minimumMarketScore: 55,
    minimumDemandRatio: 0.1,
  };
  assert.equal(app.effectiveExchangeRate(), 151.25);
}

{
  app.state.settings = {
    ...app.DEFAULT_SETTINGS,
    autoExchangeRate: false,
    exchangeRate: 150,
    sellerPlan: "no_store_or_starter",
    monthlySalesUsd: 0,
    buyerSalesTaxRate: 7,
    promotedRate: 0,
    ebayFeeTaxRate: 10,
    payoneerWithdrawalRate: 3,
    payoneerFixedJpy: 0,
    payoneerAnnualAllocationJpy: 0,
    returnReserveRate: 3,
    additionalFvfRate: 0,
    minimumProfitJpy: 5000,
    minimumMarginRate: 25,
    minimumSold90d: 3,
    minimumMarketScore: 55,
    minimumDemandRatio: 0.1,
  };
  app.state.costs = {
    "25550-5SA0A": {
      salePriceUsd: 100,
      procurementJpy: 2000,
      domesticShippingJpy: 0,
      internationalShippingJpy: 1500,
      packagingJpy: 0,
      originCode: "JP",
      tariffRate: 15,
      supplierConfirmed: true,
      tariffConfirmed: true,
    },
  };
  const result = app.calculateProfit({
    part_number: "25550-5SA0A",
    sold_90d_est: 10,
    competition_known: true,
    market_score: 80,
    demand_ratio: 0.5,
    price_median_usd: 100,
    sales_quality: "observed_delta_30d",
    sales_confidence: "high",
    sales_auto_verified: true,
    competition_confidence: "high",
  });
  assert.equal(result.tariff, 2250);
  assert.equal(result.hasCosts, true);
  assert.equal(result.salesVerified, true);
  assert.equal(result.passes, true);
  assert.equal(result.judgment, "購入候補");
  assert.ok(result.ebayFeeTaxJpy > 0);
  assert.ok(result.payoneerFee > 0);
  assert.equal(result.annualFeeApplicable, true);
  assert.ok(result.payoneerAnnualAllocation > 0);
  assert.ok(Number.isFinite(result.profit));
}

{
  app.state.costs = {
    "25550-5SA0A": {
      salePriceUsd: 100,
      procurementJpy: 2000,
      internationalShippingJpy: 1500,
      originCode: "JP",
      tariffRate: 15,
    },
  };
  const product = {
    part_number: "25550-5SA0A",
    sold_90d_est: 10,
    competition_known: true,
    market_score: 80,
    demand_ratio: 0.5,
    price_median_usd: 100,
    sales_quality: "listing_lifetime_under_90d",
    sales_confidence: "learning",
    sales_auto_verified: false,
    competition_confidence: "high",
  };
  const result = app.calculateProfit(product);
  assert.equal(result.provisional, true);
  assert.match(result.judgment, /^概算候補/);
  assert.equal(app.combinedJudgment(product, result), "概算候補");
  assert.equal(app.nextAction(product, result), "自動差分を蓄積中。操作は不要");
}

{
  app.state.settings = {
    ...app.DEFAULT_SETTINGS,
    autoExchangeRate: false,
    exchangeRate: 100,
    sellerPlan: "no_store_or_starter",
    monthlySalesUsd: 0,
    buyerSalesTaxRate: 0,
    promotedRate: 0,
    ebayFeeTaxRate: 10,
    payoneerWithdrawalRate: 0,
    payoneerFixedJpy: 0,
    payoneerAnnualAllocationJpy: 0,
    returnReserveRate: 0,
    additionalFvfRate: 0,
    minimumProfitJpy: 0,
    minimumMarginRate: 0,
    minimumSold90d: 0,
    minimumMarketScore: 0,
    minimumDemandRatio: 0,
  };
  app.state.costs = {
    "LOW-ORDER-1": {
      salePriceUsd: 9,
      procurementJpy: 1,
      domesticShippingJpy: 0,
      internationalShippingJpy: 1,
      packagingJpy: 0,
      originCode: "US",
      tariffRate: 0,
      supplierConfirmed: true,
      tariffConfirmed: true,
    },
  };
  const result = app.calculateProfit({
    part_number: "LOW-ORDER-1",
    sold_90d_est: 10,
    competition_known: true,
    market_score: 80,
    demand_ratio: 1,
    price_median_usd: 9,
    sales_quality: "product_research_manual",
    sales_confidence: "confirmed",
    sales_auto_verified: true,
  });
  assert.equal(result.perOrderFeeUsd, 0.3);
  // FVF: $9 × 13.6% + $0.30 = $1.524; international fee 1.35%; then Japan tax 10%.
  assert.equal(Math.round(result.finalValueFeeJpy), 152);
  assert.equal(Math.round(result.internationalFeeJpy), 12);
  assert.equal(Math.round(result.ebayFeeTaxJpy), 16);
  assert.equal(Math.round(result.ebayFee), 181);
}

{
  app.state.settings = {
    ...app.DEFAULT_SETTINGS,
    autoExchangeRate: false,
    exchangeRate: 100,
    sellerPlan: "basic_plus",
    monthlySalesUsd: 100000,
    buyerSalesTaxRate: 0,
    promotedRate: 0,
    ebayFeeTaxRate: 10,
    payoneerWithdrawalRate: 4,
    payoneerFixedJpy: 0,
    payoneerAnnualAllocationJpy: 0,
    returnReserveRate: 0,
    additionalFvfRate: 0,
  };
  app.state.costs = {
    "FEE-CHECK-1": {
      salePriceUsd: 100,
      procurementJpy: 1,
      internationalShippingJpy: 1,
      originCode: "US",
      tariffRate: 0,
    },
  };
  const result = app.calculateProfit({
    part_number: "FEE-CHECK-1",
    sold_90d_est: 0,
    competition_known: true,
    market_score: 0,
    demand_ratio: 0,
    price_median_usd: 100,
    sales_quality: "insufficient",
  });
  assert.equal(result.feeProfile.rate, 11.5);
  assert.equal(result.internationalRate, 0.4);
  assert.ok(result.ebayFeeTaxJpy > 0);
  assert.ok(result.payoneerFee > 0);
}

console.log("web core tests: passed");

{
  app.state.settings = {
    ...app.DEFAULT_SETTINGS,
    autoExchangeRate: false,
    exchangeRate: 100,
    sellerPlan: "no_store_or_starter",
    monthlySalesUsd: 0,
    buyerSalesTaxRate: 0,
    insertionFeeUsd: 0.30,
    promotedRate: 0,
    ebayFeeTaxRate: 10,
    payoneerWithdrawalRate: 0,
    includePayoneerAnnualFee: false,
    returnReserveRate: 0,
    additionalFvfRate: 0,
  };
  app.state.costs = {
    "INSERTION-1": {
      salePriceUsd: 100,
      procurementJpy: 1,
      internationalShippingJpy: 1,
      originCode: "US",
      tariffRate: 0,
    },
  };
  const result = app.calculateProfit({
    part_number: "INSERTION-1",
    sold_90d_est: 0,
    competition_known: true,
    market_score: 0,
    demand_ratio: 0,
    price_median_usd: 100,
    sales_quality: "insufficient",
  });
  assert.equal(result.insertionFeeJpy, 30);
  assert.ok(result.ebayFeeTaxJpy >= 3);
}
