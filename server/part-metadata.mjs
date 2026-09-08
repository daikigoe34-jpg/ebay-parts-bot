// Public retailer specifications only. No credentials, browser impersonation or denial retries.
const PROVIDERS = {
  TOYOTA: ["www.toyotapartsdeal.com", "/oem/toyota~"],
  NISSAN: ["www.nissanpartsdeal.com", "/parts/nissan~"],
  HONDA: ["www.hondapartsnow.com", "/genuine/honda~"],
  SUBARU: ["www.subarupartsdeal.com", "/parts/subaru~"],
};
const UA = "PartScout/0.5 (+https://github.com/daikigoe34-jpg/ebay-parts-bot)";
const scopes = new WeakMap();
export function normalizePart(make, value) {
  if (
    !Object.hasOwn(PROVIDERS, make) ||
    typeof value !== "string" ||
    value.length > 40 ||
    !/^[a-zA-Z0-9 _-]+$/.test(value)
  )
    return null;
  const compact = value.toUpperCase().replace(/[ _-]/g, "");
  if (!/^[A-Z0-9]{5,25}$/.test(compact)) return null;
  if (["TOYOTA", "NISSAN"].includes(make) && compact.length === 10)
    return compact.slice(0, 5) + "-" + compact.slice(5);
  if (make === "HONDA" && compact.length === 11)
    return (
      compact.slice(0, 5) + "-" + compact.slice(5, 8) + "-" + compact.slice(8)
    );
  return compact;
}
function permitted(url, make, partNumber) {
  const [host, prefix] = PROVIDERS[make];
  return (
    url.protocol === "https:" &&
    url.hostname === host &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    new RegExp(
      "^" +
        prefix.replace("~", "") +
        "(?:-[a-z0-9_-]+)?(?:~[a-z0-9_-]+)+\\.html$",
      "i",
    ).test(url.pathname) &&
    normalizePart(
      make,
      url.pathname
        .split("~")
        .pop()
        .replace(/\.html$/i, ""),
    ) === partNumber
  );
}
function plain(text) {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, v) =>
      String.fromCodePoint(
        Math.min(
          0x10ffff,
          v[0].toLowerCase() === "x" ? parseInt(v.slice(1), 16) : Number(v),
        ),
      ),
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&times;/gi, "×")
    .replace(/\s+/g, " ")
    .trim();
}
function weight(text) {
  const m =
    /^(\d+(?:\.\d+)?|\.\d+)\s*(kg|kilograms?|g|grams?|lb|lbs|pounds?|oz|ounces?)$/i.exec(
      text,
    );
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const factor = /^(kg|kilogram)/.test(unit)
    ? 1
    : /^(g|gram)/.test(unit)
      ? 0.001
      : /^(oz|ounce)/.test(unit)
        ? 0.028349523125
        : 0.45359237;
  const n = Number((Number(m[1]) * factor).toPrecision(14));
  return n > 0 && Number.isFinite(n) ? n : null;
}
function dimensions(text) {
  const m =
    /^(\d+(?:\.\d+)?|\.\d+)\s*[x×]\s*(\d+(?:\.\d+)?|\.\d+)\s*[x×]\s*(\d+(?:\.\d+)?|\.\d+)\s*(cm|centimeters?|mm|millimeters?|in|inches?|inch)$/i.exec(
      text,
    );
  if (!m) return null;
  const factor = /^(mm|millimeter)/i.test(m[4])
    ? 0.1
    : /^(cm|centimeter)/i.test(m[4])
      ? 1
      : 2.54;
  const values = m
    .slice(1, 4)
    .map((v) => Number((Number(v) * factor).toPrecision(14)));
  return values.every((v) => v > 0 && Number.isFinite(v)) ? values : null;
}
export function parseProduct(html, make, partNumber) {
  const wanted = normalizePart(make, partNumber);
  const matches = [];
  let conflict = false;
  const clean = html
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  for (const table of clean.matchAll(
    /<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi,
  )) {
    const fields = new Map();
    for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = [
        ...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi),
      ].map((m) => plain(m[1]));
      if (cells.length !== 2) continue;
      const key = cells[0].toLowerCase();
      if (!fields.has(key)) fields.set(key, []);
      fields.get(key).push(cells[1]);
    }
    const identities = [
      ...(fields.get("manufacturer part number") || []),
      ...(fields.get("sku") || []),
    ];
    if (!identities.some((p) => normalizePart(make, p) === wanted)) continue;
    if (
      !fields.has("manufacturer part number") ||
      identities.some((p) => normalizePart(make, p) !== wanted)
    ) {
      conflict = true;
      continue;
    }
    const weights = fields.get("item weight") || [];
    const dims = fields.get("item dimensions") || [];
    if (
      new Set(weights.map((v) => JSON.stringify(weight(v)) ?? v)).size > 1 ||
      new Set(dims.map((v) => JSON.stringify(dimensions(v)) ?? v)).size > 1
    ) {
      conflict = true;
      continue;
    }
    matches.push({
      weightKg: weight(weights[0] || ""),
      dimensionsCm: dimensions(dims[0] || ""),
      original: { weight: weights[0] || null, dimensions: dims[0] || null },
    });
  }
  for (const field of ["weightKg", "dimensionsCm"])
    if (
      new Set(
        matches
          .filter((m) => m[field] != null)
          .map((m) => JSON.stringify(m[field])),
      ).size > 1
    )
      conflict = true;
  if (conflict)
    return {
      status: "conflict",
      weightKg: null,
      dimensionsCm: null,
      original: { weight: null, dimensions: null },
    };
  if (!matches.length)
    return {
      status: "not_found",
      weightKg: null,
      dimensionsCm: null,
      original: { weight: null, dimensions: null },
    };
  const result =
    matches.find((m) => m.weightKg != null && m.dimensionsCm != null) ||
    matches[0];
  return {
    ...result,
    status:
      result.weightKg != null && result.dimensionsCm != null
        ? "found"
        : "partial",
  };
}
export function robotsAllowed(text, path) {
  const groups = [];
  let current = null;
  let hasRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim().toLowerCase(),
      value = match[2].trim();
    if (key === "user-agent") {
      if (!current || hasRules) {
        current = { agents: [], rules: [] };
        groups.push(current);
        hasRules = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (current && ["allow", "disallow"].includes(key)) {
      hasRules = true;
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    }
  }
  const specificity = (g) =>
    Math.max(
      -1,
      ...g.agents.map((a) =>
        a === "*" ? 0 : "partscout".includes(a) ? a.length : -1,
      ),
    );
  const best = Math.max(-1, ...groups.map(specificity));
  if (best < 0) return true;
  let winner = null;
  for (const g of groups.filter((g) => specificity(g) === best))
    for (const rule of g.rules) {
      const end = rule.pattern.endsWith("$");
      const p = end ? rule.pattern.slice(0, -1) : rule.pattern;
      const regex = new RegExp(
        "^" +
          p
            .split("*")
            .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*") +
          (end ? "$" : ""),
      );
      const length = p.replace(/\*/g, "").length;
      if (
        regex.test(path) &&
        (!winner ||
          length > winner.length ||
          (length === winner.length && rule.allow))
      )
        winner = { ...rule, length };
    }
  return winner ? winner.allow : true;
}
function put(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}
async function boundedFetch(fetchImpl, url, limit, deadline, timeoutMs) {
  const controller = new AbortController();
  let timer;
  let reader;
  const remaining = Math.min(timeoutMs, deadline - Date.now());
  if (remaining <= 0) throw Error("lookup_timeout");
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      if (reader) reader.cancel().catch(() => {});
      reject(Error("source_timeout"));
    }, remaining);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const response = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": UA, Accept: "text/html,text/plain;q=0.9" },
          credentials: "omit",
          signal: controller.signal,
        });
        if (response.status === 403 || response.status === 429) {
          const denial = { status: response.status, headers: response.headers, text: "" };
          // The headers are sufficient for a provider pause. Do not wait for,
          // or let cleanup failures replace, an already observed denial.
          try { response.body?.cancel().catch(() => {}); } catch (_) {}
          return denial;
        }
        if (Number(response.headers.get("content-length")) > limit)
          throw Error("body_limit");
        let text = "";
        let count = 0;
        const decoder = new TextDecoder();
        if (response.body) {
          reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            count += value.byteLength;
            if (count > limit) {
              await reader.cancel();
              throw Error("body_limit");
            }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        }
        return { status: response.status, headers: response.headers, text };
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
function httpFailure(reason, response, now) {
  const error = Error(reason);
  const value = (response.headers.get("retry-after") || "").trim();
  // Accept HTTP delta-seconds or an HTTP date, not Date.parse's loose numeric forms.
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day|sday|nesday|rsday|urday)?(?:,| )/.test(value)
      ? Math.ceil((Date.parse(value) - now()) / 1000)
      : NaN;
  if (Number.isFinite(seconds) && seconds > 0) error.retryAfterSeconds = seconds;
  return error;
}
async function lookup(make, partNumber, options, scope) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const checkedAt = new Date(now()).toISOString();
  const [source, prefix] = PROVIDERS[make];
  const result = {
    schemaVersion: 1,
    make,
    partNumber,
    status: "unavailable",
    checkedAt,
    candidates: [],
    attempts: [],
  };
  const deadline =
    Date.now() + Math.min(45000, Math.max(1, options.totalTimeoutMs || 45000));
  const timeoutMs = Math.min(
    20000,
    Math.max(1, options.fetchTimeoutMs || 20000),
  );
  try {
    let robots = scope.robots.get(source);
    if (!robots || robots.expires <= now()) {
      if (!scope.robotsPending.has(source)) {
        const pending = (async () => {
          const response = await boundedFetch(
            fetchImpl,
            `https://${source}/robots.txt`,
            65536,
            deadline,
            timeoutMs,
          );
          let value;
          if (response.status === 404 || response.status === 410)
            value = { text: "", expires: now() + 21600000 };
          else if (response.status >= 200 && response.status < 300)
            value = { text: response.text, expires: now() + 21600000 };
          else throw httpFailure("robots_http_" + response.status, response, now);
          put(scope.robots, source, value, 4);
          return value;
        })().finally(() => scope.robotsPending.delete(source));
        scope.robotsPending.set(source, pending);
      }
      robots = await scope.robotsPending.get(source);
    }
    let url = new URL(
      `https://${source}${prefix}${partNumber.toLowerCase()}.html`,
    );
    for (let redirects = 0; ; redirects++) {
      if (!permitted(url, make, partNumber))
        throw Error("disallowed_redirect_route");
      if (!robotsAllowed(robots.text, url.pathname))
        throw Error("robots_denied");
      const response = await boundedFetch(
        fetchImpl,
        url.href,
        1048576,
        deadline,
        timeoutMs,
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= 3 || !response.headers.get("location"))
          throw Error("redirect_limit");
        url = new URL(response.headers.get("location"), url);
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        result.status = "not_found";
        result.attempts.push({ source, reason: "http_" + response.status });
        return result;
      }
      if (response.status < 200 || response.status >= 300)
        throw httpFailure("source_http_" + response.status, response, now);
      const parsed = parseProduct(response.text, make, partNumber);
      result.status = parsed.status;
      if (["found", "partial"].includes(parsed.status))
        result.candidates.push({
          source,
          url: url.href,
          partNumber,
          weightKg: parsed.weightKg,
          dimensionsCm: parsed.dimensionsCm,
          original: parsed.original,
          basis: "retailer_item_unspecified",
          checkedAt,
        });
      result.attempts.push({ source, reason: parsed.status });
      return result;
    }
  } catch (error) {
    if (Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0)
      result.retryAfterSeconds = error.retryAfterSeconds;
    result.attempts.push({
      source,
      reason: String(error.message || "source_failure").slice(0, 100),
    });
    return result;
  }
}
export async function handlePartMetadata(request, options = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), { status, headers });
  if (request.method !== "GET")
    return json(
      {
        schemaVersion: 1,
        status: "unsupported",
        error: "GET を使用してください。",
      },
      405,
    );
  const url = new URL(request.url);
  const make = (url.searchParams.get("make") || "").toUpperCase();
  const partNumber = normalizePart(make, url.searchParams.get("part"));
  if (
    !partNumber ||
    [...url.searchParams.keys()].some(
      (k) => !["make", "part", "refresh"].includes(k),
    ) ||
    url.searchParams.getAll("part").length !== 1 ||
    url.searchParams.getAll("make").length !== 1
  )
    return json(
      {
        schemaVersion: 1,
        status: "unsupported",
        error: "対応メーカーと英数字の品番を入力してください。",
      },
      400,
    );
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let scope = scopes.get(fetchImpl);
  if (!scope) {
    scope = { cache: new Map(), robots: new Map(), robotsPending: new Map(), pending: new Map() };
    scopes.set(fetchImpl, scope);
  }
  const key = make + ":" + partNumber;
  const now = (options.now || Date.now)();
  const saved = scope.cache.get(key);
  if (
    saved &&
    saved.expires > now &&
    (url.searchParams.get("refresh") !== "1" ||
      !["found", "partial"].includes(saved.value.status) ||
      now - Date.parse(saved.value.checkedAt) < 86400000)
  )
    return json(saved.value);
  if (!scope.pending.has(key)) {
    const pending = lookup(make, partNumber, options, scope)
      .then((value) => {
        put(
          scope.cache,
          key,
          {
            value,
            expires:
              (options.now || Date.now)() +
              (["found", "partial"].includes(value.status)
                ? 604800000
                : 300000),
          },
          200,
        );
        return value;
      })
      .finally(() => scope.pending.delete(key));
    scope.pending.set(key, pending);
  }
  return json(await scope.pending.get(key));
}
