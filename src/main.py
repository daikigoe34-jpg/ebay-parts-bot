"""
メイン実行スクリプト
全キーワードでeBay検索 → 正確な手数料体系で利益計算 → 結果をコンソール＆CSVに出力
"""

import argparse
import os
import sys
import time
from datetime import datetime

import pandas as pd
from tabulate import tabulate

from src import config
from src.ebay_client import search_items, get_demo_data, get_item_description, KEYWORD_INTERVAL as _KW_INTERVAL
from src.calculator import calculate_profit
from src.part_number import get_source_info, extract_part_number
from src.logger import logger


def validate_config():
    """
    config.pyの設定値が正しいかチェックする
    異常値があればエラーメッセージを表示して終了

    Raises:
        ValueError: 設定値が異常な場合
    """
    errors = []

    if config.USD_TO_JPY <= 0:
        errors.append(f"為替レートが不正です: {config.USD_TO_JPY}（0より大きい値にしてください）")

    if not (0 <= config.FVF_RATE <= 1):
        errors.append(f"FVF率が不正です: {config.FVF_RATE}（0〜1の小数で指定。例: 0.1325 = 13.25%）")

    if not (0 <= config.INTERNATIONAL_FEE_RATE <= 1):
        errors.append(f"海外決済手数料率が不正です: {config.INTERNATIONAL_FEE_RATE}（0〜1の小数で指定）")

    if not (0 <= config.DDP_TARIFF_RATE <= 1):
        errors.append(f"DDP関税率が不正です: {config.DDP_TARIFF_RATE}（0〜1の小数で指定）")

    if not (0 <= config.PAYONEER_FX_MARKUP < 1):
        errors.append(f"Payoneer為替手数料率が不正です: {config.PAYONEER_FX_MARKUP}（0〜1未満で指定）")

    if config.FVF_FIXED_FEE_USD < 0:
        errors.append(f"FVF固定手数料が不正です: {config.FVF_FIXED_FEE_USD}（0以上にしてください）")

    if errors:
        raise ValueError(
            "config.pyの設定値にエラーがあります:\n" +
            "\n".join(f"  - {e}" for e in errors)
        )


