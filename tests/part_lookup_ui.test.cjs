const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const root = path.join(__dirname, "../web");
const html =
  "<table><tr><td>Manufacturer Part Number</td><td>90915-10001</td></tr><tr><td>Item Dimensions</td><td>3.1 x 3.0 x 3.4 inches</td></tr><tr><td>Item Weight</td><td>0.80 Pounds</td></tr><tr><td>SKU</td><td>90915-10001</td></tr></table>";
const tick = () => new Promise((r) => setTimeout(r, 20));
function open(saved, fetchImpl) {
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "shipping-calculator.html"), "utf8"),
    {
      url: "https://local.test/shipping-calculator.html",
      runScripts: "outside-only",
    },
  );
  const w = dom.window;
  if (saved) w.localStorage.setItem("part-scout-shipping-draft-v1", saved);
  w.fetch = fetchImpl || (() => Promise.reject(Error("offline")));
  w.URL.createObjectURL = () => "blob:test";
  w.URL.revokeObjectURL = () => {};
  for (const s of [
    "persistence.js",
    "shipping.js",
    "part-parcel.js",
    "part-lookup-ui.js",
    "shipping-calculator.js",
  ])
    if (fs.existsSync(path.join(root, s)))
      w.eval(fs.readFileSync(path.join(root, s), "utf8"));
  return dom;
}
function input(w, selector, value) {
  const el = w.document.querySelector(selector);
  assert.ok(el, selector + " exists");
  el.value = value;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
  return el;
}
function action(w) {
  const button = w.document.querySelector("[data-lookup-action]");
  assert.ok(button, "deliberate part lookup action exists");
  button.click();
}
async function boundary(url) {
  const { handlePartMetadata } = await import("../server/part-metadata.mjs");
  return handlePartMetadata(new Request(new URL(url, "https://local.test")), {
    fetchImpl: async (u) =>
      new Response(
        u.endsWith("robots.txt") ? "User-agent: *\nDisallow: /online/" : html,
      ),
  });
}
test("standalone real input → HTTP parser → source → parcel → estimator persists immediately", async () => {
  const dom = open(null, boundary),
    w = dom.window;
  input(w, "[name=declaredValueUsd]", "20");
  input(w, "[data-lookup-field=part]", "9091510001");
  action(w);
  await tick();
  assert.equal(
    w.document.querySelector("[name=weightKg]").value,
    "0.557873896",
  );
  assert.match(
    w.document.querySelector("#shipping-price").textContent,
    /3,020/,
  );
  assert.match(
    w.document.querySelector("[data-lookup-sources]").textContent,
    /0.80 Pounds/,
  );
  assert.match(
    w.document.querySelector("[data-lookup-sources]").textContent,
    /他店との照合/,
  );
  assert.match(
    w.document.querySelector("[data-lookup-sources] a").href,
    /toyotapartsdeal/,
  );
  const saved = w.localStorage.getItem("part-scout-shipping-draft-v1");
  dom.window.close();
  const reopened = open(saved);
  assert.equal(
    reopened.window.document.querySelector("[data-lookup-field=part]").value,
    "9091510001",
  );
  assert.equal(
    reopened.window.document.querySelector("[name=weightKg]").value,
    "0.557873896",
  );
  reopened.window.close();
});
test("measured parcel is explicit, survives offline reopen, and settings changes demote it", async () => {
  const dom = open(null, boundary),
    w = dom.window;
  input(w, "[name=declaredValueUsd]", "20");
  input(w, "[data-lookup-field=part]", "90915-10001");
  action(w);
  await tick();
  input(w, "[name=weightKg]", "0.7");
  w.document.querySelector("[data-lookup-measured]").click();
  assert.match(
    w.document.querySelector("[data-lookup-status]").textContent,
    /実測.*保存/,
  );
  const saved = w.localStorage.getItem("part-scout-shipping-draft-v1");
  dom.window.close();
  const again = open(saved),
    v = again.window;
  action(v);
  await tick();
  assert.equal(v.document.querySelector("[name=weightKg]").value, "0.7");
  input(v, "[data-lookup-field=packingGrams]", "60");
  assert.notEqual(v.document.querySelector("[name=weightKg]").value, "0.7");
  assert.doesNotMatch(
    v.document.querySelector("[data-lookup-status]").textContent,
    /実測.*再利用/,
  );
  again.window.close();
});
test("new identity and manual edit win against an already pending lookup", async () => {
  for (const manual of [false, true]) {
    let release;
    const dom = open(
        null,
        (url) =>
          new Promise((resolve) => {
            release = () => boundary(url).then(resolve);
          }),
      ),
      w = dom.window;
    input(w, "[data-lookup-field=part]", "9091510001");
    action(w);
    if (manual) input(w, "[name=weightKg]", "0.8");
    else input(w, "[data-lookup-field=part]", "9091510002");
    release();
    await tick();
    assert.equal(
      w.document.querySelector("[name=weightKg]").value,
      manual ? "0.8" : "",
    );
    assert.equal(
      w.document.querySelector("#shipping-price").textContent,
      "未確定",
    );
    dom.window.close();
  }
});
test("backup validation accepts legacy and rejects unsafe imported records atomically", async () => {
  const dom = open(),
    w = dom.window;
  input(w, "[name=weightKg]", "1.2");
  const original = w.localStorage.getItem("part-scout-shipping-draft-v1");
  const file = w.document.querySelector("#calc-file");
  Object.defineProperty(file, "files", {
    configurable: true,
    value: [
      {
        size: 100,
        text: async () =>
          JSON.stringify({
            format: "part-scout-shipping-draft-v1",
            data: { weightKg: "2" },
          }),
      },
    ],
  });
  file.dispatchEvent(new w.Event("change"));
  await tick();
  assert.equal(w.document.querySelector("[name=weightKg]").value, "2");
  const previous = w.localStorage.getItem("part-scout-shipping-draft-v1");
  Object.defineProperty(file, "files", {
    configurable: true,
    value: [
      {
        size: 100,
        text: async () =>
          JSON.stringify({
            format: "part-scout-shipping-draft-v1",
            data: {
              weightKg: "3",
              partLookup: {
                version: 1,
                make: "TOYOTA",
                forms: {},
                profiles: [],
                results: [{ url: "https://evil.test" }],
              },
            },
          }),
      },
    ],
  });
  file.dispatchEvent(new w.Event("change"));
  await tick();
  assert.equal(
    w.localStorage.getItem("part-scout-shipping-draft-v1"),
    previous,
  );
  assert.equal(w.document.querySelector("[name=weightKg]").value, "2");
  assert.notEqual(original, previous);
  dom.window.close();
});
test("storage failure is visible and cannot falsely save a measured parcel", async () => {
  const dom = open(null, boundary),
    w = dom.window;
  input(w, "[data-lookup-field=part]", "9091510001");
  action(w);
  await tick();
  w.Storage.prototype.setItem = () => {
    throw Error("quota");
  };
  w.document.querySelector("[data-lookup-measured]").click();
  assert.match(
    w.document.querySelector("[data-lookup-status]").textContent,
    /保存できません/,
  );
  dom.window.close();
});
function openMain() {
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "index.html"), "utf8"),
    { url: "https://local.test/", runScripts: "outside-only" },
  );
  const w = dom.window;
  w.fetch = (url) =>
    String(url).startsWith("/api/part-metadata")
      ? boundary(url)
      : Promise.reject(Error("offline"));
  w.CSS = { escape: (s) => s };
  w.scrollTo = () => {};
  for (const s of [
    "persistence.js",
    "shipping.js",
    "part-parcel.js",
    "part-lookup-ui.js",
    "app.js",
  ])
    require("node:vm").runInContext(
      fs.readFileSync(path.join(root, s), "utf8"),
      dom.getInternalVMContext(),
    );
  return dom;
}
test("product card action uses its identity, keeps scalar costs, invalidates confirmations, and backs up lookup records", async () => {
  const dom = openMain(),
    w = dom.window;
  await tick();
  w.eval(
    `state.products=[normalizeProduct({part_number:'90915-10001',brand:'TOYOTA',title:'Filter',price_median_usd:20})];state.costs['90915-10001']={salePriceUsd:20,internationalShippingJpy:4567,supplierConfirmed:true,tariffConfirmed:true};document.body.append(createProductCard(state.products[0],1));`,
  );
  const card = w.document.querySelector(".product-card");
  assert.ok(
    card.querySelector("[data-lookup-action]"),
    "product card lookup is mounted",
  );
  assert.equal(
    card.querySelector("[data-cost=internationalShippingJpy]").value,
    "4567",
  );
  assert.equal(
    card.querySelector("[data-lookup-field=part]").value,
    "90915-10001",
  );
  card.querySelector("[data-lookup-action]").click();
  await tick();
  assert.equal(
    card.querySelector("[data-cost=parcelWeightKg]").value,
    "0.557873896",
  );
  const data = JSON.parse(w.localStorage.getItem("part-scout-user-v1"));
  assert.equal(data.costs["90915-10001"].supplierConfirmed, false);
  assert.equal(data.costs["90915-10001"].tariffConfirmed, false);
  assert.equal(data.costs["90915-10001"].internationalShippingJpy, 4567);
  const backup = w.eval("makeBackup()");
  assert.equal(JSON.parse(backup).data.partLookup.results.length, 1);
  const bad = JSON.parse(backup);
  bad.data.partLookup.results[0].candidates[0].url =
    "https://evil.test/oem/toyota~x.html";
  const before = w.localStorage.getItem("part-scout-user-v1");
  assert.throws(() => w.restoreBackup(JSON.stringify(bad)));
  assert.equal(w.localStorage.getItem("part-scout-user-v1"), before);
  dom.window.close();
});
test("refresh with malformed schema never resurrects an older source quote", async () => {
  let broken = false;
  const dom = open(null, (url) =>
      broken
        ? Promise.resolve(new Response('{"schemaVersion":1,"status":"found"}'))
        : boundary(url),
    ),
    w = dom.window;
  input(w, "[name=declaredValueUsd]", "20");
  input(w, "[data-lookup-field=part]", "9091510001");
  action(w);
  await tick();
  broken = true;
  w.document.querySelector("[data-lookup-refresh]").click();
  await tick();
  assert.equal(w.document.querySelector("[name=weightKg]").value, "");
  assert.equal(
    w.document.querySelector("#shipping-price").textContent,
    "未確定",
  );
  dom.window.close();
});
test("partial or conflicting imported measurements cannot claim found or measured provenance", () => {
  const P = require("../web/part-parcel.js"),
    L = require("../web/part-lookup-ui.js");
  assert.throws(() =>
    P.validateResult({
      schemaVersion: 1,
      make: "TOYOTA",
      partNumber: "90915-10001",
      status: "found",
      checkedAt: "2026-09-08T00:00:00.000Z",
      candidates: [],
      attempts: [],
    }),
  );
  const dom = open(),
    w = dom.window;
  const state = L.emptyState();
  state.forms.standalone = {
    make: "TOYOTA",
    part: "90915-10001",
    provenance: "measured",
    active: true,
  };
  const saved = JSON.stringify({ weightKg: "1", partLookup: state });
  dom.window.close();
  const reopened = open(saved);
  assert.doesNotMatch(
    reopened.window.document.querySelector("[data-lookup-status]").textContent,
    /保存した実測値/,
  );
  reopened.window.close();
});
test("pending request cannot apply after backup restoration", async () => {
  let release;
  const dom = open(
      null,
      (url) =>
        new Promise((resolve) => {
          release = () => boundary(url).then(resolve);
        }),
    ),
    w = dom.window;
  input(w, "[data-lookup-field=part]", "9091510001");
  action(w);
  const file = w.document.querySelector("#calc-file");
  Object.defineProperty(file, "files", {
    value: [
      {
        size: 100,
        text: async () =>
          JSON.stringify({
            format: "part-scout-shipping-draft-v1",
            data: { weightKg: "1.9" },
          }),
      },
    ],
  });
  file.dispatchEvent(new w.Event("change"));
  await tick();
  release();
  await tick();
  assert.equal(w.document.querySelector("[name=weightKg]").value, "1.9");
  dom.window.close();
});
test("editing another card for the same part invalidates the first card pending result", async () => {
  const dom = openMain(),
    w = dom.window;
  await tick();
  let release;
  w.fetch = (url) =>
    new Promise((resolve) => {
      release = () => boundary(url).then(resolve);
    });
  w.eval(
    `state.products=[normalizeProduct({part_number:'90915-10001',brand:'TOYOTA',title:'Filter',price_median_usd:20})];document.body.append(createProductCard(state.products[0],1),createProductCard(state.products[0],2));`,
  );
  const cards = w.document.querySelectorAll(".product-card");
  cards[0].querySelector("[data-lookup-action]").click();
  const control = cards[1].querySelector("[data-cost=parcelWeightKg]");
  control.value = "0.9";
  control.dispatchEvent(new w.Event("input", { bubbles: true }));
  release();
  await tick();
  assert.equal(
    cards[1].querySelector("[data-cost=parcelWeightKg]").value,
    "0.9",
  );
  assert.equal(
    JSON.parse(w.localStorage.getItem("part-scout-user-v1")).costs[
      "90915-10001"
    ].parcelWeightKg,
    "0.9",
  );
  dom.window.close();
});
test("offline shell installation contains both calculators and shared lookup dependencies", async () => {
  const handlers = {},
    cached = new Set();
  const context = require("node:vm").createContext({
    URL,
    Response,
    Headers,
    AbortController,
    setTimeout,
    clearTimeout,
    importScripts() {},
    caches: {
      open: async () => ({
        addAll: async (urls) =>
          urls.forEach((u) =>
            cached.add(new URL(u, "https://local.test/").pathname),
          ),
      }),
    },
    self: {
      PartScoutSWCore: require("../web/sw_core.js"),
      location: { origin: "https://local.test" },
      registration: { scope: "https://local.test/" },
      addEventListener: (name, fn) => (handlers[name] = fn),
      skipWaiting() {},
    },
  });
  require("node:vm").runInContext(
    fs.readFileSync(path.join(root, "sw.js"), "utf8"),
    context,
  );
  let pending;
  handlers.install({ waitUntil: (p) => (pending = p) });
  await pending;
  for (const asset of [
    "/shipping-calculator.html",
    "/shipping-calculator.js",
    "/part-parcel.js",
    "/part-lookup-ui.js",
  ])
    assert.ok(cached.has(asset), asset + " available offline");
});
test("adding declaration after lookup recalculates the same derived parcel; unsupported region clears it", async () => {
  const dom = open(null, boundary),
    w = dom.window;
  input(w, "[data-lookup-field=part]", "9091510001");
  action(w);
  await tick();
  assert.equal(
    w.document.querySelector("#shipping-price").textContent,
    "未確定",
  );
  input(w, "[name=declaredValueUsd]", "20");
  assert.equal(
    w.document.querySelector("[name=weightKg]").value,
    "0.557873896",
  );
  assert.match(
    w.document.querySelector("#shipping-price").textContent,
    /3,020/,
  );
  input(w, "[name=region]", "OTHER");
  assert.equal(w.document.querySelector("[name=weightKg]").value, "");
  assert.equal(
    w.document.querySelector("#shipping-price").textContent,
    "未確定",
  );
  dom.window.close();
});
test("new backup state rejects false or oversized records before replacing the saved draft", async () => {
  const dom = open(),
    w = dom.window;
  input(w, "[name=weightKg]", "1");
  const before = w.localStorage.getItem("part-scout-shipping-draft-v1");
  const file = w.document.querySelector("#calc-file");
  for (const partLookup of [
    false,
    {
      version: 1,
      make: "TOYOTA",
      forms: {},
      results: Array(201).fill({}),
      profiles: [],
    },
  ]) {
    Object.defineProperty(file, "files", {
      configurable: true,
      value: [
        {
          size: 100,
          text: async () =>
            JSON.stringify({
              format: "part-scout-shipping-draft-v1",
              data: { weightKg: "2", partLookup },
            }),
        },
      ],
    });
    file.dispatchEvent(new w.Event("change"));
    await tick();
    assert.equal(
      w.localStorage.getItem("part-scout-shipping-draft-v1"),
      before,
    );
  }
  dom.window.close();
});
test("product cards keep a single-item parcel so market defaults cannot become bundle economics", async () => {
  const dom = openMain(),
    w = dom.window;
  await tick();
  w.eval(
    `state.products=[normalizeProduct({part_number:'90915-10001',brand:'TOYOTA',title:'Filter',price_median_usd:20})];document.body.append(createProductCard(state.products[0],1));`,
  );
  const quantity = w.document.querySelector(
    ".product-card [data-lookup-field=quantity]",
  );
  assert.equal(quantity.value, "1");
  assert.equal(quantity.readOnly, true);
  assert.match(
    w.document.querySelector(".product-card .part-lookup").textContent,
    /商品カード.*1個/,
  );
  dom.window.close();
});

