# Security

## 秘密情報

次の値はGitHub ActionsのRepository Secretsへ登録し、ソースコードへ書かないでください。

- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `RAKUTEN_APPLICATION_ID`（楽天自動価格を使う場合）
- `RAKUTEN_ACCESS_KEY`（楽天自動価格を使う場合）

誤って公開した場合は、各サービスでキーを失効・再発行し、GitHub履歴からも除去してください。

## 公開されるデータ

このリポジトリとGitHub Pagesが公開の場合、次は第三者から閲覧できます。

- ソースコード
- 検索語と監視品番
- eBay公開出品から得た市場集計
- `web/data/results.json`
- `state/snapshots.json`
- `state/watchlist.json`
- `state/research_state.json`
- 楽天APIから得た公開商品名・価格・URL

個人情報、購入履歴、eBayログイン情報は保存しません。

## iPhone内だけに保存するデータ

次はSafariのlocalStorageへ保存し、通常はGitHubへ送信しません。

- 手動修正した仕入価格
- 国内・国際送料
- 梱包費、通関固定費
- 原産国・関税確認状態
- Payoneer率と手数料設定
- Product Researchの手入力／CSV補正
- 利益判定設定

Safariのサイトデータ削除、端末変更、プライベートブラウズ等で失われる可能性があります。必要な一覧はCSVで保存してください。

## 外部サービス

- eBayはApplication Tokenで公開Browse APIを読み取ります。User TokenやSeller HubのCookieは使用しません。
- 楽天は公式商品検索APIだけを使用します。
- モノタロウは品番入力済み検索URLを開くだけで、ログイン情報、Cookie、購入情報を読み取りません。
- ECBの公開為替レートを読み取ります。
- 自動購入、自動発注、自動出品、自動価格変更は行いません。

## 判定上の安全策

- 7日未満の販売差分を90日へ拡大しません。
- 観測開始前の累計販売数量を販売実績として計上しません。
- 競合検索総数をそのまま同一品番の競合数にしません。
- 30日以上の差分だけでなく、市場カバーと追跡出品数も満たす場合だけ「自動精度・高」にします。
- 原産国不明は低い税率へ決め打ちせず、25%の保守的な仮計算にします。
- 仕入条件と原産国・関税の確認前は、最終の`購入候補`にしません。

## GitHub設定

第三者へ公開する場合は、Secret scanning、Dependabot alerts、Actionsの最小権限を有効にしてください。ワークフローの書込み権限は、調査JSONと学習状態を`main`へ保存する用途だけに使用します。
