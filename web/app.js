"use strict";

const Persistence = typeof PartScoutPersistence !== "undefined"
  ? PartScoutPersistence : require("./persistence.js");
const Shipping = typeof PartScoutShipping !== "undefined"
  ? PartScoutShipping : require("./shipping.js");
const localStore = Persistence.createStore((() => {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (_) { return null; }
})());
const USER_DATA_KEY = "part-scout-user-v1";
const RESULT_CACHE_KEY = "part-scout-results-v1";

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
  feesConfirmed: false,
  internationalDiscountConfirmed: false,
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
  app_version: "0.4.1",
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
const TARIFF_POLICY_REVIEW = "2026-09-08";

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function loadJson(key, fallback) {
  return localStore.read(key, clone(fallback));
}

function saveJson(key, value) {
  return localStore.write(key, value);
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
  for (const key of [...STORAGE_KEYS.legacyCosts].reverse()) {
    const value = loadJson(key, {});
    if (value && typeof value === "object") merged = { ...merged, ...value };
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
  workspace: { tab: "today", expanded: [], scrollY: 0 },
  offline: false,
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateUserData(value) {
  if (!isRecord(value) || !isRecord(value.settings) || !isRecord(value.costs) || !isRecord(value.workspace)) {
    throw new Error("保存ファイルの形式が違います。");
  }
  for (const [key, setting] of Object.entries(value.settings)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue;
    if (typeof DEFAULT_SETTINGS[key] === "boolean" && typeof setting !== "boolean") throw new Error("設定値の形式が違います。");
    if (typeof DEFAULT_SETTINGS[key] !== "boolean" && !["number", "string"].includes(typeof setting)) throw new Error("設定値の形式が違います。");
    if (typeof setting === "number" && !Number.isFinite(setting)) throw new Error("設定値が数値ではありません。");
  }
  if (Object.keys(value.costs).length > 5000) throw new Error("保存件数が多すぎます。");
  for (const [part, costs] of Object.entries(value.costs)) {
    if (!isPlausiblePartNumber(part) || !isRecord(costs)) throw new Error("品番または金額の形式が違います。");
    for (const [key, v] of Object.entries(costs)) {
      if (["__proto__", "constructor", "prototype"].includes(key)
          || !["string", "number", "boolean"].includes(typeof v)) throw new Error("金額の形式が違います。");
      if (typeof v === "number" && !Number.isFinite(v)) throw new Error("金額が数値ではありません。");
    }
  }
  return value;
}

function applyUserData(data) {
  state.settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.hasOwn(data.settings, key)) state.settings[key] = data.settings[key];
  }
  state.costs = clone(data.costs);
  state.workspace = {
    tab: ["today", "all", "observation", "settings"].includes(data.workspace.tab) ? data.workspace.tab : "today",
    expanded: Array.isArray(data.workspace.expanded) ? data.workspace.expanded.filter(v => typeof v === "string").slice(0, 5000) : [],
    scrollY: Math.max(0, Number(data.workspace.scrollY) || 0),
  };
  state.filter = String(data.workspace.filter || "").slice(0, 200);
  state.sort = ["profit", "score", "sold", "competition", "price"].includes(data.workspace.sort) ? data.workspace.sort : "profit";
}

let saveFailed = false;
function userDataSnapshot() {
  return { settings: state.settings, costs: state.costs,
    workspace: { ...state.workspace, filter: state.filter, sort: state.sort }, savedAt: new Date().toISOString() };
}

function showSaveStatus(ok, message) {
  saveFailed = !ok;
  if (typeof document === "undefined") return;
  const el = document.querySelector("#save-status");
  if (!el) return;
  el.textContent = message || (ok ? `端末に保存済み ${new Date().toLocaleTimeString("ja-JP")}` : "保存できません。設定の「バックアップ」を押してください。");
  el.classList.toggle("save-error", !ok);
}

function persistUserData() {
  const result = saveJson(USER_DATA_KEY, userDataSnapshot());
  showSaveStatus(result.ok);
  return result.ok;
}

