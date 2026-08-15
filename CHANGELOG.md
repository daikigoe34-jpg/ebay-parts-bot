# Changelog

## 0.4.1 — 2026-08-15

### 障害時のデータ保護

- 候補探索が全件失敗した場合、前回候補を保持して次回へ自動再試行
- 同一品番検索が全件失敗した場合も、候補・監視リスト・販売差分を上書きしない
- 一部成功時は取得済み候補を保存し、`partial_success`として失敗分を再試行
- 成功した空検索とAPI障害による空結果を区別
- 成功した実データへ`data_status: real`を明示

### 診断精度

- Developer Analyticsの403を`analytics_unavailable`として分離
- 任意の利用上限APIが使えなくてもBrowse本番権限は正常表示
- UIへ`前回結果保持・自動再試行`と表示し、不要な人操作を求めない

### 料金設定の誤推定防止

- Below Standard等でInternational Feeの売上割引を受けられない場合、割引をOFFにして1.35%で計算
- Payoneer年間アカウント手数料の適用可否をeBay売上から推測せず、実アカウントに合わせてON／OFF
- Payoneer出金率・固定費・年間手数料配賦をそれぞれ独立設定

### 検証

- Python 30件
- JavaScriptロジックテスト
- 一時障害時の候補保持、成功した空検索、Analytics権限分離を追加検証

## 0.4.0 — 2026-08-15

### Production API専用化

- Production App ID／Cert IDのClient Credentials構成へ固定
- 制限API依存をコード、ワークフロー、UI、デモデータ、テスト、説明から撤去
- `missing_credentials`、`invalid_credentials`、`browse_not_approved`、`rate_limited`、`temporary_error`、`ready`を自動分類
- 診断失敗時も既存候補を消さず、ステータスだけ更新
- Developer Analyticsが使える場合はBrowse残量を表示

### 販売推定

- 観測前累計販売数からの90日換算を廃止
- 7日未満は販売数0・学習中
- 7日以上の正の差分だけを出品ごとに90日換算
- 売切れ・終了出品の観測差分を保持
- 30日以上の観測ゼロを低需要データとして扱う
- 最大60品番を90日保持し、順位落ちによる学習中断を防止

### UI

- Productionキー、OAuth、Browse本番権限、差分学習を4項目で表示
- Browse 403を「キー不一致」ではなく「本番権限なし」と表示
- 初回設定・申請・自動再試行の次操作を1つだけ表示
- Product Researchを`任意補正`へ変更
- 学習中は仕入価格入力より先に「操作不要」と案内

### 検証

- Python 26件
- JavaScriptロジックテスト
- Python／JavaScript／JSON／YAML構文
- 7日未満の過大換算防止
- Browse権限とキー不一致の分類
- 監視品番の保持・期限切れ削除

## 0.3.1

- eBay料金・Payoneer・関税の分離計算
- 日次差分推定と順番操作UI
