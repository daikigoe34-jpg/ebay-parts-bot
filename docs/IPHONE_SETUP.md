# iPhoneセットアップ

## 最初の1回

1. GitHub Secretsへ`EBAY_CLIENT_ID`と`EBAY_CLIENT_SECRET`を登録
2. `Settings` → `Pages` → Sourceを`GitHub Actions`
3. `Actions` → `eBay自動リサーチ` → `Run workflow`
4. Pages URLをSafariで開く
5. 共有 → `ホーム画面に追加`

## 画面の見方

上部に次の4項目があります。

1. Productionキー
2. OAuth認証
3. Browse本番権限
4. 販売差分学習

`Browse本番権限：申請必要`と表示された場合、Productionキーは有効です。キーを作り直すのではなく、eBayへBuy/Browse APIのProduction利用申請を行います。

## 日常操作

- `1 今日やる`を開く
- 黄色い「次にすること」だけ処理
- `自動学習中`なら何もしない
- 自動精度・高になった候補だけ仕入価格・在庫・送料を確認
- 最終候補だけ原産国・HTSUS・DDP関税を確認

`3 任意補正`は通常使いません。

## データ保存

仕入価格、送料、Payoneer設定、任意補正はそのiPhone内に保存されます。必要に応じて画面下のCSV保存を使用してください。
