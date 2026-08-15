# Part Scout Mobile v0.4.1 テスト報告

## 自動テスト

- Python：30件合格
- JavaScriptロジック：合格
- Python構文：合格
- JavaScript構文：合格
- JSON：合格
- GitHub Actions YAML：合格

## 重点確認

- 観測前の累計販売数を90日販売数へ使用しない
- 観測7日未満は0件・学習中
- 7日以上は正の差分だけを換算
- 再出品等による販売数減少をマイナス販売にしない
- 終了出品の観測差分を保持
- 30日以上の観測ゼロを見送り方向へ評価
- Productionキー未登録とキー不一致を分離
- OAuth成功後のBrowse 403を本番権限不足として分類
- API障害時も既存候補を消さない
- 全探索失敗・全品番検索失敗時は監視履歴と販売差分も更新しない
- 成功した0件検索と、障害による0件を区別する
- Developer Analyticsの権限不足をBrowse本番権限不足と誤分類しない
- 一部成功時は候補を保存し、失敗分だけ自動再試行する
- 監視品番を90日保持し、期限切れだけ削除
- eBay、Payoneer、消費税、広告、出品料、関税を分離計算
- v0.4.1をiPhone相当390×844で実ブラウザ検証し、横はみ出し・JavaScriptエラーなし
- 4画面構造、初回設定、接続済み、Browse本番権限なしの各表示を確認
- International Fee割引OFFとPayoneer年会費OFFの端末内保存を確認
- 長い再試行表示へ`max-width`・折返しを追加
- 後続の再実行は実行環境のlocalhost管理ポリシーで拒否されたが、成功済みレポートを`docs/BROWSER_TEST_REPORT.json`へ保存
- API未設定時はサンプル表示と明示し、販売学習を「開始前」と表示

## 未実施の外部確認

実Production API通信は利用者のGitHub SecretsとeBay側Browse Production権限に依存します。初回Actions実行で自動診断し、結果をiPhone画面へ表示します。

## iPhone実ブラウザ

- 390×844pxで横方向のはみ出しなし
- `1 今日やる`→`2 全候補`→`3 任意補正`→`4 設定`の切替成功
- Productionキー未登録、接続済み、Browse本番権限なしの案内を確認
- International Fee割引OFFとPayoneer年会費OFFの保存を確認
- JavaScript例外・コンソールエラーなし

詳細：`docs/BROWSER_TEST_REPORT.json`

## 料金ロジック追加確認

- International Feeの割引対象外時は1.35%へ戻る
- Payoneer年会費は実アカウントに応じた明示ON／OFF
- eBay売上からPayoneer年会費適用可否を推測しない
