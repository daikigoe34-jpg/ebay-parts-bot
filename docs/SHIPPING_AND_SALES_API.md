# SpeedPAK Economy送料とeBay実績の自動化

確認日：2026-09-08。送料の参考計算を先に追加し、認証が必要なライブ連携は接続前として扱う。

## 送料の参考計算

商品詳細の「送料の計算方法」でSpeedPAK Economyを選択し、**梱包後の重量・箱の3辺**を入力する。米国本土48州を想定する参考計算。入力値は商品ごとにその場で保存する。商品名から重量を推測して確定送料にしない。

計算元は[Orange Connex公式料金表・2026-03-25発効版](https://static.orangeconnex.com/capricorn/selfQuery/1141130239112384512.pdf)。取得できた既知版であり、毎日最新料金を取得する機能ではない。燃油込みの基本送料に規定外寸法の追加料金を反映する。関税と通関関連費用は分離する。参考額だけでは最終購入候補にせず、CPaSSの実見積に切り替える。

米国本土以外・他国宛て、危険物・電池入り、寸法や申告額の条件を満たさない荷物は、この計算だけで発送可否・最終料金を決めない。[公式サービス案内](https://www.orangeconnex.jp/product)を確認する。

## SpeedPAK公式API

[Orange Connex公式の開発者ページ](https://www.orangeconnex.jp/developer)から案内される[日本向けAPI仕様](https://3pp-jp-openapi.apifox.cn/)で、送料見積APIを確認した。

- 見積：`POST /developer/api/preference/v1/estimation/multi_package_type_fee`
- Economyは `serviceId: "EE"`。
- 重量・寸法・配送先・発送日が必要。米国宛ては商品情報も必要。
- 応答は割引後総額と費用明細。総額を国際送料に入れたうえで同じ関税等を再加算しない。サンプルの税率や燃油額を現行料金として固定しない。
- キーは開発者用とセラー用の両方が必要。テスト・OC検証後に本番キーと本番接続先が発行される。セラー側ではeBayアカウント認可が必要。

出典：[Shipping Cost Estimation](https://3pp-jp-openapi.apifox.cn/8-shipping-cost-estimation-443715936e0)、[オンボーディング](https://3pp-jp-openapi.apifox.cn/3pp-jp-introduction-8933830m0)。公開仕様だけではAPI利用料や個人開発者の採用条件を確定できないため、完全無料のライブ連携は未確認。開発者窓口への送信・申請はまだ行っていない。

請求書・決済明細取得は仕様上「Coming Soon」に分類されている。[Get Invoice](https://3pp-jp-openapi.apifox.cn/get-invoice-467731597e0)、[Get Transactions](https://3pp-jp-openapi.apifox.cn/get-transactions-468227570e0)。提供開始を確認するまでは、OCへの実支払送料が自動取得できるとは扱わない。

## 「eBayの実績」は2種類

| 対象 | 取得手段 | 制約 |
|---|---|---|
| 自分の受注数・商品・売上 | Fulfillment API `getOrders` | セラー本人のOAuth認可が必要。通常90日、期間指定で最大2年。注文のキャンセル・返金状態も扱う。 |
| 自分のeBay手数料・返金・決済 | Finances API `getTransactions` | 本人の認可が必要。受注と注文ID等で照合。外部の仕入費・Payoneer費・OC請求額は別。 |
| 市場全体の正確な過去成約履歴 | Marketplace Insights API | 新規ユーザーへの開放は停止中。既存のBrowse観測値は過去90日の確定成約実績ではない。 |

出典：[Fulfillment API仕様](https://developer.ebay.com/develop/api/spec/fulfillment_api.json)、[Finances API仕様](https://developer.ebay.com/develop/api/spec/finances_api.json)、[Marketplace Insightsの利用制限](https://developer.ebay.com/api-docs/buy/static/ref-marketplace-supported.html)。

2026年追加のFinances `getOrderEarnings` は、現在US・CN・HK居住の対象セラーに限定され、追加のアクセス申請も必要。日本居住セラーがすぐ使える前提にはしない。同じ[公式API仕様](https://developer.ebay.com/develop/api/spec/finances_api.json)で対象条件を確認した。

## 自分の販売実績を接続する構成

次の連携は未実装・未認可。現在のProduction Browse用アプリトークンだけでは自分の注文を取得できない。

1. 非公開の保存先と、認可付きのAPIサーバーを用意する。フロントエンドから個人の販売実績を読む際も本人認証を必須にする。
2. 本人が一度eBayで認可し、サーバーがトークンを更新する。注文は `sell.fulfillment.readonly`、会計は `sell.finances`。取得用途のGETだけを実装する。
3. 注文の更新日時による差分取得と全ページ処理を行い、注文ID・明細IDで重複を防ぐ。キャンセル・返金・通貨を分けて集計する。
4. SKU／純正品番を照合し、自分の実績と市場の推定値を別表示する。受注額をそのまま利益にしない。
5. 通勤中は更新済み実績を見るだけにする。最終取得日時を表示し、通信失敗時は前回の正常データを保持する。

個別注文・購入者情報・APIキーは公開Git、`web/data`、Actionsログへ保存しない。eBay開発者登録には[無料枠](https://developer.ebay.com/signin)があるが、非公開保存先・OC本番APIの利用条件が未確認なので、この段階で完全自動・無料の稼働完了とはしない。

## 公開状況

利用画面は本人用のSitesに移す。利用URL：[Part Scout](https://part-scout-mobile.takasuka.chatgpt.site)。キー未登録でも[送料計算](https://part-scout-mobile.takasuka.chatgpt.site/shipping-calculator.html)を開ける。送料だけの画面には独立した端末保存・バックアップ／復元がある。

日次リサーチは既存GitHub Actionsを使い、画面はmainの公開調査結果JSONを取得する。売り手本人の注文・会計はこの公開JSONに混ぜない。キー未登録時は取得済みと表示しない。Sitesの公開成功とeBay APIの接続成功は別に確認する。

GitHub Pagesの初回設定は未完了だが、このSites URLを利用するために設定する必要はない。公開完了はSitesの成功応答で確認し、最新状況を[Notion](https://app.notion.com/p/3bce122bd6a08123a2a3cf31f2b99fda)へ記録する。