test("manual shipping selection after lookup preserves amount and supplier confirmation workflow", async () => {
  const dom = openMain(), w = dom.window;
  await tick();
  w.eval(`state.products=[normalizeProduct({part_number:'90915-10001',brand:'TOYOTA',title:'Filter',price_median_usd:20})];state.costs['90915-10001']={salePriceUsd:20,internationalShippingJpy:4567};document.body.append(createProductCard(state.products[0],1));`);
  action(w); await tick();
  const method = w.document.querySelector("[data-cost=shippingMethod]");
  method.value = "manual"; method.dispatchEvent(new w.Event("change", {bubbles:true}));
  const data = JSON.parse(w.localStorage.getItem("part-scout-user-v1"));
  assert.equal(method.value, "manual");
  assert.equal(data.costs["90915-10001"].shippingMethod, "manual");
  assert.equal(data.costs["90915-10001"].internationalShippingJpy, 4567);
  assert.equal(data.partLookup.forms["product:90915-10001"].active, false);
  assert.equal(w.document.querySelector("[data-cost=internationalShippingJpy]").value, "4567");
  const confirm = w.document.querySelector("[data-cost=supplierConfirmed]");
  assert.equal(confirm.disabled, false);
  confirm.checked = true; confirm.dispatchEvent(new w.Event("change", {bubbles:true}));
  assert.equal(JSON.parse(w.localStorage.getItem("part-scout-user-v1")).costs["90915-10001"].supplierConfirmed, true);
  dom.window.close();
});
function startImport(w, read) {
  const file = w.document.querySelector("#calc-file");
  Object.defineProperty(file, "files", {configurable:true, value:[{size:100,text:read}]});
  file.dispatchEvent(new w.Event("change"));
}
const legacyBackup = weight => JSON.stringify({format:"part-scout-shipping-draft-v1",data:{weightKg:weight}});
test("new maker, part and packing input win against delayed standalone import and stay saved", async () => {
  for (const [name,value] of [["make","HONDA"],["part","9091510002"],["packingGrams","80"],["boxId","custom"]]) {
    const dom = open(), w = dom.window; let release;
    startImport(w, () => new Promise(resolve => { release = resolve; }));
    input(w, `[data-lookup-field=${name}]`, value);
    const saved = w.localStorage.getItem("part-scout-shipping-draft-v1");
    release(legacyBackup("2")); await tick();
    assert.equal(w.document.querySelector(`[data-lookup-field=${name}]`).value, value, name);
    assert.equal(w.localStorage.getItem("part-scout-shipping-draft-v1"), saved);
    assert.match(w.document.querySelector("#calc-save").textContent, /入力.*変更.*中止/);
    dom.window.close();
  }
});
test("newer standalone import wins even when earlier file reading finishes last", async () => {
  const dom = open(), w = dom.window; let release;
  startImport(w, () => new Promise(resolve => { release = resolve; }));
  startImport(w, async () => legacyBackup("3")); await tick();
  const status = w.document.querySelector("#calc-save").textContent;
  release(legacyBackup("2")); await tick();
  assert.equal(w.document.querySelector("[name=weightKg]").value, "3");
  assert.equal(JSON.parse(w.localStorage.getItem("part-scout-shipping-draft-v1")).weightKg, "3");
  assert.equal(w.document.querySelector("#calc-save").textContent, status);
  dom.window.close();
});
function unavailable(w, reason = "source_timeout") {
  return {schemaVersion:1,make:"TOYOTA",partNumber:"90915-10001",status:"unavailable",checkedAt:new w.Date(w.Date.now()).toISOString(),candidates:[],attempts:[{source:"www.toyotapartsdeal.com",reason}]};
}
test("browser ordinary lookup expires failures at five minutes, retaining success for seven days", async () => {
  for (const status of ["unavailable","not_found","conflict","found","partial"]) {
    let calls = 0, time = Date.now();
    const dom = open(null, async url => {
      calls++;
      const result = ["found","partial"].includes(status) ? await (await boundary(url)).json() : unavailable(dom.window);
      result.status = status; result.checkedAt = new Date(time).toISOString();
      for (const c of result.candidates) c.checkedAt = result.checkedAt;
      return new Response(JSON.stringify(result));
    }), w = dom.window;
    w.Date.now = () => time;
    input(w,"[data-lookup-field=part]","9091510001"); action(w); await tick();
    const ttl = ["found","partial"].includes(status) ? 7*86400000 : 300000;
    time += ttl-1; action(w); await tick(); assert.equal(calls,1,status+" fresh");
    time++; action(w); await tick(); assert.equal(calls,2,status+" expired");
    dom.window.close();
  }
});
test("gate cooldown stays honest and never persists as a source failure or automatically retries", async () => {
  let calls=0;
  const dom = open(null, async () => {
    calls++;
    return new Response(JSON.stringify({...unavailable(dom.window,"acquisition_cooldown"),retryAfterSeconds:60}));
  }), w=dom.window;
  input(w,"[data-lookup-field=part]","9091510001"); action(w); await tick();
  assert.match(w.document.querySelector("[data-lookup-status]").textContent,/取得.*間隔|1分/);
  assert.equal(w.document.querySelector("[data-lookup-sources]").textContent,"");
  assert.equal(JSON.parse(w.localStorage.getItem("part-scout-shipping-draft-v1")).partLookup.results.length,0);
  assert.equal(w.document.querySelector("#shipping-price").textContent,"未確定");
  assert.match(w.document.querySelector("#part-lookup").textContent,/1分.*30.*保存.*実測/);
  assert.equal(calls,1);
  action(w); await tick(); assert.equal(calls,2);
  dom.window.close();
});
test("Retry-After is optional and validated before browser persistence", () => {
  const P=require("../web/part-parcel.js");
  const result={schemaVersion:1,make:"TOYOTA",partNumber:"90915-10001",status:"unavailable",checkedAt:new Date().toISOString(),candidates:[],attempts:[{source:"www.toyotapartsdeal.com",reason:"source_http_429"}]};
  assert.equal(P.validateResult({...result,retryAfterSeconds:120}).retryAfterSeconds,120);
  for(const retryAfterSeconds of [0,-1,Infinity,NaN,"60",null]) assert.throws(()=>P.validateResult({...result,retryAfterSeconds}));
});
test("saved measured parcel remains reusable while a provider pause is cached", async () => {
  let calls = 0;
  const dom = open(null, async () => {
    calls++;
    return new Response(JSON.stringify(unavailable(dom.window, "provider_paused")));
  }), w = dom.window;
  input(w, "[data-lookup-field=part]", "9091510001");
  input(w, "[name=declaredValueUsd]", "20");
  action(w); await tick();
  for (const [name,value] of [["weightKg","0.7"],["lengthCm","20"],["widthCm","15"],["heightCm","10"]]) input(w, `[name=${name}]`, value);
  w.document.querySelector("[data-lookup-measured]").click();
  action(w); await tick();
  assert.equal(w.document.querySelector("[name=weightKg]").value, "0.7");
  assert.match(w.document.querySelector("[data-lookup-status]").textContent, /実測値.*再利用/);
  assert.equal(calls, 1);
  dom.window.close();
});
test("focusing unchanged lookup input does not discard a pending source result", async () => {
  let release;
  const dom = open(null, url => new Promise(resolve => {
    release = () => boundary(url).then(resolve);
  })), w = dom.window;
  input(w, "[name=declaredValueUsd]", "20");
  const part = input(w, "[data-lookup-field=part]", "9091510001");
  action(w);
  part.focus();
  part.click();
  release(); await tick();
  assert.equal(w.document.querySelector("[name=weightKg]").value, "0.557873896");
  assert.doesNotMatch(w.document.querySelector("[data-lookup-status]").textContent, /取得中/);
  assert.equal(JSON.parse(w.localStorage.getItem("part-scout-shipping-draft-v1")).partLookup.results.length, 1);
  dom.window.close();
});