def run(demo_mode=False, dryrun_mode=False, cost_jpy=None, weight_g=None, country=None):
    """
    メイン処理を実行する

    Args:
        demo_mode (bool): Trueならダミーデータで動作確認
        dryrun_mode (bool): Trueなら1商品分の計算ステップを詳細表示
        cost_jpy (int): 仕入原価（円）。Noneならデフォルト
        weight_g (int): 商品重量（グラム）
        country (str): 宛先国コード
    """
    # 設定値のバリデーション
    validate_config()

    if country is None:
        country = config.DEFAULT_COUNTRY

    # 国名の表示用マッピング
    country_names = {
        "us": "アメリカ（本土48州）",
        "us_remote": "アメリカ（アラスカ・ハワイ等）",
        "uk": "イギリス",
        "de": "ドイツ",
        "au": "オーストラリア",
    }
    country_name = country_names.get(country, country)

    # Payoneer実効レート
    effective_rate = config.USD_TO_JPY * (1 - config.PAYONEER_FX_MARKUP)

    print("=" * 60)
    print("  eBay 日本車パーツ 売れ筋リサーチBot")
    print(f"  宛先: {country_name}")
    print(f"  手数料: FVF {config.FVF_RATE*100:.2f}%+${config.FVF_FIXED_FEE_USD:.2f}"
          f" / 海外決済 {config.INTERNATIONAL_FEE_RATE*100:.2f}%")
    print(f"  為替: 仲値{config.USD_TO_JPY}円 → Payoneer実効{effective_rate:.2f}円")
    if country in ("us", "us_remote"):
        print(f"  DDP関税: {config.DDP_TARIFF_RATE*100:.0f}%（自動車部品・アメリカ宛）")
    else:
        print(f"  関税: 買い手負担（セラー負担なし）")
    print("=" * 60)

    # ------ dryrunモード: 設定値一覧を表示 ------
    if dryrun_mode:
        print("\n--- config.py 現在のパラメータ ---")
        print(f"  USD_TO_JPY:              {config.USD_TO_JPY}")
        print(f"  PAYONEER_FX_MARKUP:      {config.PAYONEER_FX_MARKUP} ({config.PAYONEER_FX_MARKUP*100}%)")
        print(f"  FVF_RATE:                {config.FVF_RATE} ({config.FVF_RATE*100:.2f}%)")
        print(f"  FVF_FIXED_FEE_USD:       ${config.FVF_FIXED_FEE_USD}")
        print(f"  INTERNATIONAL_FEE_RATE:  {config.INTERNATIONAL_FEE_RATE} ({config.INTERNATIONAL_FEE_RATE*100:.2f}%)")
        print(f"  DDP_TARIFF_RATE:         {config.DDP_TARIFF_RATE} ({config.DDP_TARIFF_RATE*100}%)")
        print(f"  DEFAULT_COST_JPY:        ¥{config.DEFAULT_COST_JPY:,}")
        print(f"  DEFAULT_WEIGHT_G:        {config.DEFAULT_WEIGHT_G}g")
        print(f"  PACKING_COST_JPY:        ¥{config.PACKING_COST_JPY}")
        print(f"  DEFAULT_COUNTRY:         {config.DEFAULT_COUNTRY}")
        print("-----------------------------------")

    # ------ 商品データの取得 ------
    if demo_mode or dryrun_mode:
        print("\n[デモモード] ダミーデータを使用します\n")
        all_items = get_demo_data()
    else:
        print(f"\neBay Browse API から商品を検索します（${config.MIN_PRICE_USD:.0f}〜${config.MAX_PRICE_USD:.0f}）...\n")
        all_items = []
        for i, keyword in enumerate(config.SEARCH_KEYWORDS, 1):
            logger.info(f"[{i}/{len(config.SEARCH_KEYWORDS)}] 検索中...")
            items = search_items(keyword)
            all_items.extend(items)
            # レート制限対策: キーワード間に待機を入れる
            if i < len(config.SEARCH_KEYWORDS):
                time.sleep(_KW_INTERVAL)

    if not all_items:
        print("\n商品が見つかりませんでした。")
        return

    print(f"\n合計 {len(all_items)}件 の商品を取得しました。")

    # ------ 品番なし商品: 説明文から品番を補完 ------
    if not demo_mode and not dryrun_mode:
        no_pn_items = [item for item in all_items
                       if item.get("item_id") and not extract_part_number(item["title"])]
        if no_pn_items:
            print(f"品番なし {len(no_pn_items)}件 → 商品説明から品番を検索中...")
            found = 0
            for i, item in enumerate(no_pn_items):
                desc = get_item_description(item["item_id"])
                if desc:
                    pn = extract_part_number(desc)
                    if pn:
                        # タイトル末尾に品番を追記（抽出用）
                        item["_desc_part_number"] = pn
                        found += 1
                # レート制限対策: 1秒間隔
                if i < len(no_pn_items) - 1:
                    time.sleep(1)
            print(f"  → 説明文から {found}件 の品番を追加抽出\n")

    print("利益計算中...\n")

    # ------ dryrunモード: 1商品目の計算ステップを詳細表示 ------
    if dryrun_mode:
        item = all_items[0]
        p = item["price_usd"]
        actual_cost = cost_jpy if cost_jpy is not None else config.DEFAULT_COST_JPY
        actual_weight = weight_g if weight_g is not None else config.DEFAULT_WEIGHT_G

        fvf = p * config.FVF_RATE + config.FVF_FIXED_FEE_USD
        intl = p * config.INTERNATIONAL_FEE_RATE
        ebay_total = fvf + intl
        payout_usd = p - ebay_total
        eff_rate = config.USD_TO_JPY * (1 - config.PAYONEER_FX_MARKUP)
        payout_jpy = payout_usd * eff_rate
        tariff_usd = p * config.DDP_TARIFF_RATE if country in ("us", "us_remote") else 0
        tariff_jpy = round(tariff_usd * config.USD_TO_JPY)

        from src.shipping import get_shipping_cost
        ship = get_shipping_cost(actual_weight, country=country)

        total_cost = tariff_jpy + actual_cost + ship + config.PACKING_COST_JPY
        profit = round(payout_jpy) - total_cost
        sale_jpy = p * config.USD_TO_JPY
        margin = (profit / sale_jpy * 100) if sale_jpy > 0 else 0

        print("--- 利益計算の詳細（デバッグモード） ---")
        print(f"商品名: {item['title']}")
        print(f"販売価格: ${p:.2f}")
        print(f"  ├─ FVF落札手数料: ${p:.2f} × {config.FVF_RATE*100:.2f}% + ${config.FVF_FIXED_FEE_USD:.2f} = ${fvf:.2f}")
        print(f"  ├─ 海外決済手数料: ${p:.2f} × {config.INTERNATIONAL_FEE_RATE*100:.2f}% = ${intl:.2f}")
        print(f"  ├─ eBay手数料合計: ${ebay_total:.2f}")
        print(f"  ├─ eBay受取額: ${p:.2f} - ${ebay_total:.2f} = ${payout_usd:.2f}")
        print(f"  ├─ Payoneer実効レート: {config.USD_TO_JPY} × {1-config.PAYONEER_FX_MARKUP} = {eff_rate:.2f} JPY/USD")
        print(f"  ├─ 日本円受取額: ${payout_usd:.2f} × {eff_rate:.2f} = ¥{round(payout_jpy):,}")
        if country in ("us", "us_remote"):
            print(f"  ├─ DDP関税: ${p:.2f} × {config.DDP_TARIFF_RATE*100:.0f}% = ${tariff_usd:.2f} → ¥{tariff_jpy:,}")
        else:
            print(f"  ├─ DDP関税: ¥0（{country_name}は買い手負担）")
        print(f"  ├─ 仕入原価: ¥{actual_cost:,}")
        print(f"  ├─ SpeedPAK送料({actual_weight}g): ¥{ship:,}")
        print(f"  ├─ 梱包材: ¥{config.PACKING_COST_JPY:,}")
        print(f"  ├─ コスト合計: ¥{total_cost:,}")
        print(f"  └─ 利益: ¥{round(payout_jpy):,} - ¥{total_cost:,} = ¥{profit:,}（利益率 {margin:.1f}%）")
        print("--------------------------------------\n")

    # ------ 利益計算 ------
    results = []
    for i, item in enumerate(all_items, 1):
        if not dryrun_mode:
            logger.debug(f"利益計算中: [{i}/{len(all_items)}] {item['title'][:30]}...")

        calc = calculate_profit(
            price_usd=item["price_usd"],
            cost_jpy=cost_jpy,
            weight_g=weight_g,
            country=country,
        )

        # 品番抽出・モノタロウURL生成（タイトル→説明文の順で試行）
        source = get_source_info(item["title"])
        if not source["part_number"] and item.get("_desc_part_number"):
            source = get_source_info(item["_desc_part_number"])

        results.append({
            "商品名": item["title"][:50],
            "品番": source["part_number"],
            "販売価格(USD)": f"${item['price_usd']:.2f}",
            "販売価格(JPY)": f"¥{calc['sale_jpy']:,}",
            "eBay手数料(USD)": f"${calc['ebay_fee_total_usd']:.2f}",
            "Payoneer受取(JPY)": f"¥{calc['payout_jpy']:,}",
            "DDP関税(JPY)": f"¥{calc['tariff_jpy']:,}",
            "仕入(JPY)": f"¥{calc['cost_jpy']:,}",
            "送料(JPY)": f"¥{calc['shipping_jpy']:,}",
            "利益(JPY)": f"¥{calc['profit_jpy']:,}",
            "利益率(%)": calc["profit_margin"],
            "販売日": item["sold_date"],
            "URL": item["url"],
            "モノタロウ": source["monotaro_url"],
            "_profit_margin_raw": calc["profit_margin"],
            "_profit_jpy_raw": calc["profit_jpy"],
        })

    # ------ 利益率でソート（高い順） ------
    results.sort(key=lambda x: x["_profit_margin_raw"], reverse=True)

    # ------ 利益>0でフィルタ ------
    profitable = [r for r in results if r["_profit_jpy_raw"] > config.MIN_PROFIT_JPY]

    # ------ コンソール表示 ------
    print("-" * 60)
    print(f"利益がプラスの商品: {len(profitable)}件 / {len(results)}件")
    print("-" * 60)

    if profitable:
        display_data = []
        for r in profitable:
            row = {k: v for k, v in r.items() if not k.startswith("_")}
            display_data.append(row)

        print(tabulate(display_data, headers="keys", tablefmt="grid", showindex=True))
    else:
        print("利益がプラスの商品はありませんでした。")
        print("対処法: 仕入原価を下げるか、より高額な商品を狙ってみてください。")

    # ------ サマリー表示 ------
    print("\n" + "=" * 60)
    print("  サマリー")
    print("=" * 60)
    print(f"  検索した商品数:     {len(results)}件")
    print(f"  利益が出る商品数:   {len(profitable)}件")

    if profitable:
        avg_margin = sum(r["_profit_margin_raw"] for r in profitable) / len(profitable)
        print(f"  平均利益率:         {avg_margin:.1f}%")

        print(f"\n  【利益率TOP5】")
        for i, r in enumerate(profitable[:5]):
            print(f"  {i+1}. {r['商品名']}")
            print(f"     販売{r['販売価格(USD)']} → 利益{r['利益(JPY)']}（利益率{r['利益率(%)']}%）")
    else:
        print(f"  平均利益率:         - （黒字商品なし）")

    if country in ("us", "us_remote"):
        print(f"\n  ※DDP関税{config.DDP_TARIFF_RATE*100:.0f}%込み。関税率は ebay.co.jp/tariffs で最新を確認")
    print(f"  ※Payoneer為替手数料{config.PAYONEER_FX_MARKUP*100:.0f}%込み（実効レート{effective_rate:.2f}円/USD）")

    # ------ CSV出力 ------
    output_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output")
    os.makedirs(output_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_path = os.path.join(output_dir, f"ebay_research_{timestamp}.csv")

    csv_data = []
    for r in results:
        row = {k: v for k, v in r.items() if not k.startswith("_")}
        csv_data.append(row)

    df = pd.DataFrame(csv_data)

    try:
        df.to_csv(csv_path, index=False, encoding="utf-8-sig")
        logger.info(f"CSV出力完了: {csv_path}")
        print(f"\nCSVファイル: {csv_path}")
        print(f"全 {len(results)}件 出力完了")
    except PermissionError:
        logger.error(f"CSV書き込み権限エラー: {csv_path}")
        print(f"\nエラー: CSVファイルの書き込み権限がありません: {csv_path}")
        print("対処法: outputフォルダの権限を確認してください。")
    except OSError as e:
        logger.error(f"CSV書き込みエラー: {e}")
        print(f"\nエラー: CSVファイルの書き込みに失敗しました: {e}")
        print("対処法: ディスク容量を確認してください。")


def main():
    """
    コマンドライン引数を解析してrun()を実行
    """
    parser = argparse.ArgumentParser(
        description="eBay 日本車パーツ 売れ筋リサーチBot（FVF+海外決済+Payoneer+DDP対応）"
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="デモモード（ダミーデータで動作確認）",
    )
    parser.add_argument(
        "--dryrun",
        action="store_true",
        help="ドライランモード（1商品分の計算ステップを詳細表示）",
    )
    parser.add_argument(
        "--cost",
        type=int,
        default=None,
        help=f"仕入原価（円・0以上）。デフォルト: ¥{config.DEFAULT_COST_JPY:,}",
    )
    parser.add_argument(
        "--weight",
        type=int,
        default=None,
        help=f"商品重量（グラム・1以上）。デフォルト: {config.DEFAULT_WEIGHT_G}g",
    )
    parser.add_argument(
        "--country",
        type=str,
        default=None,
        choices=["us", "us_remote", "uk", "de", "au"],
        help="宛先国（us/us_remote/uk/de/au）。デフォルト: us",
    )

    args = parser.parse_args()

    # 引数バリデーション
    if args.cost is not None and args.cost < 0:
        print("エラー: 仕入原価は0以上で指定してください。", file=sys.stderr)
        sys.exit(1)
    if args.weight is not None and args.weight < 1:
        print("エラー: 商品重量は1g以上で指定してください。", file=sys.stderr)
        sys.exit(1)

    try:
        run(
            demo_mode=args.demo,
            dryrun_mode=args.dryrun,
            cost_jpy=args.cost,
            weight_g=args.weight,
            country=args.country,
        )
    except ValueError as e:
        print(f"\n設定エラー: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n\n処理を中断しました。")
        sys.exit(0)


if __name__ == "__main__":
    main()
