function importProductResearchCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSVにデータ行がありません。");
  const headers = rows[0].map(normalizeHeader);
  const indexes = {
    title: findHeader(headers, ["title", "itemtitle", "listingtitle", "商品名", "タイトル"]),
    part: findHeader(headers, ["manufacturerpartnumber", "mpn", "partnumber", "品番", "oempartnumber"]),
    price: findHeader(headers, ["soldprice", "saleprice", "averagesoldprice", "averageprice", "price", "販売価格", "平均販売価格", "落札価格"]),
    date: findHeader(headers, ["solddate", "datesold", "lastsolddate", "enddate", "販売日", "最終販売日", "終了日"]),
    quantity: findHeader(headers, ["totalsold", "quantitysold", "soldquantity", "sales", "quantity", "総販売数", "販売数量", "個数"]),
    seller: findHeader(headers, ["seller", "sellername", "セラー", "出品者"]),
    active: findHeader(headers, ["activelistings", "activecount", "currentlistings", "competition", "競合数", "出品数"]),
  };
  if (indexes.title < 0 && indexes.part < 0) throw new Error("商品名または品番の列を認識できませんでした。");

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const groups = new Map();
  for (const row of rows.slice(1)) {
    const soldDate = indexes.date >= 0 ? parseDate(row[indexes.date]) : null;
    if (soldDate && soldDate < cutoff) continue;
    const title = indexes.title >= 0 ? String(row[indexes.title] || "") : "";
    const explicitPart = indexes.part >= 0 ? normalizePartNumber(row[indexes.part]) : "";
    const parts = isPlausiblePartNumber(explicitPart) ? [explicitPart] : extractPartNumbers(title);
    if (!parts.length) continue;
    const qty = Math.max(0, Math.round(indexes.quantity >= 0 ? number(row[indexes.quantity], 0) : 1));
    if (qty === 0) continue;
    const price = indexes.price >= 0 ? parsePrice(row[indexes.price]) : 0;
    const seller = indexes.seller >= 0 ? String(row[indexes.seller] || "") : "";
    for (const part of parts.slice(0, 3)) {
      if (!groups.has(part)) groups.set(part, { part, sold: 0, prices: [], sellers: new Set(), titles: [], activeCounts: [] });
      const group = groups.get(part);
      group.sold += qty;
      if (price > 0) group.prices.push(price);
      if (seller) group.sellers.add(seller);
      if (title) group.titles.push(title);
      const activeCount = indexes.active >= 0 ? number(row[indexes.active], -1) : -1;
      if (activeCount >= 0) group.activeCounts.push(activeCount);
    }
  }

  return Array.from(groups.values()).map((group) => {
    const existing = (state.apiPayload?.products || []).find((product) => product.part_number === group.part) || {};
    const priceMedian = group.prices.length ? median(group.prices) : number(existing.price_median_usd);
    const apiCompetitionKnown = existing.competition_known === true;
    const csvActive = group.activeCounts.length ? Math.max(...group.activeCounts) : null;
    const activeKnown = csvActive !== null || apiCompetitionKnown;
    const active = csvActive ?? number(existing.active_competition, 0);
    const score = marketScore(group.sold, active, group.prices.length ? group.prices : [priceMedian]);
    return {
      ...existing,
      part_number: group.part,
      title: group.titles[0] || existing.title || `${group.part} auto part`,
      brand: existing.brand || "Unknown",
      sold_90d_est: group.sold,
      sales_quality: "product_research_csv",
      sales_scope: "product_research_90d",
      sales_confirmation_required: false,
      sampled_listings: group.sold,
      sampled_sellers: group.sellers.size,
      active_competition: active,
      competition_known: activeKnown,
      competition_confidence: activeKnown ? "confirmed" : "unknown",
      competition_match_rate: activeKnown ? 1 : 0,
      sample_coverage: activeKnown ? 1 : 0,
      demand_ratio: group.sold / Math.max(active, 1),
      price_median_usd: priceMedian,
      price_p25_usd: group.prices.length ? percentile(group.prices, .25) : priceMedian,
      price_p75_usd: group.prices.length ? percentile(group.prices, .75) : priceMedian,
      market_score: score,
      market_judgment: !activeKnown ? "競合未取得" : score >= 72 && group.sold >= 5 ? "有望" : score >= 55 && group.sold >= 2 ? "候補" : score >= 40 ? "監視" : "見送り",
      source: "product_research_csv",
    };
  });
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

function mergeProducts() {
  const merged = new Map();
  for (const product of state.apiPayload?.products || []) merged.set(product.part_number, { ...product });
  for (const product of state.csvProducts || []) merged.set(product.part_number, { ...(merged.get(product.part_number) || {}), ...product });
  state.products = Array.from(merged.values());
}

