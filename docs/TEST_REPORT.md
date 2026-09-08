# Part Scout Mobile v0.4.1 テストレポート

実施日：2026-09-08

## 結果

- Python：36件合格
- JavaScript：既存3スイート、新規20件合格
- Python／JavaScript構文、GitHub Actions YAML、JSON、変更差分の空白検証：合格
- 実HTMLとJavaScriptをDOMエミュレーターで起動し、オンライン／保存済みオフライン復元：合格
- 別担当レビューで見つかった売価固定・旧キャッシュ消失を修正し、関連箇所の再レビューで阻害事項なし

## 今回の回帰検証

| 項目 | 検証内容 |
|---|---|
| 保存 | 入力直後・描画待ち時間前に保存、再起動、破損時の直前版復旧、容量不足、バックアップの検証後復元 |
| オフライン | HTTP 503・通信断で最終データへ復帰、キャッシュ書込失敗でも正常な通信結果を保持 |
| アプリ更新 | v8の調査データを移行、容量不足時に旧データを保持、新しいデータを古いキャッシュで上書きしない |
| 利益 | 手計算との一致、空欄・負数・非数値・未確認手数料・古い為替で購入判定を止める |
| 関税 | 実見積が概算を置換、HTSUS等の未確認・確認期限切れを検知、販売相場変更時に再確認 |
| 相場 | 仕入・関税の確認をしても次回の自動売価更新を保持 |
| 販売推定 | 欠測を0にしない、累計リセット後の回復を架空の販売増分として数えない |
| 取得データ | 非USD価格、国名の誤部分一致、破損履歴、不正レスポンスを処理 |

## 確認できていない運用条件

- 最新の保存済み接続状態は `missing_secrets`、`ready: false`（2026-09-07T23:30:54Z）。処理の成功表示は実API接続成功を意味しない。
- 公開予定URLは確認時HTTP 404。既存Pages実行も初回未設定による公開スキップ。所有者のPages初期設定が必要。
- eBay Production OAuth／Browse実接続、楽天実接続、実DDP見積による商品別計算は未確認。
- iPhone実機・Safari・ホーム画面アプリの操作確認は今回未実施。DOM起動確認は実機検証ではない。
- OS／ブラウザの保存領域消去を含む絶対的なデータ保持や端末間自動同期は保証しない。入力と設定はJSONバックアップで移行できる。
- 米国関税の根拠と適用条件は[別紙](TARIFF_REVIEW_2026-09-08.md)。すべての部品の税率を自動確定する機能はない。

## 再現コマンド

```bash
python -m pip install -r requirements.txt
python -m pytest -q
node tests/web_core.test.cjs
node tests/sw_core.test.cjs
node tests/data_freshness.test.cjs
node --test tests/accuracy_regression.test.cjs tests/persistence.test.cjs tests/sw_offline.test.cjs
python -m py_compile scripts/core.py scripts/research.py
node --check web/app.js
node --check web/sw.js
node --check web/persistence.js
git diff --check
```

今回の一時環境では依存パッケージを `/tmp/part-scout-deps` に入れ、Pythonテストに `PYTHONPATH` を指定した。通常のCIは上記の標準インストールで実行する。

## 参考資料

- [GitHub：GITHUB_TOKENによるpushのワークフロー起動制限](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub：公開リポジトリの標準ランナー料金](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [MDN：ブラウザ保存領域と消去](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [eBay：International Feeと割引条件](https://export.ebay.com/en/fees-regulations-policies/seller-fees/international-fees/)
- [Payoneer：料金](https://www.payoneer.com/pricing/)

---

# v0.4.0の検証記録（履歴）

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
