# Part Scout Mobile v0.4.0

**eBay Production Browse APIだけで、日本車純正部品を自動探索し、iPhoneで仕入候補を上から処理するPWA**です。

GitHub Actionsが毎日、検索語のローテーション、純正品番抽出、同一品番の競合・出品相場調査、販売増分の継続観測、為替、国内仕入候補、手数料、関税一次概算、利益判定まで実行します。

## 重要な前提

- 使用するeBay認証情報はProduction App IDとProduction Cert IDです。
- Productionキーを持っていても、Buy/Browse APIのProduction利用権限が別途必要な場合があります。
- 標準のBrowse APIは、過去90日の成約履歴を直接返しません。
- 本アプリは`estimatedSoldQuantity`を毎日保存し、**観測開始後の正の増分だけ**で販売ペースを学習します。
- 出品に表示される過去の累計販売数は参考表示に残しても、仕入判定には使いません。
- 有料API、生成AI API、OCR、スクレイピング基盤は使用しません。

公式要件：

- https://developer.ebay.com/api-docs/buy/static/buy-requirements.html
- https://developer.ebay.com/api-docs/buy/browse/overview.html

## v0.4.0で直したこと

- 制限APIへの依存と関連コードを削除
- Production OAuthとBrowse APIを初回実行時に個別診断
- 「キー未登録」「キー誤り」「Browse本番権限不足」「一時エラー」を別表示
- 接続できなくても既存結果を壊さず、iPhone画面へ次の操作を表示
- 1実行3,500コールの安全上限を設定し、再試行もカウント
- 7日未満の観測を90日へ外挿しない
- 累計販売数が大きくても、観測差分がなければ販売判定を0にする
- ランキングと購入判定に点推定ではなく保守的な信頼区間下限を使用
- 販売数のCSV・手入力を日常画面から削除
- UIを`初回接続 → 今日やる → 全候補 → 観測状況 → 設定`へ整理
- 観測中は人へ仕入調査を要求せず「操作不要」と表示

## 自動化範囲

| 処理 | 状態 | 内容 |
|---|---|---|
| Production OAuth診断 | 自動 | App IDとCert IDの組み合わせを確認 |
| Browse API権限診断 | 自動 | OAuth成功後、検索APIを1回実行して権限を判定 |
| eBay候補探索 | 自動 | 日本車メーカー、純正語、小型部品語を順番に巡回 |
| 純正品番抽出 | 自動 | Item Specifics優先、タイトルを補助利用 |
| 同一品番市場調査 | 自動 | 競合数、セラー数、出品価格中央値、価格帯を集計 |
| 販売ペース | 自動学習 | 日次の`estimatedSoldQuantity`増分だけを記録 |
| 終了・売切れ出品 | 自動 | 観測履歴に残し、確認済みの増分を失わない |
| 為替 | 自動 | ECB公開レートからUSD/JPYを更新 |
| 楽天価格 | 任意自動 | 楽天公式APIキー登録時に品番一致を取得 |
| モノタロウ | 1タップ | 品番入力済み検索を開く |
| 国際送料 | 自動概算 | 商品名から小型プロファイルを選択。最終確認は必要 |
| eBay手数料 | 自動 | プラン、カテゴリ、売上総額、海外決済料等を計算 |
| Payoneer | 自動概算 | 出金率、固定費、年間費用配賦を別計算 |
| 米国関税 | 一次概算 | 原産国別の保守値。HTSUS・DDP実見積は最終候補のみ確認 |
| 利益判定 | 自動 | 販売下限、競合、利益、利益率、確認状態を総合判定 |

## 初回設定

### 1. eBay Productionキーを登録

GitHubリポジトリで次を開きます。

`Settings` → `Secrets and variables` → `Actions` → `New repository secret`

| Secret名 | 入れる値 |
|---|---|
| `EBAY_CLIENT_ID` | Production App ID / Client ID |
| `EBAY_CLIENT_SECRET` | Production Cert ID / Client Secret |

キーはJavaScript、README、Issue、チャットへ貼らないでください。

### 2. GitHub Pagesを有効化

`Settings` → `Pages` → `Build and deployment` → `Source: GitHub Actions`

### 3. 初回調査を実行

`Actions` → `eBay自動リサーチ` → `Run workflow`

検索語は空欄で構いません。

実行後、`web/data/setup_status.json`に次のいずれかが保存されます。

