"""
shipping.py のユニットテスト
"""

import pytest
from src.shipping import get_shipping_cost, calculate_volumetric_weight, get_billable_weight
from src import config


class TestShippingCost:
    """送料テーブルのテスト"""

    def test_100g_us(self):
        """100g(アメリカ宛)の送料が正しいテーブル値を返すか"""
        cost = get_shipping_cost(100, country="us")
        assert cost == 1227

    def test_500g_us(self):
        """500g(アメリカ宛)の送料が正しいテーブル値を返すか"""
        cost = get_shipping_cost(500, country="us")
        assert cost == 2060

    def test_1kg_us(self):
        """1kg(アメリカ宛)の送料"""
        cost = get_shipping_cost(1000, country="us")
        assert cost == 3020

    def test_1_5kg_us(self):
        """1.5kg(アメリカ宛)の送料"""
        cost = get_shipping_cost(1500, country="us")
        assert cost == 3816

    def test_over_25kg_returns_last_value(self):
        """25kg超の場合は最後の値を返すか"""
        cost = get_shipping_cost(30000, country="us")
        assert cost == config.SPEEDPAK_TABLE_US[-1][1]

    def test_uk_shipping(self):
        """イギリス宛の送料が正しいか"""
        cost = get_shipping_cost(100, country="uk")
        assert cost == 938  # UKの0.1kg帯

    def test_unknown_country_defaults_to_us(self):
        """未知の国コードはUSテーブルにフォールバックするか"""
        cost = get_shipping_cost(100, country="xx")
        assert cost == 1227  # USの0.1kg帯

    def test_weight_boundary(self):
        """重量帯の境界値（ちょうど0.5kg）"""
        cost = get_shipping_cost(500, country="us")
        assert cost == 2060  # 0.5kgの帯

    def test_weight_just_over_boundary(self):
        """重量帯の境界を少し超えた場合（501g → 0.6kg帯）"""
        cost = get_shipping_cost(501, country="us")
        assert cost == 2222  # 0.6kgの帯


class TestVolumetricWeight:
    """容積重量計算のテスト"""

    def test_volumetric_calculation(self):
        """容積重量: 30×20×10cm → 30×20×10÷8000×1000 = 750g"""
        vol = calculate_volumetric_weight(30, 20, 10)
        assert vol == 750.0

    def test_billable_weight_actual_heavier(self):
        """実重量0.8kgで容積0.75kgのとき → 実重量800gが適用"""
        weight = get_billable_weight(800, length_cm=30, width_cm=20, height_cm=10)
        assert weight == 800

    def test_billable_weight_volumetric_heavier(self):
        """実重量0.3kgで容積0.75kgのとき → 容積重量750gが適用"""
        weight = get_billable_weight(300, length_cm=30, width_cm=20, height_cm=10)
        assert weight == 750.0

    def test_billable_weight_no_dimensions(self):
        """サイズ未指定のとき実重量をそのまま返すか"""
        weight = get_billable_weight(500)
        assert weight == 500

    def test_volumetric_shipping_cost(self):
        """容積重量が大きい場合、容積重量の送料が適用されるか"""
        # 実重量300g、容積重量750g → 0.8kg帯の送料
        billable = get_billable_weight(300, length_cm=30, width_cm=20, height_cm=10)
        cost = get_shipping_cost(billable, country="us")
        assert cost == 2703  # 0.8kgの帯
