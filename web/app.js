"use strict";

const STORAGE_KEYS = {
  settings: "part-scout-settings-v4",
  legacySettings: ["part-scout-settings-v3", "part-scout-settings-v2"],
  costs: "part-scout-costs-v3",
  legacyCosts: ["part-scout-costs-v2", "part-scout-costs-v1"],
};

const DEFAULT_SETTINGS = {
  sellerPlan: "no_store_or_starter",
  monthlySalesUsd: 0,
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
  observed_delta_30d: "自動差分・30日以上",
  observed_delta: "自動差分",
  tracking_not_ready: "観測準備中",
  insufficient: "データ不足",
};

const SALES_CONFIDENCE_LABELS = {
  high: "自動精度・高",
  medium: "自動精度・中",
  low: "自動精度・低",
  learning: "自動学習中",
  unknown: "データ不足",
};

const COMPETITION_LABELS = {
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

const DEFAULT_SETUP_STATUS = {
  schema_version: 1,
  app_version: "0.4.0",
  ready: false,
  status: "not_checked",
  mode: "production_browse_only",
  message: "Production APIの接続確認がまだです",
  next_action: "eBay Production APIキーを登録して初回調査を実行",
  links: {
    secrets: "https://github.com/daikigoe34-jpg/ebay-parts-bot/settings/secrets/actions",
    pages: "https://github.com/daikigoe34-jpg/ebay-parts-bot/settings/pages",
    workflow: "https://github.com/daikigoe34-jpg/ebay-parts-bot/actions/workflows/research.yml",
    buy_api_access: "https://developer.ebay.com/api-docs/buy/static/buy-requirements.html",
  },
  details: {},
};

const DATA_REFRESH_MAX_AGE_MS = 5 * 60 * 1000;

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function loadJson(key, fallback) {
  if (typeof localStorage === "undefined") return clone(fallback);
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : clone(fallback);
  } catch (_) {
    return clone(fallback);
  }
}

function saveJson(key, value) {
  if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(value));
}

function loadWithLegacy(currentKey, legacyKeys, fallback) {
  const current = loadJson(currentKey, null);
  if (current && typeof current === "object") return { ...clone(fallback), ...current };
  for (const key of legacyKeys) {
    const legacy = loadJson(key, null);
    if (legacy && typeof legacy === "object") return { ...clone(fallback), ...legacy };
  }
  return clone(fallback);
}

function loadSettings() {
  const settings = loadWithLegacy(STORAGE_KEYS.settings, STORAGE_KEYS.legacySettings, DEFAULT_SETTINGS);
  if (settings.payoneerWithdrawalRate == null && settings.fxSpreadRate != null) {
    settings.payoneerWithdrawalRate = Number(settings.fxSpreadRate) || DEFAULT_SETTINGS.payoneerWithdrawalRate;
  }
  delete settings.fxSpreadRate;
  return settings;
}

function loadCosts() {
  let merged = {};
  if (typeof localStorage !== "undefined") {
    for (const key of [...STORAGE_KEYS.legacyCosts].reverse()) {
      const value = loadJson(key, {});
      if (value && typeof value === "object") merged = { ...merged, ...value };
    }
  }
  const current = loadJson(STORAGE_KEYS.costs, {});
  return { ...merged, ...(current && typeof current === "object" ? current : {}) };
}

const state = {
  setupStatus: clone(DEFAULT_SETUP_STATUS),
  apiPayload: null,
  products: [],
  settings: loadSettings(),
  costs: loadCosts(),
  filter: "",
  sort: "profit",
};

let lastLoadedAt = 0;
let loadDataPromise = null;
let settingsSaveTimer = null;

const els = typeof document !== "undefined" ? {
  runStatus: document.querySelector("#run-status"),
  setupPanel: document.querySelector("#setup-panel"),
  setupBadge: document.querySelector("#setup-badge"),
  setupTitle: document.querySelector("#setup-title"),
  setupMessage: document.querySelector("#setup-message"),
  setupPrimary: document.querySelector("#setup-primary"),
  setupSecondary: document.querySelector("#setup-secondary"),
  setupKeyState: document.querySelector("#setup-key-state"),
  setupBrowseState: document.querySelector("#setup-browse-state"),
  setupPagesState: document.querySelector("#setup-pages-state"),
  automationHealth: document.querySelector("#automation-health"),
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
  observationList: document.querySelector("#observation-list"),
  observationSummary: document.querySelector("#observation-summary"),
  filterInput: document.querySelector("#filter-input"),
  sortSelect: document.querySelector("#sort-select"),
  qualityNotice: document.querySelector("#data-quality-notice"),
  template: document.querySelector("#product-card-template"),
  observationTemplate: document.querySelector("#observation-card-template"),
  settingsForm: document.querySelector("#settings-form"),
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
  return product.sales_auto_verified === true && product.sales_confidence === "high";
}

function isDemoPayload(payload = {}) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.demo_data === true) return true;
  const productionStatus = String(payload.automation?.production_api?.status || "").toLowerCase();
  if (productionStatus.startsWith("demo")) return true;
  return (payload.products || []).some((product) => {
    const title = String(product?.title || "").toUpperCase();
    const source = String(product?.source || "").toLowerCase();
    return title.startsWith("DEMO:") || source.startsWith("demo_") || source.includes("demo_production");
  });
}

function shouldUsePayloadProducts(setupStatus, payload) {
  return setupStatus?.ready === true && !isDemoPayload(payload);
}

function shouldRefreshData(lastLoadedAt, now = Date.now(), maxAgeMs = DATA_REFRESH_MAX_AGE_MS) {
  const loaded = Number(lastLoadedAt);
  const current = Number(now);
  if (!Number.isFinite(loaded) || loaded <= 0) return true;
  if (!Number.isFinite(current) || current < loaded) return true;
  return current - loaded >= Math.max(0, Number(maxAgeMs) || DATA_REFRESH_MAX_AGE_MS);
}

