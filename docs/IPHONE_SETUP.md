# iPhone設定手順

## 公開URLを確認

1. GitHubで`daikigoe34-jpg/ebay-parts-bot`を開きます。
2. `Settings`を押します。
3. 左側の`Pages`を押します。
4. `Your site is live at ...`のURLをSafariで開きます。

表示されない場合は次を確認します。

- `Settings` → `Pages` → Sourceが`GitHub Actions`
- `Actions` → `GitHub Pages公開`が緑色で完了
- `EBAY_CLIENT_ID`と`EBAY_CLIENT_SECRET`の名前が完全一致

## ホーム画面へ追加

1. 公開URLをSafariで開きます。
2. 共有ボタンを押します。
3. `ホーム画面に追加`を押します。
4. 名前が`Part Scout`であることを確認します。
5. 右上の`追加`を押します。

以後、ホーム画面のアイコンから全画面表示で起動できます。

## 新しい調査を実行

画面上部の`今すぐ調査`を押すと、GitHubの`eBay自動リサーチ`画面が開きます。

1. GitHubへログインします。
2. `Run workflow`を押します。
3. 空欄ならランダム検索です。
4. 任意検索なら英語の検索語を入力します。
5. 緑色で完了後、Part Scoutへ戻って右上の`↻`を押します。

`↻`は保存済みデータの再読込であり、単独ではeBay調査を開始しません。

## 最終候補までの操作

1. 候補カードのモノタロウ／楽天で仕入価格を確認します。
2. 仕入価格と国際送料を入力します。
3. eBay Product Researchを90日指定して、販売数・競合数・成約価格を確認します。
4. Part Scoutの`90日補正`へ入力します。
5. SpeedPAK等でDDP関税の実見積を確認します。
6. 金額を関税率または`通関・DDP追加費`へ反映します。
7. `DDP関税を実見積で確認済み`へチェックします。

API推定だけでは`仮候補`です。Product Research実績とDDP関税実見積を確認した場合だけ`販売候補`になります。

## 端末内データ

仕入価格、送料、利益設定、Product Research補正はこのiPhoneのSafari内に保存されます。GitHubへは送信されません。Safariのサイトデータを削除すると消えるため、画面下のCSV保存を定期的に使ってください。
