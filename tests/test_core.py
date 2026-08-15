from datetime import datetime, timedelta, timezone

from scripts.core import (
    ProfitInputs,
    calculate_profit,
    estimate_competition,
    estimate_sales_pace,
    estimate_90d_sold,
    extract_country_of_origin,
    extract_part_numbers,
    extract_part_numbers_from_text,
    international_fee_rate,
    market_score,
    tariff_scenario,
)
from scripts.research import (
    ApiCallBudget,
    EbayApiError,
    aggregate_sales_estimate,
    build_candidate,
    classify_setup_error,
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


def test_snapshot_delta_is_scaled_to_90_days_and_high_after_30_days():
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
    details = estimate_sales_pace(item, history, now=now)
    assert value == 30.0
    assert quality == "observed_delta_30d"
    assert details["confidence"] == "high"
    assert details["auto_verified"] is True


def test_short_snapshot_history_is_not_explosively_annualized():
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    item = {
        "itemId": "v1|short|0",
        "estimatedAvailabilities": [{"estimatedSoldQuantity": 20}],
    }
    history = [
        {
            "item_id": "v1|short|0",
            "observed_at": (now - timedelta(days=1)).isoformat(),
            "sold_quantity": 19,
        }
    ]
    details = estimate_sales_pace(item, history, now=now)
    assert details["quality"] == "insufficient"
    assert details["estimate"] == 0
    assert details["auto_verified"] is False


def test_part_level_delta_keeps_recent_listing_that_disappeared():
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    part = "25550-5SA0A"
    current = {
        "itemId": "current",
        "estimatedAvailabilities": [{"estimatedSoldQuantity": 7}],
    }
    snapshots = {
        "current": [
            {
                "item_id": "current",
                "part_numbers": [part],
                "observed_at": (now - timedelta(days=30)).isoformat(),
                "sold_quantity": 5,
            }
        ],
        "ended": [
            {
                "item_id": "ended",
                "part_numbers": [part],
                "observed_at": (now - timedelta(days=30)).isoformat(),
                "sold_quantity": 10,
            },
            {
                "item_id": "ended",
                "part_numbers": [part],
                "observed_at": (now - timedelta(days=5)).isoformat(),
                "sold_quantity": 13,
            },
        ],
    }
    result = aggregate_sales_estimate(part, [current], snapshots, now)
    # 2 units over 30 days + 3 over 25 days. Each listing uses its own window:
    # (2 / 30 + 3 / 25) * 90 = 16.8.
    assert result["observed_delta"] == 5
    assert result["estimate"] == 16.8
    assert result["observed_days"] == 27.5
    assert result["tracked_listings"] == 2
    assert result["confidence"] == "medium"


def test_part_level_delta_reaches_high_confidence_after_median_30_days():
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    part = "25550-5SA0A"
    items = []
    snapshots = {}
    for index, days in enumerate((30, 35, 40), start=1):
        item_id = f"item-{index}"
        items.append({
            "itemId": item_id,
            "estimatedAvailabilities": [{"estimatedSoldQuantity": 4}],
        })
        snapshots[item_id] = [{
            "item_id": item_id,
            "part_numbers": [part],
            "observed_at": (now - timedelta(days=days)).isoformat(),
            "sold_quantity": 2,
        }]
    result = aggregate_sales_estimate(part, items, snapshots, now)
    assert result["tracked_listings"] == 3
    assert result["observed_days"] == 35.0
    assert result["confidence"] == "high"
    assert result["auto_verified"] is True


def test_profit_includes_tariff_ebay_tax_and_payoneer():
    result = calculate_profit(
        ProfitInputs(
            sale_price_usd=100,
            exchange_rate=150,
            procurement_jpy=4000,
            international_shipping_jpy=2500,
            tariff_rate=0.15,
            payoneer_withdrawal_rate=0.03,
            return_reserve_rate=0.03,
        )
    )
    assert result["tariff_jpy"] == 2250
    assert result["ebay_fee_tax_jpy"] > 0
    assert result["payoneer_fee_jpy"] > 0
    assert result["profit_jpy"] < 5000


def test_market_score_prefers_demand_and_low_competition():
    strong = market_score(20, 10, [80, 82, 85])
    weak = market_score(1, 100, [20, 60, 100])
    assert strong > weak


def test_year_range_and_unit_are_not_part_numbers():
    values = extract_part_numbers_from_text("Fits Nissan 2018-2020 12-VOLT switch")
    assert "2018-2020" not in values
    assert "12-VOLT" not in values


def test_fee_base_includes_buyer_sales_tax_and_japan_consumption_tax():
    result = calculate_profit(
        ProfitInputs(
            sale_price_usd=100,
            exchange_rate=100,
            procurement_jpy=1,
            international_shipping_jpy=1,
            ebay_fee_rate=0.10,
            international_fee_rate=0,
            payoneer_withdrawal_rate=0,
            tariff_rate=0,
            return_reserve_rate=0,
            per_order_fee_usd=0,
            buyer_sales_tax_rate=0.10,
            ebay_fee_tax_rate=0.10,
        )
    )
    assert result["buyer_sales_tax_usd"] == 10.0
    assert result["final_value_fee_jpy"] == 1100
    assert result["ebay_fee_tax_jpy"] == 110
    assert result["ebay_fee_jpy"] == 1210


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


def test_ebay_fee_uses_tiered_rate_low_order_fee_and_tax():
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
            payoneer_withdrawal_rate=0,
            tariff_rate=0,
            return_reserve_rate=0,
            per_order_fee_usd=0.40,
            buyer_sales_tax_rate=0,
            ebay_fee_tax_rate=0.10,
        )
    )
    # $5 × 10% + $4 × 2% + $0.30 = $0.88; Japan consumption tax = $0.088.
    assert low_order["final_value_fee_jpy"] == 88
    assert low_order["ebay_fee_tax_jpy"] == 9
    assert low_order["ebay_fee_jpy"] == 97


