# 検証結果

検証日：2026-08-15  
対象：Part Scout Mobile 0.2.0

## 合格した確認

- Python単体テスト：12件合格
  - 純正品番抽出
  - 日次差分の90日換算
  - キーワード検索総数を一致率で補正する競合推定
  - 一致ゼロ時に検索総数を競合数として誤採用しない処理
  - eBay段階料率と10USD以下0.30USD固定手数料
  - 関税・売上税込み利益計算
- JavaScript単体テスト：合格
  - 品番抽出
  - CSV解析／取込
  - Product Research手入力
  - Product ResearchとDDP関税確認済み時のみ「販売候補」
  - API推定だけの場合は「仮候補」
  - eBay段階料率と固定手数料
- `app.js`／`sw.js`構文検証：合格
- Python構文検証：合格
- JSON 4ファイルの構文検証：合格
- iPhone相当390×844pxのブラウザ操作テスト：合格
  - デモ候補4件を描画
  - 競合数を「約」で表示
  - 競合精度・サンプルカバー率を表示
  - モノタロウ／楽天／eBayの品番リンクを生成
  - 仕入価格・国際送料・DDP確認状態に応じて再計算
  - 横方向の表示はみ出しなし
  - JavaScript実行エラーなし

## 実通信後に確認する項目

- 利用者のProduction eBay APIキーによる実データ取得
- GitHub Actionsでの日次保存とmainへの自動コミット
- GitHub Pagesへの実公開
- 実機iPhone Safariでのホーム画面追加

秘密鍵は成果物に含めていないため、上記はGitHub SecretsとPages設定後の初回Actions実行で確認します。
