"""
config.py のユニットテスト
"""

from src import config


class TestConfigValues:
    """設定値の妥当性チェック"""

    def test_rates_are_decimals_not_percentages(self):
        """手数料率が0〜1の小数で定義されているか（パーセントではなく）"""
        assert 0 < config.FVF_RATE < 1, f"FVF_RATE={config.FVF_RATE} はパーセント値では？0〜1で指定"
        assert 0 < config.INTERNATIONAL_FEE_RATE < 1
        assert 0 < config.DDP_TARIFF_RATE < 1
        assert 0 < config.PAYONEER_FX_MARKUP < 1

    def test_required_parameters_exist(self):
        """必須パラメータが全て定義されているか"""
        assert hasattr(config, "USD_TO_JPY")
        assert hasattr(config, "FVF_RATE")
        assert hasattr(config, "FVF_FIXED_FEE_USD")
        assert hasattr(config, "INTERNATIONAL_FEE_RATE")
        assert hasattr(config, "DDP_TARIFF_RATE")
        assert hasattr(config, "PAYONEER_FX_MARKUP")
        assert hasattr(config, "DEFAULT_COST_JPY")
        assert hasattr(config, "DEFAULT_WEIGHT_G")
        assert hasattr(config, "PACKING_COST_JPY")
        assert hasattr(config, "SPEEDPAK_TABLES")

    def test_exchange_rate_positive(self):
        """為替レートが正の値か"""
        assert config.USD_TO_JPY > 0

    def test_speedpak_tables_not_empty(self):
        """送料テーブルが空でないか"""
        for country, table in config.SPEEDPAK_TABLES.items():
            assert len(table) > 0, f"{country}の送料テーブルが空です"

    def test_speedpak_tables_sorted(self):
        """送料テーブルが重量順にソートされているか"""
        for country, table in config.SPEEDPAK_TABLES.items():
            weights = [w for w, _ in table]
            assert weights == sorted(weights), f"{country}のテーブルがソートされていません"

    def test_search_keywords_not_empty(self):
        """検索キーワードが空でないか"""
        assert len(config.SEARCH_KEYWORDS) > 0

    def test_default_country_in_tables(self):
        """デフォルト国コードがテーブルに存在するか"""
        assert config.DEFAULT_COUNTRY in config.SPEEDPAK_TABLES

    def test_price_filter_range(self):
        """価格フィルタの範囲が正しいか"""
        assert config.MIN_PRICE_USD > 0
        assert config.MAX_PRICE_USD > config.MIN_PRICE_USD

    def test_browse_api_url_exists(self):
        """Browse API URLが定義されているか"""
        assert hasattr(config, "EBAY_BROWSE_API_URL")
        assert "browse" in config.EBAY_BROWSE_API_URL
