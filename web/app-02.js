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
      brand: existing.brand || inferBrand(group.titles[0] || ""),
      sold_90d_est: group.sold,
      sold_90d_low: group.sold,
      sold_90d_high: group.sold,
      sales_quality: "product_research_csv",
      sales_confidence: "confirmed",
      sales_observed_days: 90,
      sales_scope: "product_research_90d",
      sales_auto_verified: true,
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

function mergeProducts() {
  const merged = new Map();
  for (const product of state.apiPayload?.products || []) merged.set(product.part_number, { ...product });
  for (const product of state.csvProducts || []) {
    merged.set(product.part_number, { ...(merged.get(product.part_number) || {}), ...product });
  }
  state.products = Array.from(merged.values());
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

function productDefaults(product) {
  const auto = product.auto_costs || {};
  const rakutenBest = product.rakuten?.items?.[0] || {};
  const backendTariff = number(auto.tariff_rate, number(product.tariff?.rate, NaN));
  const tariffRate = Number.isFinite(backendTariff) ? backendTariff * (backendTariff <= 1 ? 100 : 1) : tariffScenario(product.country_of_origin).rate;
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
  const automaticAnnualAllocation = annualFeeApplicable
    ? 29.95 * exchangeRate / estimatedAnnualOrders
    : 0;
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
  const operationalChecks = [
    [profit >= number(state.settings.minimumProfitJpy), "利益"],
    [margin >= number(state.settings.minimumMarginRate) / 100, "利益率"],
    [number(product.sold_90d_est) >= number(state.settings.minimumSold90d), "販売ペース"],
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

  let judgment = "仕入価格を確認";
  if (!hasProcurement) judgment = "仕入価格を確認";
  else if (!hasShipping) judgment = "送料を確認";
  else if (profit <= 0) judgment = "赤字見込み";
  else if (operationalFailed.length) judgment = `再検討：${operationalFailed.join("・")}`;
  else if (provisional) judgment = `概算候補：${confirmationFailed.join("・")}待ち`;
  else if (passes) judgment = "購入候補";

  return {
    values,
    salePriceUsd,
    exchangeRate,
    grossJpy,
    buyerSalesTaxUsd,
    feeBaseUsd,
    feeProfile: profile,
    internationalRate,
    perOrderFeeUsd,
    finalValueFeeJpy,
    internationalFeeJpy,
    promotedFeeJpy,
    insertionFeeJpy,
    ebayFeeTaxJpy,
    ebayFee,
    payoneerFee,
    payoneerAnnualAllocation,
    annualFeeApplicable,
    tariffRate,
    tariff,
    returnReserve,
    totalCost,
    profit,
    margin,
    hasProcurement,
    hasShipping,
    hasCosts,
    salesVerified,
    operationalFailed,
    confirmationFailed,
    passes,
    provisional,
    judgment,
  };
}

function badgeClass(judgment) {
  const text = String(judgment || "");
  if (["有望", "購入候補"].includes(text)) return "badge-good";
  if (["候補", "監視", "競合未取得", "学習中", "仕入価格を確認", "送料を確認"].includes(text)
    || text.startsWith("再検討") || text.startsWith("概算候補")) return "badge-warn";
  if (["見送り", "赤字見込み"].includes(text)) return "badge-bad";
  return "badge-info";
}

function combinedJudgment(product, profit) {
  if (profit.hasCosts) {
    if (profit.passes) return "購入候補";
    if (profit.profit <= 0) return "見送り";
    if (profit.operationalFailed.length === 0) return "概算候補";
    return "再検討";
  }
  if (!profit.hasProcurement) return "仕入確認";
  if (product.sales_confidence === "learning" || product.sales_confidence === "low") return "学習中";
  return product.market_judgment || "データ不足";
}

function nextAction(product, profit) {
  if (!profit.hasProcurement) return "楽天／モノタロウで仕入価格を確認";
  if (profit.profit <= 0) return "仕入価格か販売価格を見直す";
  if (profit.operationalFailed.length) return `${profit.operationalFailed[0]}が基準未達。次候補へ進む`;
  if (!profit.salesVerified) return "自動差分を蓄積中。操作は不要";
  if (profit.values.supplierConfirmed !== true) return "仕入先で価格・在庫・送料を確認";
  if (profit.values.tariffConfirmed !== true) return "原産国とDDP関税を確認";
  if (profit.passes) return "購入候補。仕入判断へ進む";
  return product.next_action || "詳細を確認";
}
