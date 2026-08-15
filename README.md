# Part Scout Mobile

**eBay Motorsの日本車純正部品を自動探索し、iPhoneで仕入れ候補を上から処理するPWA**です。

GitHub Actionsが毎日、Production API診断、検索語ローテーション、純正品番抽出、同一品番の競合・相場調査、販売差分の学習、楽天価格、為替、手数料、関税の仮計算、利益判定まで行います。

日常操作は、画面の`1 今日やる`に表示される「次にすること」を処理するだけです。

## v0.4.1の重要変更

- **一時的なeBay検索障害で候補一覧を空に上書きしない**
- 候補探索または同一品番検索が全滅した場合、前回候補・監視履歴・販売差分を保持して次回へ自動再試行
- 一部の検索だけ失敗した場合は、取得できた候補を保存し、失敗分だけ次回に再試行
- 任意のDeveloper Analytics権限不足を、Browse API本番権限不足と誤表示しない
- 成功した実調査には`data_status=real`、一時障害時には`research_status`を記録
- Python自動テストを30件へ拡充

## v0.4.0から継続するProduction API専用仕様

- **eBay Production App ID／Cert IDだけで使う構成に固定**
- Marketplace Insightsなどの制限API依存をコード・UI・説明から撤去
- Productionキー未登録、キー不一致、OAuth障害、Browse本番未承認、呼出上限を自動診断
- Browse APIが403の場合に、キー不一致と誤表示せず`Browse本番権限なし`と表示
- `estimatedSoldQuantity`の観測開始前累計を90日販売数へ混ぜない
- 観測7日未満は90日換算値を**0件・学習中**として扱う
- 消えた出品も過去スナップショットから販売増分を保持
- 監視品番を最大60件・90日保持し、一時的に候補順位が落ちても学習を継続
- Product Research／外部CSVは日常フローから外し、任意補正へ降格
- Developer Analytics APIが利用できる場合はBrowse API残量も表示
- UIに`Productionキー → OAuth → Browse本番権限 → 差分学習`の状態を表示

## Productionキーだけで使える範囲

登録するSecretは次の2つです。

| Secret名 | eBay Developer Portal上の値 |
|---|---|
| `EBAY_CLIENT_ID` | Production App ID / Client ID |
| `EBAY_CLIENT_SECRET` | Production Cert ID / Client Secret |

この2つからClient Credentials GrantでApplication access tokenを取得します。

ただし、**Productionキーが発行されていても、Buy/Browse APIのProduction利用が自動的に許可されるとは限りません。** 初回実行時に最小検索を1回行い、次のように切り分けます。

| 画面表示 | 意味 | 次にすること |
|---|---|---|
| `未登録` | GitHub Secretsが空 | 2つのSecretを登録 |
| `キー不一致` | OAuthが401等で失敗 | 同じProduction KeysetのApp ID／Cert IDへ修正 |
| `本番権限なし` | OAuth成功、Browseが403 | eBayへBuy/Browse API Production利用申請 |
| `上限到達` | Browseが429 | 人の操作不要。次回実行で再試行 |
| `接続済み` | OAuth・Browseとも成功 | 自動調査開始 |

キーやトークンはJSON、JavaScript、ログ、画面へ出力しません。

## 初回設定

### 1. eBay Productionキー

GitHubリポジトリで次を開きます。

`Settings` → `Secrets and variables` → `Actions` → `New repository secret`

`EBAY_CLIENT_ID`と`EBAY_CLIENT_SECRET`を登録します。

### 2. GitHub Pages

`Settings` → `Pages` → `Build and deployment` → `Source`を **GitHub Actions** にします。

### 3. 初回診断・調査

`Actions` → `eBay自動リサーチ` → `Run workflow`

検索語は空欄のままで構いません。診断結果は`web/data/results.json`へ保存され、iPhone画面に次の操作が表示されます。

### 4. 楽天APIキー（任意）

楽天の品番一致価格を自動入力する場合だけ、次を登録します。

| Secret名 | 内容 |
|---|---|
| `RAKUTEN_APPLICATION_ID` | 楽天ウェブサービスApplication ID |
| `RAKUTEN_ACCESS_KEY` | 楽天ウェブサービスAccess Key |

未登録でも楽天・モノタロウの品番検索ボタンは使えます。

## 自動化される処理

