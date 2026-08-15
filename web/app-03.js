function render() {
  mergeProducts();
  let products = state.products.filter((product) => {
    const haystack = `${product.part_number} ${product.brand} ${product.title}`.toLowerCase();
    return haystack.includes(state.filter.toLowerCase());
  });

  products.sort((a, b) => {
    if (state.sort === "sold") return number(b.sold_90d_est) - number(a.sold_90d_est);
    if (state.sort === "competition") return number(a.active_competition, Infinity) - number(b.active_competition, Infinity);
    if (state.sort === "price") return number(b.price_median_usd) - number(a.price_median_usd);
    if (state.sort === "profit") return calculateProfit(b).profit - calculateProfit(a).profit;
    return number(b.market_score) - number(a.market_score);
  });

  els.productList.replaceChildren();
  for (const product of products) els.productList.append(createProductCard(product));
  els.emptyState.hidden = products.length !== 0;

  const promising = state.products.filter((product) => ["販売候補", "仮候補", "有望"].includes(combinedJudgment(product, calculateProfit(product)))).length;
  els.summaryCount.textContent = String(state.products.length);
  els.summaryPromising.textContent = String(promising);
  els.summaryQuery.textContent = state.apiPayload?.query || "CSVのみ";
  els.csvStatus.textContent = state.csvProducts.length
    ? `${state.csvProducts.length}品番を端末内に取り込み済みです。`
    : "CSVはGitHubへ送信されません。";
}

function createProductCard(product) {
  const fragment = els.template.content.cloneNode(true);
  const card = fragment.querySelector(".product-card");
  const profit = calculateProfit(product);
  const judgment = combinedJudgment(product, profit);
  const encodedPart = encodeURIComponent(product.part_number);

  card.dataset.partNumber = product.part_number;
  card.querySelector(".brand-label").textContent = product.brand || "Unknown";
  card.querySelector(".part-number").textContent = product.part_number;
  card.querySelector(".product-title").textContent = product.title || "";
  const badge = card.querySelector(".judgment-badge");
  badge.textContent = judgment;
  badge.classList.add(badgeClass(judgment));
  card.querySelector(".sold-value").textContent = `${number(product.sold_90d_est).toFixed(1)}個`;
  const competitionPrefix = product.competition_confidence === "confirmed" ? "" : "約";
  card.querySelector(".competition-value").textContent = product.competition_known === false
    ? "不明"
    : `${competitionPrefix}${number(product.active_competition)}件`;
  card.querySelector(".price-value").textContent = usd(product.price_median_usd);
  card.querySelector(".score-value").textContent = `${number(product.market_score)}/100`;
  card.querySelector(".quality-label").textContent = QUALITY_LABELS[product.sales_quality] || product.sales_quality || "不明";
  card.querySelector(".demand-ratio").textContent = `販売÷競合 ${number(product.demand_ratio).toFixed(2)}`;
  const p25 = number(product.price_p25_usd, number(product.price_median_usd));
  const p75 = number(product.price_p75_usd, number(product.price_median_usd));
  card.querySelector(".price-band").textContent = `相場帯 ${usd(p25)}–${usd(p75)}`;
  const coverage = Math.max(0, Math.min(1, number(product.sample_coverage, 0)));
  const confidence = COMPETITION_LABELS[product.competition_confidence] || "不明";
  card.querySelector(".sample-detail").textContent = CONFIRMED_SALES_QUALITIES.has(product.sales_quality)
    ? `90日実績確認済み / ${number(product.sampled_sellers)}セラー / 競合 ${confidence}`
    : `確認 ${number(product.sampled_listings)}出品 / カバー ${(coverage * 100).toFixed(0)}% / 競合精度 ${confidence}`;
  card.querySelector(".monotaro-link").href = `https://www.monotaro.com/s/q-${encodedPart}/`;
  card.querySelector(".rakuten-link").href = `https://search.rakuten.co.jp/search/mall/${encodedPart}/`;
  card.querySelector(".ebay-link").href = product.ebay_url || `https://www.ebay.com/sch/i.html?_nkw=${encodedPart}&_sacat=6028`;

  const values = state.costs[product.part_number] || {};
  for (const input of card.querySelectorAll("[data-cost]")) {
    const key = input.dataset.cost;
    if (input.type === "checkbox") {
      input.checked = values[key] === true;
      input.addEventListener("change", () => {
        state.costs[product.part_number] ||= {};
        state.costs[product.part_number][key] = input.checked;
        saveJson(STORAGE_KEYS.costs, state.costs);
        updateProfitArea(card, product);
      });
    } else {
      const defaultValue = key === "salePriceUsd" ? number(product.price_median_usd) : 0;
      input.value = number(values[key], defaultValue) || "";
      input.addEventListener("input", () => {
        state.costs[product.part_number] ||= {};
        state.costs[product.part_number][key] = number(input.value);
        saveJson(STORAGE_KEYS.costs, state.costs);
        updateProfitArea(card, product);
      });
    }
  }
  updateProfitArea(card, product);
  return fragment;
}

