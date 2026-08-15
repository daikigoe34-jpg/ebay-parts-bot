# Security Policy

## APIキー

`EBAY_CLIENT_ID`と`EBAY_CLIENT_SECRET`はGitHub Repository Secretsだけへ保存してください。

禁止事項：

- ソースコードへ直接記載
- `web/`配下へ記載
- Issue、Pull Request、README、スクリーンショットへ掲載
- iPhoneのLocal Storageへ保存

楽天APIを使う場合も`RAKUTEN_APPLICATION_ID`と`RAKUTEN_ACCESS_KEY`をRepository Secretsへ保存します。

## フロントエンド

GitHub Pagesへ配信するHTML・JavaScriptにはeBay Secretを含めません。eBay API通信はGitHub Actions内のPythonだけが行い、公開画面は生成済みJSONを読み取ります。

## 失敗時の保護

次の場合、既存の調査結果を消しません。

- Secret未登録
- OAuth失敗
- Browse API Production権限不足
- API上限
- 一時的な通信障害

接続状態は`web/data/setup_status.json`へ、秘密情報を含めず保存します。

## API利用量

1回の自動実行へ安全上限を設定し、OAuth、検索、商品詳細、再試行をすべて数えます。安全上限に達した場合は部分結果を保存し、次回へ継続します。

## 国内EC

モノタロウ等へ無断の自動スクレイピングを行いません。品番入力済み検索リンクを使い、利用者が最終候補だけ確認します。

## 利益・関税

料金、税、関税、送料は一次判定です。最終仕入れ前に公式料金、HTSUS、原産国証明、DDP見積を確認してください。
