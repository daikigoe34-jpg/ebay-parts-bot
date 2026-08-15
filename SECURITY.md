# Security

## 秘密情報

以下はGitHub Repository Secretsへだけ登録します。

- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `RAKUTEN_APPLICATION_ID`（任意）
- `RAKUTEN_ACCESS_KEY`（任意）

ソース、`results.json`、Actionsログ、ブラウザJavaScriptへ秘密情報を出力しません。OAuth access tokenも保存しません。

## 診断ログ

API障害はHTTP状態、処理段階、短いエラー概要だけを保存します。Authorizationヘッダー、Client Secret、access tokenは保存対象外です。

## ブラウザ内データ

次はiPhone SafariのlocalStorageにだけ保存されます。

- 手動で修正した仕入価格・送料
- Payoneer設定
- 原産国・DDP確認状態
- 任意CSV／手動補正

GitHubへ自動送信しません。Safariのサイトデータ削除で消えます。

## 公開リポジトリ

リポジトリを公開する場合、`web/data/results.json`、`state/snapshots.json`、`state/watchlist.json`には公開eBay出品由来の集計が含まれます。個人のeBay認証情報は含めません。

## 料金・関税

手数料と関税は利益スクリーニング用です。料金改定、契約別Payoneer料率、HTSUS、原産国、Section 232等の現行措置、DDP請求額を販売前に確認してください。
