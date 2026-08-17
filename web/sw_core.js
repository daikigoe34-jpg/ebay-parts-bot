"use strict";

const DYNAMIC_DATA_PATHS = ["/data/results.json", "/data/setup_status.json"];

function stableCacheUrl(rawUrl) {
  const url = new URL(String(rawUrl));
  url.search = "";
  url.hash = "";
  return url.href;
}

function isDynamicDataUrl(rawUrl) {
  try {
    const pathname = new URL(String(rawUrl)).pathname;
    return DYNAMIC_DATA_PATHS.some((path) => pathname.endsWith(path));
  } catch (_) {
    return false;
  }
}

if (typeof self !== "undefined") {
  self.PartScoutSWCore = { stableCacheUrl, isDynamicDataUrl };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { stableCacheUrl, isDynamicDataUrl };
}
