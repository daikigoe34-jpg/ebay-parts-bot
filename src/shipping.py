"""
SpeedPAK Economy 送料計算モジュール
重量帯別の送料テーブルと容積重量計算を提供する

SpeedPAK Economy（公式Rate Card 2025年1月16日発効）:
- Orange Connex社が提供するeBay公式配送サービス
- 郵便局またはローソン（Loppi設置店）から発送可能
- 追跡サービス無料、セラー保護あり
- 対応国: アメリカ(本土48州+遠隔地), イギリス, ドイツ, オーストラリア
- 容積重量(kg) = 縦×横×高さ(cm) ÷ 8,000
- 実重量と容積重量の大きい方を適用
"""

from src import config


def calculate_volumetric_weight(length_cm, width_cm, height_cm):
    """
    容積重量を計算する
    容積重量(g) = 縦(cm) × 横(cm) × 高さ(cm) ÷ 8,000 × 1,000

    Args:
        length_cm (float): 縦（cm）
        width_cm (float): 横（cm）
        height_cm (float): 高さ（cm）

    Returns:
        float: 容積重量（グラム）
    """
    volumetric_kg = (length_cm * width_cm * height_cm) / config.VOLUMETRIC_DIVISOR
    return volumetric_kg * 1000  # グラムに変換


def get_billable_weight(actual_weight_g, length_cm=None, width_cm=None, height_cm=None):
    """
    課金対象の重量を返す（実重量と容積重量の大きい方）

    Args:
        actual_weight_g (float): 実際の重量（グラム）
        length_cm (float): 梱包後の縦（cm）。Noneなら容積重量は計算しない
        width_cm (float): 梱包後の横（cm）
        height_cm (float): 梱包後の高さ（cm）

    Returns:
        float: 課金対象の重量（グラム）
    """
    # サイズが指定されていなければ実重量をそのまま返す
    if length_cm is None or width_cm is None or height_cm is None:
        return actual_weight_g

    # 容積重量を計算
    vol_weight = calculate_volumetric_weight(length_cm, width_cm, height_cm)

    # 実重量と容積重量の大きい方を適用
    return max(actual_weight_g, vol_weight)


def get_shipping_cost(weight_g, country="us"):
    """
    SpeedPAK Economy の重量帯に応じた送料を返す

    Args:
        weight_g (float): 課金対象の重量（グラム）
        country (str): 宛先国コード（"us", "us_remote", "uk", "de", "au"）

    Returns:
        int: 送料（円）
    """
    # 宛先国に対応するテーブルを取得
    table = config.SPEEDPAK_TABLES.get(country, config.SPEEDPAK_TABLE_US)

    # 重量をkgに変換（テーブルはkg単位）
    weight_kg = weight_g / 1000.0

    for max_kg, cost in table:
        if weight_kg <= max_kg:
            return cost

    # テーブルの最大値を超えた場合は最後の値を返す
    return table[-1][1]
