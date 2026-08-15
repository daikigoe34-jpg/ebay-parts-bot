# 手数料・関税の根拠 — 2026-08-15確認

本ファイルは初期設定値の根拠です。販売時点の規約、セラー画面、HTSUS、DDP見積が最終値です。

## eBay.com販売手数料

- ストアなし／StarterのeBay Motors Parts & Accessories: 7,500 USDまで13.6%、超過部分2.35%
- Basic以上の標準Parts & Accessories: 1,000 USDまで11.5%、超過部分2.35%
- Basic以上のタイヤ: 1,000 USDまで9.5%、超過部分2.35%
- Basic以上のApparel, Protective Gear & Merchandise: 1,000 USDまで12.7%、超過部分2.35%
- Basic以上のIn-Car Technology, GPS & Security: 1,000 USDまで9.35%、超過部分2.35%
- 1注文固定料: 売上総額10 USD以下0.30 USD、超過0.40 USD
- 手数料ベースの売上総額には商品、購入者負担送料、税等を含める

公式:

- https://www.ebay.com/help/selling/fees-credits-invoices/store-selling-fees?id=4809
- https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=5224
- https://wwwcojp.ebay.com/fee/overview-selling-fees/

## 日本セラーのInternational Fee

- 基本: 1.35%
- 前々月売上3,000–9,999.99 USD: 1.20%
- 10,000–49,999.99 USD: 0.95%
- 50,000–99,999.99 USD: 0.70%
- 100,000 USD以上: 0.40%
- 前月20日時点でBelow Standardの場合、ボリューム割引は適用されない

アプリでは「海外決済手数料の売上割引を使用」をOFFにすると1.35%へ戻ります。

公式:

- https://wwwcojp.ebay.com/fee/overview-selling-fees/

## Payoneer

- 銀行口座への出金・送金は、地域、通貨、送金経路等で通常1.2–4%の範囲
- 連続12か月の受取が6,000 USD未満の場合等、年間アカウント手数料29.95 USDが適用されることがある
- 正確な料率はPayoneerアカウントの「手数料」画面が最終値

アプリの出金率初期値3%は確定値ではなく、設定可能な仮置きです。年間手数料も実アカウントで対象の場合だけONにします。

公式:

- https://www.payoneer.com/ja/about/pricing/

## 米国関税

日本原産品の15%は、2025年の米日枠組みに基づく一次スクリーニング値です。自動車部品はHTSUS、原産国、Section 232の対象範囲、材質、輸入日時点の措置で変わります。

アプリでは15%を確定税率とは表示せず、次の確認が終わるまで「購入候補」にしません。

- HTSUS
- 原産国証明
- DDP実見積
- 輸入日時点の追加措置

公式:

- https://www.whitehouse.gov/fact-sheets/2025/09/fact-sheet-president-donald-j-trump-implements-a-historic-u-s-japan-framework-agreement/
- https://rulings.cbp.gov/
- https://hts.usitc.gov/

## eBay Production API

- Client CredentialsでApplication access tokenを取得
- Production keysetを持っていても、Buy APIのProduction利用には別途Production access要件がある
- 本ツールはBrowse APIのみを利用し、制限APIや廃止済みFinding APIを呼ばない

公式:

- https://developer.ebay.com/develop/guides-v2/authorization
- https://developer.ebay.com/api-docs/buy/buy-requirements.html
- https://developer.ebay.com/api-docs/buy/browse/overview.html
- https://developer.ebay.com/develop/get-started/api-deprecation-status
