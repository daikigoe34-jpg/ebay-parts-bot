# Part Scout Mobile

**eBay Motorsの日本車純正部品を自動調査し、iPhoneで仕入れ候補と利益を判定するPWA**です。

GitHub Actionsが毎日ランダム検索し、GitHub Pagesの画面をiPhoneのホーム画面から使います。モノタロウ・楽天・eBayは、抽出した純正品番を入れた検索画面を1タップで開きます。


## できること

- 日産・トヨタ・ホンダ・マツダ・スバル・三菱・スズキ・いすゞをランダム調査
- `OEM`、`Genuine`、`Factory Original`と小型部品語を自動で組み合わせ
- eBay Motors「Parts & Accessories」（カテゴリー6028）を検索
- Item Specificsを優先し、商品名も補助利用して純正品番を抽出
- 同一品番を再検索し、競合数・価格中央値・価格帯・セラー数を集計
- 競合検索の一致率から、競合数の推定値・精度・サンプルカバー率を表示
- 現行出品の累計販売数量を日次保存し、確認できた出品サンプルの90日販売数を推定
- eBay Product Researchの90日実績をiPhoneから手入力、またはCSVで補正
- モノタロウ・楽天・eBayを品番指定で1タップ検索
- 仕入価格、国内送料、SpeedPAK送料、梱包、関税、eBay手数料、海外手数料、広告、為替ロス、返品引当を含む利益計算
- 「販売候補／仮候補／再検討／見送り」を自動判定
- iPhone画面からGitHub Actionsの手動調査画面を開く
- 一覧をCSV保存

## 判定の考え方

### APIだけの結果は「仮候補」

通常のeBay Browse APIは、現行出品の検索と個別出品の`estimatedSoldQuantity`取得には使えますが、過去90日の成約履歴をそのまま返すAPIではありません。成約履歴向けMarketplace Insights APIは制限公開で、新規利用者には開放されていません。

本プログラムは次の順で精度を上げます。

1. **Product Research手入力／CSV**：90日実績として最優先
2. **日次差分**：同一出品の累計販売数の増加を90日換算
3. **掲載期間平均**：履歴が少ないときの仮推定
4. **データ不足**：販売数量を取得できない場合

API推定は、検索市場全体ではなく**確認できた現行出品サンプルの合計**です。したがって、利益条件を満たしてもProduct Research未確認なら「仮候補」に止めます。

### 競合数も推定

品番だけで検索しても、関連型番や適合情報を含む別商品が混ざります。そこで、eBay検索結果の`total`をそのまま競合数にせず、返された最大50件のうち同一品番を商品名に含む割合から競合数を推定します。

- 精度「高／中／低／不明」を表示
- 確認できた出品数と推定競合数からサンプルカバー率を表示
- 精度が低い候補は市場スコアを減点

### 関税は実見積確認が必須

日本原産品の米国向け関税は15%を仮の初期値にしていますが、材質、HTSUS、原産国、追加関税、DDP配送条件により変わります。**最終の「販売候補」判定には、SpeedPAK等のDDP実見積を確認し、各商品で確認済みチェックを入れる必要があります。**

実見積に関税が含まれる場合は、関税率を0%にして「通関・DDP追加費」へ金額を入力できます。

## 無料運用の構成

| 部分 | 使用サービス | 役割 |
|---|---|---|
| 自動処理 | GitHub Actions | 毎日のeBay API調査・テスト・結果更新 |
| iPhone画面 | GitHub Pages | HTML/CSS/JavaScriptのPWA公開 |
| eBay検索 | eBay Browse API | 現行出品、品番、価格、累計販売数量の取得 |
| 仕入先検索 | モノタロウ／楽天 | 自動取得せず、品番検索リンクのみ生成 |
| 端末データ | Safari localStorage | 仕入価格、送料、補正データ、設定を保存 |

有料API、生成AI API、OCR、外部データベースは使用しません。公開リポジトリのGitHub ActionsとGitHub Pagesを使う構成です。

## 対象GitHubリポジトリ

この版は次のリポジトリへの配置を前提にしています。

`daikigoe34-jpg/ebay-parts-bot`

画面上部の「今すぐ調査」は、このリポジトリの`eBay自動リサーチ`ワークフローを開きます。

## 初期設定

### 1. eBay ProductionキーをSecretsへ登録

GitHubの対象リポジトリで次を開きます。

`Settings` → `Secrets and variables` → `Actions` → `New repository secret`

| Secret名 | 入れる値 |
|---|---|
| `EBAY_CLIENT_ID` | eBay DeveloperのProduction App ID（Client ID） |
| `EBAY_CLIENT_SECRET` | Production Cert ID（Client Secret） |

Client Secretはファイル、JavaScript、READMEへ直接書かないでください。GitHub Actions内で短期Application Tokenを発行します。User Tokenは不要です。

### 2. GitHub Pagesを有効化

`Settings` → `Pages` → `Build and deployment` → `Source` を **GitHub Actions** にします。

### 3. 初回調査

`Actions` → `eBay自動リサーチ` → `Run workflow`

- 検索語を空欄：メーカー・純正語・小型部品語をランダム選択
- 検索語を入力：例 `Nissan Genuine switch`

成功すると、`web/data/results.json`が実データへ更新され、`GitHub Pages公開`ワークフローが起動します。

書込み権限エラーになった場合のみ、`Settings` → `Actions` → `General` → `Workflow permissions`で **Read and write permissions** を選択します。

## iPhoneで使う

1. `Settings` → `Pages` に表示されたURLをSafariで開く
2. Safariの共有ボタンを押す
3. **ホーム画面に追加**を押す
4. ホーム画面の「Part Scout」から起動

