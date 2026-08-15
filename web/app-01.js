"use strict";

const STORAGE_KEYS = {
  settings: "part-scout-settings-v3",
  legacySettings: "part-scout-settings-v2",
  costs: "part-scout-costs-v2",
  legacyCosts: "part-scout-costs-v1",
  csvProducts: "part-scout-csv-products-v2",
  legacyCsvProducts: "part-scout-csv-products-v1",
};

const DEFAULT_SETTINGS = {
  sellerPlan: "no_store_or_starter",
  monthlySalesUsd: 0,
  internationalFeeDiscountEligible: true,
  autoExchangeRate: true,
  exchangeRate: 150,
  buyerSalesTaxRate: 7,
  insertionFeeUsd: 0,
  promotedRate: 0,
  ebayFeeTaxRate: 10,
  payoneerWithdrawalRate: 3,
  payoneerFixedJpy: 0,
  includePayoneerAnnualFee: true,
  payoneerAnnualAllocationJpy: 0,
  returnReserveRate: 3,
  additionalFvfRate: 0,
  defaultInternationalShippingJpy: 2800,
  defaultPackagingJpy: 150,
  defaultDomesticShippingJpy: 800,
  minimumProfitJpy: 5000,
  minimumMarginRate: 25,
  minimumSold90d: 3,
  minimumMarketScore: 55,
  minimumDemandRatio: 0.1,
};

const QUALITY_LABELS = {
  observed_delta_30d: "Production差分・高精度",
  observed_delta: "Production差分",
  learning_baseline: "Production差分を学習中",
  insufficient: "データ不足",
  product_research_csv: "任意CSV補正",
  product_research_manual: "任意手動補正",
};

const SALES_CONFIDENCE_LABELS = {
  confirmed: "任意補正・確認済み",
  high: "自動精度・高",
  medium: "自動精度・中",
  low: "自動精度・低",
  learning: "自動学習中",
  unknown: "データ不足",
};

const COMPETITION_LABELS = {
  confirmed: "確認済み",
  high: "高",
  medium: "中",
  low: "低",
  unknown: "不明",
};

const ORIGIN_LABELS = {
  JP: "日本",
  US: "米国",
  CN: "中国",
  KR: "韓国",
  TW: "台湾",
  TH: "タイ",
  MX: "メキシコ",
  CA: "カナダ",
  DE: "ドイツ",
  GB: "英国",
  OTHER: "その他",
  "": "不明",
};

const CONFIRMED_SALES_QUALITIES = new Set(["product_research_csv", "product_research_manual"]);

const EBAY_API_STATUS_LABELS = {
  ready: "接続済み",
  missing_credentials: "未登録",
  invalid_credentials: "キー不一致",
  browse_not_approved: "本番権限なし",
  token_rejected: "トークン拒否",
  rate_limited: "上限到達",
  request_rejected: "要求拒否",
  oauth_temporary_error: "一時障害",
  temporary_error: "一時障害",
  checking: "確認中",
};

const RESEARCH_STATUS_LABELS = {
  success: "調査完了",
  partial_success: "一部取得・自動再試行",
  partial_failure: "前回結果保持",
  discovery_unavailable: "候補探索を自動再試行",
  exact_search_unavailable: "品番調査を自動再試行",
  api_unavailable: "API設定待ち",
};

const RESEARCH_RETRY_STATUSES = new Set([
  "partial_failure",
  "discovery_unavailable",
  "exact_search_unavailable",
]);

function loadJson(key, fallback) {
  if (typeof localStorage === "undefined") return structuredClone(fallback);
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : structuredClone(fallback);
  } catch (_) {
    return structuredClone(fallback);
  }
}

function saveJson(key, value) {
  if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(value));
}

function loadSettings() {
  const legacy = loadJson(STORAGE_KEYS.legacySettings, {});
  const current = loadJson(STORAGE_KEYS.settings, {});
  const migrated = { ...DEFAULT_SETTINGS, ...legacy, ...current };
  if (current.payoneerWithdrawalRate == null && legacy.fxSpreadRate != null) {
    migrated.payoneerWithdrawalRate = Number(legacy.fxSpreadRate) || DEFAULT_SETTINGS.payoneerWithdrawalRate;
  }
  delete migrated.fxSpreadRate;
  return migrated;
}

