from datetime import datetime, timedelta, timezone

import pytest

from scripts.core import normalize_country
from scripts.research import aggregate_sales_estimate, append_snapshot, item_price_usd, load_json


def test_non_usd_or_unknown_currency_never_becomes_a_usd_price():
    for currency in ("JPY", "EUR", "", None):
        assert item_price_usd({"price": {"value": "15000", "currency": currency}}) == 0
    assert item_price_usd({"price": {"value": "123.45", "currency": "USD"}}) == 123.45


def test_missing_sold_quantity_is_saved_as_unknown_not_zero():
    snapshots = {}
    append_snapshot(snapshots, {"itemId": "item1"}, datetime.now(timezone.utc), ["25550-5SA0A"])
    assert snapshots["item1"][0]["sold_quantity"] is None


def test_quantity_recovery_does_not_create_fictitious_sales():
    now = datetime(2026, 9, 8, tzinfo=timezone.utc)
    snapshots = {"item1": [
        {"observed_at": (now - timedelta(days=days)).isoformat(), "sold_quantity": qty,
         "part_numbers": ["25550-5SA0A"]}
        for days, qty in [(40, 100), (30, 0), (20, 100), (10, None)]
    ]}
    item = {"itemId": "item1", "estimatedAvailabilities": [{"estimatedSoldQuantity": 102}]}
    result = aggregate_sales_estimate("25550-5SA0A", [item], snapshots, now)
    assert result["observed_delta"] == 2
    assert result["estimate"] == 4.5


def test_unknown_country_text_does_not_match_two_letter_substrings():
    assert normalize_country("OTHER") == ""
    assert normalize_country("NOT SPECIFIED") == ""
    assert normalize_country("UNKNOWN") == ""
    assert normalize_country("Made in Japan") == "JP"


def test_corrupted_history_stops_instead_of_being_replaced_by_empty_data(tmp_path):
    path = tmp_path / "snapshots.json"
    path.write_text('{"broken":')
    with pytest.raises(ValueError):
        load_json(path, {})
    assert path.read_text() == '{"broken":'