def test_payoneer_is_separate_and_applied_after_ebay_fees():
    result = calculate_profit(
        ProfitInputs(
            sale_price_usd=100,
            exchange_rate=100,
            procurement_jpy=1,
            international_shipping_jpy=1,
            ebay_fee_rate=0,
            international_fee_rate=0,
            ebay_fee_tax_rate=0,
            payoneer_withdrawal_rate=0.03,
            tariff_rate=0,
            return_reserve_rate=0,
            per_order_fee_usd=0,
            buyer_sales_tax_rate=0,
        )
    )
    assert result["payoneer_fee_jpy"] == 300


def test_international_fee_volume_tiers():
    assert international_fee_rate(0) == 0.0135
    assert international_fee_rate(3_000) == 0.0120
    assert international_fee_rate(10_000) == 0.0095
    assert international_fee_rate(50_000) == 0.0070
    assert international_fee_rate(100_000) == 0.0040


def test_origin_comes_from_structured_aspect_not_seller_location():
    item = {
        "itemLocation": {"country": "US"},
        "localizedAspects": [{"name": "Country/Region of Manufacture", "value": "Japan"}],
    }
    assert extract_country_of_origin(item) == ("JP", "aspect")
    scenario = tariff_scenario("JP")
    assert scenario["rate"] == 0.15
    assert scenario["confirmation_required"] is True


def test_unknown_origin_uses_conservative_screening_not_false_certainty():
    scenario = tariff_scenario("")
    assert scenario["rate"] == 0.25
    assert scenario["confidence"] == "unknown"
    assert scenario["confirmation_required"] is True


def test_query_rotation_advances_without_random_repeats():
    from scripts.research import choose_queries

    seeds = {
        "brands": [{"label_ja": "日産", "query": "Nissan"}, {"label_ja": "トヨタ", "query": "Toyota"}],
        "authenticity_terms": ["OEM", "Genuine"],
        "small_part_terms": ["switch", "sensor"],
    }
    state = {}
    first = choose_queries(seeds, state, count=2)
    second = choose_queries(seeds, state, count=2)
    assert len(first) == 2
    assert len(second) == 2
    assert {query for query, _ in first}.isdisjoint({query for query, _ in second})
    assert state["query_cursor"] == 0