function selectPayloadProducts(setupStatus, payload) {
  return shouldUsePayloadProducts(setupStatus, payload) && Array.isArray(payload?.products)
    ? payload.products
    : [];
}

function safeExternalUrl(rawUrl, allowedHosts, fallbackUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    const hostname = url.hostname.toLowerCase();
    const allowed = (allowedHosts || []).some((host) => {
      const normalized = String(host || "").toLowerCase().replace(/^\./, "");
      return normalized && (hostname === normalized || hostname.endsWith(`.${normalized}`));
    });
    return url.protocol === "https:" && allowed ? url.href : fallbackUrl;
  } catch (_) {
    return fallbackUrl;
  }
}

function payloadExchangeRate() {
  return number(state.apiPayload?.cost_defaults?.exchange_rate?.rate, number(state.apiPayload?.cost_defaults?.exchange_rate, 0));
}

function effectiveExchangeRate() {
  if (state.settings.autoExchangeRate) {
    const auto = payloadExchangeRate();
    if (auto > 0) return auto;
  }
  return number(state.settings.exchangeRate, 150);
}

function normalizeProduct(product) {
  const originCode = String(product.country_of_origin || "");
  const scenario = tariffScenario(originCode);
  const point = number(product.sold_90d_est, 0);
  const low = number(product.sold_90d_low, 0);
  return {
    sold_90d_est: point,
    sold_90d_low: low,
    sold_90d_high: number(product.sold_90d_high, point),
    sold_90d_decision: number(product.sold_90d_decision, low),
    sales_confidence: product.sales_confidence || (product.sales_auto_verified ? "high" : "learning"),
    sales_quality: product.sales_quality || "insufficient",
    sales_observed_days: number(product.sales_observed_days, 0),
    sales_observed_delta: number(product.sales_observed_delta, 0),
    sales_tracked_listings: number(product.sales_tracked_listings, 0),
    sales_lifetime_reference: number(product.sales_lifetime_reference, 0),
    sales_auto_verified: product.sales_auto_verified === true,
    competition_known: product.competition_known !== false,
    competition_confidence: product.competition_confidence || "unknown",
    country_of_origin: originCode,
    tariff: product.tariff || { rate: scenario.rate / 100, confidence: "unknown", confirmation_required: true, screening_only: true },
    rakuten: product.rakuten || { enabled: false, match_count: 0, confidence: "disabled", items: [] },
    auto_costs: product.auto_costs || {
      procurement_jpy: 0,
      domestic_shipping_jpy: 0,
      international_shipping_jpy: number(state.settings.defaultInternationalShippingJpy, 2800),
      packaging_jpy: number(state.settings.defaultPackagingJpy, 150),
      tariff_rate: scenario.rate / 100,
    },
    ...product,
  };
}

function productDefaults(product) {
  const auto = product.auto_costs || {};
  const rakutenBest = product.rakuten?.items?.[0] || {};
  const backendTariff = number(auto.tariff_rate, number(product.tariff?.rate, NaN));
  const tariffRate = Number.isFinite(backendTariff)
    ? backendTariff * (backendTariff <= 1 ? 100 : 1)
    : tariffScenario(product.country_of_origin).rate;
  return {
    salePriceUsd: number(product.price_median_usd),
    buyerShippingUsd: 0,
    procurementJpy: number(auto.procurement_jpy, number(rakutenBest.price_jpy, 0)),
    domesticShippingJpy: number(auto.domestic_shipping_jpy, rakutenBest.postage_included === true ? 0 : (rakutenBest.price_jpy ? state.settings.defaultDomesticShippingJpy : 0)),
    internationalShippingJpy: number(auto.international_shipping_jpy, state.settings.defaultInternationalShippingJpy),
    packagingJpy: number(auto.packaging_jpy, state.settings.defaultPackagingJpy),
    customsFixedJpy: 0,
    originCode: String(product.country_of_origin || ""),
    tariffRate,
    supplierConfirmed: false,
    tariffConfirmed: false,
  };
}

function getCostValues(product) {
  return { ...productDefaults(product), ...(state.costs[product.part_number] || {}) };
}