function makeBackup() {
  return JSON.stringify({ format: "part-scout-backup", version: 1, data: userDataSnapshot() }, null, 2);
}

function restoreBackup(text) {
  if (typeof text !== "string" || text.length > 5_000_000) throw new Error("ファイルが大きすぎます。");
  const parsed = JSON.parse(text);
  if (parsed?.format !== "part-scout-backup" || parsed.version !== 1) throw new Error("Part Scoutのバックアップを選んでください。");
  const data = validateUserData(parsed.data);
  if (!saveJson(USER_DATA_KEY, data).ok) throw new Error("保存領域が不足しています。現在のデータは変更していません。");
  applyUserData(data);
  return true;
}

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
  if (typeof value === "boolean" || value == null || String(value).trim() === "") return "未確定";
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value)).toLocaleString("ja-JP")}円` : "未確定";
}

function usd(value) {
  return `$${number(value).toFixed(2)}`;
}

function percent(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "未確定";
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
  if (origin) return { rate: 25, low: 15, high: 50, label: "他国原産・未分類の試算" };
  return { rate: 25, low: 15, high: 50, label: "原産国不明・未分類の試算" };
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
  return !product.history_only && product.sales_auto_verified === true && product.sales_confidence === "high";
}

function isDemoPayload(payload = {}) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.demo_data === true) return true;
  const productionStatus = String(payload.automation?.production_api?.status || "").toLowerCase();
  if (productionStatus.startsWith("demo")) return true;
  return (Array.isArray(payload.products) ? payload.products : []).some((product) => {
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

function isPayloadFresh(payload, now = Date.now(), maxAgeMs = 48 * 60 * 60 * 1000) {
  const generatedAt = Date.parse(String(payload?.generated_at || ""));
  const current = Number(now);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(current)) return false;
  const age = current - generatedAt;
  const allowedFutureSkew = 5 * 60 * 1000;
  return age >= -allowedFutureSkew && age <= Math.max(0, Number(maxAgeMs) || 0);
}

function selectRenderableProducts(setupStatus, payload, now = Date.now()) {
  return isPayloadFresh(payload, now) ? selectPayloadProducts(setupStatus, payload) : [];
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
    speedpakOtherCustomsJpy: 0,
    shippingMethod: "manual",
    parcelWeightKg: "",
    parcelLengthCm: "",
    parcelWidthCm: "",
    parcelHeightCm: "",
    shippingRegion: "US48",
    originCode: String(product.country_of_origin || ""),
    tariffRate,
    htsus: "",
    dutyQuoteJpy: "",
    supplierConfirmed: false,
    tariffConfirmed: false,
  };
}

function getCostValues(product) {
  const values = { ...productDefaults(product), ...(state.costs[product.part_number] || {}) };
  values.shippingMethod = values.shippingMethod === "speedpak_economy_us" ? "speedpak_economy_us" : "manual";
  values.shippingQuote = values.shippingMethod === "speedpak_economy_us"
    ? Shipping.estimateEconomy({
      weightKg: values.parcelWeightKg,
      lengthCm: values.parcelLengthCm,
      widthCm: values.parcelWidthCm,
      heightCm: values.parcelHeightCm,
      region: values.shippingRegion,
      declaredValueUsd: values.salePriceUsd,
    })
    : null;
  if (values.shippingQuote) values.internationalShippingJpy = values.shippingQuote.ok ? values.shippingQuote.shippingJpy : null;
  values.supplierConfirmed = values.supplierConfirmed === true && recentConfirmation(values.supplierConfirmedAt);
  if (values.shippingMethod === "speedpak_economy_us") values.supplierConfirmed = false;
  values.tariffConfirmed = values.tariffConfirmed === true && recentConfirmation(values.tariffConfirmedAt)
    && values.tariffPolicyReview === TARIFF_POLICY_REVIEW
    && number(values.tariffSalePriceUsd, -1) === number(values.salePriceUsd, -2);
  return values;
}

function validNumber(value, min = 0, max = 1e9) {
  if (typeof value === "boolean" || value == null || String(value).trim() === "") return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

function recentConfirmation(value, maxDays = 7) {
  const age = Date.now() - Date.parse(String(value || ""));
  return Number.isFinite(age) && age >= -300000 && age <= maxDays * 86400000;
}

function confirmedExchangeRate() {
  if (!state.settings.autoExchangeRate) return validNumber(state.settings.exchangeRate, 1, 10000);
  const rate = state.apiPayload?.cost_defaults?.exchange_rate;
  return isRecord(rate) && rate.fallback === false && validNumber(rate.rate, 1, 10000) && recentConfirmation(rate.date);
}

function costInputErrors(values) {
  const errors = [];
  const customsKey = values.shippingMethod === "speedpak_economy_us" ? "speedpakOtherCustomsJpy" : "customsFixedJpy";
  for (const key of ["salePriceUsd", "buyerShippingUsd", "procurementJpy", "domesticShippingJpy", "internationalShippingJpy", "packagingJpy", customsKey, "tariffRate"]) {
    if (!validNumber(values[key], 0, key === "tariffRate" ? 1000 : 1e9)) errors.push(key);
  }
  if (values.dutyQuoteJpy !== "" && !validNumber(values.dutyQuoteJpy)) errors.push("dutyQuoteJpy");
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof fallback !== "number" || (key === "exchangeRate" && state.settings.autoExchangeRate)) continue;
    const max = /Rate$/.test(key) && key !== "exchangeRate" ? 100 : 1e9;
    if (!validNumber(state.settings[key], key === "exchangeRate" ? 1 : 0, max)) errors.push(key);
  }
  return errors;
}

function updateCostValue(product, key, value) {
  const previous = getCostValues(product);
  const next = { ...(state.costs[product.part_number] || {}), [key]: value };
  const shippingFields = ["shippingMethod", "parcelWeightKg", "parcelLengthCm", "parcelWidthCm", "parcelHeightCm", "shippingRegion"];
  if (key === "supplierConfirmed" && value === true && previous.shippingMethod === "speedpak_economy_us") {
    next.supplierConfirmed = false;
  } else if (["supplierConfirmed", "tariffConfirmed"].includes(key) && value === true) {
    const fields = key === "supplierConfirmed"
      ? ["procurementJpy", "domesticShippingJpy", "internationalShippingJpy", "packagingJpy"]
      : ["originCode", "htsus", "dutyQuoteJpy", previous.shippingMethod === "speedpak_economy_us" ? "speedpakOtherCustomsJpy" : "customsFixedJpy"];
    for (const field of fields) next[field] = previous[field];
    next[`${key}At`] = new Date().toISOString();
    if (key === "tariffConfirmed") {
      next.tariffSalePriceUsd = previous.salePriceUsd;
      next.tariffPolicyReview = TARIFF_POLICY_REVIEW;
    }
  } else if (String(previous[key]) !== String(value)) {
    if (["procurementJpy", "domesticShippingJpy", "internationalShippingJpy", "packagingJpy"].includes(key)) next.supplierConfirmed = false;
    if (["salePriceUsd", "originCode", "tariffRate", "htsus", "dutyQuoteJpy", "customsFixedJpy", "speedpakOtherCustomsJpy"].includes(key)) next.tariffConfirmed = false;
    if (shippingFields.includes(key)) { next.supplierConfirmed = false; next.tariffConfirmed = false; }
    if (key === "salePriceUsd" && previous.shippingMethod === "speedpak_economy_us") next.supplierConfirmed = false;
    if (key === "originCode") { next.tariffRate = tariffScenario(value).rate; next.dutyQuoteJpy = ""; next.htsus = ""; }
  }
  state.costs[product.part_number] = next;
}

function calculateProfit(product) {
  const values = getCostValues(product);
  const inputErrors = costInputErrors(values);
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
  const internationalRate = state.settings.internationalDiscountConfirmed === true
    ? internationalFeeRate(state.settings.monthlySalesUsd) : 1.35;
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
  const tariff = validNumber(values.dutyQuoteJpy) ? Number(values.dutyQuoteJpy) : salePriceUsd * exchangeRate * tariffRate / 100;
  const returnReserve = grossJpy * number(state.settings.returnReserveRate) / 100;
  const speedpakFees = values.shippingMethod === "speedpak_economy_us" && values.shippingQuote?.ok
    ? values.shippingQuote.clearanceJpy + tariff * values.shippingQuote.dutyProcessingRate
    : 0;
  const customsCost = values.shippingMethod === "speedpak_economy_us"
    ? number(values.speedpakOtherCustomsJpy)
    : number(values.customsFixedJpy);
  const fixedCosts = number(values.procurementJpy)
    + number(values.domesticShippingJpy)
    + number(values.internationalShippingJpy)
    + number(values.packagingJpy)
    + customsCost
    + speedpakFees;
  const totalCost = inputErrors.length ? NaN : ebayFee + payoneerFee + tariff + returnReserve + fixedCosts;
  const profit = grossJpy - totalCost;
  const margin = inputErrors.length ? NaN : grossJpy > 0 ? profit / grossJpy : 0;

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
    [confirmedExchangeRate(), "為替"],
    [state.settings.feesConfirmed === true, "手数料設定"],
    [values.supplierConfirmed === true && recentConfirmation(values.supplierConfirmedAt), "仕入条件"],
    [values.tariffConfirmed === true && recentConfirmation(values.tariffConfirmedAt)
      && Boolean(values.originCode) && values.originCode !== "OTHER"
      && /^\d{10}$/.test(String(values.htsus || "").replace(/[.\s]/g, ""))
      && validNumber(values.dutyQuoteJpy), "原産国・関税"],
  ];
  const confirmationFailed = confirmationChecks.filter(([passed]) => !passed).map(([, label]) => label);
  const hasCosts = hasProcurement && hasShipping && inputErrors.length === 0;
  const passes = hasCosts && operationalFailed.length === 0 && confirmationFailed.length === 0;
  const provisional = hasCosts && operationalFailed.length === 0 && confirmationFailed.length > 0;

  let judgment = "自動観測中";
  if (inputErrors.length) judgment = "入力を確認";
  else if (product.history_only) judgment = "保存済み・更新待ち";
  else if (!salesVerified) judgment = "自動観測中";
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
    speedpakFees, shippingQuote: values.shippingQuote,
    returnReserve, totalCost, profit, margin, hasProcurement, hasShipping, hasCosts,
    salesVerified, decisionSold, operationalFailed, confirmationFailed, passes,
    provisional, judgment,
    inputErrors,
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
  if (profit.inputErrors.length) return "入力を確認";
  if (product.history_only) return "保存済み・更新待ち";
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
  if (profit.inputErrors.length) return "空欄・負の金額・料率を確認してください";
  if (product.history_only) return "保存済みデータです。接続後の更新をお待ちください";
  if (!profit.salesVerified) return "操作不要。販売差分を自動観測中";
  if (profit.operationalFailed.some((label) => ["販売ペース下限", "競合データ", "市場スコア", "販売÷競合"].includes(label))) {
    return `${profit.operationalFailed[0]}が基準未達。次候補へ進む`;
  }
  if (!profit.hasProcurement) return "楽天／モノタロウで仕入価格を確認";
  if (profit.profit <= 0) return "仕入価格か販売価格を見直す";
  if (profit.operationalFailed.length) return `${profit.operationalFailed[0]}が基準未達。次候補へ進む`;
  if (profit.confirmationFailed.includes("為替")) return "為替が未取得です。設定で確認してください";
  if (profit.confirmationFailed.includes("手数料設定")) return "設定でPayoneerなどの実料率を確認";
  if (profit.values.shippingMethod === "speedpak_economy_us" && profit.confirmationFailed.includes("仕入条件")) {
    return "CPaSS見積の送料に切替（手入力）して確認";
  }
  if (profit.confirmationFailed.includes("仕入条件")) return "仕入先で価格・在庫・送料を確認";
  if (profit.confirmationFailed.includes("原産国・関税")) return "原産国・HTSUS・DDP関税額を確認";
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
  const payload = state.apiPayload;
  const generatedAt = Date.parse(String(payload?.generated_at || ""));
  const real = !isDemoPayload(payload) && Array.isArray(payload?.products)
    && Number.isFinite(generatedAt) && generatedAt <= Date.now() + 300000;
  const historyOnly = !state.setupStatus.ready || !isPayloadFresh(payload) || state.offline;
  state.products = real ? payload.products.map(product => normalizeProduct({ ...product, history_only: historyOnly })) : [];
}

function productSortValue(product, mode) {
  const profit = calculateProfit(product);
  if (mode === "sold") return number(product.sold_90d_decision, 0);
  if (mode === "competition") return -number(product.active_competition, 999999);
  if (mode === "price") return number(product.price_median_usd);
  if (mode === "score") return number(product.market_score);
  return profit.salesVerified && profit.hasCosts ? profit.profit : -1e9 + number(product.market_score);
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
  els.setupPanel.hidden = state.setupStatus.ready === true;
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
  const fresh = state.setupStatus.ready && isPayloadFresh(state.apiPayload) && !isDemoPayload(state.apiPayload);
  els.automationHealth.textContent = state.offline ? "保存済みを表示" : fresh ? "自動運転中" : state.setupStatus.ready ? "更新を確認" : "初回設定中";
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
  if (state.offline || !isPayloadFresh(state.apiPayload)) {
    els.nextTaskTitle.textContent = "保存済みデータから再開できます";
    els.nextTaskDetail.textContent = "入力内容は端末に残っています。全候補から確認でき、通信が戻ると自動更新します。更新までは購入判定を止めています。";
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
  const settingsPending = rows.find(({ profit }) => profit.provisional && profit.confirmationFailed.some(label => ["為替", "手数料設定"].includes(label)));
  if (settingsPending) {
    els.nextTaskTitle.textContent = "設定で為替・手数料を確認してください";
    els.nextTaskDetail.textContent = "取得できない為替や未確認のPayoneer料率では購入候補にしません。初回に実料率を設定してください。";
    return;
  }
  const supplierPending = rows.find(({ profit }) => profit.salesVerified && profit.provisional && profit.confirmationFailed.includes("仕入条件"));
  if (supplierPending) {
    els.nextTaskTitle.textContent = `${supplierPending.product.part_number}の仕入条件を確認`;
    els.nextTaskDetail.textContent = "楽天またはモノタロウを押し、税込価格・在庫・国内送料を確認してください。";
    return;
  }
  const tariffPending = rows.find(({ profit }) => profit.salesVerified && profit.provisional && profit.confirmationFailed.includes("原産国・関税"));
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
  const details = card.querySelector(".profit-details");
  details.open = state.workspace.expanded.includes(product.part_number);
  details.addEventListener("toggle", () => {
    if (!card.isConnected) return;
    const expanded = new Set(state.workspace.expanded);
    if (details.open) expanded.add(product.part_number); else expanded.delete(product.part_number);
    state.workspace.expanded = [...expanded];
    persistUserData();
  });
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
  card.querySelector(".tariff-rate-value").textContent = validNumber(values.dutyQuoteJpy) ? `見積 ${yen(values.dutyQuoteJpy)}` : `試算 ${number(values.tariffRate).toFixed(1)}%`;
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

    input.addEventListener(input.type === "checkbox" || input.tagName === "SELECT" ? "change" : "input", () => {
      updateCostValue(product, key, input.type === "checkbox" ? input.checked : input.value);
      persistUserData();
      updateAllCardsForProduct(product.part_number);
    });
  }
  updateProfitArea(card, product);
  return fragment;
}

function applyCostValuesToControls(controls, values, active = typeof document !== "undefined" ? document.activeElement : null) {
  for (const control of controls || []) {
    if (control === active) continue;
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
      control.value = values?.[key] ?? "";
    }
    if (key === "internationalShippingJpy") control.readOnly = values?.shippingMethod === "speedpak_economy_us";
    if (key === "supplierConfirmed") control.disabled = values?.shippingMethod === "speedpak_economy_us";
  }
}

function updateShippingReference(card, values) {
  const autoMode = values.shippingMethod === "speedpak_economy_us";
  card.querySelectorAll("[data-shipping-auto]").forEach((element) => { element.hidden = !autoMode; });
  card.querySelectorAll("[data-shipping-manual]").forEach((element) => { element.hidden = autoMode; });
  const reference = card.querySelector(".shipping-reference");
  if (reference) {
    reference.hidden = !autoMode;
    if (autoMode) {
      const quote = values.shippingQuote;
      reference.querySelector(".shipping-reference-summary").textContent = quote?.ok
        ? `参考送料 ${yen(quote.shippingJpy)}（基本 ${yen(quote.baseJpy)}／サイズ加算 ${yen(quote.oversizeJpy)}）`
        : "参考送料 未確定";
      reference.querySelector(".shipping-reference-weight").textContent = quote?.ok
        ? `課金重量 ${quote.chargeableWeightKg.toFixed(3)} kg／料金区分 ${quote.billedWeightKg} kgまで`
        : (quote?.errors || []).join(" ");
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
  els.summaryPromising.textContent = String(state.products.filter(row => {
    const p = calculateProfit(row); return p.passes || p.provisional;
  }).length);
}

function updateProfitArea(card, product) {
  const profit = calculateProfit(product);
  const values = profit.values;
  const originCode = String(values.originCode || product.country_of_origin || "");
  updateShippingReference(card, values);
  card.querySelector(".profit-value-main").textContent = profit.salesVerified && profit.hasCosts ? yen(profit.profit) : "未確定";
  card.querySelector(".procurement-value").textContent = number(values.procurementJpy) > 0 ? yen(values.procurementJpy) : "未取得";
  card.querySelector(".shipping-value").textContent = yen(values.internationalShippingJpy);
  card.querySelector(".origin-value").textContent = ORIGIN_LABELS[originCode] || originCode || "不明";
  card.querySelector(".tariff-rate-value").textContent = validNumber(values.dutyQuoteJpy) ? `見積 ${yen(values.dutyQuoteJpy)}` : `試算 ${number(values.tariffRate).toFixed(1)}%`;
  card.querySelector(".next-action-text").textContent = nextAction(product, profit);
  card.querySelector(".fee-profile-note").textContent = `eBay料率: ${profit.feeProfile.label} ${profit.feeProfile.rate}%（超過分 ${profit.feeProfile.aboveRate}%）`;
  card.querySelector(".ebay-fee-value").textContent = yen(profit.ebayFee);
  card.querySelector(".payoneer-value").textContent = yen(profit.payoneerFee);
  card.querySelector(".tariff-value").textContent = yen(profit.tariff);
  card.querySelector(".cost-value").textContent = yen(profit.totalCost);
  card.querySelector(".profit-value").textContent = profit.hasCosts ? yen(profit.profit) : "未確定";
  card.querySelector(".margin-value").textContent = profit.hasCosts ? percent(profit.margin) : "未確定";
  for (const input of card.querySelectorAll("[data-cost]")) {
    input.setAttribute("aria-invalid", String(profit.inputErrors.includes(input.dataset.cost)));
  }
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
  const next = { ...state.settings };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const input = els.settingsForm.elements.namedItem(key);
    if (!input) continue;
    if (input.type === "checkbox") next[key] = input.checked;
    else next[key] = input.value;
  }
  return next;
}

function persistSettings() {
  if (!els.settingsForm) return;
  state.settings = collectSettings();
  persistUserData();
}

function scheduleSettingsSave() {
  persistSettings();
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(render, 180);
}

function downloadText(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+@\t\r\n]/.test(text) || (/^-/.test(text) && !Number.isFinite(Number(text)))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv() {
  const headers = [
    "品番", "メーカー", "判定", "次にすること", "90日販売下限", "90日推定", "販売精度", "観測日数", "追跡出品数", "観測増分", "競合数", "相場中央値USD",
    "仕入価格円", "国際送料円", "原産国", "関税試算率（%・実見積優先）", "eBay料率区分", "eBay手数料消費税込円", "Payoneer円", "関税円", "予想利益円", "利益率",
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
      profit.hasCosts ? Math.round(profit.profit) : "未確定", profit.hasCosts ? (profit.margin * 100).toFixed(1) : "未確定",
    ];
  });
  const csv = [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  downloadText(`\ufeff${csv}`, `part-scout-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv;charset=utf-8");
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { value: await response.json(), ok: true, offline: response.headers.get("X-Part-Scout-Offline") === "1" };
  } catch (_) {
    return { value: clone(fallback), ok: false, offline: true };
  } finally {
    clearTimeout(timeout);
  }
}

