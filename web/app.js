"use strict";

// Node.js test entry point. The browser loads app-01.js → app-03.js directly.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

for (const file of ["app-01.js", "app-02.js", "app-03.js"]) {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  vm.runInThisContext(source, { filename: file });
}

module.exports = vm.runInThisContext(`({
  state,
  DEFAULT_SETTINGS,
  normalizePartNumber,
  isPlausiblePartNumber,
  extractPartNumbers,
  detectDelimiter,
  parseCsv,
  importProductResearchCsv,
  createManualResearchProduct,
  calculateProfit,
  combinedJudgment,
  nextAction,
  marketScore,
  percentile,
  tariffScenario,
  internationalFeeRate,
  feeProfile,
  productDefaults,
  getCostValues,
  effectiveExchangeRate,
  isSalesAutoVerified,
  RESEARCH_STATUS_LABELS,
  RESEARCH_RETRY_STATUSES,
})`);