function calculateProfit(product) {
  const values = getCostValues(product);
  const salePriceUsd = number(values.salePriceUsd, number(product.price_median_usd));
  const buyerShippingUsd = number(values.buyerShippingUsd);
  const exchangeRate = effectiveExchangeRate();
  const grossJpy = (salePriceUsd + buyerShippingUsd) * exchangeRate;
  const buyerSalesTaxUsd = (salePriceUsd + buyerShippingUsd) * number(state.settings.buyerSalesTaxRate, 0) / 100;
  const feeBaseUsd = salePriceUsd + buyerShippingUsd + buyerSalesTaxUsd;

  const profile = feeProfile(state.settings, product);
  const lowerFeeBaseUsd = Math.min(feeBaseUsd, profile.thresholdUsd);
  const upperFeeBaseUsd = Math.max(0, feeBaseUsd - profile.thresholdUsd);
  const percentageFeeUsd = lowerFeeBaseUsd * profile.rate / 100
    + upperFeeBaseUsd * profile.aboveRate / 100
    + feeBaseUsd * number(state.settings.additionalFvfRate) / 100;
  const perOrderFeeUsd = feeBaseUsd <= 10 ? 0.30 : 0.40;
  const finalValueFeeJpy = (percentageFeeUsd + perOrderFeeUsd) * exchangeRate;
  const internationalRate = internationalFeeRate(state.settings.monthlySalesUsd);
  const internationalFeeJpy = feeBaseUsd * internationalRate / 100 * exchangeRate;
  const promotedFeeJpy = feeBaseUsd * number(state.settings.promotedRate) / 100 * exchangeRate;
  const insertionFeeJpy = Math.max(0, number(state.settings.insertionFeeUsd)) * exchangeRate;
  const ebayFeesBeforeTax = finalValueFeeJpy + internationalFeeJpy + promotedFeeJpy + insertionFeeJpy;
  const ebayFeeTaxJpy = ebayFeesBeforeTax * number(state.settings.ebayFeeTaxRate, 10) / 100;
  const ebayFee = ebayFeesBeforeTax + ebayFeeTaxJpy;

  const payoutBeforePayoneer = Math.max(0, grossJpy - ebayFee);
  const manualAnnualAllocation = Math.max(0, number(state.settings.payoneerAnnualAllocationJpy));
  const annualFeeApplicable = state.settings.includePayoneerAnnualFee !== false
    && number(state.settings.monthlySalesUsd) * 12 < 6000;
  const estimatedAnnualOrders = number(state.settings.monthlySalesUsd) > 0
    ? Math.max(12, number(state.settings.monthlySalesUsd) * 12 / Math.max(salePriceUsd + buyerShippingUsd, 1))
    : 12;
  const automaticAnnualAllocation = annualFeeApplicable ? 29.95 * exchangeRate / estimatedAnnualOrders : 0;
  const payoneerAnnualAllocation = manualAnnualAllocation > 0 ? manualAnnualAllocation : automaticAnnualAllocation;
  const payoneerFee = payoutBeforePayoneer * number(state.settings.payoneerWithdrawalRate, 3) / 100
    + number(state.settings.payoneerFixedJpy)
    + payoneerAnnualAllocation;

  const tariffRate = Math.max(0, number(values.tariffRate, tariffScenario(values.originCode).rate));
  const tariff = salePriceUsd * exchangeRate * tariffRate / 100;
  const returnReserve = grossJpy * number(state.settings.returnReserveRate) / 100;
  const fixedCosts = number(values.procurementJpy)
    + number(values.domesticShippingJpy)
    + number(values.internationalShippingJpy)
    + number(values.packagingJpy)
    + number(values.customsFixedJpy);
  const totalCost = ebayFee + payoneerFee + tariff + returnReserve + fixedCosts;
  const profit = grossJpy - totalCost;
  const margin = grossJpy > 0 ? profit / grossJpy : 0;

  const hasProcurement = number(values.procurementJpy) > 0;
  const hasShipping = number(values.internationalShippingJpy) > 0;
  const salesVerified = isSalesAutoVerified(product);
  const decisionSold = number(product.sold_90d_decision, number(product.sold_90d_low, 0));
  const operationalChecks = [
    [profit >= number(state.settings.minimumProfitJpy), "利益"],
    [margin >= number(state.settings.minimumMarginRate) / 100, "利益率"],
    [decisionSold >= number(state.settings.minimumSold90d), "販売ペース下限"],
    [product.competition_known !== false, "競合データ"],
    [number(product.market_score) >= number(state.settings.minimumMarketScore), "市場スコア"],
    [number(product.demand_ratio) >= number(state.settings.minimumDemandRatio), "販売÷競合"],
  ];
  const operationalFailed = operationalChecks.filter(([passed]) => !passed).map(([, label]) => label);
  const confirmationChecks = [
    [salesVerified, "販売差分30日"],
    [values.supplierConfirmed === true, "仕入条件"],
    [values.tariffConfirmed === true, "原産国・関税"],
  ];
  const confirmationFailed = confirmationChecks.filter(([passed]) => !passed).map(([, label]) => label);
  const hasCosts = hasProcurement && hasShipping;
  const passes = hasCosts && operationalFailed.length === 0 && confirmationFailed.length === 0;
  const provisional = hasCosts && operationalFailed.length === 0 && confirmationFailed.length > 0;

  let judgment = "自動観測中";
  if (!salesVerified) judgment = "自動観測中";
  else if (!hasProcurement) judgment = "仕入価格を確認";
  else if (!hasShipping) judgment = "送料を確認";
  else if (profit <= 0) judgment = "赤字見込み";
  else if (operationalFailed.length) judgment = `再検討：${operationalFailed.join("・")}`;
  else if (provisional) judgment = `概算候補：${confirmationFailed.join("・")}待ち`;
  else if (passes) judgment = "購入候補";

  return {
    values, salePriceUsd, exchangeRate, grossJpy, buyerSalesTaxUsd, feeBaseUsd,
    feeProfile: profile, internationalRate, perOrderFeeUsd, finalValueFeeJpy,
    internationalFeeJpy, promotedFeeJpy, insertionFeeJpy, ebayFeeTaxJpy, ebayFee,
    payoneerFee, payoneerAnnualAllocation, annualFeeApplicable, tariffRate, tariff,
    returnReserve, totalCost, profit, margin, hasProcurement, hasShipping, hasCosts,
    salesVerified, decisionSold, operationalFailed, confirmationFailed, passes,
    provisional, judgment,
  };
}

function badgeClass(judgment) {
  const text = String(judgment || "");
  if (["有望", "購入候補"].includes(text)) return "badge-good";
  if (["候補", "監視", "競合未取得", "自動観測中", "仕入価格を確認", "送料を確認"].includes(text)
      || text.startsWith("再検討") || text.startsWith("概算候補")) return "badge-warn";
  if (["見送り", "赤字見込み"].includes(text)) return "badge-bad";
  return "badge-info";
}

function combinedJudgment(product, profit = calculateProfit(product)) {
  if (!profit.salesVerified) return "自動観測中";
  if (profit.hasCosts) {
    if (profit.passes) return "購入候補";
    if (profit.profit <= 0) return "見送り";
    if (profit.operationalFailed.length === 0) return "概算候補";
    return "再検討";
  }
  if (!profit.hasProcurement) return "仕入確認";
  return product.market_judgment || "データ不足";
}

