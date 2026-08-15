# Security

## eBayキー

- `EBAY_CLIENT_ID`と`EBAY_CLIENT_SECRET`はGitHub ActionsのRepository Secretsへ登録します。
- Client Secret、Application Token、User Tokenをソースコードへ書かないでください。
- 誤って公開した場合は、eBay Developer Portalでキーを再発行し、GitHubのコミット履歴からも除去してください。

## 公開されるもの

GitHub Pagesは公開サイトです。公開リポジトリを使う場合、次は第三者から閲覧可能です。

- ソースコード
- ランダム検索条件
- API調査結果 `web/data/results.json`
- 日次販売数量スナップショット `state/snapshots.json`

## GitHubへ送られないもの

次はSafariのlocalStorageに保存され、通常はGitHubへ送信されません。

- モノタロウ／楽天の仕入価格
- 国内・国際送料
- 梱包費、固定通関費
- DDP関税の確認状態
- 利益設定
- Product Researchの手入力補正
- 取り込んだCSVの集計結果

ただし、Safariのサイトデータ削除・端末変更・閲覧履歴消去等で失われる可能性があります。必要な一覧はCSV保存してください。

## 外部サイト

- モノタロウ、楽天、eBayへは検索リンクで移動するだけです。
- ログイン情報、Cookie、購入情報を読み取りません。
- 自動発注、自動購入、自動出品は行いません。

## 脆弱性

第三者へ公開する前に、GitHubのSecret scanningとDependabot alertsを有効にすることを推奨します。

## 判定上の安全策

- Browse API推定だけでは最終の`販売候補`にしません。
- Product Researchの90日実績とDDP関税実見積の両方を確認した場合だけ`販売候補`にします。
- キーワード検索の総件数は、そのまま同一品番の競合数として扱いません。
