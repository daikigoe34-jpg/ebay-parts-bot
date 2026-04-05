"""
part_number.py のユニットテスト
"""

from src.part_number import extract_part_number, get_monotaro_url, get_source_info


class TestExtractPartNumber:
    """品番抽出のテスト"""

    def test_nissan_oil_filter(self):
        """日産オイルフィルター: 15208-65F0E"""
        title = "Genuine Nissan Oil Filter 15208-65F0E Japan OEM"
        assert extract_part_number(title) == "15208-65F0E"

    def test_toyota_brake_pad(self):
        """トヨタブレーキパッド: 04465-26420"""
        title = "OEM Toyota Brake Pad Front 04465-26420 JDM Genuine"
        assert extract_part_number(title) == "04465-26420"

    def test_honda_air_filter(self):
        """ホンダエアフィルター: 17220-5BA-A00（3セグメント）"""
        title = "Genuine Honda Civic Air Filter 17220-5BA-A00 Japan"
        assert extract_part_number(title) == "17220-5BA-A00"

    def test_toyota_thermostat(self):
        """トヨタサーモスタット: 90916-03100"""
        title = "Toyota Genuine Thermostat 90916-03100 Japan OEM"
        assert extract_part_number(title) == "90916-03100"

    def test_subaru_cabin_filter(self):
        """スバルキャビンフィルター: 72880FG000（ハイフンなし）"""
        title = "Subaru OEM Cabin Filter 72880FG000 Forester Japan"
        assert extract_part_number(title) == "72880FG000"

    def test_subaru_head_gasket(self):
        """スバルヘッドガスケット: 11044AA770（ハイフンなし）"""
        title = "Subaru Genuine Head Gasket 11044AA770 EJ25 Japan"
        assert extract_part_number(title) == "11044AA770"

    def test_mazda_spark_plug(self):
        """マツダスパークプラグ: PE5R-18-110"""
        title = "Mazda Genuine Spark Plug Set PE5R-18-110 x4 Japan"
        assert extract_part_number(title) == "PE5R-18-110"

    def test_mazda_fuel_filter(self):
        """マツダフューエルフィルター: KL47-20-490A（3セグメント）"""
        title = "Mazda Genuine Fuel Filter KL47-20-490A Japan OEM"
        assert extract_part_number(title) == "KL47-20-490A"

    def test_no_part_number(self):
        """品番なしのタイトル"""
        title = "Car Parts Accessories Japan Import"
        assert extract_part_number(title) is None

    def test_empty_title(self):
        """空のタイトル"""
        assert extract_part_number("") is None
        assert extract_part_number(None) is None


class TestGetMonotaroUrl:
    """モノタロウURL生成のテスト"""

    def test_normal_part_number(self):
        """通常の品番"""
        url = get_monotaro_url("15208-65F0E")
        assert "monotaro.com" in url
        assert "15208-65F0E" in url

    def test_empty_part_number(self):
        """空の品番"""
        assert get_monotaro_url("") == ""
        assert get_monotaro_url(None) == ""


class TestGetSourceInfo:
    """仕入れ情報取得のテスト"""

    def test_with_part_number(self):
        """品番ありの場合"""
        info = get_source_info("Genuine Nissan Oil Filter 15208-65F0E Japan")
        assert info["part_number"] == "15208-65F0E"
        assert "monotaro.com" in info["monotaro_url"]

    def test_without_part_number(self):
        """品番なしの場合"""
        info = get_source_info("Some random item")
        assert info["part_number"] == ""
        assert info["monotaro_url"] == ""
