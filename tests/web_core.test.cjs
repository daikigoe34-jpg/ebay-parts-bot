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
  assert.equal(product.brand, "Nissan");
}

{
  app.state.settings = {
    ...app.state.settings,
    exchangeRate: 150,
    ebayFeeRate: 13.6,
    ebayFeeThresholdUsd: 7500,
    ebayFeeAboveRate: 2.35,
    internationalFeeRate: 1.35,
    perOrderFeeUsd: 0.4,
    buyerSalesTaxRate: 7,
    promotedRate: 0,
    fxSpreadRate: 2,
    tariffRate: 15,
    returnReserveRate: 3,
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
      internationalShippingJpy: 1500,
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
    sales_quality: "product_research_manual",
    competition_confidence: "confirmed",
  });
  assert.equal(result.tariff, 2250);
  assert.equal(result.hasCosts, true);
  assert.equal(result.passes, true);
  assert.equal(result.judgment, "販売候補");
  assert.ok(Number.isFinite(result.profit));
}

{
  app.state.costs = {
    "25550-5SA0A": {
      salePriceUsd: 100,
      procurementJpy: 2000,
      internationalShippingJpy: 1500,
    },
  };
  const product = {
    part_number: "25550-5SA0A",
    sold_90d_est: 10,
    competition_known: true,
    market_score: 80,
    demand_ratio: 0.5,
    price_median_usd: 100,
    sales_quality: "lifetime_velocity_estimate",
    competition_confidence: "high",
  };
  const result = app.calculateProfit(product);
  assert.equal(result.confirmationOnly, true);
  assert.match(result.judgment, /^仮候補/);
  assert.equal(app.combinedJudgment(product, result), "仮候補");
}

{
  app.state.settings = {
    ...app.state.settings,
    exchangeRate: 100,
    ebayFeeRate: 10,
    ebayFeeThresholdUsd: 5,
    ebayFeeAboveRate: 2,
    internationalFeeRate: 0,
    perOrderFeeUsd: 0.4,
    buyerSalesTaxRate: 0,
    promotedRate: 0,
    fxSpreadRate: 0,
    tariffRate: 0,
    returnReserveRate: 0,
  };
  app.state.costs = {
    "LOW-ORDER-1": {
      salePriceUsd: 9,
      procurementJpy: 1,
      internationalShippingJpy: 1,
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
  });
  assert.equal(result.perOrderFeeUsd, 0.3);
  assert.equal(Math.round(result.ebayFee), 88);
}

console.log("web core tests: passed");