function updateProfitArea(card, product) {
  const profit = calculateProfit(product);
  card.querySelector(".profit-value").textContent = yen(profit.profit);
  card.querySelector(".margin-value").textContent = percent(profit.margin);
  card.querySelector(".tariff-value").textContent = yen(profit.tariff);
  card.querySelector(".cost-value").textContent = yen(profit.totalCost);
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
    const input = els.settingsForm.elements.namedItem(key);
    if (input) input.value = value;
  }
}

function collectSettings() {
  const formData = new FormData(els.settingsForm);
  const next = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) next[key] = number(formData.get(key), DEFAULT_SETTINGS[key]);
  return next;
}

function exportCsv() {
  const headers = [
    "品番", "メーカー", "市場判定", "推定90日販売数", "競合数", "相場中央値USD", "市場スコア",
    "仕入価格円", "国際送料円", "予想利益円", "利益率", "データ品質", "競合精度", "DDP関税確認",
  ];
  const rows = state.products.map((product) => {
    const costs = state.costs[product.part_number] || {};
    const profit = calculateProfit(product);
    return [
      product.part_number, product.brand, combinedJudgment(product, profit), product.sold_90d_est,
      product.active_competition, product.price_median_usd, product.market_score,
      number(costs.procurementJpy), number(costs.internationalShippingJpy), Math.round(profit.profit),
      (profit.margin * 100).toFixed(1), QUALITY_LABELS[product.sales_quality] || product.sales_quality,
      COMPETITION_LABELS[product.competition_confidence] || "不明", costs.tariffConfirmed === true ? "済" : "未",
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

async function loadData() {
  els.runStatus.textContent = "eBayデータを読み込んでいます…";
  try {
    const response = await fetch(`./data/results.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.apiPayload = await response.json();
    const generated = state.apiPayload.generated_at ? new Date(state.apiPayload.generated_at) : null;
    els.runStatus.textContent = generated && !Number.isNaN(generated.getTime())
      ? `更新 ${generated.toLocaleString("ja-JP")}`
      : "更新日時不明";
    els.qualityNotice.textContent = state.apiPayload.method_note || "";
    els.qualityNotice.classList.toggle("is-visible", Boolean(state.apiPayload.method_note));
  } catch (error) {
    console.error(error);
    state.apiPayload = { products: [], query: "読込失敗" };
    els.runStatus.textContent = "データ読込に失敗しました";
    els.qualityNotice.textContent = "GitHub Actionsの実行状況とweb/data/results.jsonを確認してください。";
    els.qualityNotice.classList.add("is-visible");
  }
  render();
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab === button));
      document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === `tab-${button.dataset.tab}`));
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
    document.querySelector('[data-tab="results"]').click();
  });
  document.querySelector("#reset-settings-button").addEventListener("click", () => {
    state.settings = structuredClone(DEFAULT_SETTINGS);
    saveJson(STORAGE_KEYS.settings, state.settings);
    populateSettingsForm();
    render();
  });
  document.querySelectorAll(".tariff-preset").forEach((button) => {
    button.addEventListener("click", () => {
      els.settingsForm.elements.namedItem("tariffRate").value = button.dataset.rate;
    });
  });
  document.querySelectorAll(".fee-preset").forEach((button) => {
    button.addEventListener("click", () => {
      els.settingsForm.elements.namedItem("ebayFeeRate").value = button.dataset.rate;
      els.settingsForm.elements.namedItem("ebayFeeThresholdUsd").value = button.dataset.threshold;
    });
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