function loadCosts() {
  const legacy = loadJson(STORAGE_KEYS.legacyCosts, {});
  const current = loadJson(STORAGE_KEYS.costs, {});
  return { ...legacy, ...current };
}

function loadCsvProducts() {
  const legacy = loadJson(STORAGE_KEYS.legacyCsvProducts, []);
  const current = loadJson(STORAGE_KEYS.csvProducts, []);
  return current.length ? current : legacy;
}

const state = {
  apiPayload: null,
  products: [],
  settings: loadSettings(),
  costs: loadCosts(),
  csvProducts: loadCsvProducts(),
  filter: "",
  sort: "profit",
};

const els = typeof document !== "undefined" ? {
  runStatus: document.querySelector("#run-status"),
  automationHealth: document.querySelector("#automation-health"),
  setupCredentials: document.querySelector("#setup-credentials"),
  setupOauth: document.querySelector("#setup-oauth"),
  setupBrowse: document.querySelector("#setup-browse"),
  setupLearning: document.querySelector("#setup-learning"),
  flowResearch: document.querySelector("#flow-research"),
  flowMarket: document.querySelector("#flow-market"),
  flowProcurement: document.querySelector("#flow-procurement"),
  summaryCount: document.querySelector("#summary-count"),
  summaryVerified: document.querySelector("#summary-verified"),
  summaryPromising: document.querySelector("#summary-promising"),
  summaryQuery: document.querySelector("#summary-query"),
  nextTaskTitle: document.querySelector("#next-task-title"),
  nextTaskDetail: document.querySelector("#next-task-detail"),
  topProductList: document.querySelector("#top-product-list"),
  topEmptyState: document.querySelector("#top-empty-state"),
  productList: document.querySelector("#product-list"),
  emptyState: document.querySelector("#empty-state"),
  filterInput: document.querySelector("#filter-input"),
  sortSelect: document.querySelector("#sort-select"),
  qualityNotice: document.querySelector("#data-quality-notice"),
  template: document.querySelector("#product-card-template"),
  settingsForm: document.querySelector("#settings-form"),
  csvInput: document.querySelector("#csv-input"),
  csvStatus: document.querySelector("#csv-status"),
  manualForm: document.querySelector("#manual-research-form"),
  manualStatus: document.querySelector("#manual-status"),
} : {};

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function yen(value) {
  return `${Math.round(number(value)).toLocaleString("ja-JP")}円`;
}

function usd(value) {
  return `$${number(value).toFixed(2)}`;
}

function percent(value) {
  return `${(number(value) * 100).toFixed(1)}%`;
}

function normalizePartNumber(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[–—−‐‑ー]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/[^A-Z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

const PART_NUMBER_NOISE = new Set([
  "NISSAN", "TOYOTA", "HONDA", "MAZDA", "SUBARU", "MITSUBISHI", "SUZUKI", "ISUZU",
  "LEXUS", "INFINITI", "ACURA", "OEM", "GENUINE", "FACTORY", "FRONT", "REAR", "RIGHT",
  "LEFT", "UPPER", "LOWER", "BLACK", "WHITE", "SILVER", "NEW", "USED", "PAIR", "PCS",
  "PIECE", "ASSEMBLY", "ASSY", "PART", "PARTS", "DIRECT", "REPLACEMENT",
]);

function isPlausiblePartNumber(value) {
  const normalized = normalizePartNumber(value);
  if (normalized.length < 5 || normalized.length > 24) return false;
  if (PART_NUMBER_NOISE.has(normalized)) return false;
  if (/^(?:19|20)\d{2}(?:-(?:19|20)\d{2})?$/.test(normalized)) return false;
  if (/^\d{1,3}-(?:V|VOLT|MM|CM|IN|INCH|PCS|PIECE|SPEED|PIN|PINS|DOOR|DOORS|CYL|CYLINDER|HOLE|HOLES|PORT|PORTS|WAY|WIRE|WIRES)$/.test(normalized)) return false;
  if (/^(?:2WD|4WD|AWD|FWD|RWD)(?:-(?:2WD|4WD|AWD|FWD|RWD))+$/.test(normalized)) return false;
  if (/^\d+(?:X\d+){1,3}(?:MM|CM|IN|INCH)?$/.test(normalized)) return false;
  if (/^\d{1,2}-\d{1,2}L$/.test(normalized)) return false;
  if (!/\d/.test(normalized)) return false;
  if (!/[A-Z]/.test(normalized) && !/^\d{5}-\d{4,6}(?:-\d{1,4})?$/.test(normalized)) return false;
  return true;
}

function extractPartNumbers(text) {
  const normalized = String(text || "").toUpperCase().replace(/[–—−‐‑ー]/g, "-");
  const patterns = [
    /\b\d{5}-[A-Z0-9]{4,6}(?:-[A-Z0-9]{1,4})?\b/g,
    /\b\d{5}-[A-Z0-9]{3}-[A-Z0-9]{3}\b/g,
    /\b[A-Z0-9]{2,7}(?:-[A-Z0-9]{2,8}){1,3}\b/g,
    /\b(?:[A-Z]{1,4}\d{5,10}[A-Z0-9]{0,4}|\d{4,7}[A-Z]{1,4}\d{2,7})\b/g,
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const value = normalizePartNumber(match[0]);
      if (isPlausiblePartNumber(value) && !found.includes(value)) found.push(value);
    }
  }
  return found;
}

function median(values) {
  const data = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!data.length) return 0;
  const middle = Math.floor(data.length / 2);
  return data.length % 2 ? data[middle] : (data[middle - 1] + data[middle]) / 2;
}

