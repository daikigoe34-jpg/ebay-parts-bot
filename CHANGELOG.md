# CHANGELOG

## 2026-04-06

- Finding API → Browse API に切り替え（Finding APIがレート制限で使用不可のため）
- OAuth 2.0 Client Credentials Grant によるトークン取得・キャッシュ機能追加
- 価格フィルタ追加（$10〜$800）: 非現実的な高額商品を除外
- レート制限対策: キーワード間2秒間隔 + 指数バックオフリトライ（最大3回）
- Finding APIレート制限チェックスクリプト追加（scripts/check_finding_api.py）
- テスト追加: 価格フィルタ範囲、Browse API URL存在チェック（計38テスト）

## 2026-04-05

- 初版リリース
- eBay Browse API による日本車純正部品検索
- SpeedPAK Economy送料テーブル（US/US_REMOTE/UK/DE/AU）
- FVF + International Fee + Payoneer FX + DDP関税の正確な利益計算
- CLI（--demo, --dryrun, --cost, --weight, --country）
- CSV出力（BOM付きUTF-8）+ コンソール表示
- 38件のユニットテスト
