"use strict";
(function (root, factory) {
  const api = factory(
    root,
    typeof module !== "undefined" && module.exports
      ? require("./part-parcel.js")
      : root.PartScoutParcel,
  );
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PartScoutLookup = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, P) {
  const defaults = {
    make: "TOYOTA",
    part: "",
    quantity: "1",
    paddingCm: "1",
    packingGrams: "50",
    boxId: "auto",
    customInnerLengthCm: "",
    customInnerWidthCm: "",
    customInnerHeightCm: "",
    customLengthCm: "",
    customWidthCm: "",
    customHeightCm: "",
    customTareGrams: "",
    provenance: "manual",
    active: false,
  };
  const gateMessages = {
    acquisition_cooldown: "取得の間隔を空けてください。新しい取得は1分に1回までです。",
    daily_lookup_limit: "本日の新しい取得は30回に達しました。保存済みデータや実測値を利用できます。",
    provider_paused: "取得元へのアクセスを一時停止しています。確認が終わるまで実測値を入力してください。",
    source_policy_review: "取得元の利用条件を確認中です。実測値を入力してください。",
    storage_unavailable: "取得回数を確認できないため、新しい取得を停止しています。時間をおいて再確認してください。",
  };
  const transientGateReasons = new Set(["acquisition_cooldown", "daily_lookup_limit", "storage_unavailable"]);
  const gateReason = result => result?.attempts.find(a => Object.hasOwn(gateMessages, a.reason))?.reason;
  const transientGate = result => result.attempts.some(a => transientGateReasons.has(a.reason));
  let epoch = 0;
  function emptyState() {
    return { version: 1, make: "TOYOTA", forms: {}, results: [], profiles: [] };
  }
  function validateState(value) {
    if (
      !value ||
      value.version !== 1 ||
      !Object.hasOwn(P.providers, value.make) ||
      !value.forms ||
      typeof value.forms !== "object" ||
      Array.isArray(value.forms) ||
      Object.keys(value.forms).length > 200 ||
      !Array.isArray(value.results) ||
      value.results.length > 200 ||
      !Array.isArray(value.profiles) ||
      value.profiles.length > 200
    )
      throw Error("品番見積の保存形式が不正です。");
    const result = emptyState();
    result.make = value.make;
    for (const [key, form] of Object.entries(value.forms)) {
      if (
        !/^[A-Za-z0-9:_ -]{1,100}$/.test(key) ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        !form ||
        typeof form !== "object" ||
        Array.isArray(form)
      )
        throw Error("品番入力の保存形式が不正です。");
      const clean = { ...defaults };
      for (const [k, v] of Object.entries(form)) {
        if (!Object.hasOwn(defaults, k)) throw Error("梱包設定が不正です。");
        if (k === "active") {
          if (typeof v !== "boolean") throw Error("見積状態が不正です。");
        } else if (typeof v !== "string" || v.length > 100)
          throw Error("梱包入力が不正です。");
        clean[k] = v;
      }
      if (
        !Object.hasOwn(P.providers, clean.make) ||
        !["manual", "estimate", "measured"].includes(clean.provenance) ||
        !["auto", "custom", ...P.boxes.map((b) => b.id)].includes(clean.boxId)
      )
        throw Error("見積条件が不正です。");
      result.forms[key] = clean;
    }
    result.results = value.results.map(P.validateResult).filter(r => !transientGate(r));
    result.profiles = value.profiles.map((p) => {
      if (!p || !P.reuseProfile(p, p.make, p.partNumber, p.config))
        throw Error("実測記録が不正です。");
      return P.makeProfile(
        p.make,
        p.partNumber,
        p.config,
        p.parcel,
        p.measuredAt,
      );
    });
    return result;
  }
  function invalidateAll() {
    epoch++;
  }
  function mount(container, options) {
    const doc = container.ownerDocument;
    const estimate = options.estimate || root.PartScoutShipping.estimateEconomy;
    const state = () => options.getState();
    const key = options.key || "standalone";
    let revision = 0,
      controller = null,
      disposed = false;
    const stored = state().forms[key];
    const initial = {
      ...defaults,
      make: state().make,
      ...options.defaults,
      ...stored,
    };
    if (!Object.hasOwn(P.providers, initial.make)) initial.make = state().make;
    if (options.singleItem) initial.quantity = "1";
    let form = initial;
    const nodes = {};
    container.classList.add("part-lookup");
    container.replaceChildren();
    function el(tag, text, parent = container) {
      const node = doc.createElement(tag);
      if (text) node.textContent = text;
      parent.append(node);
      return node;
    }
    el("h3", "品番から梱包・送料を見積もる");
    const grid = el("div");
    grid.className = "lookup-grid";
    function field(name, label, choices, parent = grid) {
      const labelNode = el("label", label, parent);
      const control = el(choices ? "select" : "input", "", labelNode);
      control.dataset.lookupField = name;
      if (choices)
        for (const [value, text] of choices) {
          const option = el("option", text, control);
          option.value = value;
        }
      else {
        control.type = "text";
        control.inputMode = name === "part" ? "text" : "decimal";
        control.maxLength = 100;
      }
      control.value = form[name];
      nodes[name] = control;
      control.addEventListener("input", () => changed(name));
      control.addEventListener("change", () => changed(name));
      return control;
    }
    field(
      "make",
      "メーカー",
      Object.keys(P.providers).map((m) => [m, m]),
    );
    field("part", "品番");
    const action = el("button", "品番から送料を出す");
    action.type = "button";
    action.dataset.lookupAction = "";
    const refresh = el("button", "取得元を再確認");
    refresh.type = "button";
    refresh.dataset.lookupRefresh = "";
    el("p", "新しい取得は全メーカー共通で1分に1回・1日30回（日本時間）までです。保存済みデータと実測荷物の再利用は回数に含みません。");
    const sources = el("div");
    sources.dataset.lookupSources = "";
    sources.className = "lookup-sources";
    const details = el("details");
    el("summary", "梱包の仮定・箱を変更", details);
    const settings = el("div", "", details);
    settings.className = "lookup-grid";
    field(
      "quantity",
      options.singleItem ? "数量（商品カードは1個）" : "数量（1〜20個）",
      null,
      settings,
    );
    if (options.singleItem) {
      nodes.quantity.readOnly = true;
      el(
        "p",
        "商品カードの利益計算は1個分です。複数個の荷物は専用の送料画面で見積もってください。",
        details,
      );
    } else {
      el(
        "p",
        "商品申告額は、この荷物に入れる全商品の合計額（USD）を入力してください。",
        details,
      );
    }
    field("paddingCm", "外周の余裕（片側 cm）", null, settings);
    field("packingGrams", "緩衝材（1個あたり g）", null, settings);
    field(
      "boxId",
      "箱",
      [
        ["auto", "参考送料が最も安い箱"],
        ...P.boxes.map((b) => [b.id, b.id]),
        ["custom", "自分の箱"],
      ],
      settings,
    );
    const custom = el("div", "", details);
    custom.className = "lookup-grid";
    for (const [k, label] of [
      ["customInnerLengthCm", "内寸 長さ cm"],
      ["customInnerWidthCm", "内寸 幅 cm"],
      ["customInnerHeightCm", "内寸 高さ cm"],
      ["customLengthCm", "外寸 長さ cm"],
      ["customWidthCm", "外寸 幅 cm"],
      ["customHeightCm", "外寸 高さ cm"],
      ["customTareGrams", "箱の重さ g"],
    ])
      field(k, label, null, custom);
    const boxInfo = el("div", "", details);
    boxInfo.className = "lookup-boxes";
    for (const box of P.boxes) {
      const p = el(
        "p",
        `${box.id}：外寸 ${box.outer.join(" × ")} cm／内寸 ${box.inner.join(" × ")} cm／箱 ${box.tareGrams} g（2026-09-08参照） `,
        boxInfo,
      );
      const a = el("a", "箱の仕様", p);
      a.href = box.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    el(
      "p",
      "販売店の寸法が裸の部品寸法か梱包寸法かは未確認です。向きを揃えた箱詰めの仮定による参考値です。発送前に梱包後の重量・外寸を実測してください。",
      details,
    );
    const status = el("p");
    status.dataset.lookupStatus = "";
    status.setAttribute("role", "status");
    const measured = el("button", "梱包後の実測値として保存");
    measured.type = "button";
    measured.dataset.lookupMeasured = "";
    el(
      "p",
      "下の荷物の重量・外寸は編集できます。編集だけでは実測記録になりません。",
    );
    function identity() {
      return P.normalizePart(form.make, form.part);
    }
    function config() {
      return { ...form, ...options.getContext() };
    }
    function save(message) {
      const s = state();
      s.make = form.make;
      s.forms[key] = { ...form };
      while (Object.keys(s.forms).length > 200)
        delete s.forms[Object.keys(s.forms)[0]];
      const ok = options.save();
      status.textContent = ok
        ? message || "入力を保存しました。"
        : "端末に保存できません。バックアップしてください。";
      return ok;
    }
    function cancel() {
      revision++;
      if (controller) controller.abort();
      controller = null;
    }
    function clear(force = false) {
      cancel();
      if (form.active || force) {
        form.active = false;
        form.provenance = "manual";
        options.clearParcel();
      }
      sources.replaceChildren();
    }
    function resultForPart() {
      return state().results.find(
        (r) => !transientGate(r) && r.make === form.make && r.partNumber === identity(),
      );
    }
    function showSource(result) {
      sources.replaceChildren();
      if (!result || gateReason(result)) return;
      const days = Math.max(
        0,
        Math.floor((Date.now() - Date.parse(result.checkedAt)) / 86400000),
      );
      el(
        "p",
        `取得日 ${result.checkedAt.slice(0, 10)}（${days}日前）／販売店の参考仕様。 他店との照合・梱包後実測は未確認。`,
        sources,
      );
      for (const c of result.candidates) {
        const p = el(
          "p",
          `品番 ${c.partNumber}：Item Weight ${c.original.weight || "未取得"}／Item Dimensions ${c.original.dimensions || "未取得"}。換算 ${c.weightKg ?? "未取得"} kg／${c.dimensionsCm ? c.dimensionsCm.join(" × ") : "未取得"} cm `,
          sources,
        );
        const a = el("a", c.source, p);
        a.href = c.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
    }
    function apply(result) {
      const cfg = config();
      showSource(result);
      const part = identity();
      const profile = state().profiles.find((p) =>
        P.reuseProfile(p, form.make, part, cfg),
      );
      const actual = profile && P.reuseProfile(profile, form.make, part, cfg);
      if (actual && cfg.region === "US48") {
        form.active = true;
        form.provenance = "measured";
        options.applyParcel(actual);
        save(
          `保存した実測値を再利用しました（${profile.measuredAt.slice(0, 10)}）。送料は参考値です。`,
        );
        return true;
      }
      const gate = gateReason(result);
      if (gate) {
        save(gateMessages[gate] + (result.retryAfterSeconds
          ? ` 再確認は少なくとも${Math.ceil(result.retryAfterSeconds / 60)}分後です。` : ""));
        return false;
      }
      if (!result || !["found", "partial"].includes(result.status)) {
        save(
          "寸法・重量を取得できません。荷物の実測値を下に入力してください。",
        );
        return false;
      }
      const complete = result.candidates.filter(
        (c) => c.weightKg != null && c.dimensionsCm != null,
      );
      const signatures = new Set(
        complete.map((c) => JSON.stringify([c.weightKg, c.dimensionsCm])),
      );
      if (signatures.size !== 1) {
        save("寸法・重量が不足または一致しません。自動の箱を決められません。");
        return false;
      }
      const selected = P.selectParcel(complete[0], cfg, estimate);
      if (!selected.ok) {
        save(selected.error);
        return false;
      }
      form.active = true;
      form.provenance = "estimate";
      options.applyParcel(selected.parcel);
      save(
        `${selected.box.id === "custom" ? "自分の箱" : selected.box.id} の外寸・重量で参考計算。実測前の推定値です。`,
      );
      return true;
    }
    function changed(name) {
      if (name === "quantity" && options.singleItem) nodes.quantity.value = "1";
      if (form[name] === nodes[name].value) return;
      form[name] = nodes[name].value;
      clear();
      custom.hidden = form.boxId !== "custom";
      save();
      options.onSettingsChange?.();
      if (!["make", "part"].includes(name)) {
        apply(resultForPart());
      }
    }
    async function lookup(force = false) {
      clear(true);
      save("取得中…");
      options.onSettingsChange?.();
      const part = identity();
      if (!part) {
        save("メーカーと英数字の品番を確認してください。");
        return;
      }
      const saved = resultForPart();
      const profile = state().profiles.find((p) =>
        P.reuseProfile(p, form.make, part, config()),
      );
      if (!force && profile) {
        apply(saved);
        return;
      }
      if (
        !force &&
        saved &&
        Date.now() - Date.parse(saved.checkedAt) <
          (["found", "partial"].includes(saved.status) ? 7 * 86400000 : 300000)
      ) {
        apply(saved);
        return;
      }
      const capturedRevision = options.getRevision?.();
      const ticket = revision,
        capturedEpoch = epoch,
        capturedIdentity = form.make + ":" + part,
        capturedConfig = P.fingerprint(form.make, part, config());
      controller = new AbortController();
      const current = () =>
        !disposed &&
        capturedRevision === options.getRevision?.() &&
        ticket === revision &&
        capturedEpoch === epoch &&
        capturedIdentity === form.make + ":" + identity() &&
        capturedConfig === P.fingerprint(form.make, identity(), config());
      let transportFailed = true;
      try {
        const response = await (options.fetchImpl || root.fetch)(
          `/api/part-metadata?make=${encodeURIComponent(form.make)}&part=${encodeURIComponent(part)}${force ? "&refresh=1" : ""}`,
          {
            signal: controller.signal,
            credentials: "same-origin",
            cache: "no-store",
          },
        );
        transportFailed = false;
        if (!response.ok) throw Error("取得できませんでした。");
        const result = P.validateResult(await response.json());
        if (!current()) return;
        if (result.make !== form.make || result.partNumber !== part)
          throw Error("取得した品番が一致しません。");
        if (!transientGate(result)) state().results = [
          result,
          ...state().results.filter(
            (r) => r.make !== result.make || r.partNumber !== result.partNumber,
          ),
        ].slice(0, 200);
        apply(result);
      } catch (error) {
        if (!current()) return;
        if (saved && transportFailed && error.name !== "AbortError") {
          apply(saved);
          status.textContent +=
            " 接続できないため保存済みの取得日を使用しています。";
        } else
          save(
            "取得できません。実測値を入力するか、時間をおいて再確認してください。",
          );
      }
    }
    action.addEventListener("click", () => lookup());
    refresh.addEventListener("click", () => lookup(true));
    measured.addEventListener("click", () => {
      cancel();
      const parcel = options.readParcel();
      const p = P.makeProfile(form.make, identity(), config(), parcel);
      if (!p) {
        save(
          "有効な品番・数量・梱包設定と、荷物の重量・外寸を入力してください。",
        );
        return;
      }
      const previous = state().profiles;
      state().profiles = [
        p,
        ...previous.filter((v) => v.fingerprint !== p.fingerprint),
      ].slice(0, 200);
      const old = { ...form };
      form.provenance = "measured";
      form.active = true;
      if (!save("梱包後の実測値を保存しました。")) {
        state().profiles = previous;
        form = old;
      }
    });
    if (form.provenance === "measured") {
      const actual = options.readParcel();
      const profile = state().profiles.find((p) => {
        const parcel = P.reuseProfile(p, form.make, identity(), config());
        return (
          parcel &&
          ["weightKg", "lengthCm", "widthCm", "heightCm"].every(
            (k) => parcel[k] === actual[k],
          )
        );
      });
      if (!profile) {
        form.provenance = "manual";
        form.active = false;
      }
    }
    custom.hidden = form.boxId !== "custom";
    showSource(resultForPart());
    status.textContent =
      form.provenance === "measured"
        ? "保存した実測値です。送料は参考値です。"
        : form.provenance === "estimate"
          ? "販売店の参考仕様からの推定値です。"
          : "品番を入力して送料を見積もれます。";
    return {
      lookup,
      manualEdit() {
        cancel();
        form.active = false;
        form.provenance = "manual";
        save(
          "荷物の入力を変更しました。実測記録は保存ボタンで確定してください。",
        );
      },
      contextChanged() {
        const wasActive = form.active;
        clear();
        save();
        options.onSettingsChange?.();
        if (wasActive) apply(resultForPart());
      },
      dispose() {
        disposed = true;
        cancel();
      },
    };
  }
  return { emptyState, validateState, mount, invalidateAll };
});
