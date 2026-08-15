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
  normalizePartNumber,
  isPlausiblePartNumber,
  extractPartNumbers,
  detectDelimiter,
  parseCsv,
  importProductResearchCsv,
  createManualResearchProduct,
  calculateProfit,
  combinedJudgment,
  marketScore,
  percentile,
})`);
