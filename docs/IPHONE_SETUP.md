# iPhone初回設定

## 1. Productionキー

GitHubで以下を登録します。

`Settings` → `Secrets and variables` → `Actions`

- `EBAY_CLIENT_ID`：Production App ID
- `EBAY_CLIENT_SECRET`：Production Cert ID

[このリポジトリのSecrets設定](https://github.com/daikigoe34-jpg/ebay-parts-bot/settings/secrets/actions)で登録します。

## 2. Pages

`Settings` → `Pages` → `Source: GitHub Actions`

[Pages設定を開く](https://github.com/daikigoe34-jpg/ebay-parts-bot/settings/pages)

## 3. 初回実行

`Actions` → `eBay自動リサーチ` → `Run workflow`

検索語は空欄で構いません。

[リサーチ実行画面](https://github.com/daikigoe34-jpg/ebay-parts-bot/actions/workflows/research.yml)。調査後は公開処理も自動実行します。

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
5. 原産国・10桁HTSUS・DDP関税実見積額を入力し、確認にチェック
6. `購入候補`だけ仕入判断

`観測状況`は見るだけで、入力欄はありません。

初回は「設定」で実際のeBay・Payoneer手数料を確認します。仕入条件・関税の確認は7日で外れます。期限切れや価格変更時だけ再確認してください。

## 途中で閉じたとき

入力はその場で保存され、同じ端末・同じブラウザで再開できます。日常はホーム画面のPart Scoutを使ってください。保存エラーが出た場合は「設定 → バックアップ」でJSONを保存します。

一度正常な調査結果を読み込めば、圏外でも前回データを表示します。保存済み・更新待ちの間は購入候補判定を止めます。通信復帰後は自動で更新します。

端末変更・ブラウザデータ削除の前にもJSONバックアップを保存し、変更先で「復元」します。ブラウザ保存を消去した場合の完全自動復元や端末間同期はありません。