function nextAction(product, profit = calculateProfit(product), setupStatus = state.setupStatus) {
  const setup = setupPresentation(setupStatus);
  if (!setupStatus?.ready) return setup.action;
  if (!profit.salesVerified) return "操作不要。販売差分を自動観測中";
  if (profit.operationalFailed.some((label) => ["販売ペース下限", "競合データ", "市場スコア", "販売÷競合"].includes(label))) {
    return `${profit.operationalFailed[0]}が基準未達。次候補へ進む`;
  }
  if (!profit.hasProcurement) return "楽天／モノタロウで仕入価格を確認";
  if (profit.profit <= 0) return "仕入価格か販売価格を見直す";
  if (profit.operationalFailed.length) return `${profit.operationalFailed[0]}が基準未達。次候補へ進む`;
  if (profit.values.supplierConfirmed !== true) return "仕入先で価格・在庫・送料を確認";
  if (profit.values.tariffConfirmed !== true) return "原産国とDDP関税を確認";
  if (profit.passes) return "購入候補。仕入判断へ進む";
  return product.next_action || "詳細を確認";
}

function setupPresentation(status = DEFAULT_SETUP_STATUS) {
  const links = { ...DEFAULT_SETUP_STATUS.links, ...(status.links || {}) };
  const code = String(status.status || "not_checked");
  const map = {
    not_checked: {
      badge: "初回設定",
      tone: "warn",
      title: "最初にProduction APIを接続します",
      message: "APIキーを2つ登録し、初回調査を1回実行してください。以後は毎日自動です。",
      action: "Production APIキーを登録",
      href: links.secrets,
      secondary: "調査画面を開く",
      secondaryHref: links.workflow,
    },
    missing_secrets: {
      badge: "キー未登録",
      tone: "warn",
      title: "Production APIキーを登録してください",
      message: "EBAY_CLIENT_IDとEBAY_CLIENT_SECRETが未登録です。ソースコードへは書かず、GitHub Secretsへ登録します。",
      action: "APIキーを登録",
      href: links.secrets,
      secondary: "登録後に調査を実行",
      secondaryHref: links.workflow,
    },
    auth_failed: {
      badge: "認証失敗",
      tone: "bad",
      title: "Productionキーの組み合わせを確認してください",
      message: status.message || "Production App IDまたはCert IDが正しくありません。",
      action: "Secretsを修正",
      href: links.secrets,
      secondary: "再実行",
      secondaryHref: links.workflow,
    },
    browse_access_denied: {
      badge: "Browse権限待ち",
      tone: "bad",
      title: "キーは有効ですがBrowse APIのProduction承認が必要です",
      message: "Productionキーを持っていてもBuy/Browse APIの本番利用権限は別です。eBayの利用条件を確認してください。",
      action: "利用条件を確認",
      href: links.buy_api_access,
      secondary: "再実行",
      secondaryHref: links.workflow,
    },
    call_budget_exceeded: {
      badge: "安全停止",
      tone: "warn",
      title: "本日のAPI安全上限で停止しました",
      message: "取得済みデータは保持されています。操作は不要で、次回の自動実行から続行します。",
      action: "実行状況を見る",
      href: links.workflow,
      secondary: "設定を確認",
      secondaryHref: links.secrets,
    },
    rate_limited: {
      badge: "API上限",
      tone: "warn",
      title: "eBay側のAPI上限に達しました",
      message: "既存結果は保持されています。次回の自動実行を待ってください。",
      action: "実行状況を見る",
      href: links.workflow,
      secondary: "利用条件を確認",
      secondaryHref: links.buy_api_access,
    },
    temporary_error: {
      badge: "一時エラー",
      tone: "warn",
      title: "一時的なAPIエラーです",
      message: status.message || "既存結果は保持されています。再実行してください。",
      action: "調査を再実行",
      href: links.workflow,
      secondary: "Secretsを確認",
      secondaryHref: links.secrets,
    },
    ready_partial: {
      badge: "自動運転中",
      tone: "good",
      title: "Production API接続済み・安全上限で分割実行中",
      message: "取得済みデータは保存済みです。次回の自動実行で続きを処理します。",
      action: "今日やるを見る",
      href: "#tab-today",
      secondary: "実行状況を見る",
      secondaryHref: links.workflow,
    },
    ready: {
      badge: "接続済み",
      tone: "good",
      title: "Production Browse APIで自動運転中です",
      message: status.message || "販売差分、競合、相場、利益を毎日自動更新します。",
      action: "今日やるを見る",
      href: "#tab-today",
      secondary: "実行状況を見る",
      secondaryHref: links.workflow,
    },
  };
  return map[code] || {
    badge: code,
    tone: status.ready ? "good" : "warn",
    title: status.message || "接続状態を確認してください",
    message: status.next_action || "GitHub Actionsの実行状況を確認してください。",
    action: "実行状況を見る",
    href: links.workflow,
    secondary: "Secretsを確認",
    secondaryHref: links.secrets,
  };
}

function observationProgress(product) {
  const days = Math.max(0, number(product.sales_observed_days, 0));
  const confidence = String(product.sales_confidence || "unknown");
  const target = 30;
  return {
    days,
    target,
    percent: Math.max(0, Math.min(100, days / target * 100)),
    complete: isSalesAutoVerified(product),
    label: SALES_CONFIDENCE_LABELS[confidence] || confidence,
    remainingDays: Math.max(0, Math.ceil(target - days)),
  };
}

function mergeProducts() {
  state.products = selectPayloadProducts(state.setupStatus, state.apiPayload).map(normalizeProduct);
}

function productSortValue(product, mode) {
  const profit = calculateProfit(product);
  if (mode === "sold") return number(product.sold_90d_decision, 0);
  if (mode === "competition") return -number(product.active_competition, 999999);
  if (mode === "price") return number(product.price_median_usd);
  if (mode === "score") return number(product.market_score);
  return profit.salesVerified ? profit.profit : -1e9 + number(product.market_score);
}

function getVisibleProducts() {
  const products = state.products.filter((product) => {
    const haystack = `${product.part_number} ${product.brand} ${product.title}`.toLowerCase();
    return haystack.includes(state.filter.toLowerCase());
  });
  products.sort((a, b) => productSortValue(b, state.sort) - productSortValue(a, state.sort));
  return products;
}