function calculateProfit(product) {
  const values = state.costs[product.part_number] || {};
  const salePriceUsd = number(values.salePriceUsd, number(product.price_median_usd));
  const buyerShippingUsd = number(values.buyerShippingUsd);
  const exchangeRate = number(state.settings.exchangeRate, 150);
  const grossJpy = (salePriceUsd + buyerShippingUsd) * exchangeRate;
  const buyerSalesTaxUsd = (salePriceUsd + buyerShippingUsd) * number(state.settings.buyerSalesTaxRate, 0) / 100;
  const feeBaseUsd = salePriceUsd + buyerShippingUsd + buyerSalesTaxUsd;
  const feeThresholdUsd = Math.max(0, number(state.settings.ebayFeeThresholdUsd, 7500));
  const lowerFeeBaseUsd = feeThresholdUsd ? Math.min(feeBaseUsd, feeThresholdUsd) : 0;
  const upperFeeBaseUsd = feeThresholdUsd ? Math.max(0, feeBaseUsd - feeThresholdUsd) : feeBaseUsd;
  const percentageFeeUsd = lowerFeeBaseUsd * number(state.settings.ebayFeeRate) / 100
    + upperFeeBaseUsd * number(state.settings.ebayFeeAboveRate, 2.35) / 100;
  const perOrderFeeUsd = feeBaseUsd <= 10 ? 0.30 : number(state.settings.perOrderFeeUsd, 0.40);
  const ebayFee = (percentageFeeUsd + perOrderFeeUsd) * exchangeRate;
  const internationalFee = feeBaseUsd * number(state.settings.internationalFeeRate) / 100 * exchangeRate;
  const promotedFee = feeBaseUsd * number(state.settings.promotedRate) / 100 * exchangeRate;
  const fxCost = grossJpy * number(state.settings.fxSpreadRate) / 100;
  const tariff = salePriceUsd * exchangeRate * number(state.settings.tariffRate) / 100;
  const returnReserve = grossJpy * number(state.settings.returnReserveRate) / 100;
  const fixedCosts = number(values.procurementJpy) + number(values.domesticShippingJpy) + number(values.internationalShippingJpy) + number(values.packagingJpy) + number(values.customsFixedJpy);
  const totalCost = ebayFee + internationalFee + promotedFee + fxCost + tariff + returnReserve + fixedCosts;
  const profit = grossJpy - totalCost;
  const margin = grossJpy > 0 ? profit / grossJpy : 0;
  const hasCosts = number(values.procurementJpy) > 0 && number(values.internationalShippingJpy) > 0;
  const operationalChecks = [
    [profit >= number(state.settings.minimumProfitJpy), "利益"],
    [margin >= number(state.settings.minimumMarginRate) / 100, "利益率"],
    [number(product.sold_90d_est) >= number(state.settings.minimumSold90d), "販売数"],
    [product.competition_known !== false, "競合データ"],
    [number(product.market_score) >= number(state.settings.minimumMarketScore), "市場スコア"],
    [number(product.demand_ratio) >= number(state.settings.minimumDemandRatio), "販売÷競合"],
  ];
  const confirmationChecks = [
    [CONFIRMED_SALES_QUALITIES.has(product.sales_quality), "90日実績"],
    [values.tariffConfirmed === true, "DDP関税"],
  ];
  const operationalFailed = operationalChecks.filter(([passed]) => !passed).map(([, label]) => label);
  const confirmationFailed = confirmationChecks.filter(([passed]) => !passed).map(([, label]) => label);
  const failed = [...operationalFailed, ...confirmationFailed];
  const passes = hasCosts && failed.length === 0;
  const confirmationOnly = operationalFailed.length === 0 && confirmationFailed.length > 0;
  let judgment = "仕入価格・国際送料を入力してください";
  if (hasCosts) {
    if (passes) judgment = "販売候補";
    else if (profit <= 0) judgment = "赤字見込み";
    else if (confirmationOnly) judgment = `仮候補：${confirmationFailed.join("・")}確認待ち`;
    else judgment = `再検討：${failed.join("・")}`;
  }
  return {
    salePriceUsd,
    grossJpy,
    buyerSalesTaxUsd,
    feeBaseUsd,
    perOrderFeeUsd,
    ebayFee,
    tariff,
    totalCost,
    profit,
    margin,
    passes,
    hasCosts,
    failed,
    operationalFailed,
    confirmationFailed,
    confirmationOnly,
    judgment,
  };
}

function badgeClass(judgment) {
  if (["有望", "販売候補"].includes(judgment)) return "badge-good";
  if (["候補", "監視", "競合未取得", "仕入価格・国際送料を入力してください"].includes(judgment)
    || String(judgment).startsWith("再検討")
    || String(judgment).startsWith("仮候補")) return "badge-warn";
  if (["見送り", "赤字見込み"].includes(judgment)) return "badge-bad";
  return "badge-info";
}

function combinedJudgment(product, profit) {
  if (profit.hasCosts) {
    if (profit.passes) return "販売候補";
    if (profit.profit <= 0) return "見送り";
    return profit.confirmationOnly ? "仮候補" : "再検討";
  }
  if (!CONFIRMED_SALES_QUALITIES.has(product.sales_quality) && ["有望", "候補"].includes(product.market_judgment)) {
    return "仮候補";
  }
  return product.market_judgment || "データ不足";
}
