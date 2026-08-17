# Security Policy

## APIキー

`EBAY_CLIENT_ID`と`EBAY_CLIENT_SECRET`はGitHub Repository Secretsだけへ保存してください。

禁止事項：

- ソースコードへ直接記載
- `web/`配下へ記載
- Issue、Pull Request、README、スクリーンショットへ掲載
- iPhoneのLocal Storageへ保存

楽天APIを使う場合も`RAKUTEN_APPLICATION_ID`と`RAKUTEN_ACCESS_KEY`をRepository Secretsへ保存します。

GitHub Actionsでは、これらの秘密値を**実API調査ステップだけ**へ渡します。依存関係インストール、テスト、構文検証、Git保存処理へは渡しません。

## GitHub Actions

- 外部Actionは可変タグではなく、検証済みの完全なcommit SHAへ固定します。
- 検証CIは`contents: read`のみとし、checkout資格情報を永続化しません。
- 日次調査Workflowは結果保存のため`contents: write`を必要としますが、checkout資格情報は永続化せず、`github.token`を最終保存ステップだけへ渡します。
- Python依存関係は`requirements.txt`でバージョン固定し、意図しない自動更新を避けます。

## フロントエンド

GitHub Pagesへ配信するHTML・JavaScriptにはeBay Secretを含めません。eBay API通信はGitHub Actions内のPythonだけが行い、公開画面は生成済みJSONを読み取ります。

外部APIから取得したURLは信頼済みとは扱いません。ブラウザから開くURLはHTTPSかつ許可ドメイン（eBay/Rakuten）だけを通し、それ以外は固定の検索URLへフォールバックします。

`web/data/results.json`に同梱されるデモデータはProduction接続状態に関係なく仕入判定へ使いません。Production APIが接続済みで、かつ実データと判定できる場合だけ商品候補を表示します。

## PWAキャッシュ

`results.json`と`setup_status.json`はnetwork-firstで取得します。キャッシュバスターのクエリ文字列はキャッシュキーから除去し、同じデータファイルが無制限にキャッシュ増殖しないようにします。オフライン時だけ直近の安定キーをフォールバックとして使います。

## 失敗時の保護

次の場合、リポジトリ上の既存調査結果ファイル自体は消しません。

- Secret未登録
- OAuth失敗
- Browse API Production権限不足
- API上限
- 一時的な通信障害

ただし、Production接続が確認できない状態ではフロントエンドから仕入候補として表示しません。接続状態は`web/data/setup_status.json`へ、秘密情報を含めず保存します。

## API利用量

1回の自動実行へ安全上限を設定し、OAuth、検索、商品詳細、再試行をすべて数えます。安全上限に達した場合は部分結果を保存し、次回へ継続します。

## 国内EC

モノタロウ等へ無断の自動スクレイピングを行いません。品番入力済み検索リンクを使い、利用者が最終候補だけ確認します。

## 利益・関税

料金、税、関税、送料は一次判定です。最終仕入れ前に公式料金、HTSUS、原産国証明、DDP見積を確認してください。仕入れ・購入などの不可逆操作は自動化しません。
