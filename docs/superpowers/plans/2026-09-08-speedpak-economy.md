# SpeedPAK Economy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保存できる梱包情報から、日本発・米国本土48州向けのSpeedPAK Economy参考送料を自動計算する。

**Architecture:** ブラウザ内の純粋関数で公式の既知版料金表を計算し、既存の商品別原価フォームと即時保存に接続する。ライブAPIのキー、本番ホスト、利用許可がない間は接続済みと表示しない。自分の販売データの自動取得は公開リポジトリへ保存せず、別の非公開連携として調査結果を残す。

**Tech Stack:** 既存のVanilla JavaScript、Node標準テスト、GitHub Pages。

**Spec:** この文書のGlobal ConstraintsとTask 1が今回の実装仕様。元の依頼は自動化・簡単操作・誤計算防止・スマホ利用・中断復元・無料。

## Global Constraints

- 追加の有料サービス、外部依存、キー入力欄を追加しない。
- 既存の手入力送料、入力途中の値、JSONバックアップ、即時保存とオフライン復元を維持する。
- 金額は参考見積と実際の請求額を区別する。料金表は2026-03-25発効の既知版であり「最新を自動確認済み」とは表示しない。
- 送料は燃油込み。関税、通関245円、関税処理手数料2.1%を別項目として扱い、二重加算しない。
- 個別注文、購入者情報、認証トークンをweb/data、Git、ログに保存しない。
- このタスクは配送ラベル発行、集荷予約、外部API呼出しを実行しない。

## Task 1: 保存できる送料参考計算と原価フォームへの反映

**Files:**
- Create: `web/shipping.js`, `tests/shipping.test.cjs`
- Modify: `web/app.js`, `web/index.html`, `web/styles.css`, `web/sw.js`, `.github/workflows/ci-zero-tap.yml`
- Modify existing focused test fixtures only if a dependency or explicit shipping method is required; preserve their assertions.

**Interfaces:**
- `PartScoutShipping.estimateEconomy({weightKg,lengthCm,widthCm,heightCm,region,declaredValueUsd})`
- Export same object via CommonJS for tests; browser global uses existing IIFE/UMD convention.
- `region` is `US48` or `OTHER`; OTHER gives unsupported result. Default region US48 must be visibly labelled as assumption for research.
- Result shape: `{ok, errors, chargeableWeightKg, billedWeightKg, baseJpy, oversizeJpy, shippingJpy, clearanceJpy, dutyProcessingRate, sourceUrl, effectiveDate}`; unavailable monetary values are null, never zero.
- `shippingJpy = baseJpy + oversizeJpy`. Clearance and processing are separate and NOT included in shippingJpy.

**Evidence:** Official Orange Connex PDF https://static.orangeconnex.com/capricorn/selfQuery/1141130239112384512.pdf pages 5–9 (printed numbers). Effective 2026-03-25. Research viewed 2026-09-08. Source PDF is a dated reference, not a live quote. Current API documentation separately confirms EE Economy and pricing estimates, with production onboarding required: https://3pp-jp-openapi.apifox.cn/8-shipping-cost-estimation-443715936e0 .

- [x] **Step 1: Write focused failing tests and run them**

Use Node standard `node:test`. Required independent expectations:

```js
const parcel = {weightKg:0.5,lengthCm:20,widthCm:15,heightCm:10,region:'US48',declaredValueUsd:100};
assert.equal(estimateEconomy(parcel).shippingJpy,2060);
assert.equal(estimateEconomy({...parcel,lengthCm:40,widthCm:20,heightCm:20}).shippingJpy,5245);
assert.equal(estimateEconomy({...parcel,weightKg:0.5001}).baseJpy,2222);
assert.equal(estimateEconomy({...parcel,weightKg:0.5,lengthCm:56,widthCm:10,heightCm:10}).oversizeJpy,2475);
assert.equal(estimateEconomy({...parcel,weightKg:''}).ok,false);
assert.equal(estimateEconomy({...parcel,lengthCm:67}).ok,false);
assert.equal(estimateEconomy({...parcel,declaredValueUsd:1300.01}).ok,false);
assert.equal(estimateEconomy({...parcel,region:'OTHER'}).ok,false);
```

Also test length/volume/weight boundaries, malformed numeric values, identical results for rotated dimensions, UI-derived shipping updates on parcel edits and restores, confirmation invalidation, manual mode preservation, and missing dimensions preventing a purchase candidate. Test fees exactly once: clearance245 and processing `dutyJpy*0.021` excluded from shipping but included once in total costs for automatic mode. Validate finite totals and no unknown amount converted to zero.

Run `node --test tests/shipping.test.cjs` and record RED.

- [x] **Step 2: Implement the rate calculator**

Use the following verified USD-destination JPY rate pairs (kg maximum: JPY) for US48 only:

