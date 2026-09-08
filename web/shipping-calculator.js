"use strict";
(() => {
  const key = "part-scout-shipping-draft-v1";
  const form = document.querySelector("#parcel-form");
  const status = document.querySelector("#calc-save");
  let storage;
  try { storage = localStorage; } catch (_) { storage = null; }
  const store = PartScoutPersistence.createStore(storage);
  let partLookup = PartScoutLookup.emptyState();
  let lookup;
  let workspaceSync;
  let researchQueue;
  let editRevision = 0;
  let importGeneration = 0;
  const controls = [...form.elements].filter(x => x.name);
  const fields = new Set(controls.map(x => x.name));
  const snapshot = () => ({...Object.fromEntries(controls.map(x => [x.name, x.value])), partLookup});
  const yen = value => `${Math.round(value).toLocaleString("ja-JP")}円`;
  function validDraft(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).every(name => name === "partLookup" || (fields.has(name) && typeof value[name] === "string" && value[name].length <= 100))
      && (!value.region || ["US48", "OTHER"].includes(value.region));
  }
  function restore(value) {
    partLookup = Object.hasOwn(value, "partLookup") ? PartScoutLookup.validateState(value.partLookup) : PartScoutLookup.emptyState();
    for (const control of controls) control.value = value[control.name] ?? (control.name === "region" ? "US48" : "");
  }
  function render() {
    const quote = PartScoutShipping.estimateEconomy(snapshot());
    document.querySelector("#shipping-price").textContent = quote.ok ? yen(quote.shippingJpy) : "未確定";
    document.querySelector("#quote-detail").textContent = quote.ok
      ? `課金重量 ${quote.chargeableWeightKg} kg（${quote.billedWeightKg} kgまでの料金）\n基本送料 ${yen(quote.baseJpy)} ＋ 寸法追加 ${yen(quote.oversizeJpy)}\n別途：輸入通関 ${yen(quote.clearanceJpy)} ＋ 関税額 ＋ 関税額の2.1%\n関税は原産国・HTSUS・発送時点の見積で確認します。`
      : quote.errors.join("\n");
  }
  function save() {
    const result = store.write(key, snapshot());
    status.textContent = result.ok ? "保存済み。この端末・ブラウザで続きから再開できます。" : "端末に保存できません。この見積をバックアップしてください。";
    if (result.ok) { workspaceSync?.changed(); researchQueue?.capture(snapshot()); }
    render();
    return result.ok;
  }
  function mountLookup() {
    lookup?.dispose();
    lookup = PartScoutLookup.mount(document.querySelector("#part-lookup"), {
      getState: () => partLookup, save, getRevision: () => editRevision,
      getContext: () => ({region:form.elements.region.value, declaredValueUsd:form.elements.declaredValueUsd.value}),
      readParcel: () => Object.fromEntries(["weightKg", "lengthCm", "widthCm", "heightCm"].map(k => [k, Number(form.elements[k].value)])),
      applyParcel: parcel => { for (const [k,v] of Object.entries(parcel)) form.elements[k].value = String(v); },
      clearParcel: () => { for (const k of ["weightKg", "lengthCm", "widthCm", "heightCm"]) form.elements[k].value = ""; },
    });
  }
  const saved = store.read(key, null);
  try { if (validDraft(saved)) restore(saved); } catch (_) { status.textContent = "保存した品番見積を読み込めません。バックアップを確認してください。"; }
  mountLookup();
  // Capture lookup edits/actions before their handlers, including measured saves.
  const lookupSection = document.querySelector("#part-lookup");
  for (const eventName of ["input", "change", "click"]) lookupSection.addEventListener(eventName, event => {
    if (event.target.matches(eventName === "click" ? "button" : "[data-lookup-field]")) editRevision++;
  }, true);
  form.addEventListener("submit", event => event.preventDefault());
  function edited(event) { editRevision++; if (["region", "declaredValueUsd"].includes(event.target.name)) lookup.contextChanged(); else lookup.manualEdit(); save(); }
  form.addEventListener("input", edited);
  form.addEventListener("change", edited);
  document.querySelector("#calc-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({format:key,data:snapshot()}, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "speedpak-shipping-backup.json";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const fileInput = document.querySelector("#calc-file");
  document.querySelector("#calc-import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    PartScoutLookup.invalidateAll();
    const revision = editRevision;
    const generation = ++importGeneration;
    try {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (file.size > 2000000) throw new Error("大きすぎるファイルです。");
      const text = await file.text();
      if (generation !== importGeneration) return;
      const value = JSON.parse(text);
      if (value.format !== key || !validDraft(value.data)) throw new Error("この画面のバックアップを選んでください。");
      if (Object.hasOwn(value.data, "partLookup")) value.data.partLookup = PartScoutLookup.validateState(value.data.partLookup);
      if (revision !== editRevision) throw new Error("入力が変更されたため復元を中止しました。");
      PartScoutLookup.invalidateAll();
      if (!store.write(key, value.data).ok) throw new Error("保存できないため、復元を中止しました。");
      restore(value.data); mountLookup(); render();
      workspaceSync?.changed(); researchQueue?.capture(snapshot());
      status.textContent = "見積を復元しました。";
    } catch (error) { if (generation === importGeneration) status.textContent = error.message || "復元できませんでした。"; }
    finally { if (generation === importGeneration) fileInput.value = ""; }
  });
  function validateSyncedDraft(value) {
    if (!validDraft(value)) throw Error("見積の形式が違います。");
    if (Object.hasOwn(value, "partLookup")) value = {...value,partLookup:PartScoutLookup.validateState(value.partLookup)};
    return value;
  }
  function applyDraft(value) {
    value = validateSyncedDraft(value);
    if (!store.write(key, value).ok) return false;
    editRevision++; importGeneration++;
    PartScoutLookup.invalidateAll();
    restore(value); mountLookup(); render();
    return true;
  }
  if (typeof PartScoutSync !== "undefined") {
    workspaceSync = PartScoutSync.mountStatus(document.querySelector("#shipping-sync"), {
      namespace:"shipping",storage,getLocal:snapshot,hasLocal:()=>store.read(key,null)!==null,
      validate:validateSyncedDraft,
      canApply:()=>!document.activeElement?.matches("#parcel-form input, #parcel-form select, #part-lookup input, #part-lookup select"),
      applyRemote:applyDraft,
    });
    workspaceSync.start();
  }
  if (typeof PartScoutQueue !== "undefined") {
    researchQueue = PartScoutQueue.mount(document.querySelector("#research-queue"), {adapter:{
      capture:snapshot,
      apply:value=>{if(!applyDraft(value))return false;workspaceSync?.changed();return true;},
      fresh:item=>({region:"US48",weightKg:"",declaredValueUsd:"",lengthCm:"",widthCm:"",heightCm:"",
        partLookup:{...PartScoutLookup.emptyState(),make:item.manufacturer,forms:{standalone:{make:item.manufacturer,part:item.partNumber}}}}),
    }});
    const requested = new URL(location.href).searchParams.get("research");
    if (requested) researchQueue.resumeRequested(requested);
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  render();
})();