function renderSetup() {
  if (!els.setupPanel) return;
  const view = setupPresentation(state.setupStatus);
  els.setupPanel.className = `setup-panel setup-${view.tone}`;
  els.setupBadge.textContent = view.badge;
  els.setupBadge.className = `health-badge badge-${view.tone === "good" ? "good" : view.tone === "bad" ? "bad" : "warn"}`;
  els.setupTitle.textContent = view.title;
  els.setupMessage.textContent = view.message;
  els.setupPrimary.textContent = view.action;
  els.setupPrimary.href = view.href;
  els.setupSecondary.textContent = view.secondary;
  els.setupSecondary.href = view.secondaryHref;

  const code = String(state.setupStatus.status || "not_checked");
  const keyOk = state.setupStatus.ready || !["not_checked", "missing_secrets", "auth_failed"].includes(code);
  const browseOk = state.setupStatus.ready;
  els.setupKeyState.textContent = keyOk ? "完了" : "未完了";
  els.setupKeyState.className = keyOk ? "step-state state-done" : "step-state state-pending";
  els.setupBrowseState.textContent = browseOk ? "完了" : code === "browse_access_denied" ? "承認待ち" : "未確認";
  els.setupBrowseState.className = browseOk ? "step-state state-done" : "step-state state-pending";
  els.setupPagesState.textContent = "この画面が開けば完了";
  els.setupPagesState.className = "step-state state-info";
}

function renderAutomation() {
  const automation = state.apiPayload?.automation || {};
  const production = automation.production_api || state.setupStatus.details || {};
  const generated = state.apiPayload?.generated_at ? new Date(state.apiPayload.generated_at) : null;
  const ageHours = generated && !Number.isNaN(generated.getTime()) ? (Date.now() - generated.getTime()) / 3600000 : Infinity;
  const fresh = state.setupStatus.ready && ageHours <= 48;
  els.automationHealth.textContent = fresh ? "自動運転中" : state.setupStatus.ready ? "更新を確認" : "初回設定中";
  els.automationHealth.className = `health-badge ${fresh ? "badge-good" : "badge-warn"}`;
  if (!state.setupStatus.ready) {
    els.flowResearch.textContent = "Productionキー登録後、検索語を自動ローテーション";
    els.flowMarket.textContent = "初回に基準値を保存し、翌日以降の増分だけを計測";
    els.flowProcurement.textContent = "楽天APIは任意。モノタロウ・楽天は1タップ検索";
    return;
  }
  els.flowResearch.textContent = automation.queries_per_run
    ? `1回${number(automation.queries_per_run)}語／監視${number(automation.watchlist_size)}品番／API ${number(production.calls_used)}回`
    : "Production Browse APIで毎日自動実行";
  els.flowMarket.textContent = automation.snapshot_runs
    ? `販売差分の記録 ${number(automation.snapshot_runs)}回。30日以上で高信頼判定`
    : "初回は基準値を保存し、翌日以降の増分だけを販売として計測";
  els.flowProcurement.textContent = automation.rakuten_enabled
    ? "楽天公式API接続済み。品番一致価格を自動入力"
    : "楽天APIは任意。未設定でも検索ボタンで1タップ確認";
}

function updateGlobalNextTask(sorted) {
  const setup = setupPresentation(state.setupStatus);
  if (!state.setupStatus.ready) {
    els.nextTaskTitle.textContent = setup.title;
    els.nextTaskDetail.textContent = setup.message;
    return;
  }
  if (!sorted.length) {
    els.nextTaskTitle.textContent = "自動調査を1回実行してください";
    els.nextTaskDetail.textContent = "検索語は空欄のままで構いません。実行後は毎日自動で更新されます。";
    return;
  }
  const rows = sorted.map((product) => ({ product, profit: calculateProfit(product) }));
  const ready = rows.find(({ profit }) => profit.passes);
  if (ready) {
    els.nextTaskTitle.textContent = `${ready.product.part_number}が購入候補です`;
    els.nextTaskDetail.textContent = "在庫、適合、原産国、DDP請求額を最終確認して仕入判断へ進みます。";
    return;
  }
  const supplierPending = rows.find(({ profit }) => profit.salesVerified && profit.provisional && profit.values.supplierConfirmed !== true);
  if (supplierPending) {
    els.nextTaskTitle.textContent = `${supplierPending.product.part_number}の仕入条件を確認`;
    els.nextTaskDetail.textContent = "楽天またはモノタロウを押し、税込価格・在庫・国内送料を確認してください。";
    return;
  }
  const tariffPending = rows.find(({ profit }) => profit.salesVerified && profit.provisional && profit.values.tariffConfirmed !== true);
  if (tariffPending) {
    els.nextTaskTitle.textContent = `${tariffPending.product.part_number}の原産国・DDP関税を確認`;
    els.nextTaskDetail.textContent = "画面の関税率は一次選別用です。仕入前に実際のDDP見積を確認してください。";
    return;
  }
  const procurementMissing = rows.find(({ profit, product }) => profit.salesVerified && !profit.hasProcurement && number(product.market_score) >= number(state.settings.minimumMarketScore));
  if (procurementMissing) {
    els.nextTaskTitle.textContent = `${procurementMissing.product.part_number}の仕入価格を確認`;
    els.nextTaskDetail.textContent = "楽天またはモノタロウを押し、見つかった価格だけ入力してください。";
    return;
  }
  const learning = rows.find(({ profit }) => !profit.salesVerified);
  if (learning) {
    const progress = observationProgress(learning.product);
    els.nextTaskTitle.textContent = "販売差分を自動観測中です";
    els.nextTaskDetail.textContent = progress.days > 0
      ? `${learning.product.part_number}は${progress.days.toFixed(1)}日観測済みです。操作は不要です。`
      : "初回基準値を保存済みです。翌日以降の販売増分を自動計測します。";
    return;
  }
  els.nextTaskTitle.textContent = "現在は人の操作がありません";
  els.nextTaskDetail.textContent = "候補が基準未達です。次回の自動巡回を待ってください。";
}

