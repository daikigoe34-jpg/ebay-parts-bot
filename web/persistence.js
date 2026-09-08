"use strict";

// Each user edit is one synchronous, atomic localStorage write. The previous
// valid revision is retained separately; saving never requires a network request.
function createStore(storage) {
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
      if (raw === previous) return { ok: true };
      if (previous != null) {
        try {
          JSON.parse(previous);
          storage.setItem(`${key}:previous`, previous);
        } catch (_) { /* A bad previous value must not replace the recovery copy. */ }
      }
      storage.setItem(key, raw);
      return { ok: true };
    } catch (_) {
      return { ok: false };
    }
  }
  return { read, write, get recovered() { return recovered; } };
}

if (typeof globalThis !== "undefined") globalThis.PartScoutPersistence = { createStore };
if (typeof module !== "undefined" && module.exports) module.exports = { createStore };