詳しい手順は[`docs/IPHONE_SETUP.md`](docs/IPHONE_SETUP.md)にあります。

## 毎日の使い方

1. 候補一覧を市場スコア順または90日販売数順で確認
2. 品番カードの「モノタロウ」「楽天」を押して仕入価格を確認
3. SpeedPAK等で国際送料とDDP関税を見積
4. 仕入価格、送料、関税条件を入力
5. 重要候補は「90日補正」でProduct Research実績を入力
6. DDP関税の実見積確認済みにチェック
7. 「販売候補」になった商品のみ仕入れを検討
8. 一覧をCSV保存

仕入価格、送料、Product Research補正値はGitHubへ送信されず、Safari内だけに保存されます。Safariのサイトデータを削除すると消えるため、CSVを定期保存してください。

## 自動実行

- 毎日 **06:17 JST** にランダム調査
- 画面上部「今すぐ調査」からActions画面を開ける
- 1回の候補上限：15品番
- 各品番の詳細確認：最大15出品
- 日次スナップショット保持：100日

変更場所：`.github/workflows/research.yml`

## 初期の利益計算設定

2026年8月15日に公式資料を再確認した参考値です。画面から変更できます。

| 項目 | 初期値 | 計算方法・注意 |
|---|---:|---|
| 為替 | 150円/USD | 実勢に合わせて変更 |
| eBay手数料・ストアなし／Starter | 13.6% | 総売上7,500USDまで。超過分2.35% |
| eBay手数料・Basic以上 | 11.5% | 対象Parts & Accessoriesの1,000USDまで。超過分2.35% |
| 1取引固定手数料 | $0.30 / $0.40 | 総売上10USD以下は0.30、超えると0.40 |
| 日本セラー海外手数料 | 1.35% | 販売量割引前 |
| 米国売上税仮定 | 7% | eBay手数料計算ベース用。州で異なる |
| 為替・出金ロス | 2% | 安全側の仮置き |
| 関税 | 15% | 日本原産の基準としての仮置き。実見積必須 |
| 返品・不良引当 | 3% | 自社実績に合わせて変更 |

eBay手数料の計算ベースには商品価格、購入者負担送料、仮定した売上税を含めます。

## 「販売候補」の初期条件

次をすべて満たす必要があります。

- 予想利益：5,000円以上
- 利益率：25%以上
- Product Researchで確認した90日販売数：3個以上
- 市場スコア：55以上
- 販売数 ÷ 競合数：0.10以上
- 競合データ取得済み
- 仕入価格と国際送料を入力済み
- DDP関税実見積を確認済み

市場スコアは、需要、販売数÷競合、競合の少なさ、価格水準・ばらつきを100点化した独自の一次選別指標です。利益を保証する指標ではありません。

## CSV補正

同梱の[`docs/product-research-sample.csv`](docs/product-research-sample.csv)を複製して使えます。UTF-8のCSV、タブ区切り、セミコロン区切りを認識します。

主な対応列：

- `Title` / `商品名`
- `Manufacturer Part Number` / `MPN` / `品番`
- `Average Sold Price` / `Sold Price` / `販売価格`
- `Total Sold` / `Sold Quantity` / `販売数量`
- `Active Listings` / `Competition` / `競合数`
- `Seller` / `セラー`
- `Last Sold Date` / `販売日`

販売日がある場合は、取込日から90日より古い行を除外します。

## 公開範囲とセキュリティ

- このリポジトリとGitHub Pagesは公開です。
- API調査結果`web/data/results.json`は第三者も閲覧できます。
- eBay Client SecretはGitHub Secrets内だけに保存します。
- 仕入価格、送料、利益設定、手入力補正、CSV内容はSafari内に保存し、GitHubへ書込みません。
- モノタロウ／楽天は自動スクレイピングせず、検索リンクだけ生成します。
- 購入、発注、出品を自動実行しません。

詳細は[`SECURITY.md`](SECURITY.md)を確認してください。

## テスト

```bash
python3 -m pip install -r requirements.txt
python3 -m pytest -q
node tests/web_core.test.cjs
node --check web/app.js
node --check web/sw.js
python3 -m py_compile scripts/core.py scripts/research.py
```

GitHub ActionsでもeBay APIを呼ぶ前にテストします。

## 公式資料（2026年8月15日確認）

- [eBay Browse API](https://developer.ebay.com/api-docs/buy/api-browse.html)
- [eBay EstimatedAvailability / estimatedSoldQuantity](https://developer.ebay.com/api-docs/buy/browse/types/gct%3AEstimatedAvailability)
- [eBay Buy API Field Filters：Marketplace Insightsの利用制限](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html)
- [eBay Store selling fees](https://www.ebay.com/help/selling/fees-credits-invoices/store-selling-fees?id=4809)
- [eBay International fees for global sellers](https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=5224)
- [米国政府：日米枠組みの15%基準](https://www.whitehouse.gov/fact-sheets/2025/09/fact-sheet-president-donald-j-trump-implements-a-historic-u-s-japan-framework-agreement/)
- [米国政府：鉄・アルミ・銅の個別取扱い](https://www.whitehouse.gov/presidential-actions/2026/06/further-adjusting-the-tariff-regimes-for-imports-of-aluminum-steel-and-copper-into-the-united-states/)
- [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages)

## 免責

利益、関税、送料、市場需要は変動します。表示値は仕入れ候補を絞るための推定であり、利益を保証しません。出品前に、eBayの最新手数料、配送会社のDDP見積、商品の原産国、HTSUS、知的財産権、メーカー販売条件を確認してください。