function render() {
  mergeProducts();
  const visible = getVisibleProducts();
  const allSorted = [...state.products].sort((a, b) => productSortValue(b, "profit") - productSortValue(a, "profit"));

  els.productList.replaceChildren();
  visible.forEach((product, index) => els.productList.append(createProductCard(product, index + 1)));
  els.emptyState.hidden = visible.length !== 0;

  const todayProducts = allSorted.filter((product) => {
    const profit = calculateProfit(product);
    return profit.passes || profit.provisional || (profit.salesVerified && number(product.market_score) >= number(state.settings.minimumMarketScore));
  }).slice(0, 5);
  els.topProductList.replaceChildren();
  todayProducts.forEach((product, index) => els.topProductList.append(createProductCard(product, index + 1)));
  els.topEmptyState.hidden = todayProducts.length !== 0;

  const verified = state.products.filter(isSalesAutoVerified).length;
  const promising = state.products.filter((product) => ["購入候補", "概算候補"].includes(combinedJudgment(product))).length;
  els.summaryCount.textContent = String(state.products.length);
  els.summaryVerified.textContent = String(verified);
  els.summaryPromising.textContent = String(promising);
  els.summaryQuery.textContent = state.apiPayload?.query || "初回調査前";

  renderSetup();
  renderAutomation();
  renderObservations();
  updateGlobalNextTask(allSorted);
}

function createProductCard(product, rank) {
  const fragment = els.template.content.cloneNode(true);
  const card = fragment.querySelector(".product-card");
  const profit = calculateProfit(product);
  const judgment = combinedJudgment(product, profit);
  const values = profit.values;
  const encodedPart = encodeURIComponent(product.part_number);
  const originCode = String(values.originCode || product.country_of_origin || "");

  card.dataset.partNumber = product.part_number;
  card.querySelector(".rank-label").textContent = `#${rank}`;
  card.querySelector(".brand-label").textContent = product.brand || "Unknown";
  card.querySelector(".part-number").textContent = product.part_number;
  card.querySelector(".product-title").textContent = product.title || "";
  const badge = card.querySelector(".judgment-badge");
  badge.textContent = judgment;
  badge.className = `judgment-badge ${badgeClass(judgment)}`;

  const decisionSold = number(product.sold_90d_decision, 0);
  card.querySelector(".sold-value").textContent = isSalesAutoVerified(product) ? `${decisionSold.toFixed(1)}個以上` : "学習中";
  const competitionPrefix = product.competition_confidence === "high" ? "" : "約";
  card.querySelector(".competition-value").textContent = product.competition_known === false
    ? "不明"
    : `${competitionPrefix}${number(product.active_competition)}件`;
  card.querySelector(".price-value").textContent = usd(product.price_median_usd);
  card.querySelector(".profit-value-main").textContent = profit.salesVerified && profit.hasCosts ? yen(profit.profit) : "未確定";

  card.querySelector(".quality-label").textContent = SALES_CONFIDENCE_LABELS[product.sales_confidence]
    || QUALITY_LABELS[product.sales_quality]
    || "データ不足";
  card.querySelector(".observation-label").textContent = `${number(product.sales_observed_days).toFixed(1)}日 / ${number(product.sales_tracked_listings)}出品追跡`;
  const low = number(product.sold_90d_low, 0);
  const high = number(product.sold_90d_high, 0);
  const tracking = number(product.sales_observed_days) < 7
    ? `累計表示${number(product.sales_lifetime_reference)}個は判定に不使用 / `
    : `観測増分${number(product.sales_observed_delta)}個 / `;
  card.querySelector(".range-note").textContent = `${tracking}保守下限${low.toFixed(1)}～上限${high.toFixed(1)}個 / 出品相場 ${usd(product.price_p25_usd)}～${usd(product.price_p75_usd)} / スコア${number(product.market_score)}`;

  card.querySelector(".procurement-value").textContent = number(values.procurementJpy) > 0 ? yen(values.procurementJpy) : "未取得";
  card.querySelector(".shipping-value").textContent = yen(values.internationalShippingJpy);
  card.querySelector(".origin-value").textContent = ORIGIN_LABELS[originCode] || originCode || "不明";
  card.querySelector(".tariff-rate-value").textContent = `${number(values.tariffRate).toFixed(1)}%`;
  card.querySelector(".next-action-text").textContent = nextAction(product, profit);

  const rakutenBest = product.rakuten?.items?.[0];
  const rakutenLink = card.querySelector(".rakuten-link");
  const rakutenFallback = `https://search.rakuten.co.jp/search/mall/${encodedPart}/`;
  rakutenLink.href = safeExternalUrl(rakutenBest?.url, ["rakuten.co.jp"], rakutenFallback);
  rakutenLink.textContent = rakutenBest ? `楽天 ${yen(rakutenBest.price_jpy)}` : "楽天を見る";
  card.querySelector(".monotaro-link").href = `https://www.monotaro.com/s/q-${encodedPart}/`;
  const ebayFallback = `https://www.ebay.com/sch/i.html?_nkw=${encodedPart}&_sacat=6028`;
  card.querySelector(".ebay-link").href = safeExternalUrl(product.ebay_url, ["ebay.com"], ebayFallback);

  for (const input of card.querySelectorAll("[data-cost]")) {
    const key = input.dataset.cost;
    applyCostValuesToControls([input], values);

    input.addEventListener(input.type === "number" ? "input" : "change", () => {
      state.costs[product.part_number] ||= {};
      if (input.type === "checkbox") state.costs[product.part_number][key] = input.checked;
      else if (input.tagName === "SELECT") state.costs[product.part_number][key] = input.value;
      else state.costs[product.part_number][key] = number(input.value);
      if (key === "originCode") {
        state.costs[product.part_number].tariffRate = tariffScenario(input.value).rate;
        const tariffInput = card.querySelector('[data-cost="tariffRate"]');
        if (tariffInput) tariffInput.value = state.costs[product.part_number].tariffRate;
      }
      saveJson(STORAGE_KEYS.costs, state.costs);
      updateAllCardsForProduct(product.part_number);
    });
  }
  updateProfitArea(card, product);
  return fragment;
}

