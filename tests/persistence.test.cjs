"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function memoryStorage() {
  const rows = new Map();
  return { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, String(value)),
    removeItem: key => rows.delete(key), rows };
}

test("a second app instance restores the last save; corrupt primary restores previous revision", () => {
  const { createStore } = require("../web/persistence.js");
  const storage = memoryStorage();
  let store = createStore(storage);
  assert.equal(store.write("draft", { price: "12." }).ok, true);
  assert.equal(store.write("draft", { price: "12.34" }).ok, true);
  store = createStore(storage);
  assert.equal(store.read("draft", null).price, "12.34");
  storage.setItem("draft", "broken");
  assert.equal(store.read("draft", null).price, "12.");
});

test("quota or unavailable storage reports failure and preserves the previous save", () => {
  const { createStore } = require("../web/persistence.js");
  const storage = memoryStorage();
  const store = createStore(storage);
  store.write("draft", { price: 100 });
  storage.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.equal(store.write("draft", { price: 200 }).ok, false);
  assert.equal(store.read("draft", null).price, 100);
  assert.equal(createStore(null).write("draft", {}).ok, false);
});

test("settings are durable before the render debounce fires, and backup import validates before changing state", () => {
  const storage = memoryStorage();
  const context = vm.createContext({ module: { exports: {} }, require, localStorage: storage,
    structuredClone, console, URL, Date, setTimeout: () => 1, clearTimeout: () => {},
    PartScoutPersistence: require("../web/persistence.js"),
    PartScoutShipping: require("../web/shipping.js") });
  vm.runInContext(fs.readFileSync(require.resolve("../web/app.js"), "utf8"), context);
  vm.runInContext(`
    els.settingsForm = { elements: { namedItem(key) {
      return key === "minimumProfitJpy" ? { type: "number", value: "6789" } : null;
    } } };
    scheduleSettingsSave();
  `, context);
  const stored = JSON.parse(storage.getItem("part-scout-user-v1"));
  assert.equal(Number(stored.settings.minimumProfitJpy), 6789);
  const api = context.module.exports;
  const backup = api.makeBackup();
  api.state.settings.minimumProfitJpy = 1;
  api.restoreBackup(backup);
  assert.equal(Number(api.state.settings.minimumProfitJpy), 6789);
  const before = storage.getItem("part-scout-user-v1");
  assert.throws(() => api.restoreBackup('{"format":"wrong"}'));
  assert.equal(storage.getItem("part-scout-user-v1"), before);
  assert.throws(() => api.restoreBackup(JSON.stringify({format: "part-scout-backup", version: 1,
    data: { settings: {}, costs: { "__proto__": [] }, workspace: [] } })));
});

test("guarded stores archive the actual durable edit and stale proposal without overwriting", () => {
  const { createStore } = require("../web/persistence.js");
  const storage = memoryStorage(); storage.setItem("draft", JSON.stringify({weight:"1"}));
  const a=createStore(storage,{guardedKeys:["draft"]}), b=createStore(storage,{guardedKeys:["draft"]});
  a.read("draft",null);b.read("draft",null);
  assert.equal(a.write("draft",{weight:"UNSENT_A"}).ok,true);
  assert.deepEqual(b.write("draft",{weight:"STALE_B"}),{ok:false,conflict:true});
  assert.equal(JSON.parse(storage.getItem("draft")).weight,"UNSENT_A");
  const reopened=createStore(storage,{guardedKeys:["draft"]});reopened.read("draft",null);reopened.write("draft",{weight:"NEW_A"});
  const archive=reopened.conflicts("draft");
  assert.equal(archive[0].remote.weight,"UNSENT_A");assert.equal(archive[0].local.weight,"STALE_B");
});

test("guarded stale write fails safely when permanent recovery cannot be saved", () => {
  const {createStore}=require("../web/persistence.js");const storage=memoryStorage();
  storage.setItem("draft",JSON.stringify({weight:"1"}));const store=createStore(storage,{guardedKeys:["draft"]});store.read("draft",null);
  storage.setItem("draft",JSON.stringify({weight:"OTHER_TAB"}));storage.setItem=()=>{throw Error("quota");};
  assert.equal(store.write("draft",{weight:"STALE"}).ok,false);
  assert.equal(JSON.parse(storage.getItem("draft")).weight,"OTHER_TAB");
});
