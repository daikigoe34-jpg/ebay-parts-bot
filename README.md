# eBay 日本車パーツ 売れ筋リサーチBot

eBayで日本の自動車純正部品がいくらで売れているかを調べ、正確な手数料体系に基づいた利益シミュレーションを出力するCLIツール。

## クイックスタート（初めての人向け）

```bash
# 1. 依存パッケージをインストール
pip install -r requirements.txt

# 2. まずデモモードで動作確認（APIキー不要）
python -m src.main --demo

# 3. 計算ステップの詳細を確認
python -m src.main --dryrun
```

## セットアップ（本番API使用時）

```bash
# 環境変数ファイルを作成
cp .env.example .env
# .env を開いて EBAY_APP_ID と EBAY_CERT_ID を入力

# 本番実行
python -m src.main
```

## 使い方

```bash
# デモモード（APIキーなしで動作確認）
python -m src.main --demo

# ドライランモード（1商品分の計算ステップを詳細表示）
python -m src.main --dryrun

# 仕入原価を指定（デフォルト: ¥2,000）
python -m src.main --demo --cost 1500

# 商品重量を指定（デフォルト: 500g）
python -m src.main --demo --weight 1000

# 宛先国を変更（デフォルト: us）
python -m src.main --demo --country uk    # イギリス（関税なし）
python -m src.main --demo --country de    # ドイツ
python -m src.main --demo --country au    # オーストラリア

# ヘルプ
python -m src.main --help
```

## 手数料体系

```
【eBay側で天引き（USDベース）】
  FVF落札手数料:   販売価格 × 13.25% + $0.40
  海外決済手数料:   販売価格 × 1.35%
  → 合計 ≒ 14.6% + $0.40

【Payoneer引き出し（USD→JPY変換時）】
  為替手数料:       仲値の2%（実効レート = 仲値 × 0.98）

【DDP関税（アメリカ宛のみ・自動車部品）】
  関税率:           販売価格 × 15%
  ※イギリス/ドイツ/オーストラリアは買い手負担（セラー負担0%）

【固定コスト】
  梱包材:           ¥300
  国内送料:         ¥0（郵便局/ローソン持ち込み）
```

### 手数料率の変更方法

`src/config.py` を編集して、以下のパラメータを変更してください:

| パラメータ | デフォルト | 説明 |
|-----------|-----------|------|
| `FVF_RATE` | 0.1325 | FVF率（Basic Store: 0.1235に変更） |
| `INTERNATIONAL_FEE_RATE` | 0.0135 | 海外決済手数料率 |
| `DDP_TARIFF_RATE` | 0.15 | DDP関税率（※流動的） |
| `PAYONEER_FX_MARKUP` | 0.02 | Payoneer為替手数料率 |
| `USD_TO_JPY` | 150.0 | 為替レート（仲値） |

### 関税率の更新

関税率は頻繁に変わります。最新情報は以下で確認:
- https://ebay.co.jp/tariffs

変更時は `config.py` の `DDP_TARIFF_RATE` を更新してください。

### SpeedPAK送料テーブルの更新

1. SpeedPAKセラーポータルから最新の料金表をダウンロード
2. `config.py` の `SPEEDPAK_TABLE_US` 等を更新

## 出力

- **コンソール**: 利益がプラスの商品を表形式で表示 + サマリー + TOP5
- **CSV**: `output/` フォルダに全商品の結果を出力（Excel対応BOM付きUTF-8）
- **ログ**: `output/bot.log` に詳細ログを記録

## API について

- **Browse API** を使用（OAuth 2.0 Client Credentials Grant）
- 価格フィルタ: $10〜$800（送料負け・仕入れリスクを除外）
- レート制限対策: キーワード間2秒間隔 + 指数バックオフリトライ（最大3回）

## テスト

```bash
pytest -v
```

## ファイル構成

```
ebay_bot/
├── README.md
├── .env.example          # APIキーのテンプレート
├── .gitignore
├── requirements.txt
├── src/
│   ├── config.py         # 全パラメータ一元管理
│   ├── ebay_client.py    # eBay API接続・検索
│   ├── shipping.py       # SpeedPAK Economy送料計算
│   ├── calculator.py     # 利益計算（正確な手数料体系）
│   ├── main.py           # メイン実行（CLI）
│   └── logger.py         # ログ設定
├── tests/                # ユニットテスト
├── output/               # CSV・ログ出力先
└── docs/                 # 計画書
```
