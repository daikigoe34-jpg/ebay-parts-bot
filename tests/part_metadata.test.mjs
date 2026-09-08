import test from "node:test";
import assert from "node:assert/strict";
import {
  handlePartMetadata,
  parseProduct,
  robotsAllowed,
  normalizePart,
} from "../server/part-metadata.mjs";
const html = (
  part = "90915-10001",
  dims = "3.1 x 3.0 x 3.4 inches",
  weight = "0.80 Pounds",
) =>
  `<table><tr><td>Item Weight</td><td>${weight}</td></tr><tr><td>Manufacturer Part Number</td><td>${part}</td></tr><tr><td>Item Dimensions</td><td>${dims}</td></tr><tr><td>SKU</td><td>${part}</td></tr></table>`;
const request = (query = "make=TOYOTA&part=9091510001") =>
  new Request("https://local.test/api/part-metadata?" + query);
test("parser binds measurements to exact table identity, preserving units", () => {
  const r = parseProduct(html(), "TOYOTA", "90915-10001");
  assert.equal(r.status, "found");
  assert.equal(r.weightKg, 0.362873896);
  assert.deepEqual(r.dimensionsCm, [7.874, 7.62, 8.636]);
  assert.equal(r.original.weight, "0.80 Pounds");
  assert.equal(
    parseProduct(html("OTHER"), "TOYOTA", "90915-10001").status,
    "not_found",
  );
  assert.equal(
    parseProduct(
      html().replace(
        "<td>90915-10001</td></tr></table>",
        "<td>90915-10002</td></tr></table>",
      ),
      "TOYOTA",
      "90915-10001",
    ).status,
    "conflict",
  );
  assert.equal(
    parseProduct(
      html("90915-10001", "unknown", "3-5 kg"),
      "TOYOTA",
      "90915-10001",
    ).weightKg,
    null,
  );
  assert.equal(
    parseProduct(html("90915-10001", "unknown"), "TOYOTA", "90915-10001")
      .status,
    "partial",
  );
  assert.equal(
    parseProduct(
      html() + html("90915-10001", "1 x 2 x 3 cm"),
      "TOYOTA",
      "90915-10001",
    ).status,
    "conflict",
  );
  assert.equal(
    parseProduct("<script>" + html() + "</script>", "TOYOTA", "90915-10001")
      .status,
    "not_found",
  );
});
test("normalization preserves identity without supersession inference", () => {
  assert.equal(normalizePart("HONDA", "15400plma02"), "15400-PLM-A02");
  assert.equal(normalizePart("SUBARU", "15208AA100"), "15208AA100");
  assert.equal(normalizePart("NISSAN", "152089e01a"), "15208-9E01A");
  assert.equal(normalizePart("TOYOTA", "https://x"), null);
});
test("robots selects applicable agent and longest wildcard rule", () => {
  assert.equal(
    robotsAllowed(
      "User-agent: *\nDisallow: /\nUser-agent: PartScout\nDisallow: /oem/*\nAllow: /oem/toyota~*.html$",
      "/oem/toyota~123.html",
    ),
    true,
  );
  assert.equal(
    robotsAllowed("User-agent: *\nDisallow: /oem/*", "/oem/toyota~123.html"),
    false,
  );
});
test("HTTP validates before network and rejects unsupported requests", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw Error();
  };
  assert.equal(
    (await handlePartMetadata(request("make=BMW&part=123"), { fetchImpl }))
      .status,
    400,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await handlePartMetadata(new Request(request(), { method: "POST" }), {
        fetchImpl,
      })
    ).status,
    405,
  );
});
test("real HTTP boundary parses, deduplicates and retains cached checkedAt", async () => {
  let calls = 0;
  let time = Date.parse("2026-09-08T00:00:00Z");
  const fetchImpl = async (url) => {
    calls++;
    return new Response(
      url.endsWith("/robots.txt")
        ? "User-agent: *\nDisallow: /online/"
        : html(),
    );
  };
  const options = { fetchImpl, now: () => time };
  const [a, b] = await Promise.all([
    handlePartMetadata(request(), options),
    handlePartMetadata(request(), options),
  ]);
  const first = await a.json();
  assert.equal(first.status, "found");
  assert.equal(first.candidates[0].weightKg, 0.362873896);
  assert.equal(calls, 2);
  assert.match(b.headers.get("cache-control"), /no-store/);
  time += 1000;
  assert.equal(
    (await (await handlePartMetadata(request(), options)).json()).checkedAt,
    first.checkedAt,
  );
  assert.equal(calls, 2);
  time += 8 * 86400000;
  await handlePartMetadata(request(), options);
  assert.equal(calls, 4);
});
test("denial fails closed and repeated denied lookup stays bounded", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("denied", { status: 403 });
  };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await (await handlePartMetadata(request(), { fetchImpl })).json())
        .status,
      "unavailable",
    );
  assert.equal(calls, 1);
});
test("cross-host redirect never makes a second product request", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return url.endsWith("robots.txt")
      ? new Response("")
      : new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/oem/x.html" },
        });
  };
  const r = await (await handlePartMetadata(request(), { fetchImpl })).json();
  assert.equal(r.status, "unavailable");
  assert.equal(urls.length, 2);
  assert.match(r.attempts[0].reason, /redirect|route/);
});
test("body limit and fetch deadline fail closed", async () => {
  for (const fetchImpl of [
    async () => new Response("x".repeat(65537)),
    async () => new Promise(() => {}),
  ]) {
    const r = await (
      await handlePartMetadata(request(), { fetchImpl, fetchTimeoutMs: 15 })
    ).json();
    assert.equal(r.status, "unavailable");
  }
});
test("ordinary Nissan and Subaru redirects reach verified descriptive product routes", async () => {
  for (const [make, part, canonical, dims, weight] of [
    [
      "NISSAN",
      "15208-9E01A",
      "https://www.nissanpartsdeal.com/parts/nissan-oil-filter~15208-9e01a.html",
      "3.7 x 2.9 x 2.6 inches",
      "0.60 Pounds",
    ],
    [
      "SUBARU",
      "15208AA100",
      "https://www.subarupartsdeal.com/parts/subaru-oil-filter-complete~15208aa100.html",
      "10.6 x 7.1 x 4.5 inches",
      "2.30 Pounds",
    ],
  ]) {
    const fetchImpl = async (url) =>
      url.endsWith("robots.txt")
        ? new Response("")
        : url === canonical
          ? new Response(html(part, dims, weight))
          : new Response(null, {
              status: 302,
              headers: { location: canonical },
            });
    const r = await (
      await handlePartMetadata(request("make=" + make + "&part=" + part), {
        fetchImpl,
      })
    ).json();
    assert.equal(r.status, "found");
    assert.equal(r.candidates[0].url, canonical);
  }
});
test("streamed bodies honor deadline and HTML size limit", async () => {
  for (const kind of ["stream", "large"]) {
    const fetchImpl = async (url) =>
      url.endsWith("robots.txt")
        ? new Response("")
        : kind === "large"
          ? new Response("x".repeat(1048577))
          : new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode("<table>"));
                },
              }),
            );
    const r = await (
      await handlePartMetadata(request(), {
        fetchImpl,
        fetchTimeoutMs: 20,
        totalTimeoutMs: 10,
      })
    ).json();
    assert.equal(r.status, "unavailable");
    assert.match(r.attempts[0].reason, /timeout|body_limit/);
  }
});
test("robots denial blocks product and redirect disallow is checked before follow", async () => {
  let products = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("robots.txt"))
      return new Response(
        "User-agent: *\nDisallow: /oem/toyota~blocked~90915-10001.html",
      );
    products++;
    return new Response(null, {
      status: 302,
      headers: { location: "/oem/toyota~blocked~90915-10001.html" },
    });
  };
  const r = await (await handlePartMetadata(request(), { fetchImpl })).json();
  assert.equal(r.status, "unavailable");
  assert.match(r.attempts[0].reason, /robots_denied/);
  assert.equal(products, 1);
});
test("Toyota and Honda canonical tilde routes are followed only for the requested final part", async () => {
  for (const [make, part, canonical] of [
    [
      "TOYOTA",
      "90915-10001",
      "https://www.toyotapartsdeal.com/oem/toyota~filter~sub~assy~oil~90915-10001.html",
    ],
    [
      "HONDA",
      "15400-PLM-A02",
      "https://www.hondapartsnow.com/genuine/honda~filter~oil~15400-plm-a02.html",
    ],
  ]) {
    const fetchImpl = async (url) =>
      url.endsWith("robots.txt")
        ? new Response("")
        : url === canonical
          ? new Response(html(part))
          : new Response(null, {
              status: 302,
              headers: { location: canonical },
            });
    const r = await (
      await handlePartMetadata(request("make=" + make + "&part=" + part), {
        fetchImpl,
      })
    ).json();
    assert.equal(r.status, "found");
    assert.equal(r.candidates[0].url, canonical);
  }
});
test("same-host redirect to a different final part stops before second product fetch", async () => {
  let products = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("robots.txt")) return new Response("");
    products++;
    return products === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "/oem/toyota~filter~90915-10002.html" },
        })
      : new Response(html());
  };
  const r = await (await handlePartMetadata(request(), { fetchImpl })).json();
  assert.equal(r.status, "unavailable");
  assert.equal(products, 1);
});
test("success cache evicts oldest beyond200 normalized parts", async () => {
  let products = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("robots.txt")) return new Response("");
    products++;
    const part = new URL(url).pathname
      .split("~")
      .pop()
      .replace(".html", "")
      .toUpperCase();
    return new Response(html(part));
  };
  for (let i = 0; i < 201; i++)
    await handlePartMetadata(
      request("make=TOYOTA&part=90915-" + String(10000 + i)),
      { fetchImpl },
    );
  await handlePartMetadata(request("make=TOYOTA&part=90915-10000"), {
    fetchImpl,
  });
  assert.equal(products, 202);
});