function applyCostValuesToControls(controls, values) {
  for (const control of controls || []) {
    const key = control?.dataset?.cost;
    if (!key) continue;
    if (control.type === "checkbox") {
      control.checked = values?.[key] === true;
    } else if (control.tagName === "SELECT") {
      const selectValue = String(values?.[key] ?? "");
      const options = Array.from(control.options || []);
      control.value = options.some((option) => option.value === selectValue)
        ? selectValue
        : (selectValue ? "OTHER" : "");
    } else {
      control.value = number(values?.[key], 0) || "";
    }
  }
}

function updateAllCardsForProduct(partNumber) {
  const product = state.products.find((row) => row.part_number === partNumber);
  if (!product || typeof document === "undefined") return;
  const values = getCostValues(product);
  document.querySelectorAll(`.product-card[data-part-number="${CSS.escape(partNumber)}"]`).forEach((card) => {
    applyCostValuesToControls(card.querySelectorAll("[data-cost]"), values);
    updateProfitArea(card, product);
  });
  const sorted = [...state.products].sort((a, b) => productSortValue(b, "profit") - productSortValue(a, "profit"));
  updateGlobalNextTask(sorted);
}

function updateProfitArea(card, product) {
  const profit = calculateProfit(product);
  const values = profit.values;
  const originCode = String(values.originCode || product.country_of_origin || "");
  card.querySelector(".profit-value-main").textContent = profit.salesVerified && profit.hasCosts ? yen(profit.profit) : "未確定";
  card.querySelector(".procurement-value").textContent = number(values.procurementJpy) > 0 ? yen(values.procurementJpy) : "未取得";
  card.querySelector(".shipping-value").textContent = yen(values.internationalShippingJpy);
  card.querySelector(".origin-value").textContent = ORIGIN_LABELS[originCode] || originCode || "不明";
  card.querySelector(".tariff-rate-value").textContent = `${number(values.tariffRate).toFixed(1)}%`;
  card.querySelector(".next-action-text").textContent = nextAction(product, profit);
  card.querySelector(".fee-profile-note").textContent = `eBay料率: ${profit.feeProfile.label} ${profit.feeProfile.rate}%（超過分 ${profit.feeProfile.aboveRate}%）`;
  card.querySelector(".ebay-fee-value").textContent = yen(profit.ebayFee);
  card.querySelector(".payoneer-value").textContent = yen(profit.payoneerFee);
  card.querySelector(".tariff-value").textContent = yen(profit.tariff);
  card.querySelector(".cost-value").textContent = yen(profit.totalCost);
  card.querySelector(".profit-value").textContent = yen(profit.profit);
  card.querySelector(".margin-value").textContent = percent(profit.margin);
  const result = card.querySelector(".profit-judgment");
  result.textContent = profit.judgment;
  result.className = `profit-judgment ${badgeClass(profit.judgment)}`;
  const badge = card.querySelector(".judgment-badge");
  const judgment = combinedJudgment(product, profit);
  badge.textContent = judgment;
  badge.className = `judgment-badge ${badgeClass(judgment)}`;
}

function renderObservations() {
  if (!els.observationList) return;
  const products = [...state.products].sort((a, b) => number(b.sales_observed_days) - number(a.sales_observed_days));
  const verified = products.filter(isSalesAutoVerified).length;
  const learning = products.filter((product) => !isSalesAutoVerified(product)).length;
  els.observationSummary.textContent = products.length
    ? `${products.length}品番を追跡中／高信頼${verified}品番／学習中${learning}品番。入力作業はありません。`
    : "初回調査後、ここに品番ごとの観測日数が表示されます。";
  els.observationList.replaceChildren();
  for (const product of products) {
    const progress = observationProgress(product);
    const fragment = els.observationTemplate.content.cloneNode(true);
    fragment.querySelector(".observation-part").textContent = product.part_number;
    fragment.querySelector(".observation-confidence").textContent = progress.label;
    fragment.querySelector(".observation-confidence").className = `observation-confidence ${progress.complete ? "badge-good" : "badge-info"}`;
    fragment.querySelector(".observation-progress-bar").style.width = `${progress.percent}%`;
    fragment.querySelector(".observation-days").textContent = `${progress.days.toFixed(1)} / ${progress.target}日`;
    fragment.querySelector(".observation-detail").textContent = progress.complete
      ? `追跡${number(product.sales_tracked_listings)}出品／観測増分${number(product.sales_observed_delta)}個／判定下限${number(product.sold_90d_decision).toFixed(1)}個`
      : `あと約${progress.remainingDays}日／追跡${number(product.sales_tracked_listings)}出品。操作不要です。`;
    els.observationList.append(fragment);
  }
}

function populateSettingsForm() {
  if (!els.settingsForm) return;
  for (const [key, value] of Object.entries(state.settings)) {
    const input = els.settingsForm.elements.namedItem(key);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = value === true;
    else input.value = value;
  }
}

function collectSettings() {
  const formData = new FormData(els.settingsForm);
  const next = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const input = els.settingsForm.elements.namedItem(key);
    if (!input) continue;
    if (input.type === "checkbox") next[key] = input.checked;
    else if (key === "sellerPlan") next[key] = String(formData.get(key) || DEFAULT_SETTINGS[key]);
    else next[key] = number(formData.get(key), DEFAULT_SETTINGS[key]);
  }
  return next;
}

function persistSettings() {
  if (!els.settingsForm) return;
  state.settings = collectSettings();
  saveJson(STORAGE_KEYS.settings, state.settings);
  render();
}

