# Part Scout Mobile v0.4.0 テストレポート

実施日：2026-08-15

## 自動テスト

- Python：26件合格
- JavaScriptロジック：合格
- Python構文：合格
- JavaScript構文：合格
- JSON：合格
- GitHub Actions YAML：合格

## 主な検証項目

### Production接続

- APIコール安全上限
- OAuth失敗とBrowse 403の分類
- Secret未登録時の既存結果保持
- 接続状態JSONの画面表示

### 販売推定

- 30日差分の90日換算
- 7日未満の外挿禁止
- 終了出品の増分保持
- 出品ごとの異なる観測期間
- 累計販売数250個でも観測差分なしなら判定0
- 信頼区間下限を購入判定へ使用

### 利益

- eBay段階料率
- 注文固定料
- 海外決済手数料
- 日本の消費税
- Payoneer費用の分離
- 関税一次概算
- 仕入・送料・確認状態による判定変更

### iPhone UI

- 初回設定の次アクション表示
- 今日やるの1アクション表示
- 全候補の並べ替え
- 観測進捗表示
- 設定保存
- CSV出力

## 未検証となる外部条件

実アカウント固有の以下は、本人のProductionキー登録後にGitHub Actionsで確認します。

- eBay Production OAuth
- Browse API Production利用権限
- 実APIレスポンスのItem Specifics
- 実際のAPI残量
- 楽天API設定時の実商品価格

接続失敗時もUIが原因と次の操作を表示するため、ログを手作業で読む必要はありません。
