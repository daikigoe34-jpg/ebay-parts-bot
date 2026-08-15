# iPhone初回設定

## 1. Productionキー

GitHubで以下を登録します。

`Settings` → `Secrets and variables` → `Actions`

- `EBAY_CLIENT_ID`：Production App ID
- `EBAY_CLIENT_SECRET`：Production Cert ID

## 2. Pages

`Settings` → `Pages` → `Source: GitHub Actions`

## 3. 初回実行

`Actions` → `eBay自動リサーチ` → `Run workflow`

検索語は空欄で構いません。

## 4. 状態を確認

公開画面上部に次のいずれかが表示されます。

- 接続済み：完了
- キー未登録：Secretsへ登録
- 認証失敗：App IDとCert IDを修正
- Browse権限待ち：eBayのBuy API Production利用条件を確認
- 一時エラー：再実行
- 安全停止：操作不要。次回自動継続

## 5. ホーム画面へ追加

1. Pages URLをSafariで開く
2. 共有
3. ホーム画面に追加
4. `Part Scout`を開く

## 日常操作

1. `今日やる`を開く
2. 黄色の指示が「操作不要」なら閉じる
3. 価格確認の指示が出た最終候補だけ楽天・モノタロウを開く
4. 仕入価格・在庫・送料を確認
5. 原産国・DDP関税を確認
6. `購入候補`だけ仕入判断

`観測状況`は見るだけで、入力欄はありません。