function percentile(values, p) {
  const data = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!data.length) return 0;
  if (data.length === 1) return data[0];
  const index = (data.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return data[lower];
  return data[lower] * (upper - index) + data[upper] * (index - lower);
}

function marketScore(sold, competition, prices) {
  const active = Math.max(number(competition), 0);
  const demandRatio = number(sold) / Math.max(active, 1);
  const demandPoints = Math.min(35, Math.log1p(Math.max(number(sold), 0)) / Math.log(21) * 35);
  const ratioPoints = Math.min(30, demandRatio / 1.5 * 30);
  const competitionPoints = 20 / (1 + active / 18);
  let pricePoints = 0;
  const cleanPrices = prices.map(Number).filter((v) => Number.isFinite(v) && v > 0);
  if (cleanPrices.length) {
    const med = median(cleanPrices);
    if (med >= 25) pricePoints += Math.min(8, med / 100 * 8);
    if (cleanPrices.length >= 2) {
      const mean = cleanPrices.reduce((sum, v) => sum + v, 0) / cleanPrices.length;
      const variance = cleanPrices.reduce((sum, v) => sum + ((v - mean) ** 2), 0) / cleanPrices.length;
      const cv = mean ? Math.sqrt(variance) / mean : 1;
      pricePoints += Math.max(0, 7 * (1 - Math.min(cv, 1)));
    } else {
      pricePoints += 2;
    }
  }
  return Math.max(0, Math.min(100, Math.round(demandPoints + ratioPoints + competitionPoints + pricePoints)));
}

function detectDelimiter(text) {
  const firstLine = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  const candidates = [",", "\t", ";"];
  let best = ",";
  let bestCount = -1;
  for (const delimiter of candidates) {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < firstLine.length; index += 1) {
      if (firstLine[index] === '"') quoted = !quoted;
      else if (!quoted && firstLine[index] === delimiter) count += 1;
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function parseCsv(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(source);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => String(value).trim() !== "")) rows.push(row);
  }
  return rows;
}

function normalizeHeader(value) {
  return String(value || "").replace(/^\uFEFF/, "").toLowerCase().replace(/[\s_\-\/()（）・:：]+/g, "");
}

function findHeader(headers, candidates) {
  const normalizedCandidates = candidates.map(normalizeHeader).filter(Boolean);
  const exact = headers.findIndex((header) => header && normalizedCandidates.includes(header));
  if (exact >= 0) return exact;
  return headers.findIndex((header) => header && normalizedCandidates.some((candidate) => (
    header.includes(candidate) || (header.length >= 4 && candidate.includes(header))
  )));
}