function usablePayload(payload) {
  const date = Date.parse(String(payload?.generated_at || ""));
  return isRecord(payload) && !isDemoPayload(payload) && Array.isArray(payload.products)
    && Number.isFinite(date) && date <= Date.now() + 300000
    && payload.products.every(row => isRecord(row) && isPlausiblePartNumber(row.part_number));
}

let restorePosition = true;

async function loadData() {
  if (loadDataPromise) return loadDataPromise;
  loadDataPromise = (async () => {
    els.runStatus.textContent = "接続状態とeBayデータを読み込んでいます…";
    const cached = loadJson(RESULT_CACHE_KEY, null);
    const [setupResult, payloadResult] = await Promise.all([
      fetchJson("./data/setup_status.json", cached?.setup || state.setupStatus),
      fetchJson("./data/results.json", cached?.payload || state.apiPayload),
    ]);
    const setup = isRecord(setupResult.value) && typeof setupResult.value.ready === "boolean"
      ? setupResult.value : clone(DEFAULT_SETUP_STATUS);
    const incoming = payloadResult.value;
    const previous = usablePayload(cached?.payload) ? cached.payload : state.apiPayload;
    const acceptIncoming = usablePayload(incoming)
      && (!usablePayload(previous) || Date.parse(incoming.generated_at) >= Date.parse(previous.generated_at));
    const payload = acceptIncoming ? incoming : usablePayload(previous) ? previous : { products: [], query: "初回調査前" };
    state.offline = !setupResult.ok || !payloadResult.ok || setupResult.offline || payloadResult.offline
      || (setup.ready && !acceptIncoming);
    state.setupStatus = { ...clone(DEFAULT_SETUP_STATUS), ...setup, links: { ...DEFAULT_SETUP_STATUS.links, ...(setup.links || {}) } };
    state.apiPayload = payload;
    if (setup.ready && acceptIncoming && !state.offline) saveJson(RESULT_CACHE_KEY, { setup, payload });
    applyPayloadDefaults();

    const generated = state.apiPayload.generated_at ? new Date(state.apiPayload.generated_at) : null;
    if (state.setupStatus.ready && generated && !Number.isNaN(generated.getTime())) {
      els.runStatus.textContent = `${state.offline ? "保存済み " : "更新 "}${generated.toLocaleString("ja-JP")} / USDJPY ${effectiveExchangeRate().toFixed(2)}円${confirmedExchangeRate() ? "" : "（仮値）"}`;
    } else {
      els.runStatus.textContent = setupPresentation(state.setupStatus).badge;
    }
    els.qualityNotice.textContent = isDemoPayload(incoming)
      ? "デモデータは仕入判定に使用しません。Production API接続後に実データへ切り替わります。"
      : state.offline || !isPayloadFresh(state.apiPayload)
        ? "全候補に保存済みデータを表示します。入力は保存できますが、最新データの取得までは購入判定を止めています。"
        : (state.apiPayload.method_note || "Production Browse APIの日次差分だけで販売ペースを学習します。");
    els.qualityNotice.classList.add("is-visible");
    populateSettingsForm();
    render();
    if (restorePosition && typeof window !== "undefined") {
      window.scrollTo(0, state.workspace.scrollY);
      restorePosition = false;
    }
    lastLoadedAt = Date.now();
  })();
  try {
    return await loadDataPromise;
  } finally {
    loadDataPromise = null;
  }
}

