"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PartScoutParcel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const providers = {
    TOYOTA: ["www.toyotapartsdeal.com", "/oem/toyota~"],
    NISSAN: ["www.nissanpartsdeal.com", "/parts/nissan~"],
    HONDA: ["www.hondapartsnow.com", "/genuine/honda~"],
    SUBARU: ["www.subarupartsdeal.com", "/parts/subaru~"],
  };
  const boxes = [
    {
      id: "cb11-060",
      outer: [25, 18, 16.3],
      inner: [24, 17, 14.8],
      tareGrams: 145,
    },
    {
      id: "cb09-080-a4",
      outer: [31.5, 22.5, 25],
      inner: [30.5, 21.5, 23],
      tareGrams: 264,
    },
    {
      id: "cb03-100-a4",
      outer: [34, 25, 25.5],
      inner: [33, 24, 24],
      tareGrams: 344,
    },
  ].map((b) => ({
    ...b,
    url: "https://www.boxbank.jp/c/cardboard/" + b.id,
    checkedAt: "2026-09-08",
  }));
  function number(v, min = 0, max = 1e6) {
    if (typeof v === "string") {
      if (!/^(\d+(?:\.\d+)?|\.\d+)$/.test(v.trim())) return null;
      v = Number(v);
    }
    return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
      ? v
      : null;
  }
  const positive = (v) => {
    const n = number(v);
    return n > 0 ? n : null;
  };
  function normalizePart(make, value) {
    if (
      !Object.hasOwn(providers, make) ||
      typeof value !== "string" ||
      value.length > 40 ||
      !/^[a-zA-Z0-9 _-]+$/.test(value)
    )
      return null;
    const s = value.toUpperCase().replace(/[ _-]/g, "");
    if (!/^[A-Z0-9]{5,25}$/.test(s)) return null;
    if (["TOYOTA", "NISSAN"].includes(make) && s.length === 10)
      return s.slice(0, 5) + "-" + s.slice(5);
    if (make === "HONDA" && s.length === 11)
      return s.slice(0, 5) + "-" + s.slice(5, 8) + "-" + s.slice(8);
    return s;
  }
  function safeSourceUrl(value, make, partNumber) {
    try {
      const url = new URL(value),
        p = providers[make];
      return (
        !!p &&
        url.protocol === "https:" &&
        url.hostname === p[0] &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        new RegExp(
          "^" +
            p[1].replace("~", "") +
            "(?:-[a-z0-9_-]+)?(?:~[a-z0-9_-]+)+\\.html$",
          "i",
        ).test(url.pathname) &&
        normalizePart(
          make,
          url.pathname
            .split("~")
            .pop()
            .replace(/\.html$/i, ""),
        ) === normalizePart(make, partNumber) &&
        normalizePart(make, partNumber) !== null
      );
    } catch (_) {
      return false;
    }
  }
  const dimensions = (v) =>
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && positive(n) != null);
  function configValue(c = {}) {
    const quantity = number(c.quantity, 1, 20),
      paddingCm = number(c.paddingCm, 0, 100),
      packingGrams = number(c.packingGrams, 0, 10000);
    if (
      !Number.isInteger(quantity) ||
      paddingCm == null ||
      packingGrams == null ||
      !["auto", "custom", ...boxes.map((b) => b.id)].includes(c.boxId)
    )
      return null;
    const value = { quantity, paddingCm, packingGrams, boxId: c.boxId };
    if (c.boxId === "custom") {
      for (const k of [
        "customInnerLengthCm",
        "customInnerWidthCm",
        "customInnerHeightCm",
        "customLengthCm",
        "customWidthCm",
        "customHeightCm",
        "customTareGrams",
      ]) {
        const n = k === "customTareGrams" ? number(c[k]) : positive(c[k]);
        if (n == null) return null;
        value[k] = n;
      }
      if (
        ["Length", "Width", "Height"].some(
          (k) => value["customInner" + k + "Cm"] > value["custom" + k + "Cm"],
        )
      )
        return null;
    }
    return value;
  }
  function fits(item, inner, quantity, paddingCm) {
    if (
      !dimensions(item) ||
      !dimensions(inner) ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 20 ||
      number(paddingCm) == null
    )
      return false;
    const orientations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    return orientations.some(
      (order) =>
        order.reduce(
          (capacity, axis, i) =>
            capacity *
            Math.max(
              0,
              Math.floor((inner[i] - 2 * paddingCm + 1e-10) / item[axis]),
            ),
          1,
        ) >= quantity,
    );
  }
  function selectParcel(item, config, estimate) {
    const c = configValue(config);
    const fail = {
      ok: false,
      error:
        "品目の寸法・重量、数量、梱包条件、発送先を確認してください。箱に収まらない場合は実測値を入力してください。",
    };
    if (
      !c ||
      !item ||
      positive(item.weightKg) == null ||
      !dimensions(item.dimensionsCm) ||
      config.region !== "US48"
    )
      return fail;
    const choices =
      c.boxId === "custom"
        ? [
            {
              id: "custom",
              inner: [
                c.customInnerLengthCm,
                c.customInnerWidthCm,
                c.customInnerHeightCm,
              ],
              outer: [c.customLengthCm, c.customWidthCm, c.customHeightCm],
              tareGrams: c.customTareGrams,
            },
          ]
        : boxes.filter((b) => c.boxId === "auto" || b.id === c.boxId);
    const matches = [];
    for (const box of choices) {
      if (!fits(item.dimensionsCm, box.inner, c.quantity, c.paddingCm))
        continue;
      const parcel = {
        weightKg:
          item.weightKg * c.quantity +
          box.tareGrams / 1000 +
          (c.packingGrams * c.quantity) / 1000,
        lengthCm: box.outer[0],
        widthCm: box.outer[1],
        heightCm: box.outer[2],
      };
      // A fixed positive declaration allows box comparison even before the user enters a declaration.
      // The actual quote below still requires the user's own declaration.
      const comparison = estimate({
        ...parcel,
        region: config.region,
        declaredValueUsd: 1,
      });
      if (!comparison.ok) continue;
      matches.push({
        ok: true,
        parcel,
        box,
        quote: estimate({
          ...parcel,
          region: config.region,
          declaredValueUsd: config.declaredValueUsd,
        }),
        cost: comparison.shippingJpy,
      });
    }
    matches.sort(
      (a, b) =>
        a.cost - b.cost ||
        a.box.outer.reduce((a, b) => a * b) -
          b.box.outer.reduce((a, b) => a * b),
    );
    return matches[0] || fail;
  }
  const parcelKeys = ["weightKg", "lengthCm", "widthCm", "heightCm"];
  function validParcel(p) {
    return (
      !!p &&
      typeof p === "object" &&
      Object.keys(p).length === 4 &&
      parcelKeys.every(
        (k) => typeof p[k] === "number" && positive(p[k]) != null,
      )
    );
  }
  function fingerprint(make, part, c) {
    const cfg = configValue(c),
      normalized = normalizePart(make, part);
    return cfg && normalized ? JSON.stringify([make, normalized, cfg]) : null;
  }
  function validDate(s) {
    return (
      typeof s === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) &&
      Number.isFinite(Date.parse(s)) &&
      Date.parse(s) <= Date.now() + 300000
    );
  }
  function makeProfile(
    make,
    part,
    config,
    parcel,
    measuredAt = new Date().toISOString(),
  ) {
    const key = fingerprint(make, part, config);
    if (!key || !validParcel(parcel) || !validDate(measuredAt)) return null;
    return {
      make,
      partNumber: normalizePart(make, part),
      config: configValue(config),
      fingerprint: key,
      parcel: { ...parcel },
      provenance: "measured",
      measuredAt,
    };
  }
  function reuseProfile(profile, make, part, config) {
    const key = fingerprint(make, part, config);
    if (
      !profile ||
      profile.provenance !== "measured" ||
      !validDate(profile.measuredAt) ||
      !validParcel(profile.parcel) ||
      !key ||
      profile.fingerprint !== key ||
      fingerprint(profile.make, profile.partNumber, profile.config) !== key
    )
      return null;
    return { ...profile.parcel };
  }
  function validateResult(r) {
    if (
      !r ||
      r.schemaVersion !== 1 ||
      !normalizePart(r.make, r.partNumber) ||
      normalizePart(r.make, r.partNumber) !== r.partNumber ||
      !validDate(r.checkedAt) ||
      ![
        "found",
        "partial",
        "not_found",
        "unavailable",
        "unsupported",
        "conflict",
      ].includes(r.status) ||
      !Array.isArray(r.candidates) ||
      r.candidates.length > 4 ||
      !Array.isArray(r.attempts) ||
      r.attempts.length > 8 ||
      (Object.hasOwn(r, "retryAfterSeconds") &&
        (typeof r.retryAfterSeconds !== "number" ||
          !Number.isFinite(r.retryAfterSeconds) || r.retryAfterSeconds <= 0))
    )
      throw Error("取得データの形式を確認できません。");
    const candidates = r.candidates.map((c) => {
      if (
        !c ||
        c.partNumber !== r.partNumber ||
        !safeSourceUrl(c.url, r.make, r.partNumber) ||
        c.source !== providers[r.make][0] ||
        c.basis !== "retailer_item_unspecified" ||
        !validDate(c.checkedAt) ||
        c.checkedAt !== r.checkedAt ||
        (c.weightKg !== null &&
          (typeof c.weightKg !== "number" || positive(c.weightKg) == null)) ||
        (c.dimensionsCm !== null && !dimensions(c.dimensionsCm)) ||
        !c.original ||
        !["weight", "dimensions"].every(
          (k) =>
            c.original[k] === null ||
            (typeof c.original[k] === "string" && c.original[k].length <= 200),
        )
      )
        throw Error("取得元または測定値が不正です。");
      return {
        source: c.source,
        url: c.url,
        partNumber: c.partNumber,
        weightKg: c.weightKg,
        dimensionsCm: c.dimensionsCm && [...c.dimensionsCm],
        original: {
          weight: c.original.weight,
          dimensions: c.original.dimensions,
        },
        basis: c.basis,
        checkedAt: c.checkedAt,
      };
    });
    if (
      r.status === "found" &&
      (!candidates.length ||
        candidates.some((c) => c.weightKg == null || c.dimensionsCm == null))
    )
      throw Error("寸法・重量が不足しています。");
    if (!["found", "partial"].includes(r.status) && candidates.length)
      throw Error("取得状態が不正です。");
    return {
      schemaVersion: 1,
      make: r.make,
      partNumber: r.partNumber,
      status: r.status,
      checkedAt: r.checkedAt,
      ...(Object.hasOwn(r, "retryAfterSeconds") ? { retryAfterSeconds: r.retryAfterSeconds } : {}),
      candidates,
      attempts: r.attempts.map((a) => {
        if (
          !a ||
          a.source !== providers[r.make][0] ||
          typeof a.reason !== "string" ||
          a.reason.length > 100
        )
          throw Error("取得履歴が不正です。");
        return { source: a.source, reason: a.reason };
      }),
    };
  }
  return {
    boxes,
    providers,
    normalizePart,
    safeSourceUrl,
    number,
    positive,
    configValue,
    fits,
    selectParcel,
    fingerprint,
    validParcel,
    validDate,
    makeProfile,
    reuseProfile,
    validateResult,
  };
});