test("unrelated-only robots groups do not apply to PartScout", () => {
  assert.equal(robotsAllowed("User-agent: OtherBot\nDisallow: /", "/oem/toyota~90915-10001.html"), true);
});
test("distinct parts coalesce cold-host robots and share denial or network rejection", async () => {
  for (const outcome of ["allow", "deny", "reject"]) {
    let robotsCalls = 0, products = 0, release;
    const fetchImpl = async (url) => {
      if (url.endsWith("robots.txt")) {
        robotsCalls++;
        await new Promise(resolve => { release = resolve; });
        if (outcome === "reject") throw Error("network_down");
        return new Response(outcome === "deny" ? "User-agent: *\nDisallow: /" : "");
      }
      products++;
      return new Response(html(url.includes("10002") ? "90915-10002" : "90915-10001"));
    };
    const pending = [request(), request("make=TOYOTA&part=9091510002")].map(r => handlePartMetadata(r, { fetchImpl, fetchTimeoutMs: 30 }));
    release();
    const results = await Promise.all(pending.map(async p => (await p).json()));
    assert.equal(robotsCalls, 1, outcome + " fetch count");
    assert.equal(products, outcome === "allow" ? 2 : 0);
    for (const result of results) {
      assert.equal(result.status, outcome === "allow" ? "found" : "unavailable");
      if (outcome !== "allow") assert.equal(result.attempts[0].reason, outcome === "deny" ? "robots_denied" : "network_down");
    }
  }
});
test("forced successful refresh retains original dates and fetch count until24hours", async () => {
  for (const partial of [false, true]) {
    let time = Date.parse("2026-09-08T00:00:00Z"), products = 0;
    const fetchImpl = async url => {
      if (url.endsWith("robots.txt")) return new Response("");
      products++;
      return new Response(html("90915-10001", partial ? "unknown" : "1 x 2 x 3 cm"));
    };
    const options = { fetchImpl, now: () => time };
    const first = await (await handlePartMetadata(request(), options)).json();
    time += 86400000 - 1;
    assert.deepEqual(await (await handlePartMetadata(request("make=TOYOTA&part=9091510001&refresh=1"), options)).json(), first);
    assert.equal(products, 1);
    time++;
    const refreshed = await (await handlePartMetadata(request("make=TOYOTA&part=9091510001&refresh=1"), options)).json();
    assert.equal(products, 2);
    assert.notEqual(refreshed.checkedAt, first.checkedAt);
  }
});
test("denial Retry-After seconds and HTTP dates survive without retries, including robots429", async () => {
  const time = Date.parse("2026-09-08T00:00:00Z");
  for (const robots of [false, true]) {
    for (const [header, expected] of [["120",120], ["Wed, 09 Sep 2026 00:00:00 GMT",86400], ["0",undefined], ["-2",undefined], ["1.5",undefined], ["nonsense",undefined], ["Tue, 08 Sep 2026 00:00:00 GMT",undefined], ["9".repeat(400),undefined]]) {
      let calls = 0;
      const fetchImpl = async url => {
        calls++;
        if (!robots && url.endsWith("robots.txt")) return new Response("");
        return new Response("denied", {status:429, headers:{"Retry-After":header}});
      };
      const result = await (await handlePartMetadata(request(), { fetchImpl, now: () => time })).json();
      assert.equal(result.status, "unavailable");
      assert.equal(result.attempts[0].reason, robots ? "robots_http_429" : "source_http_429");
      assert.equal(result.retryAfterSeconds, expected, header);
      await handlePartMetadata(request("make=TOYOTA&part=9091510001&refresh=1"), { fetchImpl, now: () => time });
      assert.equal(calls, robots ? 1 : 2);
    }
  }
});

for (const robots of [true, false]) {
  for (const status of [403, 429]) {
    for (const kind of ["oversized", "stalled", "error"]) {
      test(`${robots ? "robots" : "product"}${status} preserves denial headers despite ${kind} body`, async () => {
        let calls = 0;
        const fetchImpl = async url => {
          calls++;
          if (!robots && url.endsWith("robots.txt")) return new Response("");
          const body = new ReadableStream({
            start(controller) {
              if (kind === "error") controller.error(Error("denial_body_failure"));
            },
            cancel() {
              if (kind === "stalled") return new Promise(() => {});
              throw Error("denial_cleanup_failure");
            },
          });
          return new Response(body, { status, headers: {
            "Retry-After": "172800",
            ...(kind === "oversized" ? {"Content-Length":"2000000"} : {}),
          }});
        };
        const result = await (await handlePartMetadata(request(), { fetchImpl, fetchTimeoutMs: 20 })).json();
        assert.equal(result.status, "unavailable");
        assert.equal(result.attempts[0].reason, `${robots ? "robots" : "source"}_http_${status}`);
        assert.equal(result.retryAfterSeconds, 172800);
        assert.equal(calls, robots ? 1 : 2);
      });
    }
  }
}