function scheduleSettingsSave() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(persistSettings, 180);
}

function exportCsv() {
  const headers = [
    "品番", "メーカー", "判定", "次にすること", "90日販売下限", "90日推定", "販売精度", "観測日数", "追跡出品数", "観測増分", "競合数", "相場中央値USD",
    "仕入価格円", "国際送料円", "原産国", "関税率", "eBay料率区分", "eBay手数料消費税込円", "Payoneer円", "関税円", "予想利益円", "利益率",
  ];
  const rows = state.products.map((product) => {
    const profit = calculateProfit(product);
    return [
      product.part_number, product.brand, combinedJudgment(product, profit), nextAction(product, profit),
      product.sold_90d_decision, product.sold_90d_est,
      SALES_CONFIDENCE_LABELS[product.sales_confidence] || product.sales_confidence,
      product.sales_observed_days, product.sales_tracked_listings, product.sales_observed_delta,
      product.active_competition, product.price_median_usd,
      number(profit.values.procurementJpy), number(profit.values.internationalShippingJpy),
      ORIGIN_LABELS[profit.values.originCode] || profit.values.originCode, profit.tariffRate,
      profit.feeProfile.label, Math.round(profit.ebayFee), Math.round(profit.payoneerFee), Math.round(profit.tariff),
      Math.round(profit.profit), (profit.margin * 100).toFixed(1),
    ];
  });
  const csv = [headers, ...rows]
    .map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `part-scout-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function applyPayloadDefaults() {
  const defaults = state.apiPayload?.cost_defaults || {};
  if (number(defaults.default_international_shipping_jpy) > 0
      && state.settings.defaultInternationalShippingJpy === DEFAULT_SETTINGS.defaultInternationalShippingJpy) {
    state.settings.defaultInternationalShippingJpy = number(defaults.default_international_shipping_jpy);
  }
  if (number(defaults.default_packaging_jpy) > 0
      && state.settings.defaultPackagingJpy === DEFAULT_SETTINGS.defaultPackagingJpy) {
    state.settings.defaultPackagingJpy = number(defaults.default_packaging_jpy);
  }
}

async function fetchJson(url, fallback) {
  try {
    const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn(`Failed to load ${url}:`, error);
    return clone(fallback);
  }
}

async function loadData() {
  if (loadDataPromise) return loadDataPromise;
  loadDataPromise = (async () => {
    els.runStatus.textContent = "接続状態とeBayデータを読み込んでいます…";
    const [setup, payload] = await Promise.all([
      fetchJson("./data/setup_status.json", DEFAULT_SETUP_STATUS),
      fetchJson("./data/results.json", { products: [], automation: {}, cost_defaults: {}, query: "初回調査前" }),
    ]);
    state.setupStatus = { ...clone(DEFAULT_SETUP_STATUS), ...setup, links: { ...DEFAULT_SETUP_STATUS.links, ...(setup.links || {}) } };
    state.apiPayload = payload;
    applyPayloadDefaults();

    const generated = state.apiPayload.generated_at ? new Date(state.apiPayload.generated_at) : null;
    if (state.setupStatus.ready && generated && !Number.isNaN(generated.getTime())) {
      els.runStatus.textContent = `更新 ${generated.toLocaleString("ja-JP")} / USDJPY ${effectiveExchangeRate().toFixed(2)}円`;
    } else {
      els.runStatus.textContent = setupPresentation(state.setupStatus).badge;
    }
    els.qualityNotice.textContent = isDemoPayload(state.apiPayload)
      ? "デモデータは仕入判定に使用しません。Production API接続後に実データへ切り替わります。"
      : (state.apiPayload.method_note || "Production Browse APIの日次差分だけで販売ペースを学習します。");
    els.qualityNotice.classList.add("is-visible");
    populateSettingsForm();
    render();
    lastLoadedAt = Date.now();
  })();
  try {
    return await loadDataPromise;
  } finally {
    loadDataPromise = null;
  }
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === `tab-${name}`));
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      activateTab(button.dataset.tab);
      window.scrollTo({ top: document.querySelector(".tabs").offsetTop - 8, behavior: "smooth" });
    });
  });
  els.filterInput?.addEventListener("input", () => { state.filter = els.filterInput.value; render(); });
  els.sortSelect?.addEventListener("change", () => { state.sort = els.sortSelect.value; render(); });
  els.settingsForm?.addEventListener("input", scheduleSettingsSave);
  els.settingsForm?.addEventListener("change", scheduleSettingsSave);
  els.settingsForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(settingsSaveTimer);
    persistSettings();
  });
  document.querySelector("#reset-settings-button")?.addEventListener("click", () => {
    state.settings = clone(DEFAULT_SETTINGS);
    saveJson(STORAGE_KEYS.settings, state.settings);
    populateSettingsForm();
    render();
  });
  document.querySelector("#export-button")?.addEventListener("click", exportCsv);
  els.setupPrimary?.addEventListener("click", (event) => {
    if (els.setupPrimary.getAttribute("href") === "#tab-today") {
      event.preventDefault();
      activateTab("today");
      document.querySelector(".tabs")?.scrollIntoView({ behavior: "smooth" });
    }
  });
}

if (typeof document !== "undefined") {
  populateSettingsForm();
  bindEvents();
  loadData();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && shouldRefreshData(lastLoadedAt)) loadData();
  });
  window.addEventListener("pageshow", () => {
    if (shouldRefreshData(lastLoadedAt)) loadData();
  });
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.error));
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    state,
    DEFAULT_SETTINGS,
    DEFAULT_SETUP_STATUS,
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
    productDefaults,
    getCostValues,
    effectiveExchangeRate,
    isSalesAutoVerified,
    normalizeProduct,
    setupPresentation,
    observationProgress,
    isDemoPayload,
    shouldUsePayloadProducts,
    shouldRefreshData,
    selectPayloadProducts,
    safeExternalUrl,
    applyCostValuesToControls,
  };
}
