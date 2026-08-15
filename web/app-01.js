"use strict";

const STORAGE_KEYS = {
  settings: "part-scout-settings-v2",
  costs: "part-scout-costs-v1",
  csvProducts: "part-scout-csv-products-v1",
};

const DEFAULT_SETTINGS = {
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

const QUALITY_LABELS = {
  observed_delta: "日次差分から推定",
  mixed_estimate: "出品サンプルの複数推定",
  listing_lifetime_under_90d: "出品サンプルの掲載累計",
  lifetime_velocity_estimate: "出品サンプルの掲載平均",
  insufficient: "データ不足",
  product_research_csv: "CSV実績",
  product_research_manual: "Product Research手入力",
};

const CONFIRMED_SALES_QUALITIES = new Set(["product_research_csv", "product_research_manual"]);
const COMPETITION_LABELS = {
  confirmed: "確認済み",
  high: "高",
  medium: "中",
  low: "低",
  unknown: "不明",
};

const state = {
  apiPayload: null,
  products: [],
  settings: { ...structuredClone(DEFAULT_SETTINGS), ...loadJson(STORAGE_KEYS.settings, DEFAULT_SETTINGS) },
  costs: loadJson(STORAGE_KEYS.costs, {}),
  csvProducts: loadJson(STORAGE_KEYS.csvProducts, []),
  filter: "",
  sort: "score",
};

const els = typeof document !== "undefined" ? {
  runStatus: document.querySelector("#run-status"),
  summaryCount: document.querySelector("#summary-count"),
  summaryPromising: document.querySelector("#summary-promising"),
  summaryQuery: document.querySelector("#summary-query"),
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
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[\s_\-\/()（）・:：]+/g, "");
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
  const cleaned = String(value || "").replace(/[^0-9.\-]/g, "");
  return number(cleaned, 0);
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

function createManualResearchProduct(values) {
  const part = normalizePartNumber(values.partNumber);
  if (!isPlausiblePartNumber(part)) throw new Error("品番の形式を確認してください。");
  const sold = Math.max(0, Math.round(number(values.sold90d)));
  const active = Math.max(0, Math.round(number(values.activeCompetition)));
  const price = Math.max(0, number(values.medianPriceUsd));
  if (price <= 0) throw new Error("成約価格を入力してください。");
  const title = String(values.title || "").trim();
  const existing = (state.apiPayload?.products || []).find((product) => product.part_number === part) || {};
  const score = marketScore(sold, active, [price]);
  return {
    ...existing,
    part_number: part,
    title: title || existing.title || `${part} auto part`,
    brand: existing.brand || inferBrand(title),
    sold_90d_est: sold,
    sales_quality: "product_research_manual",
    sales_scope: "product_research_90d",
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
