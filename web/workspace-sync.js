"use strict";
(function(root) {
  const copy = value => JSON.parse(JSON.stringify(value));
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
  }
  const equal = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  function safe(value, depth = 0) {
    if (depth > 24) throw Error("Data too deep");
    if (typeof value === "string" && value.length > 200000) throw Error("String too long");
    if (typeof value === "number" && !Number.isFinite(value)) throw Error("Invalid number");
    if (value && typeof value === "object") for (const [k,v] of Object.entries(value)) {
      if (["__proto__","prototype","constructor"].includes(k)) throw Error("Invalid key");
      safe(v, depth + 1);
    }
    return value;
  }
  function createSync(options) {
    if (!["main","shipping","queue"].includes(options.namespace)) throw Error("Invalid namespace");
    const key = `part-scout-sync-v1:${options.namespace}`;
    const storage = options.storage;
    const Persistence = root.PartScoutPersistence || require("./persistence.js");
    const journal = Persistence.createStore(storage,{guardedKeys:[key]});
    const transport = options.fetch || ((...args) => root.fetch(...args));
    let meta = {version:1,userKey:null,baseRevision:0,baseData:null,pending:null,conflict:null,attempt:null};
    let status = "checking", timer, busy, disposed = false, blocked = false;
    function emit(next) { status = next; options.onStatus?.(next, meta.updatedAt); }
    function persist() {
      try {
        const result = journal.write(key,meta);
        if (!result.ok) { blocked=true; emit(result.conflict ? "tab-conflict" : "storage-error"); return false; }
        blocked=false; return true;
      }
      catch (_) { blocked = true; emit("storage-error"); return false; }
    }
    function validate(value) {
      safe(value);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid document");
      const result = options.validate(copy(value));
      if (result === false) throw Error("Invalid document");
      return copy(result && typeof result === "object" ? result : value);
    }
    try {
      const raw = storage?.getItem(key);
      if (raw) {
        const saved = safe(JSON.parse(raw));
        if (saved.version !== 1 || !Number.isSafeInteger(saved.baseRevision) || saved.baseRevision < 0) throw Error("Invalid metadata");
        for (const field of ["pending","baseData"]) if (saved[field] != null) validate(saved[field]);
        meta = saved;
      }
      if (options.hasLocal?.()) {
        const local = validate(options.getLocal());
        if (!equal(local, meta.baseData)) meta.pending = local;
      }
      if (meta.pending || meta.conflict) persist();
      if (!blocked) emit(meta.conflict ? "conflict" : meta.pending ? "waiting" : "checking");
    } catch (_) { blocked = true; emit("storage-error"); }
    function schedule() {
      clearTimeout(timer);
      if (!disposed) { timer = setTimeout(() => flush(), options.debounceMs ?? 1000); timer?.unref?.(); }
    }
    function changed() {
      try { meta.pending = validate(options.getLocal()); }
      catch (_) { emit("storage-error"); return false; }
      if (!persist()) return false;
      emit(meta.conflict ? "conflict" : "waiting");
      schedule(); return true;
    }
    function envelope(value) {
      safe(value);
      if (value?.schemaVersion !== 1 || typeof value.userKey !== "string" || !value.userKey || value.userKey.length > 512
        || !Number.isSafeInteger(value.revision) || value.revision < 0
        || (value.updatedAt !== null && (typeof value.updatedAt !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt))))
        || (value.data === null && value.revision !== 0)
        || (value.data !== null && (value.revision === 0 || value.updatedAt === null))) throw Error("Invalid response");
      if (value.data !== null) value.data = validate(value.data);
      return value;
    }
    async function request(method, body) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await transport(`/api/workspace/${options.namespace}`, {method,credentials:"same-origin",cache:"no-store",signal:controller.signal,
          ...(body ? {headers:{"Content-Type":"application/json","X-Part-Scout-User-Key":meta.userKey},body:JSON.stringify(body)} : {})});
        if (response.status === 403) {
          const error = await response.json();
          emit(error?.error === "account_changed" ? "account-changed" : "unavailable");
          return null;
        }
        if (response.status === 401) { emit("auth-required"); return null; }
        if (![200,409].includes(response.status)) { emit(response.status === 413 ? "storage-error" : "unavailable"); return null; }
        return {doc:envelope(await response.json()), conflict:response.status === 409};
      } finally { clearTimeout(timeout); }
    }
    function checkAccount(doc) {
      if (meta.userKey && meta.userKey !== doc.userKey) { emit("account-changed"); return false; }
      meta.userKey = doc.userKey;
      return persist();
    }
    function setBase(doc) { meta.baseRevision = doc.revision; meta.baseData = copy(doc.data); meta.updatedAt = doc.updatedAt; }
    function recovery(remote, permanent = false) {
      const value = {schemaVersion:1,namespace:options.namespace,userKey:meta.userKey,local:copy(options.getLocal()),remote:copy(remote),savedAt:new Date().toISOString()};
      try {
        if (permanent) {
          const history = JSON.parse(storage.getItem(`${key}:conflict-recovery`) || "[]");
          if (!Array.isArray(history) || history.length >= 20) throw Error("Recovery archive full");
          history.push(value); storage.setItem(`${key}:conflict-recovery`,JSON.stringify(history));
        } else storage.setItem(`${key}:recovery`,JSON.stringify(value));
        return true;
      }
      catch (_) { emit("storage-error"); return false; }
    }
    function receive(doc) {
      if (options.canApply && !options.canApply()) { emit("waiting"); return false; }
      if (!recovery(doc.data)) return false;
      if (options.applyRemote(copy(doc.data)) === false) { emit("storage-error"); return false; }
      setBase(doc); meta.pending = null; meta.attempt = null;
      return persist();
    }
    function conflict(doc) { meta.conflict = copy(doc); persist(); if (!blocked) emit("conflict"); }
    async function run() {
      if (blocked || disposed) return;
      emit("checking");
      try {
        const response = await request("GET");
        if (!response || disposed || !checkAccount(response.doc)) return;
        const doc = response.doc;
        // A committed PUT can lose its response. Recognize its exact value on GET.
        if (meta.attempt && equal(doc.data,meta.attempt.data)) { setBase(doc); meta.attempt = null; if (equal(meta.pending,doc.data)) meta.pending = null; if (!persist()) return; }
        if (meta.conflict) { conflict(doc); return; }
        if (meta.pending && equal(meta.pending,doc.data)) { setBase(doc); meta.pending = null; if (persist()) emit("synced"); return; }
        if (!meta.pending) {
          if (doc.data !== null && !equal(doc.data,meta.baseData)) { if (!receive(doc)) return; }
          else { setBase(doc); if (!persist()) return; }
          emit("synced"); return;
        }
        if (doc.revision !== meta.baseRevision || !equal(doc.data,meta.baseData)) { conflict(doc); return; }
        const sent = copy(meta.pending);
        const body = {baseRevision:doc.revision,data:sent};
        const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(JSON.stringify(body)).length : new Blob([JSON.stringify(body)]).size;
        if (bytes > 2000000) { emit("storage-error"); return; }
        meta.attempt = body; if (!persist()) return;
        const written = await request("PUT",body);
        if (!written || disposed || !checkAccount(written.doc)) return;
        if (written.conflict) { if (!equal(written.doc.data,sent)) { conflict(written.doc); return; } }
        else if (!equal(written.doc.data,sent) || written.doc.revision !== doc.revision + 1) throw Error("Invalid acknowledgement");
        setBase(written.doc); meta.attempt = null;
        if (equal(meta.pending,sent)) meta.pending = null;
        if (persist()) emit(meta.pending ? "waiting" : "synced");
      } catch (_) { emit("unavailable"); }
    }
    function flush() {
      clearTimeout(timer);
      if (busy) return busy;
      busy = run().finally(() => { busy = null; if (status === "waiting" && meta.pending && !meta.conflict) schedule(); }); return busy;
    }
    async function resolve(choice) {
      if (!meta.conflict || !["local","remote"].includes(choice) || busy) return false;
      const remote = meta.conflict;
      if (!recovery(remote.data,true)) return false;
      if (choice === "remote") {
        if (remote.data === null || (options.canApply && !options.canApply())) return false;
        try { if (options.applyRemote(validate(remote.data)) === false) return false; } catch (_) { emit("storage-error"); return false; }
        meta.pending = null;
      } else meta.pending = validate(options.getLocal());
      setBase(remote); meta.conflict = null; meta.attempt = null;
      if (!persist()) return false;
      emit(meta.pending ? "waiting" : "synced"); schedule(); return true;
    }
    const refresh = () => { if (!root.document?.hidden) schedule(); };
    function start() { root.addEventListener?.("online",refresh);root.addEventListener?.("focus",refresh);root.document?.addEventListener("visibilitychange",refresh);root.document?.addEventListener("focusout",refresh);return flush(); }
    function dispose() { disposed = true; clearTimeout(timer);root.removeEventListener?.("online",refresh);root.removeEventListener?.("focus",refresh);root.document?.removeEventListener("visibilitychange",refresh);root.document?.removeEventListener("focusout",refresh); }
    return {changed,flush,resolve,start,dispose,get status(){return status;},backup(){let saved=null,history=[];try{saved=JSON.parse(storage.getItem(`${key}:recovery`));history=JSON.parse(storage.getItem(`${key}:conflict-recovery`)||"[]");}catch(_){}return {schemaVersion:1,namespace:options.namespace,local:copy(options.getLocal()),remote:copy(meta.conflict?.data ?? meta.baseData),recovery:saved,conflictRecovery:history.at(-1)||null,conflictHistory:history,...options.backupExtras?.(),tabConflicts:[...(options.backupExtras?.().tabConflicts||[]),...journal.conflicts(key).map(record=>({...record,local:record.local?.pending||record.local?.baseData,remote:record.remote?.pending||record.remote?.baseData}))]};}};
  }
  const labels = {"tab-conflict":"別のタブで編集が保存されました。両方をバックアップして再読み込みしてください。",checking:"同期を確認中…",waiting:"端末に保存済み・同期待ち",synced:"同期済み",conflict:"別の端末の編集と競合しています。両方をバックアップして選んでください。","auth-required":"同期にはログインが必要です。端末の保存は残ります。",unavailable:"同期を利用できません（オフライン・静的ホスト等）。端末で続けられます。","account-changed":"ログインが変わりました。前のアカウントの編集を保護して同期を停止しました。元のアカウントで再開してください。","storage-error":"保存領域またはデータ容量を確認してください。バックアップを保存してください。"};
  function versionBackup(namespace, data) {
    if (namespace === "main") return {format:"part-scout-backup",version:1,data};
    return {format:namespace === "shipping" ? "part-scout-shipping-draft-v1" : "part-scout-research-queue-v1",data};
  }
  function mountStatus(container, options) {
    if (!container) return createSync(options);
    container.innerHTML = '<p role="status" data-sync-label></p><div class="workspace-actions"><button type="button" data-sync-now>今すぐ同期</button><button type="button" data-sync-backup>両方をバックアップ</button><button type="button" data-sync-local hidden>この端末の編集を使う</button><button type="button" data-sync-remote hidden>クラウドの編集を使う</button></div>';
    const versions = document.createElement("details");
    versions.innerHTML = '<summary>保存版を選んで書き出す・復元する</summary><p>書き出したJSONは、この画面の「復元」で読み込めます。競合時に残した版も選べます。</p><label>保存版<select data-sync-version></select></label><button type="button" data-sync-export-version>選んだ版を書き出す</button>';
    container.append(versions);
    const sync = createSync({...options,onStatus:(status,time)=>{
      container.querySelector('[data-sync-label]').textContent = labels[status] + (status === "synced" && time ? ` ${new Date(time).toLocaleString("ja-JP")}` : "");
      for (const button of container.querySelectorAll('[data-sync-local],[data-sync-remote]')) button.hidden = status !== "conflict";
      options.onStatus?.(status,time);
    }});
    let choices = [];
    function listVersions() {
      const backup=sync.backup();
      choices=[{label:"現在の端末",data:backup.local},{label:"現在のクラウド",data:backup.remote}];
      for (const [i,record] of (backup.conflictHistory||[]).entries()) for(const side of ["local","remote"]) choices.push({label:`競合保存 ${i+1} ${side === "local" ? "端末" : "クラウド"} ${record.savedAt}`,data:record[side]});
      for (const [i,record] of (backup.tabConflicts||[]).entries()) for(const side of ["local","remote"]) choices.push({label:`別タブの保存 ${i+1} ${side === "local" ? "このタブ" : "別タブ"}`,data:record[side]});
      const select=container.querySelector('[data-sync-version]');select.replaceChildren();
      choices=choices.filter(x=>x.data!=null);
      for (const [i,choice] of choices.entries()) {const option=document.createElement('option');option.value=String(i);option.textContent=choice.label;select.append(option);}
    }
    versions.addEventListener('toggle',()=>{if(versions.open)listVersions();});
    container.querySelector('[data-sync-export-version]').onclick=()=>{
      const choice=choices[Number(container.querySelector('[data-sync-version]').value)];if(!choice)return;
      const url=URL.createObjectURL(new Blob([JSON.stringify(versionBackup(options.namespace,choice.data),null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download=`part-scout-${options.namespace}-selected-backup.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    container.querySelector('[data-sync-now]').onclick = () => sync.flush();
    container.querySelector('[data-sync-local]').onclick = () => sync.resolve("local");
    container.querySelector('[data-sync-remote]').onclick = () => sync.resolve("remote");
    container.querySelector('[data-sync-backup]').onclick = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(sync.backup(),null,2)],{type:"application/json"}));
      const link = document.createElement('a');link.href=url;link.download=`part-scout-${options.namespace}-recovery.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    return sync;
  }
  root.PartScoutSync = {createSync,mountStatus,versionBackup,safe,equal};
  if (typeof module !== "undefined" && module.exports) module.exports = root.PartScoutSync;
})(typeof globalThis !== "undefined" ? globalThis : this);
