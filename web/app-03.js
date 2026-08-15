function normalizeProduct(product) {
  const originCode = String(product.country_of_origin || "");
  const scenario = tariffScenario(originCode);
  return {
    sold_90d_low: number(product.sold_90d_low, 0),
    sold_90d_high: number(product.sold_90d_high, number(product.sold_90d_est, 0) * 2),
    sales_confidence: product.sales_confidence || (product.sales_auto_verified ? "high" : "learning"),
    sales_observed_days: number(product.sales_observed_days, 0),
    sales_observed_delta: number(product.sales_observed_delta, 0),
    sales_tracked_listings: number(product.sales_tracked_listings, 0),
    sales_auto_verified: product.sales_auto_verified === true,
    competition_known: product.competition_known !== false,
    competition_confidence: product.competition_confidence || "unknown",
    country_of_origin: originCode,
    tariff: product.tariff || { rate: scenario.rate / 100, confidence: "unknown", confirmation_required: true },
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

function productSortValue(product, mode) {
  const profit = calculateProfit(product);
  if (mode === "sold") return number(product.sold_90d_est);
  if (mode === "competition") return -number(product.active_competition, 999999);
  if (mode === "price") return number(product.price_median_usd);
  if (mode === "score") return number(product.market_score);
  return profit.profit;
}

function getVisibleProducts() {
  const products = state.products.filter((product) => {
    const haystack = `${product.part_number} ${product.brand} ${product.title}`.toLowerCase();
    return haystack.includes(state.filter.toLowerCase());
  });
  products.sort((a, b) => productSortValue(b, state.sort) - productSortValue(a, state.sort));
  return products;
}

function renderAutomation() {
  const automation = state.apiPayload?.automation || {};
  const generated = state.apiPayload?.generated_at ? new Date(state.apiPayload.generated_at) : null;
  const ageHours = generated && !Number.isNaN(generated.getTime()) ? (Date.now() - generated.getTime()) / 3600000 : Infinity;
  const fresh = ageHours <= 48;
  els.automationHealth.textContent = fresh ? "自動運転中" : "更新を確認";
  els.automationHealth.className = `health-badge ${fresh ? "badge-good" : "badge-warn"}`;
  els.flowResearch.textContent = automation.queries_per_run
    ? `1回${number(automation.queries_per_run)}語を巡回／監視品番${number(automation.watchlist_size)}件`
    : "GitHub Actionsで毎日自動実行";
  els.flowMarket.textContent = automation.snapshot_runs
    ? `差分記録 ${number(automation.snapshot_runs)}回。30日で自動精度・高`
    : "差分記録を開始します";
  els.flowProcurement.textContent = automation.rakuten_enabled
    ? "楽天API接続済み。仕入価格を自動入力"
    : "楽天API未設定。検索ボタンで確認";
}

function updateGlobalNextTask(sorted) {
  if (!sorted.length) {
    els.nextTaskTitle.textContent = "eBay自動調査を実行してください";
    els.nextTaskDetail.textContent = "GitHub Secretsを設定後、「今すぐ更新」を押します。以後は毎日自動です。";
    return;
  }
  const rows = sorted.map((product) => ({ product, profit: calculateProfit(product) }));
  const procurementMissing = rows.find(({ profit }) => !profit.hasProcurement && profit.profit > -100000);
  if (procurementMissing) {
    els.nextTaskTitle.textContent = `${procurementMissing.product.part_number}の仕入価格を確認`;
    els.nextTaskDetail.textContent = "商品カードの楽天またはモノタロウを押し、見つかった価格だけ入力してください。";
    return;
  }
  const supplierPending = rows.find(({ profit }) => profit.provisional && profit.values.supplierConfirmed !== true && profit.salesVerified);
  if (supplierPending) {
    els.nextTaskTitle.textContent = `${supplierPending.product.part_number}の在庫・送料を確認`;
    els.nextTaskDetail.textContent = "価格が合っていれば、詳細欄の「仕入条件を確認済み」にチェックします。";
    return;
  }
  const tariffPending = rows.find(({ profit }) => profit.provisional && profit.values.tariffConfirmed !== true && profit.salesVerified);
  if (tariffPending) {
    els.nextTaskTitle.textContent = `${tariffPending.product.part_number}の原産国・DDP関税を確認`;
    els.nextTaskDetail.textContent = "日本原産15%は仮計算です。仕入前にDDP見積を確認してください。";
    return;
  }
  const learning = rows.find(({ profit }) => !profit.salesVerified && profit.operationalFailed.length === 0);
  if (learning) {
    els.nextTaskTitle.textContent = "販売差分を自動学習中です";
    els.nextTaskDetail.textContent = "操作は不要です。毎日の差分が30日分たまると自動で最終判定へ進みます。";
    return;
  }
  const ready = rows.find(({ profit }) => profit.passes);
  if (ready) {
    els.nextTaskTitle.textContent = `${ready.product.part_number}が購入候補です`;
    els.nextTaskDetail.textContent = "最終的な在庫、適合、原産国、DDP請求額を確認して仕入判断へ進みます。";
    return;
  }
  els.nextTaskTitle.textContent = "次の自動調査結果を待ちます";
  els.nextTaskDetail.textContent = "現在の候補は基準未達です。操作せず、次回の自動巡回を待ってください。";
}

function render() {
  mergeProducts();
  state.products = state.products.map(normalizeProduct);
  const visible = getVisibleProducts();
  const allSorted = [...state.products].sort((a, b) => productSortValue(b, "profit") - productSortValue(a, "profit"));

  els.productList.replaceChildren();
  visible.forEach((product, index) => els.productList.append(createProductCard(product, index + 1)));
  els.emptyState.hidden = visible.length !== 0;

  const top = allSorted.filter((product) => {
    const profit = calculateProfit(product);
    return profit.profit > 0 || number(product.market_score) >= number(state.settings.minimumMarketScore);
  }).slice(0, 3);
  els.topProductList.replaceChildren();
  top.forEach((product, index) => els.topProductList.append(createProductCard(product, index + 1)));
  els.topEmptyState.hidden = top.length !== 0;

  const verified = state.products.filter(isSalesAutoVerified).length;
  const promising = state.products.filter((product) => ["購入候補", "概算候補", "有望"].includes(combinedJudgment(product, calculateProfit(product)))).length;
  els.summaryCount.textContent = String(state.products.length);
  els.summaryVerified.textContent = String(verified);
  els.summaryPromising.textContent = String(promising);
  els.summaryQuery.textContent = state.apiPayload?.query_label || state.apiPayload?.query || "–";
  els.csvStatus.textContent = state.csvProducts.length
    ? `${state.csvProducts.length}品番を端末内に保存済みです。`
    : "未取込。通常はこのままで構いません。";

  renderAutomation();
  updateGlobalNextTask(allSorted);
}

function createProductCard(product, rank) {
  const fragment = els.template.content.cloneNode(true);
  const card = fragment.querySelector(".product-card");
  const profit = calculateProfit(product);
  const judgment = combinedJudgment(product, profit);
  const encodedPart = encodeURIComponent(product.part_number);
  const values = profit.values;
  const confidence = product.sales_confidence || "unknown";
  const originCode = String(values.originCode || product.country_of_origin || "");

  card.dataset.partNumber = product.part_number;
  card.querySelector(".rank-label").textContent = `#${rank}`;
  card.querySelector(".brand-label").textContent = product.brand || "Unknown";
  card.querySelector(".part-number").textContent = product.part_number;
  card.querySelector(".product-title").textContent = product.title || "";
  const badge = card.querySelector(".judgment-badge");
  badge.textContent = judgment;
  badge.classList.add(badgeClass(judgment));

  card.querySelector(".sold-value").textContent = `${number(product.sold_90d_est).toFixed(1)}個`;
  const competitionPrefix = product.competition_confidence === "confirmed" || product.competition_confidence === "high" ? "" : "約";
  card.querySelector(".competition-value").textContent = product.competition_known === false ? "不明" : `${competitionPrefix}${Math.round(number(product.active_competition))}件`;
  card.querySelector(".price-value").textContent = usd(product.price_median_usd);
  card.querySelector(".profit-value-main").textContent = profit.hasCosts ? yen(profit.profit) : "未確定";
  card.querySelector(".quality-label").textContent = SALES_CONFIDENCE_LABELS[confidence] || QUALITY_LABELS[product.sales_quality] || "不明";
  card.querySelector(".observation-label").textContent = isSalesAutoVerified(product)
    ? `観測 ${Math.round(number(product.sales_observed_days, 90))}日`
    : `観測 ${Math.round(number(product.sales_observed_days))}日 / 30日で高精度`;
  const low = number(product.sold_90d_low, 0);
  const high = number(product.sold_90d_high, number(product.sold_90d_est));
  const tracking = number(product.sales_tracked_listings) > 0
    ? `追跡${Math.round(number(product.sales_tracked_listings))}出品・観測増分${Math.round(number(product.sales_observed_delta))}個 / `
    : "";
  card.querySelector(".range-note").textContent = `${tracking}推定幅 ${low.toFixed(1)}–${high.toFixed(1)}個 / 相場帯 ${usd(product.price_p25_usd)}–${usd(product.price_p75_usd)} / 市場スコア ${number(product.market_score)}`;

  card.querySelector(".procurement-value").textContent = number(values.procurementJpy) > 0 ? yen(values.procurementJpy) : "未取得";
  card.querySelector(".shipping-value").textContent = yen(values.internationalShippingJpy);
  card.querySelector(".origin-value").textContent = ORIGIN_LABELS[originCode] || originCode || "不明";
  card.querySelector(".tariff-rate-value").textContent = `${number(values.tariffRate).toFixed(1)}%`;
  card.querySelector(".next-action-text").textContent = nextAction(product, profit);

  const rakutenBest = product.rakuten?.items?.[0];
  const rakutenLink = card.querySelector(".rakuten-link");
  rakutenLink.href = rakutenBest?.url || `https://search.rakuten.co.jp/search/mall/${encodedPart}/`;
  rakutenLink.textContent = rakutenBest ? `楽天 ${yen(rakutenBest.price_jpy)}` : "楽天を見る";
  card.querySelector(".monotaro-link").href = `https://www.monotaro.com/s/q-${encodedPart}/`;
  card.querySelector(".ebay-link").href = product.ebay_url || `https://www.ebay.com/sch/i.html?_nkw=${encodedPart}&_sacat=6028`;

  for (const input of card.querySelectorAll("[data-cost]")) {
    const key = input.dataset.cost;
    if (input.type === "checkbox") {
      input.checked = values[key] === true;
    } else if (input.tagName === "SELECT") {
      const selectValue = String(values[key] ?? "");
      input.value = Array.from(input.options).some((option) => option.value === selectValue) ? selectValue : (selectValue ? "OTHER" : "");
    } else {
      input.value = number(values[key], 0) || "";
    }
    const eventName = input.type === "number" ? "input" : "change";
    input.addEventListener(eventName, () => {
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

function updateAllCardsForProduct(partNumber) {
  const product = state.products.find((row) => row.part_number === partNumber);
  if (!product || typeof document === "undefined") return;
  document.querySelectorAll(`.product-card[data-part-number="${CSS.escape(partNumber)}"]`).forEach((card) => updateProfitArea(card, product));
  const allSorted = [...state.products].sort((a, b) => productSortValue(b, "profit") - productSortValue(a, "profit"));
  updateGlobalNextTask(allSorted);
}

function updateProfitArea(card, product) {
  const profit = calculateProfit(product);
  const values = profit.values;
  const originCode = String(values.originCode || product.country_of_origin || "");
  card.querySelector(".profit-value-main").textContent = profit.hasCosts ? yen(profit.profit) : "未確定";
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

function populateSettingsForm() {
  for (const [key, value] of Object.entries(state.settings)) {
    const input = els.settingsForm?.elements.namedItem(key);
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

function exportCsv() {
  const headers = [
    "品番", "メーカー", "判定", "次にすること", "90日換算販売ペース", "販売精度", "観測日数", "追跡出品数", "観測販売増分", "競合数", "相場中央値USD",
    "仕入価格円", "国際送料円", "原産国", "関税率", "eBay料率区分", "eBay手数料消費税込円", "Payoneer円", "関税円", "予想利益円", "利益率",
  ];
  const rows = state.products.map((product) => {
    const profit = calculateProfit(product);
    return [
      product.part_number, product.brand, combinedJudgment(product, profit), nextAction(product, profit),
      product.sold_90d_est, SALES_CONFIDENCE_LABELS[product.sales_confidence] || product.sales_confidence,
      product.sales_observed_days, product.sales_tracked_listings, product.sales_observed_delta,
      product.active_competition, product.price_median_usd,
      number(profit.values.procurementJpy), number(profit.values.internationalShippingJpy),
      ORIGIN_LABELS[profit.values.originCode] || profit.values.originCode, profit.tariffRate,
      profit.feeProfile.label, Math.round(profit.ebayFee), Math.round(profit.payoneerFee), Math.round(profit.tariff),
      Math.round(profit.profit), (profit.margin * 100).toFixed(1),
    ];
  });
  const csv = [headers, ...rows].map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
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
  if (number(defaults.default_international_shipping_jpy) > 0 && state.settings.defaultInternationalShippingJpy === DEFAULT_SETTINGS.defaultInternationalShippingJpy) {
    state.settings.defaultInternationalShippingJpy = number(defaults.default_international_shipping_jpy);
  }
  if (number(defaults.default_packaging_jpy) > 0 && state.settings.defaultPackagingJpy === DEFAULT_SETTINGS.defaultPackagingJpy) {
    state.settings.defaultPackagingJpy = number(defaults.default_packaging_jpy);
  }
}

async function loadData() {
  els.runStatus.textContent = "eBayデータを読み込んでいます…";
  try {
    const response = await fetch(`./data/results.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.apiPayload = await response.json();
    applyPayloadDefaults();
    const generated = state.apiPayload.generated_at ? new Date(state.apiPayload.generated_at) : null;
    els.runStatus.textContent = generated && !Number.isNaN(generated.getTime())
      ? `更新 ${generated.toLocaleString("ja-JP")} / USDJPY ${effectiveExchangeRate().toFixed(2)}円`
      : "更新日時不明";
    els.qualityNotice.textContent = state.apiPayload.method_note || "";
    els.qualityNotice.classList.toggle("is-visible", Boolean(state.apiPayload.method_note));
  } catch (error) {
    console.error(error);
    state.apiPayload = { products: [], query: "読込失敗", automation: {} };
    els.runStatus.textContent = "データ読込に失敗しました";
    els.qualityNotice.textContent = "GitHub Actionsの実行状況とweb/data/results.jsonを確認してください。";
    els.qualityNotice.classList.add("is-visible");
  }
  populateSettingsForm();
  render();
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab === button));
      document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === `tab-${button.dataset.tab}`));
      window.scrollTo({ top: document.querySelector(".tabs").offsetTop - 8, behavior: "smooth" });
    });
  });

  document.querySelector("#refresh-button").addEventListener("click", loadData);
  els.filterInput.addEventListener("input", () => { state.filter = els.filterInput.value; render(); });
  els.sortSelect.addEventListener("change", () => { state.sort = els.sortSelect.value; render(); });
  els.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.settings = collectSettings();
    saveJson(STORAGE_KEYS.settings, state.settings);
    render();
    document.querySelector('[data-tab="today"]').click();
  });
  document.querySelector("#reset-settings-button").addEventListener("click", () => {
    state.settings = structuredClone(DEFAULT_SETTINGS);
    saveJson(STORAGE_KEYS.settings, state.settings);
    populateSettingsForm();
    render();
  });

  els.manualForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const values = Object.fromEntries(new FormData(els.manualForm).entries());
      const product = createManualResearchProduct(values);
      const index = state.csvProducts.findIndex((row) => row.part_number === product.part_number);
      if (index >= 0) state.csvProducts[index] = product;
      else state.csvProducts.push(product);
      saveJson(STORAGE_KEYS.csvProducts, state.csvProducts);
      els.manualStatus.textContent = `${product.part_number}の実績データを保存しました。`;
      els.manualForm.reset();
      render();
    } catch (error) {
      els.manualStatus.textContent = `保存失敗: ${error.message}`;
    }
  });

  els.csvInput.addEventListener("change", async () => {
    const file = els.csvInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      state.csvProducts = importProductResearchCsv(text);
      saveJson(STORAGE_KEYS.csvProducts, state.csvProducts);
      els.csvStatus.textContent = `${state.csvProducts.length}品番を取り込みました。`;
      render();
    } catch (error) {
      els.csvStatus.textContent = `取込失敗: ${error.message}`;
    } finally {
      els.csvInput.value = "";
    }
  });
  document.querySelector("#clear-csv-button").addEventListener("click", () => {
    state.csvProducts = [];
    localStorage.removeItem(STORAGE_KEYS.csvProducts);
    render();
  });
  document.querySelector("#export-button").addEventListener("click", exportCsv);
}

if (typeof document !== "undefined") {
  populateSettingsForm();
  bindEvents();
  loadData();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.error));
  }
}
