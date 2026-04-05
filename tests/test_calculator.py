"""
calculator.py のユニットテスト
"""

import pytest
from src.calculator import calculate_profit
from src import config


class TestCalculateProfit:
    """利益計算のテスト"""

    def test_normal_50usd_500g(self):
        """正常系: $50の商品、仕入¥2,000、500g → 計画書の試算と近い値"""
        result = calculate_profit(price_usd=50.0, cost_jpy=2000, weight_g=500, country="us")

        # 計画書の計算:
        # FVF: $50 × 13.25% + $0.40 = $7.025
        # 海外決済: $50 × 1.35% = $0.675
        # 受取: $50 - $7.70 = $42.30
        # 日本円: $42.30 × 147 = ¥6,218
        # 関税: $50 × 15% × 150 = ¥1,125
        # 利益: ¥6,218 - ¥1,125 - ¥2,000 - ¥2,060 - ¥300 = ¥733
        assert result["profit_jpy"] > 0
        assert 600 <= result["profit_jpy"] <= 1100  # 計画書の¥992前後

    def test_fvf_calculation(self):
        """FVF計算: (価格 × 13.25%) + $0.40"""
        result = calculate_profit(price_usd=50.0)
        expected_fvf = 50.0 * 0.1325 + 0.40  # $7.025
        assert abs(result["fvf_usd"] - expected_fvf) < 0.01

    def test_fvf_fixed_fee_always_040(self):
        """FVF固定手数料: 現在は$0.40固定"""
        result_high = calculate_profit(price_usd=100.0)
        result_low = calculate_profit(price_usd=5.0)
        # config上は$0.40固定なので同じ
        assert result_high["fvf_usd"] == round(100.0 * config.FVF_RATE + config.FVF_FIXED_FEE_USD, 2)
        assert result_low["fvf_usd"] == round(5.0 * config.FVF_RATE + config.FVF_FIXED_FEE_USD, 2)

    def test_payoneer_effective_rate(self):
        """Payoneer手数料: 実効レートが仲値×0.98"""
        result = calculate_profit(price_usd=50.0)
        expected = config.USD_TO_JPY * (1 - config.PAYONEER_FX_MARKUP)
        assert result["effective_fx_rate"] == round(expected, 2)

    def test_ddp_tariff_us(self):
        """DDP関税: アメリカ宛 $50 × 15% = $7.50 → ¥1,125"""
        result = calculate_profit(price_usd=50.0, country="us")
        expected_tariff_jpy = round(50.0 * 0.15 * config.USD_TO_JPY)
        assert result["tariff_jpy"] == expected_tariff_jpy

    def test_ddp_tariff_uk_zero(self):
        """DDP関税: イギリス宛は0"""
        result = calculate_profit(price_usd=50.0, country="uk")
        assert result["tariff_jpy"] == 0
        assert result["tariff_usd"] == 0

    def test_ddp_tariff_de_zero(self):
        """DDP関税: ドイツ宛は0"""
        result = calculate_profit(price_usd=50.0, country="de")
        assert result["tariff_jpy"] == 0

    def test_ddp_tariff_au_zero(self):
        """DDP関税: オーストラリア宛は0"""
        result = calculate_profit(price_usd=50.0, country="au")
        assert result["tariff_jpy"] == 0

    def test_cost_zero(self):
        """仕入原価0円のとき正常に動くか"""
        result = calculate_profit(price_usd=50.0, cost_jpy=0)
        assert result["cost_jpy"] == 0
        assert result["profit_jpy"] > 0  # 仕入0なら黒字のはず

    def test_no_negative_costs(self):
        """各コストがマイナスにならないか"""
        result = calculate_profit(price_usd=50.0)
        assert result["fvf_usd"] >= 0
        assert result["intl_fee_usd"] >= 0
        assert result["tariff_jpy"] >= 0
        assert result["shipping_jpy"] >= 0
        assert result["packing_jpy"] >= 0

    def test_profit_margin_division_by_zero(self):
        """販売価格$0のとき利益率が0%になるか（0除算ガード）"""
        result = calculate_profit(price_usd=0.0)
        assert result["profit_margin"] == 0.0

    def test_very_low_price(self):
        """超低価格$0.01でもクラッシュしないか"""
        result = calculate_profit(price_usd=0.01)
        assert isinstance(result["profit_jpy"], int)
        assert result["profit_jpy"] < 0  # 赤字のはず

    def test_very_high_price(self):
        """超高価格$9999でもクラッシュしないか"""
        result = calculate_profit(price_usd=9999.0)
        assert isinstance(result["profit_jpy"], int)
        assert result["profit_jpy"] > 0  # 黒字のはず

    def test_default_values(self):
        """引数なしでデフォルト値が使われるか"""
        result = calculate_profit(price_usd=50.0)
        assert result["cost_jpy"] == config.DEFAULT_COST_JPY
        assert result["country"] == config.DEFAULT_COUNTRY

    def test_uk_more_profitable_than_us(self):
        """イギリス宛はアメリカ宛より利益率が高いか（関税なしのため）"""
        us = calculate_profit(price_usd=50.0, country="us")
        uk = calculate_profit(price_usd=50.0, country="uk")
        assert uk["profit_jpy"] > us["profit_jpy"]