function activateTab(name, save = true) {
  if (!["today", "all", "observation", "settings"].includes(name)) name = "today";
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === `tab-${name}`));
  state.workspace.tab = name;
  if (save) persistUserData();
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      activateTab(button.dataset.tab);
      window.scrollTo({ top: document.querySelector(".tabs").offsetTop - 8, behavior: "smooth" });
    });
  });
  els.filterInput?.addEventListener("input", () => { state.filter = els.filterInput.value; persistUserData(); render(); });
  els.sortSelect?.addEventListener("change", () => { state.sort = els.sortSelect.value; persistUserData(); render(); });
  els.settingsForm?.addEventListener("input", scheduleSettingsSave);
  els.settingsForm?.addEventListener("change", scheduleSettingsSave);
  els.settingsForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(settingsSaveTimer);
    persistSettings();
    render();
  });
  document.querySelector("#reset-settings-button")?.addEventListener("click", () => {
    state.settings = clone(DEFAULT_SETTINGS);
    clearTimeout(settingsSaveTimer);
    persistUserData();
    populateSettingsForm();
    render();
  });
  document.querySelector("#export-button")?.addEventListener("click", exportCsv);
  document.querySelector("#backup-button")?.addEventListener("click", () => {
    downloadText(makeBackup(), `part-scout-backup-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
  });
  document.querySelector("#restore-file")?.addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw new Error("5MB以下のバックアップを選んでください。");
      restoreBackup(await file.text());
      populateSettingsForm();
      els.filterInput.value = state.filter;
      els.sortSelect.value = state.sort;
      activateTab(state.workspace.tab, false);
      render();
      showSaveStatus(true, "バックアップを復元しました。");
    } catch (error) { showSaveStatus(!saveFailed, error.message); }
    event.target.value = "";
  });
  document.querySelector("#refresh-button")?.addEventListener("click", loadData);
  els.setupPrimary?.addEventListener("click", (event) => {
    if (els.setupPrimary.getAttribute("href") === "#tab-today") {
      event.preventDefault();
      activateTab("today");
      document.querySelector(".tabs")?.scrollIntoView({ behavior: "smooth" });
    }
  });
}

try {
  const saved = loadJson(USER_DATA_KEY, null);
  if (saved) applyUserData(validateUserData(saved));
} catch (_) { /* Keep readable legacy data; never overwrite an incompatible save. */ }

if (typeof document !== "undefined") {
  const cached = loadJson(RESULT_CACHE_KEY, null);
  if (usablePayload(cached?.payload) && isRecord(cached?.setup)) {
    state.apiPayload = cached.payload;
    state.setupStatus = cached.setup;
    state.offline = true;
  }
  populateSettingsForm();
  bindEvents();
  els.filterInput.value = state.filter;
  els.sortSelect.value = state.sort;
  activateTab(state.workspace.tab, false);
  render();
  if (localStore.recovered) showSaveStatus(true, "直前の保存データから復元しました。");
  loadData();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      state.workspace.scrollY = window.scrollY;
      persistSettings();
    }
    if (!document.hidden && shouldRefreshData(lastLoadedAt)) loadData();
  });
  window.addEventListener("pagehide", () => {
    state.workspace.scrollY = window.scrollY;
    persistSettings();
  });
  window.addEventListener("online", loadData);
  window.addEventListener("offline", () => {
    state.offline = true;
    els.runStatus.textContent = "オフライン・保存済みデータを表示しています";
    render();
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
    isPayloadFresh,
    selectRenderableProducts,
    applyCostValuesToControls,
    makeBackup, restoreBackup, updateCostValue, confirmedExchangeRate, usablePayload, csvCell,
  };
}
