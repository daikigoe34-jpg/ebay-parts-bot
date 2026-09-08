const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../web/part-parcel.js");
const S = require("../web/shipping.js");
const item = { weightKg: 0.362873896, dimensionsCm: [7.874, 7.62, 8.636] };
const config = {
  quantity: 1,
  paddingCm: 1,
  packingGrams: 50,
  boxId: "auto",
  region: "US48",
  declaredValueUsd: 20,
};
test("boxing uses inner fit, outer charge, and exact unrounded mass", () => {
  const r = P.selectParcel(item, config, S.estimateEconomy);
  assert.equal(r.ok, true);
  assert.equal(r.box.id, "cb11-060");
  assert.equal(r.parcel.weightKg, 0.557873896);
  assert.deepEqual(
    [r.parcel.lengthCm, r.parcel.widthCm, r.parcel.heightCm],
    [25, 18, 16.3],
  );
  assert.equal(r.quote.chargeableWeightKg, 0.917);
});
test("fit searches rotations and regular grid quantities", () => {
  assert.equal(P.fits([12, 20, 10], [24, 17, 14.8], 1, 1), true);
  assert.equal(P.fits([12, 20, 10], [24, 17, 14.8], 2, 1), false);
  assert.equal(P.fits([25, 18, 16.3], [24, 17, 14.8], 1, 0), false);
  assert.equal(P.fits([5, 5, 5], [12, 12, 12], 8, 1), true);
});
test("missing, invalid quantity, no fit and unsupported region cannot produce parcel", () => {
  for (const overrides of [
    { quantity: "" },
    { quantity: 0 },
    { quantity: 21 },
    { quantity: 1.5 },
    { region: "OTHER" },
    { paddingCm: "" },
  ])
    assert.equal(
      P.selectParcel(item, { ...config, ...overrides }, S.estimateEconomy).ok,
      false,
    );
  assert.equal(
    P.selectParcel({ ...item, weightKg: null }, config, S.estimateEconomy).ok,
    false,
  );
  assert.equal(
    P.selectParcel(
      { ...item, dimensionsCm: [100, 100, 100] },
      config,
      S.estimateEconomy,
    ).ok,
    false,
  );
});
test("measured profile only reuses matching identity and full packing settings", () => {
  const parcel = { weightKg: 0.6, lengthCm: 25, widthCm: 18, heightCm: 16.3 };
  const p = P.makeProfile(
    "TOYOTA",
    "9091510001",
    config,
    parcel,
    "2026-09-08T00:00:00.000Z",
  );
  assert.deepEqual(P.reuseProfile(p, "TOYOTA", "90915-10001", config), parcel);
  assert.equal(
    P.reuseProfile(p, "TOYOTA", "90915-10001", { ...config, packingGrams: 60 }),
    null,
  );
  assert.equal(
    P.reuseProfile(
      { ...p, provenance: "estimate" },
      "TOYOTA",
      "90915-10001",
      config,
    ),
    null,
  );
  assert.equal(
    P.reuseProfile(
      { ...p, parcel: { ...parcel, weightKg: 0 } },
      "TOYOTA",
      "90915-10001",
      config,
    ),
    null,
  );
});
test("source URL validation allows factual canonical routes but rejects other part identities", () => {
  assert.equal(
    P.safeSourceUrl(
      "https://www.toyotapartsdeal.com/oem/toyota~filter~sub~assy~oil~90915-10001.html",
      "TOYOTA",
      "90915-10001",
    ),
    true,
  );
  assert.equal(
    P.safeSourceUrl(
      "https://www.toyotapartsdeal.com/oem/toyota~filter~sub~assy~oil~90915-10002.html",
      "TOYOTA",
      "90915-10001",
    ),
    false,
  );
});
