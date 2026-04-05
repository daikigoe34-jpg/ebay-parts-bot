# eBay 日本車パーツ輸出リサーチBot 計画書

## プロジェクト概要
日本の自動車純正部品をeBayで海外販売するための「売れ筋リサーチBot」を構築する。
まずはリスト作成の自動化から始め、段階的に出品自動化へ拡張する。

## 自分のレベル
- プログラミング初心者（Python基礎レベル）
- 金融・貿易初心者
- MacBook使用
- Claude Codeでコード生成

## Phase 1: 売れ筋リサーチBot（今回のスコープ）

### 目的
eBayで「日本車の純正部品」が実際にいくらで売れているかを調べ、
モノタロウ等で仕入れた場合の利益シミュレーションを一覧で出力する。

### 検索キーワード例
- "genuine Nissan Japan"
- "OEM Toyota Japan"
- "genuine Honda Japan JDM"
- "Mazda genuine parts Japan"
- "Subaru OEM Japan"
- "純正" (日本語キーワードも試す)

### 使用API
- **eBay Browse API** (買い物検索・売れ筋確認)
  - エンドポイント: `https://api.ebay.com/buy/browse/v1/item_summary/search`
  - 認証: OAuth 2.0 Client Credentials (Application token)
  - 必要な情報: sold items, price, shipping, seller location
  - 参考: https://developer.ebay.com/api-docs/buy/browse/overview.html

- **eBay Finding API** (完了したオークション検索 - sold items)
  - エンドポイント: `https://svcs.ebay.com/services/search/FindingService/v1`
  - `findCompletedItems` operation で実際に売れた商品を検索可能
  - 参考: https://developer.ebay.com/devzone/finding/concepts/FindingAPIGuide.html

### 利益計算ロジック

```
売上 = eBay販売価格（USD → JPY換算）
コスト:
  - 仕入原価: モノタロウ購入価格（想定 ¥2,000前後）
  - eBay手数料: 販売価格の約13%（FVF + payment processing）
  - PayPal/決済手数料: 含まれる（Managed Payments）
  - 国際送料: 重量・サイズによる（EMS/eパケット/FedEx）
    - 小型部品500g以下: 約¥1,500〜¥2,500（eパケット）
    - 中型部品1kg: 約¥2,500〜¥4,000（EMS）
    - 大型部品2kg+: 約¥4,000〜¥8,000
  - 梱包材: 約¥200〜¥500
  - 関税（輸入国側）: 通常は買い手負担（DAP条件）
  
利益 = 売上 - 仕入原価 - eBay手数料 - 国際送料 - 梱包材
利益率 = 利益 / 売上 × 100
```

### 出力フォーマット（CSV / コンソール）
| 商品名 | eBay販売価格(USD) | 販売価格(JPY) | 仕入想定(JPY) | 送料想定(JPY) | eBay手数料(JPY) | 利益(JPY) | 利益率(%) | eBay URL | 直近販売数 |

### フォルダ構成
```
ebay-parts-bot/
├── README.md
├── .env                  # API keys (gitignore対象)
├── .env.example          # テンプレート
├── requirements.txt
├── src/
│   ├── __init__.py
│   ├── ebay_client.py    # eBay API認証・検索
│   ├── calculator.py     # 利益計算ロジック
│   ├── config.py         # 設定値（手数料率、送料テーブル等）
│   └── main.py           # メイン実行スクリプト
├── output/
│   └── (CSV出力先)
└── docs/
    └── ebay-parts-bot-plan.md  # この計画書
```

## 事前準備（自分でやること）
1. [x] eBay開発者アカウント作成: https://developer.ebay.com/
2. [ ] eBay API キー取得（Sandbox → Production）
   - Application ID (Client ID)
   - Cert ID (Client Secret)
3. [ ] eBayセラーアカウント作成（将来の出品用）
4. [ ] モノタロウアカウント（仕入先確認用）

## Phase 2以降（将来）
- Phase 2: モノタロウ価格の自動取得（スクレイピング or 手動CSV）
- Phase 3: 自動出品Bot（eBay Trading API / Inventory API）
- Phase 4: 在庫管理・注文通知
- Phase 5: 価格自動調整

## 技術メモ
- 言語: Python 3.11+
- 主要ライブラリ: requests, python-dotenv, pandas
- 為替レート: 外部API（例: exchangerate-api.com）またはハードコード
- eBay APIのレート制限に注意（1日5,000コール目安）
