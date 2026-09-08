"use strict";

// Each user edit is one synchronous, atomic localStorage write. The previous
// valid revision is retained separately; saving never requires a network request.
function createStore(storage, options = {}) {
  const observed = new Map();
  for (const key of options.guardedKeys || []) {
    try { observed.set(key, storage?.getItem(key) ?? null); }
    catch (_) { observed.set(key, undefined); }
  }
  function conflicts(key) {
    const history = JSON.parse(storage?.getItem(`${key}:conflicts`) || "[]");
    if (!Array.isArray(history)) throw Error("Invalid recovery archive");
    return history;
  }
  function archiveConflict(key, local, remote) {
    const history = conflicts(key);
    if (history.length >= 20) throw Error("Recovery archive full");
    const parse = raw => { try { return JSON.parse(raw); } catch (_) { return {unreadable:raw}; } };
    history.push({local,remote:parse(remote),savedAt:new Date().toISOString()});
    storage.setItem(`${key}:conflicts`,JSON.stringify(history));
  }
  let recovered = false;
  function read(key, fallback) {
    for (const candidate of [key, `${key}:previous`]) {
      try {
        const raw = storage?.getItem(candidate);
        if (raw != null) {
          const value = JSON.parse(raw);
          if (candidate !== key) recovered = true;
          return value;
        }
      } catch (_) { /* Try the previous valid revision. */ }
    }
    return fallback;
  }
  function write(key, value) {
    try {
      if (!storage) throw new Error("Storage unavailable");
      const raw = JSON.stringify(value);
      const previous = storage.getItem(key);
      if (observed.has(key) && observed.get(key) !== previous && raw !== previous) {
        archiveConflict(key, value, previous);
        return {ok:false,conflict:true};
      }
      if (raw === previous) { if (observed.has(key)) observed.set(key,raw); return { ok: true }; }
      if (previous != null) {
        try {
          JSON.parse(previous);
          storage.setItem(`${key}:previous`, previous);
        } catch (_) { /* A bad previous value must not replace the recovery copy. */ }
      }
      storage.setItem(key, raw);
      if (observed.has(key)) observed.set(key,raw);
      return { ok: true };
    } catch (_) {
      return { ok: false };
    }
  }
  return { read, write, conflicts, retain(key,local,remote) {
    try { archiveConflict(key,local,JSON.stringify(remote)); return {ok:true}; }
    catch (_) { return {ok:false}; }
  }, get recovered() { return recovered; } };
}

if (typeof globalThis !== "undefined") globalThis.PartScoutPersistence = { createStore };
if (typeof module !== "undefined" && module.exports) module.exports = { createStore };
