"use strict";

(function shippingModule(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PartScoutShipping = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createShippingCalculator() {
  const SOURCE_URL = "https://static.orangeconnex.com/capricorn/selfQuery/1141130239112384512.pdf";
  const EFFECTIVE_DATE = "2026-03-25";
  const CLEARANCE_JPY = 245;
  const DUTY_PROCESSING_RATE = 0.021;
  const OVERSIZE_JPY = 2475;
  const RATES = [
    [.1, 1227], [.2, 1367], [.3, 1581], [.4, 1778], [.5, 2060], [.6, 2222], [.7, 2321], [.8, 2703], [.9, 2820], [1, 3020],
    [1.1, 3136], [1.2, 3250], [1.3, 3366], [1.4, 3704], [1.5, 3816], [1.6, 3935], [1.7, 4046], [1.8, 4165], [1.9, 5056], [2, 5245],
    [2.5, 5582], [3, 6333], [3.5, 6958], [4, 7704], [4.5, 9135], [5, 11733], [5.5, 12500], [6, 13335], [6.5, 14160], [7, 15209],
    [7.5, 16058], [8, 16893], [8.5, 17562], [9, 18152], [9.5, 19106], [10, 19639], [10.5, 20276], [11, 20864], [11.5, 21565], [12, 22199],
    [12.5, 22887], [13, 23466], [13.5, 24054], [14, 24869], [14.5, 25200], [15, 25988], [15.5, 26656], [16, 28149], [16.5, 28775], [17, 29495],
    [17.5, 30196], [18, 30902], [18.5, 31478], [19, 32204], [19.5, 32936], [20, 33947], [20.5, 34655], [21, 35426], [21.5, 36145], [22, 36859],
    [22.5, 37602], [23, 38516], [23.5, 39084], [24, 39678], [24.5, 40374], [25, 40955],
  ];

  function positiveDecimal(value) {
    if (typeof value === "boolean" || value == null) return null;
    if (typeof value === "string") {
      const text = value.trim();
      if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
      value = Number(text);
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    return value;
  }

  function emptyResult(errors) {
    return {
      ok: false,
      errors,
      chargeableWeightKg: null,
      billedWeightKg: null,
      baseJpy: null,
      oversizeJpy: null,
      shippingJpy: null,
      clearanceJpy: null,
      dutyProcessingRate: DUTY_PROCESSING_RATE,
      sourceUrl: SOURCE_URL,
      effectiveDate: EFFECTIVE_DATE,
    };
  }

  function estimateEconomy(input = {}) {
    const errors = [];
    const weightKg = positiveDecimal(input.weightKg);
    const dimensions = [
      ["lengthCm", "長さ"],
      ["widthCm", "幅"],
      ["heightCm", "高さ"],
    ].map(([key, label]) => {
      const value = positiveDecimal(input[key]);
      if (value == null) errors.push(`${label}は0より大きい通常の数値で入力してください。`);
      return value;
    });
    const declaredValueUsd = positiveDecimal(input.declaredValueUsd);

    if (weightKg == null) errors.push("実重量は0より大きい通常の数値で入力してください。");
    if (declaredValueUsd == null) errors.push("申告額は0より大きい通常の数値で入力してください。");
    else if (declaredValueUsd > 1300) errors.push("申告額は1,300 USD以下にしてください。");
    if (input.region !== "US48") errors.push("米国本土48州以外はCPaSSまたは手入力で見積してください。");

    if (dimensions.every(value => value != null)) {
      const [longest, middle, shortest] = [...dimensions].sort((a, b) => b - a);
      if (longest > 66) errors.push("最長辺は66 cm以下にしてください。");
      if (longest + 2 * (middle + shortest) > 274) errors.push("長さと胴回りの合計は274 cm以下にしてください。");
    }

    if (errors.length) return emptyResult(errors);

    const volumeCm3 = dimensions.reduce((product, value) => product * value, 1);
    const actualGrams = Math.ceil(weightKg * 1000 - 1e-9);
    const volumeGrams = Math.ceil(volumeCm3 / 8 - 1e-9);
    const chargeableGrams = Math.max(actualGrams, volumeGrams);
    if (chargeableGrams > 25000) return emptyResult(["課金重量は25 kg以下にしてください。"]);

    const bracket = RATES.find(([maximumKg]) => Math.round(maximumKg * 1000) >= chargeableGrams);
    if (!bracket) return emptyResult(["対応する料金区分がありません。"]);
    const oversizeJpy = Math.max(...dimensions) > 55.88 || volumeCm3 > 55000 ? OVERSIZE_JPY : 0;
    return {
      ok: true,
      errors: [],
      chargeableWeightKg: chargeableGrams / 1000,
      billedWeightKg: bracket[0],
      baseJpy: bracket[1],
      oversizeJpy,
      shippingJpy: bracket[1] + oversizeJpy,
      clearanceJpy: CLEARANCE_JPY,
      dutyProcessingRate: DUTY_PROCESSING_RATE,
      sourceUrl: SOURCE_URL,
      effectiveDate: EFFECTIVE_DATE,
    };
  }

  return { estimateEconomy };
});