function parsePrice(value) {
  return number(String(value || "").replace(/[^0-9.\-]/g, ""), 0);
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferBrand(title) {
  const upper = String(title || "").toUpperCase();
  const brands = {
    NISSAN: "Nissan", TOYOTA: "Toyota", HONDA: "Honda", MAZDA: "Mazda",
    SUBARU: "Subaru", MITSUBISHI: "Mitsubishi", SUZUKI: "Suzuki", ISUZU: "Isuzu",
    LEXUS: "Lexus", INFINITI: "Infiniti", ACURA: "Acura",
  };
  return Object.entries(brands).find(([key]) => upper.includes(key))?.[1] || "Unknown";
}

function tariffScenario(originCode) {
  const origin = String(originCode || "").toUpperCase();
  if (origin === "JP") return { rate: 15, low: 15, high: 25, label: "日本原産・関税仮置き" };
  if (origin === "US") return { rate: 0, low: 0, high: 15, label: "米国原産・関税仮置き" };
  if (origin) return { rate: 25, low: 15, high: 50, label: "他国原産・保守的仮置き" };
  return { rate: 25, low: 15, high: 50, label: "原産国不明・保守的仮置き" };
}

function internationalFeeRate(monthlySalesUsd) {
  const sales = Math.max(0, number(monthlySalesUsd));
  if (sales >= 100000) return 0.4;
  if (sales >= 50000) return 0.7;
  if (sales >= 10000) return 0.95;
  if (sales >= 3000) return 1.2;
  return 1.35;
}

function feeProfile(settings = state.settings, product = {}) {
  if (settings.sellerPlan !== "basic_plus") {
    return { rate: 13.6, thresholdUsd: 7500, aboveRate: 2.35, label: "ストアなし／Starter・標準P&A" };
  }

  const categoryPath = String(product.category_path || product.categoryPath || "").toLowerCase();
  if (categoryPath.includes("wheels, tires & parts > tires")
      || categoryPath.includes("trailer tires & wheels > tires")
      || categoryPath.includes("aircraft tires & tubes")) {
    return { rate: 9.5, thresholdUsd: 1000, aboveRate: 2.35, label: "Basic以上・タイヤ" };
  }
  if (categoryPath.includes("apparel, protective gear & merchandise")) {
    return { rate: 12.7, thresholdUsd: 1000, aboveRate: 2.35, label: "Basic以上・アパレル等" };
  }
  if (categoryPath.includes("in-car technology, gps & security")) {
    return { rate: 9.35, thresholdUsd: 1000, aboveRate: 2.35, label: "Basic以上・車載テック" };
  }
  return { rate: 11.5, thresholdUsd: 1000, aboveRate: 2.35, label: "Basic以上・標準P&A" };
}

function isSalesAutoVerified(product) {
  return product.sales_auto_verified === true || CONFIRMED_SALES_QUALITIES.has(product.sales_quality);
}

function createManualResearchProduct(values) {
  const part = normalizePartNumber(values.partNumber);
  if (!isPlausiblePartNumber(part)) throw new Error("品番の形式を確認してください。");
  const sold = Math.max(0, Math.round(number(values.sold90d)));
  const active = Math.max(0, Math.round(number(values.activeCompetition)));
  const price = Math.max(0, number(values.medianPriceUsd));
  if (price <= 0) throw new Error("成約価格を入力してください。");
  const existing = (state.apiPayload?.products || []).find((product) => product.part_number === part) || {};
  const suppliedTitle = String(values.title || "").trim();
  const title = suppliedTitle || existing.title || `${part} auto part`;
  const score = marketScore(sold, active, [price]);
  return {
    ...existing,
    part_number: part,
    title,
    brand: existing.brand || inferBrand(title),
    sold_90d_est: sold,
    sold_90d_low: sold,
    sold_90d_high: sold,
    sales_quality: "product_research_manual",
    sales_confidence: "confirmed",
    sales_observed_days: 90,
    sales_scope: "product_research_90d",
    sales_auto_verified: true,
    sales_confirmation_required: false,
    sampled_listings: sold,
    sampled_sellers: Math.max(0, Math.round(number(values.sellerCount))),
    active_competition: active,
    competition_known: true,
    competition_confidence: "confirmed",
    competition_match_rate: 1,
    sample_coverage: 1,
    demand_ratio: sold / Math.max(active, 1),
    price_median_usd: price,
    price_p25_usd: price,
    price_p75_usd: price,
    market_score: score,
    market_judgment: score >= 72 && sold >= 5 ? "有望" : score >= 55 && sold >= 2 ? "候補" : score >= 40 ? "監視" : "見送り",
    source: "product_research_manual",
  };
}