def test_learning_mode_never_uses_pre_observation_lifetime_sales():
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    part = "25550-5SA0A"
    item = {
        "itemId": "newly-observed",
        "estimatedAvailabilities": [{"estimatedSoldQuantity": 250}],
    }
    result = aggregate_sales_estimate(part, [item], {}, now)
    assert result["confidence"] == "learning"
    assert result["quality"] == "tracking_not_ready"
    assert result["estimate"] == 0
    assert result["low"] == 0
    assert result["high"] == 0
    assert result["lifetime_sold_reference"] == 250
    assert result["auto_verified"] is False


def test_api_call_budget_stops_before_exceeding_limit():
    budget = ApiCallBudget(limit=2)
    budget.consume("oauth")
    budget.consume("browse")
    assert budget.used == 2
    assert budget.remaining == 0
    try:
        budget.consume("another call")
    except EbayApiError as exc:
        assert exc.phase == "budget"
        assert exc.status_code == 429
    else:
        raise AssertionError("budget must raise before the third call")


def test_setup_error_distinguishes_bad_key_from_browse_permission():
    auth_status = classify_setup_error(EbayApiError("bad key", status_code=401, phase="oauth"))
    browse_status = classify_setup_error(EbayApiError("forbidden", status_code=403, phase="browse"))
    assert auth_status[0] == "auth_failed"
    assert browse_status[0] == "browse_access_denied"


def test_tariff_scenario_is_explicitly_screening_only():
    scenario = tariff_scenario("JP")
    assert scenario["rate"] == 0.15
    assert scenario["screening_only"] is True
    assert scenario["is_exact"] is False
    assert scenario["requires_htsus"] is True
    assert scenario["requires_ddp_quote"] is True
    assert scenario["de_minimis_exemption_assumed"] is False


def test_previous_candidate_survives_when_all_current_listings_end():
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    part = "25550-5SA0A"
    snapshots = {
        "ended-item": [
            {
                "item_id": "ended-item",
                "part_numbers": [part],
                "observed_at": (now - timedelta(days=30)).isoformat(),
                "sold_quantity": 1,
            },
            {
                "item_id": "ended-item",
                "part_numbers": [part],
                "observed_at": (now - timedelta(days=5)).isoformat(),
                "sold_quantity": 3,
            },
        ]
    }
    candidate = build_candidate(
        part_number=part,
        items=[],
        competition={
            "active_count": 0,
            "known": True,
            "confidence": "high",
            "match_rate": 1.0,
            "search_total": 0,
            "search_returned": 0,
            "search_matched": 0,
        },
        prices=[],
        snapshots=snapshots,
        observed_at=now,
        queries=[part],
        rakuten=None,
        previous={
            "part_number": part,
            "title": "Nissan genuine switch 25550-5SA0A",
            "brand": "Nissan",
            "price_median_usd": 80,
            "price_p25_usd": 75,
            "price_p75_usd": 90,
            "country_of_origin": "JP",
            "origin_confidence": "high",
        },
        default_shipping_jpy=2800,
    )
    assert candidate["price_median_usd"] == 80
    assert candidate["active_competition"] == 0
    assert candidate["sales_observed_delta"] == 2
    assert candidate["sold_90d_est"] == 7.2
    assert candidate["country_of_origin"] == "JP"
    assert candidate["price_source"] == "previous_browse_listing"


def test_missing_secrets_writes_setup_status_without_touching_results(tmp_path, monkeypatch):
    import json
    import scripts.research as research

    setup_path = tmp_path / "setup_status.json"
    result_path = tmp_path / "results.json"
    result_path.write_text('{"sentinel": true}', encoding="utf-8")
    monkeypatch.setattr(research, "SETUP_STATUS_PATH", setup_path)
    monkeypatch.setattr(research, "RESULTS_PATH", result_path)
    monkeypatch.delenv("EBAY_CLIENT_ID", raising=False)
    monkeypatch.delenv("EBAY_CLIENT_SECRET", raising=False)

    assert research.run() == 0
    setup = json.loads(setup_path.read_text(encoding="utf-8"))
    assert setup["status"] == "missing_secrets"
    assert setup["ready"] is False
    assert result_path.read_text(encoding="utf-8") == '{"sentinel": true}'