| 状態 | 意味 | 次の操作 |
|---|---|---|
| `ready` | OAuth・Browseとも成功 | 操作不要 |
| `missing_secrets` | キー未登録 | 2つのSecretを登録 |
| `auth_failed` | キーの組合せ不正 | Secretを修正 |
| `browse_access_denied` | キーは認証できたがBrowse本番権限なし | eBayのBuy API Production要件を確認 |
| `rate_limited` | eBay側のAPI上限 | 次回実行を待つ |
| `ready_partial` | アプリの安全上限で分割停止 | 操作不要。次回続行 |
| `temporary_error` | 一時障害 | ワークフローを再実行 |

### 4. iPhoneへ追加

1. GitHub Pagesの公開URLをSafariで開く
2. 共有ボタンを押す
3. `ホーム画面に追加`を選択
4. ホーム画面の`Part Scout`を開く

## 日常操作

### 観測が育つまで

`今日やる`に「自動観測中」と出ている間は操作不要です。

### 高信頼候補が出た後

1. `今日やる`の最上部に表示された1件を開く
2. 楽天またはモノタロウで価格・在庫・国内送料を確認
3. 必要な金額だけ修正
4. 仕入条件確認済みにチェック
5. 原産国・HTSUS・DDP関税を確認
6. 関税確認済みにチェック
7. `購入候補`になった商品だけ仕入判断

人が調べる対象は、高信頼かつ市場基準を通過した最終候補だけです。

## 販売ペースのロジック

### 初回観測

初回に確認できた累計販売数は基準値として保存します。初回以前の販売を90日実績へ加えません。

### 2回目以降

```text
観測販売数 = 今回の累計販売数 - 前回の累計販売数
```

正の増分だけを使います。数量が減った場合はマイナス販売として扱いません。

出品ごとに観測期間が異なるため、各出品を個別に換算して合算します。

```text
出品ごとの90日ペース = 観測期間中の正の増分 ÷ 観測日数 × 90
品番全体の90日ペース = 同一品番の各出品ペースの合計
```

### 仕入判定に使う数値

表示用の点推定ではなく、Poissonモデルによる保守的な信頼区間下限を使います。

- 観測7日未満：判定値0
- 7～13日：低信頼
- 14～29日：中信頼
- 30日以上＋競合精度・市場カバー・追跡数を満たす：高信頼

累計販売数が250個と表示されていても、アプリ観測後の増分が0なら、仕入判定の販売数は0です。

## 競合数

品番検索の総件数には類似品番や適合説明が混ざるため、そのまま競合数にしません。

```text
推定競合数 = 検索総件数 × 返却サンプル内の完全品番一致率
```

実際に詳細確認できた一致件数より小さくならないよう補正し、精度を`高／中／低／不明`で表示します。

## 手数料・関税

利益計算は次を分離しています。

- eBay Final Value Fee
- 注文固定料
- International Fee
- Promoted Listings
- 出品料
- 追加Final Value Fee
- eBay手数料に対する日本の消費税
- Payoneer出金率・固定費・年間費用配賦
- 返品・不良引当
- 仕入、国内送料、国際送料、梱包費
- 関税一次概算、通関固定費

料金や関税は変更されるため設定可能です。関税はスクリーニング用であり、確定値ではありません。

## ファイル構成

```text
.github/workflows/research.yml  毎日の自動調査
.github/workflows/pages.yml     iPhone画面の公開
scripts/research.py             Production API取得・自動診断・集計
scripts/core.py                 品番・統計・利益ロジック
state/snapshots.json            出品ごとの販売差分履歴
state/watchlist.json            継続監視品番
state/research_state.json       検索ローテーション状態
web/data/setup_status.json      初回接続・エラー状態
web/data/results.json           iPhone表示用結果
web/index.html                  順番操作UI
web/app.js                      UI・利益計算
```

## テスト

```bash
python -m pytest -q
node tests/web_core.test.cjs
python -m py_compile scripts/core.py scripts/research.py
node --check web/app.js
node --check web/sw.js
```

## セキュリティ

- API SecretはGitHub Secretsだけに保存します。
- Secretをフロントエンドへ渡しません。
- APIキー未設定・認証失敗時は既存結果を上書きしません。
- APIコール数へ安全上限を設けます。
- 国内ECを無断で巡回するスクレイピングは行いません。