```js
const rates = [[.1,1227],[.2,1367],[.3,1581],[.4,1778],[.5,2060],[.6,2222],[.7,2321],[.8,2703],[.9,2820],[1,3020],[1.1,3136],[1.2,3250],[1.3,3366],[1.4,3704],[1.5,3816],[1.6,3935],[1.7,4046],[1.8,4165],[1.9,5056],[2,5245],[2.5,5582],[3,6333],[3.5,6958],[4,7704],[4.5,9135],[5,11733],[5.5,12500],[6,13335],[6.5,14160],[7,15209],[7.5,16058],[8,16893],[8.5,17562],[9,18152],[9.5,19106],[10,19639],[10.5,20276],[11,20864],[11.5,21565],[12,22199],[12.5,22887],[13,23466],[13.5,24054],[14,24869],[14.5,25200],[15,25988],[15.5,26656],[16,28149],[16.5,28775],[17,29495],[17.5,30196],[18,30902],[18.5,31478],[19,32204],[19.5,32936],[20,33947],[20.5,34655],[21,35426],[21.5,36145],[22,36859],[22.5,37602],[23,38516],[23.5,39084],[24,39678],[24.5,40374],[25,40955]];
```

Parse finite positive actual weight and three dimensions; disallow boolean/null/empty/exponential malformed text. Use decimal-safe rounding to grams, max(actual kg, L*W*H/8000); choose first bracket at or above chargeable grams. Longest edge <=66 cm, longest+2*(other two)<=274 cm, chargeable weight<=25 kg, declaredValueUsd<=1300. Declared value must be positive finite for valid result. Oversize2475 once if ANY edge>55.88 cm OR volume>55000 cm³ (not twice when both). No return-shipping divisor6000. Avoid floating-point near-boundary overcharging (e.g.1.1*1000).

- [x] **Step 3: Connect calculator to persistent form**

Keep existing default/manual behavior for legacy saved costs. Add a prominent `送料の計算方法` select with `手入力` and `SpeedPAK Economy（米国）`, plus weight(kg), 3 box dimensions(cm), region selection in the current detail form. New method selection is one action, fields persist via existing data-cost mechanism. Do not overwrite stored manual internationalShippingJpy when switching methods: derive auto amount in getCostValues, and expose it read-only while auto mode is active. Give reference quote breakdown, source URL, effective date and `参考送料・最終金額はCPaSSで確認` in Japanese. Region displays `米国本土48州を想定`; OTHER prompts CPaSS/manual quote. Dangerous goods/batteries not accepted is a short relevant note since catalogue is auto parts.

Map additional raw fields to simple scalars for backups. Avoid object-valued cost additions. Parcel edits/method changes clear supplierConfirmed and tariffConfirmed. Actual market price changes already clear tariffConfirmed; auto method must also ensure quote compatibility. Derived fee calculation is:

```js
const speedpakFees = autoMode && quote.ok ? quote.clearanceJpy + tariff * quote.dutyProcessingRate : 0;
const fixedCosts = procurement + domesticShipping + internationalShipping + packaging + customsFixedJpy + speedpakFees;
```

In auto mode customsFixedJpy is explicitly `その他の通関費（円）` and excludes the automatic clearance/processing to prevent double-counting. Manual mode remains existing actual quote cost semantics. Existing DDP関税額 must be duty only, not total invoice. No new assumed tariff rates.

For absent/invalid/out-of-range auto inputs, display 未確定 and make hasCosts false; include concrete input errors, never retain a previous auto quote. An automatic rate table reference cannot satisfy final shipping confirmation: when checking supplierConfirmed in auto mode, explain/use a separate `見積の送料に切替（手入力）` path or otherwise ensure purchases remain provisional until actual CPaSS quote is used. Keep reference estimate useful for ranking but cannot report purchase-ready from the dated table alone.

- [x] **Step 4: Include new script in offline shell and CI**

```html
<script src="./shipping.js" defer></script>
```

Place before app.js, add shipping.js to service worker SHELL, advance shell v9 to v10 (migration already generic). Ensure affected shell version test fixtures track new version, preserving assertions. Add `node --test tests/shipping.test.cjs` and `node --check web/shipping.js` to existing CI.

- [x] **Step 5: Verify, self-review and commit**

```sh
node --test tests/shipping.test.cjs tests/accuracy_regression.test.cjs tests/persistence.test.cjs tests/sw_offline.test.cjs
node tests/web_core.test.cjs
node tests/sw_core.test.cjs
node tests/data_freshness.test.cjs
node --check web/app.js
node --check web/shipping.js
```

Use `/tmp/part-scout-dom` jsdom if needed for focused UI persistence integration; it is not a production dependency. Do not change repo docs other than this plan's progress checkboxes (controller owns API report), or touch Python research workflow. Commit only task-owned files, no whole-tree add. Report RED/GREEN, commands, outputs, changes and concerns to task report path supplied by controller.