| 処理 | 自動化 | 内容 |
|---|---|---|
| Production API診断 | 自動 | Secret、OAuth、Browse権限、呼出上限を分類 |
| 検索語選択 | 自動 | メーカー・純正語・小型部品語を順次ローテーション |
| 品番抽出 | 自動 | Item Specificsを優先し、タイトルを補助利用 |
| 同一品番調査 | 自動 | 競合数、出品価格帯、セラー数を集計 |
| 販売ペース学習 | 自動 | `estimatedSoldQuantity`の日次差分のみ集計 |
| 終了・売切れ出品 | 自動 | 観測済み差分を履歴へ残す |
| 監視継続 | 自動 | 最大60品番を90日保持 |
| 為替 | 自動 | ECB日次レートからUSD/JPYを算出 |
| 楽天価格 | 任意で自動 | 公式API設定時、品番一致商品を抽出 |
| モノタロウ | 1タップ | 品番入力済み検索画面を開く |
| eBay・Payoneer費用 | 自動概算 | 料率区分、固定料、海外決済、消費税、出金費を分離 |
| 米国関税 | 自動仮計算 | 原産国に応じた保守的シナリオ |
| 利益判定 | 自動 | 利益、利益率、需要、競合、販売精度、確認状態を統合 |

有料API、生成AI API、OCR、外部データベースは使用しません。

## 販売数のロジック

Browse APIは現行出品を取得するAPIであり、過去90日の成約履歴を直接返しません。そのため本ツールは、同一品番出品の`estimatedSoldQuantity`を毎日保存します。

```text
観測販売増分 = 今回のestimatedSoldQuantity − 前回値
```

減少は再出品やリセットの可能性があるため、マイナス販売として扱いません。正の増分だけを集計します。

### 絶対にしない計算

```text
掲載開始からの累計販売数 ÷ 掲載日数 × 90
```

この計算は観測開始前の販売まで含み、若い出品を過大評価するため、v0.4.0では販売数として使用しません。累計値は画面説明用の「初期累計シグナル」としてのみ保持します。

### 観測期間別の扱い

| 観測期間 | 販売数表示 | 判断への利用 |
|---|---:|---|
| 0〜6日 | 0件・学習中 | 使用しない |
| 7〜13日 | 90日換算＋広い推定幅 | 参考のみ |
| 14〜29日 | 90日換算 | 一次選別 |
| 30日以上 | 90日換算 | 競合精度・カバー率・追跡数も満たせば自動精度・高 |

出品ごとに異なる観測日数を使います。

```text
出品ごとの90日換算 = 観測後の正の販売増分 ÷ その出品の観測日数 × 90
品番の販売ペース = 同一品番の各出品の90日換算を合算
```

30日以上観測して販売増分が0なら、データ不足ではなく「観測上は売れていない」として見送り方向に評価します。

## 競合数

品番検索の`total`には類似品番や適合表記だけの商品が混ざるため、そのまま競合数にはしません。

```text
推定競合数 = 品番検索総件数 × 返却サンプル内の完全品番一致率
```

実際に詳細確認できた一致件数より小さくならないよう補正し、返却数・一致件数・一致率に応じて信頼度を表示します。

## eBay・Payoneer・関税

利益計算では次を別項目として扱います。

- eBay Final Value Feeの段階料率
- 1注文固定料
- International Feeと売上規模別割引
- 出品料
- Promoted Listings
- 追加Final Value Fee
- eBayサービス料に対する日本の消費税
- Payoneer出金率・固定費・年間手数料配賦
- 返品・不良引当
- 仕入、国内送料、国際送料、梱包
- 米国関税のスクリーニング仮計算

Payoneerの実料率は契約・通貨・出金方法で変わるため、初期値3%を実アカウント表示へ1回だけ合わせます。年間アカウント手数料もeBay売上から自動推測せず、実際のPayoneer画面で対象の場合だけONにします。

eBay International Feeの売上規模別割引は、前月20日時点でBelow Standard等の対象外条件に該当する場合、設定画面でOFFにして1.35%へ戻します。

関税はHTSUS、原産国、現行追加措置、DDP条件で変わるため、確定税率とは表示しません。初期スクリーニングは日本原産15%、米国原産0%、不明25%です。最終候補は原産国・HTSUS・DDP見積の確認後に購入候補へ進みます。

## iPhoneで使う

1. GitHub Pages URLをSafariで開く
2. 共有ボタン → `ホーム画面に追加`
3. `Part Scout`を開く
4. `1 今日やる`の指示だけ処理

通常は`3 任意補正`を開く必要はありません。

## ローカル検証

```bash
python -m pip install -r requirements.txt
python -m pytest -q
node tests/web_core.test.cjs
python -m py_compile scripts/core.py scripts/research.py
node --check web/app-01.js
node --check web/app-02.js
node --check web/app-03.js
```

## データと秘密情報

- ProductionキーはGitHub Secretsだけに保存
- トークンは成果物へ保存しない
- 仕入価格などの手動修正はiPhoneのlocalStorageへ保存
- CSV任意補正もGitHubへ送信しない
- 自動保存対象は公開eBayデータの集計値、販売差分、監視品番、診断ステータス

## 参考となる公式資料

- eBay Buy APIs Requirements: `https://developer.ebay.com/api-docs/buy/static/buy-requirements.html`
- Browse API: `https://developer.ebay.com/api-docs/buy/api-browse.html`
- Developer Analytics API: `https://developer.ebay.com/develop/api/buy/developer_analytics_api`
