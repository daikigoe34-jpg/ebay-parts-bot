from datetime import datetime, timedelta, timezone

from scripts.core import (
    ProfitInputs,
    calculate_profit,
    estimate_competition,
    estimate_90d_sold,
    extract_part_numbers,
    extract_part_numbers_from_text,
    market_score,
)


def test_extract_toyota_and_honda_numbers():
    text = "Genuine Toyota 90915-YZZF2 / Honda 15400-PLM-A02 oil filter"
    values = extract_part_numbers_from_text(text)
    assert "90915-YZZF2" in values
    assert "15400-PLM-A02" in values


def test_aspect_is_preferred():
    item = {
        "title": "Nissan OEM switch 2018 2019",
        "localizedAspects": [
            {"name": "Manufacturer Part Number", "value": "25550-5SA0A"},
        ],
    }
    assert extract_part_numbers(item) == ["25550-5SA0A"]


def test_snapshot_delta_is_annualized_to_90_days():
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    item = {
        "itemId": "v1|123|0",
        "estimatedAvailabilities": [{"estimatedSoldQuantity": 20}],
    }
    history = [
        {
            "item_id": "v1|123|0",
            "observed_at": (now - timedelta(days=30)).isoformat(),
            "sold_quantity": 10,
        }
    ]
    value, quality = estimate_90d_sold(item, history, now=now)
    assert value == 30.0
    assert quality == "observed_delta"


def test_profit_includes_tariff_and_fees():
    result = calculate_profit(
        ProfitInputs(
            sale_price_usd=100,
            exchange_rate=150,
            procurement_jpy=4000,
            international_shipping_jpy=2500,
            tariff_rate=0.15,
            fx_spread_rate=0.02,
            return_reserve_rate=0.03,
        )
    )
    assert result["tariff_jpy"] == 2250
    assert result["profit_jpy"] < 5000


def test_market_score_prefers_demand_and_low_competition():
    strong = market_score(20, 10, [80, 82, 85])
    weak = market_score(1, 100, [20, 60, 100])
    assert strong > weak


def test_year_range_and_unit_are_not_part_numbers():
    values = extract_part_numbers_from_text("Fits Nissan 2018-2020 12-VOLT switch")
    assert "2018-2020" not in values
    assert "12-VOLT" not in values


def test_fee_base_includes_assumed_buyer_sales_tax():
    result = calculate_profit(
        ProfitInputs(
            sale_price_usd=100,
            exchange_rate=100,
            procurement_jpy=1,
            international_shipping_jpy=1,
            ebay_fee_rate=0.10,
            international_fee_rate=0,
            fx_spread_rate=0,
            tariff_rate=0,
            return_reserve_rate=0,
            per_order_fee_usd=0,
            buyer_sales_tax_rate=0.10,
        )
    )
    assert result["buyer_sales_tax_usd"] == 10.0
    assert result["ebay_fee_jpy"] == 1100


def test_fitment_and_dimension_tokens_are_not_part_numbers():
    values = extract_part_numbers_from_text("2WD-4WD 3-PIN 4-DOOR 10X20MM 2-0L 25550-5SA0A")
    assert values == ["25550-5SA0A"]


def test_seller_sku_does_not_override_real_title_part_number():
    item = {
        "title": "Nissan genuine switch 25550-5SA0A",
        "localizedAspects": [{"name": "SKU", "value": "SELLER-12345"}],
    }
    assert extract_part_numbers(item) == ["25550-5SA0A"]


def test_competition_estimate_scales_keyword_total_by_exact_match_rate():
    result = estimate_competition(
        total_results=120,
        returned_count=50,
        matched_count=40,
        observed_details_count=15,
    )
    assert result["active_count"] == 96
    assert result["known"] is True
    assert result["match_rate"] == 0.8
    assert result["confidence"] == "high"


def test_competition_estimate_does_not_claim_keyword_total_without_matches():
    result = estimate_competition(
        total_results=900,
        returned_count=50,
        matched_count=0,
        observed_details_count=2,
    )
    assert result["active_count"] == 2
    assert result["confidence"] == "low"


def test_ebay_fee_uses_tiered_rate_and_low_order_fixed_fee():
    low_order = calculate_profit(
        ProfitInputs(
            sale_price_usd=9,
            exchange_rate=100,
            procurement_jpy=1,
            international_shipping_jpy=1,
            ebay_fee_rate=0.10,
            ebay_fee_threshold_usd=5,
            ebay_fee_above_rate=0.02,
            international_fee_rate=0,
            fx_spread_rate=0,
            tariff_rate=0,
            return_reserve_rate=0,
            per_order_fee_usd=0.40,
            buyer_sales_tax_rate=0,
        )
    )
    # $5 × 10% + $4 × 2% + $0.30 = $0.88
    assert low_order["ebay_fee_jpy"] == 88