function startMainImport(w, read) {
  const file = w.document.querySelector("#restore-file");
  Object.defineProperty(file, "files", {configurable:true,value:[{size:100,text:read}]});
  file.dispatchEvent(new w.Event("change"));
  return file;
}
const mainBackup = weight => JSON.stringify({format:"part-scout-backup",version:1,data:{settings:{},costs:{"90915-10001":{parcelWeightKg:weight}},workspace:{}}});
test("newer main backup wins when older file finishes or fails after it", async () => {
  for (const fails of [false, true]) {
    const dom = openMain(), w = dom.window;
    await tick();
    let release;
    startMainImport(w, () => new Promise((resolve,reject) => {release = () => fails ? reject(Error("older read failed")) : resolve(mainBackup("1"));}));
    startMainImport(w, async () => mainBackup("2"));
    await tick();
    const stored = w.localStorage.getItem("part-scout-user-v1");
    assert.equal(JSON.parse(stored).costs["90915-10001"].parcelWeightKg, "2");
    const status = w.document.querySelector("#save-status").textContent;
    release(); await tick();
    assert.equal(w.localStorage.getItem("part-scout-user-v1"), stored);
    assert.equal(w.eval('state.costs["90915-10001"].parcelWeightKg'), "2");
    assert.equal(w.document.querySelector("#save-status").textContent, status);
    dom.window.close();
  }
});
test("stale main import failure cannot clear a newer pending file selection or status", async () => {
  const dom = openMain(), w = dom.window;
  await tick();
  let fail, finish;
  startMainImport(w, () => new Promise((resolve,reject) => {fail=reject;}));
  const file = startMainImport(w, () => new Promise(resolve => {finish=resolve;}));
  // File selection is the external boundary; browsers supply a nonempty value.
  Object.defineProperty(file,"value",{configurable:true,writable:true,value:"newer-backup.json"});
  const status = w.document.querySelector("#save-status").textContent;
  fail(Error("older read failed")); await tick();
  assert.equal(file.value,"newer-backup.json");
  assert.equal(w.document.querySelector("#save-status").textContent,status);
  finish(mainBackup("2")); await tick();
  assert.equal(file.value,"");
  assert.equal(JSON.parse(w.localStorage.getItem("part-scout-user-v1")).costs["90915-10001"].parcelWeightKg,"2");
  dom.window.close();
});
test("newer main cost input still prevents delayed backup restoration", async () => {
  const dom = openMain(), w = dom.window;
  await tick();
  w.eval(`state.products=[normalizeProduct({part_number:'90915-10001',brand:'TOYOTA',title:'Filter',price_median_usd:20})];document.body.append(createProductCard(state.products[0],1));`);
  let release;
  startMainImport(w, () => new Promise(resolve => {release=resolve;}));
  input(w,"[data-cost=parcelWeightKg]","0.9");
  const stored = w.localStorage.getItem("part-scout-user-v1");
  release(mainBackup("1")); await tick();
  assert.equal(w.localStorage.getItem("part-scout-user-v1"),stored);
  assert.equal(w.document.querySelector("[data-cost=parcelWeightKg]").value,"0.9");
  assert.match(w.document.querySelector("#save-status").textContent,/入力.*変更.*中止/);
  dom.window.close();
});
