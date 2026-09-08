# 米国関税の確認 — 2026-09-08

このアプリが扱う日本車部品を米国へ販売する場合の整理です。日本のメーカー名や発送地だけでは日本原産と判定しません。商品ごとのHTSUS、原産国の根拠、輸入日、申告価格、配送方法で適用を確認します。

## 現在の制度

| 対象・制度 | 確認した扱い | アプリでの扱い |
|---|---|---|
| 日本原産の自動車・対象自動車部品（232条） | 通常税率が15%未満なら通常税率＋追加232税率＝15%。通常税率が15%以上なら追加232税率は0%。2025-09-16適用。[CBP通知](https://content.govdelivery.com/accounts/USDHSCBP/bulletins/3f2c91c) | 日本原産の初期試算は15%。対象分類が未確認なので確定税率とはしない |
| 日本原産品で新しい強制労働301条関税が適用されるもの | 2026-07-24から、通常税率が12.5%未満なら通常税率＋この301税率＝12.5%。通常税率が12.5%以上ならこの追加税率は0%。対象外・除外品あり。[CBP通知](https://content.govdelivery.com/accounts/USDHSCBP/bulletins/421d887) | すべての自動車用品へ一律15%または12.5%を確定適用しない |
| 232条と新しい強制労働301条 | 232条対象の物品・対象部分は、この新301条関税から除外。[USTR説明](https://ustr.gov/about/policy-offices/press-office/fact-sheets/2026/july/fact-sheet-ustr-section-301-action-response-failure-60-economies-ban-imports-produced-forced-labor) | 15%に新301条12.5%を機械的に加算しない |
| 旧IEEPA関税 | 2026-02-24以降の対象輸入で徴収終了。232条・301条等には影響しない。[CBP通知](https://content.govdelivery.com/accounts/USDHSCBP/bulletins/40b11c9) | 旧相互関税を現在の税額へ加えない |
| 暫定122条10% | 布告の適用期限は2026-07-24。期限を過ぎて恒久税率として使わない。[大統領布告](https://www.whitehouse.gov/presidential-actions/2026/02/imposing-a-temporary-import-surcharge-to-address-fundamental-international-payments-problems/) | 期限切れの10%を上乗せしない |
| 800ドル以下の販売品 | 郵便・非郵便とも少額免税の停止をCBP規則化。郵便の新しい簡易申告手続は2026-07-24施行。[郵便](https://www.federalregister.gov/documents/2026/06/24/2026-12669/indefinite-suspension-of-the-de-minimis-exemption-for-mail-shipments-and-new-postal-informal-entry)、[非郵便](https://www.federalregister.gov/documents/2026/06/24/2026-12670/indefinite-suspension-of-the-de-minimis-exemption-for-merchandise-arriving-through-all-modes-other) | 安価な部品でも免税を仮定しない |

例えば課税価格100ドル・通常税率2.5%の日本原産品で、他の費用・措置がないと仮定すると、対象自動車部品の232条は通常2.50ドル＋追加12.50ドル＝15ドルです。新301条対象で232条対象外なら通常2.50ドル＋追加10ドル＝12.50ドルです。これは制度の算術例で、特定部品の分類・輸入見積ではありません。

## 実装上の区別

- 関税欄は「試算率」と「実見積額」を区別。実見積額を入力した場合は試算額を置き換え、二重加算しない。
- HTSUS10桁・原産国・DDP見積額・確認状態が揃うまで購入候補にしない。書式確認だけでHTSUS分類の正当性を保証するものではない。
- 確認は7日で失効し、売価や関税条件の変更、アプリの関税確認版の更新でも再確認する。
- 初期の日本15%・他国／不明25%は分類前の試算条件。特に25%は安全な上限ではない。金属関連措置、原産国別措置、別の301条措置、AD/CVD等があれば実見積を取り直す。
- 送料、通関・DDP固定費、関税を分離して入力する。関税込み送料を送料欄へ入れ、同じ関税を関税欄へ再度入れない。
- 法令の自動解釈、部品名だけからの確定HTSUS判定、関税制度の毎日の自動更新は未実装。今回の確認日を画面に残し、実際の輸入条件に対応した見積を優先する。

確認先：[USITC現行HTS](https://hts.usitc.gov/)、配送会社・通関業者の現行DDP見積。個別の確定分類や実出荷での税額は、実商品・見積を入れてから検証します。
