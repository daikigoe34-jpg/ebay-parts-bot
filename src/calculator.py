"""
利益計算モジュール
eBayの販売価格から正確な手数料体系に基づいて利益を計算する

【計算フロー】
1. 販売価格(USD)からeBay手数料(FVF+海外決済)を引く → eBay受取額(USD)
2. 受取額をPayoneer実効レート(仲値×0.98)でJPY変換 → 日本円受取額
3. DDP関税(JPY)を別途計算
4. 利益 = 日本円受取額 - DDP関税 - 仕入原価 - SpeedPAK送料 - 梱包材

【損益分岐の目安（$50・500gの場合）】
eBay手数料 ≒ 14.6% + $0.40 → USD側で天引き
Payoneer為替手数料 ≒ 2% → 換算レートに反映
DDP関税 15% → 別途JPYで差し引き
→ 合計約30%+αが引かれる
"""

from src import config
from src.shipping import get_shipping_cost, get_billable_weight


def calculate_profit(price_usd, cost_jpy=None, weight_g=None,
                     length_cm=None, width_cm=None, height_cm=None,
                     country=None):
    """
    1商品あたりの利益を計算する（正確な手数料体系版）

    Args:
        price_usd (float): eBayでの販売価格（USD・送料込み想定）
        cost_jpy (int): 仕入原価（円）。Noneならデフォルト値を使用
        weight_g (int): 商品重量（グラム）。Noneならデフォルト
        length_cm (float): 梱包後の縦(cm)。容積重量計算用
        width_cm (float): 梱包後の横(cm)
        height_cm (float): 梱包後の高さ(cm)
        country (str): 宛先国コード（"us","uk","de","au"）。Noneならデフォルト

    Returns:
        dict: 計算結果の辞書（全コスト内訳を含む）
    """
    # デフォルト値の設定
    if cost_jpy is None:
        cost_jpy = config.DEFAULT_COST_JPY
    if weight_g is None:
        weight_g = config.DEFAULT_WEIGHT_G
    if country is None:
        country = config.DEFAULT_COUNTRY

    # ========== eBay側で天引き（USDベース） ==========

    # FVF落札手数料 = (商品価格+送料) × FVF_RATE + 固定手数料
    fvf_usd = price_usd * config.FVF_RATE + config.FVF_FIXED_FEE_USD

    # 海外決済手数料 = (商品価格+送料) × INTERNATIONAL_FEE_RATE
    intl_fee_usd = price_usd * config.INTERNATIONAL_FEE_RATE

    # eBay手数料合計（USD）
    ebay_fee_total_usd = fvf_usd + intl_fee_usd

    # eBayからPayoneerへの受取額（USD）
    ebay_payout_usd = price_usd - ebay_fee_total_usd

    # ========== Payoneer引き出し（USD→JPY） ==========

    # 実効為替レート = 仲値 × (1 - Payoneer手数料率)
    effective_fx_rate = config.USD_TO_JPY * (1 - config.PAYONEER_FX_MARKUP)

    # 日本円での受取額
    payout_jpy = ebay_payout_usd * effective_fx_rate

    # ========== DDP関税（SpeedPAK経由で別途請求） ==========

    # アメリカ宛のみDDP関税が発生（UK/DE/AUは買い手負担）
    if country in ("us", "us_remote"):
        tariff_usd = price_usd * config.DDP_TARIFF_RATE
        tariff_jpy = round(tariff_usd * config.USD_TO_JPY)  # 関税は仲値で換算
    else:
        tariff_usd = 0
        tariff_jpy = 0

    # ========== 日本側のコスト（JPYベース） ==========

    # 課金対象重量（実重量と容積重量の大きい方）
    billable_weight = get_billable_weight(weight_g, length_cm, width_cm, height_cm)

    # SpeedPAK Economy 国際送料
    shipping_jpy = get_shipping_cost(billable_weight, country=country)

    # 梱包材（固定）
    packing_jpy = config.PACKING_COST_JPY

    # ========== 利益計算 ==========

    # 利益 = 日本円受取額 - DDP関税 - 仕入原価 - SpeedPAK送料 - 梱包材
    profit_jpy = payout_jpy - tariff_jpy - cost_jpy - shipping_jpy - packing_jpy

    # 利益率 = 利益 / (販売価格USD × 仲値レート) × 100
    sale_jpy = price_usd * config.USD_TO_JPY
    if sale_jpy > 0:
        profit_margin = (profit_jpy / sale_jpy) * 100
    else:
        profit_margin = 0.0

    return {
        # 売上
        "price_usd": price_usd,
        "sale_jpy": round(sale_jpy),
        # eBay手数料（USD側天引き）
        "fvf_usd": round(fvf_usd, 2),
        "intl_fee_usd": round(intl_fee_usd, 2),
        "ebay_fee_total_usd": round(ebay_fee_total_usd, 2),
        "ebay_payout_usd": round(ebay_payout_usd, 2),
        # Payoneer
        "effective_fx_rate": round(effective_fx_rate, 2),
        "payout_jpy": round(payout_jpy),
        # DDP関税
        "tariff_usd": round(tariff_usd, 2),
        "tariff_jpy": tariff_jpy,
        # 日本側コスト
        "cost_jpy": cost_jpy,
        "shipping_jpy": shipping_jpy,
        "packing_jpy": packing_jpy,
        "billable_weight_g": round(billable_weight),
        # 利益
        "profit_jpy": round(profit_jpy),
        "profit_margin": round(profit_margin, 1),
        "country": country,
    }
