from __future__ import annotations

import math
import re
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence

DASH_TRANSLATION = str.maketrans({
    "–": "-",
    "—": "-",
    "−": "-",
    "‐": "-",
    "‑": "-",
    "ー": "-",
})

NOISE_TOKENS = {
    "NISSAN", "TOYOTA", "HONDA", "MAZDA", "SUBARU", "MITSUBISHI",
    "SUZUKI", "ISUZU", "LEXUS", "INFINITI", "ACURA", "OEM", "GENUINE",
    "FACTORY", "FRONT", "REAR", "RIGHT", "LEFT", "UPPER", "LOWER",
    "BLACK", "WHITE", "SILVER", "NEW", "USED", "PAIR", "PCS", "PIECE",
    "ASSEMBLY", "ASSY", "PART", "PARTS", "DIRECT", "REPLACEMENT",
}

ASPECT_PART_KEYS = {
    "manufacturer part number",
    "manufacturerpartnumber",
    "oe/oem part number",
    "oe oem part number",
    "oem part number",
    "part number",
    "reference oe/oem number",
    "other part number",
}

# OEM-style identifiers seen in Japanese auto parts.
PART_PATTERNS = [
    # Toyota/Nissan and similar 5-5 or 5-4-2 numeric/alphanumeric structures.
    re.compile(r"(?<![A-Z0-9])\d{5}-[A-Z0-9]{4,6}(?:-[A-Z0-9]{1,4})?(?![A-Z0-9])"),
    # Honda-like 5-3-3.
    re.compile(r"(?<![A-Z0-9])\d{5}-[A-Z0-9]{3}-[A-Z0-9]{3}(?![A-Z0-9])"),
    # Mazda/Ford/general hyphenated alphanumeric identifiers.
    re.compile(r"(?<![A-Z0-9])[A-Z0-9]{2,7}(?:-[A-Z0-9]{2,8}){1,3}(?![A-Z0-9])"),
    # Subaru-style compact identifiers, Mitsubishi MR/MB etc.
    re.compile(r"(?<![A-Z0-9])(?:[A-Z]{1,4}\d{5,10}[A-Z0-9]{0,4}|\d{4,7}[A-Z]{1,4}\d{2,7})(?![A-Z0-9])"),
]


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").translate(DASH_TRANSLATION).upper()).strip()


def normalize_part_number(value: Any) -> str:
    text = normalize_text(value)
    text = text.strip(" .,:;()[]{}\"'")
    text = re.sub(r"\s*-\s*", "-", text)
    text = re.sub(r"[^A-Z0-9-]", "", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text


def is_plausible_part_number(value: str) -> bool:
    value = normalize_part_number(value)
    if not (5 <= len(value) <= 24):
        return False
    if value in NOISE_TOKENS:
        return False
    if re.fullmatch(r"(?:19|20)\d{2}(?:-(?:19|20)\d{2})?", value):
        return False
    if re.fullmatch(r"\d{1,3}-(?:V|VOLT|MM|CM|IN|INCH|PCS|PIECE|SPEED|PIN|PINS|DOOR|DOORS|CYL|CYLINDER|HOLE|HOLES|PORT|PORTS|WAY|WIRE|WIRES)", value):
        return False
    if re.fullmatch(r"(?:2WD|4WD|AWD|FWD|RWD)(?:-(?:2WD|4WD|AWD|FWD|RWD))+", value):
        return False
    if re.fullmatch(r"\d+(?:X\d+){1,3}(?:MM|CM|IN|INCH)?", value):
        return False
    if re.fullmatch(r"\d{1,2}-\d{1,2}L", value):
        return False
    if not any(ch.isdigit() for ch in value):
        return False
    # Numeric-only identifiers are accepted only with a common OEM-style split.
    if not any(ch.isalpha() for ch in value):
        if not re.fullmatch(r"\d{5}-\d{4,6}(?:-\d{1,4})?", value):
            return False
    if any(token == value for token in NOISE_TOKENS):
        return False
    return True


def split_aspect_values(value: str) -> list[str]:
    text = normalize_text(value)
    chunks = re.split(r"[,;/|\n]+", text)
    output: list[str] = []
    for chunk in chunks:
        normalized = normalize_part_number(chunk)
        if is_plausible_part_number(normalized):
            output.append(normalized)
        else:
            output.extend(extract_part_numbers_from_text(chunk))
    return dedupe(output)


def extract_part_numbers_from_text(text: Any) -> list[str]:
    normalized = normalize_text(text)
    candidates: list[str] = []
    for pattern in PART_PATTERNS:
        for match in pattern.finditer(normalized):
            value = normalize_part_number(match.group(0))
            if is_plausible_part_number(value):
                candidates.append(value)
    return dedupe(candidates)


def extract_part_numbers(item: Mapping[str, Any]) -> list[str]:
    """Extract part numbers, preferring structured eBay aspects over title text."""
    aspect_candidates: list[str] = []
    for aspect in item.get("localizedAspects") or []:
        name = normalize_text(aspect.get("name", "")).lower()
        compact_name = re.sub(r"[^a-z0-9]", "", name)
        if name in ASPECT_PART_KEYS or compact_name in {
            re.sub(r"[^a-z0-9]", "", key) for key in ASPECT_PART_KEYS
        }:
            aspect_candidates.extend(split_aspect_values(aspect.get("value", "")))
    aspect_candidates = dedupe(aspect_candidates)
    if aspect_candidates:
        return aspect_candidates[:6]
    return extract_part_numbers_from_text(item.get("title", ""))[:6]


def dedupe(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def parse_iso8601(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def sold_quantity(item: Mapping[str, Any]) -> int:
    quantities: list[int] = []
    for availability in item.get("estimatedAvailabilities") or []:
        qty = availability.get("estimatedSoldQuantity")
        if qty is not None:
            try:
                quantities.append(max(0, int(qty)))
            except (TypeError, ValueError):
                pass
    return max(quantities, default=0)


def estimate_90d_sold(
    item: Mapping[str, Any],
    history: Sequence[Mapping[str, Any]] | None,
    now: datetime | None = None,
) -> tuple[float, str]:
    """Estimate 90-day units from snapshots, otherwise lifetime velocity.

    Returns (estimated_units_90d, quality_label).
    """
    now = now or datetime.now(timezone.utc)
    current_qty = sold_quantity(item)
    current_item_id = str(item.get("itemId") or "")

    usable: list[tuple[datetime, int]] = []
    for row in history or []:
        if current_item_id and str(row.get("item_id") or current_item_id) != current_item_id:
            continue
        dt = parse_iso8601(row.get("observed_at"))
        if dt is None:
            continue
        try:
            qty = max(0, int(row.get("sold_quantity", 0)))
        except (TypeError, ValueError):
            continue
        if 0 < (now - dt).total_seconds() <= 95 * 86400:
            usable.append((dt, qty))

    usable.sort(key=lambda pair: pair[0])
    if usable:
        earliest_dt, earliest_qty = usable[0]
        days = max((now - earliest_dt).total_seconds() / 86400, 0.01)
        delta = current_qty - earliest_qty
        if days >= 2 and delta >= 0:
            return round(delta / days * 90, 2), "observed_delta"

    created = parse_iso8601(item.get("itemCreationDate") or item.get("itemStartDate"))
    if created and current_qty > 0:
        age_days = max((now - created).total_seconds() / 86400, 1.0)
        # For young listings, current sold quantity is already within 90 days.
        if age_days <= 90:
            return float(current_qty), "listing_lifetime_under_90d"
        return round(current_qty / age_days * 90, 2), "lifetime_velocity_estimate"

    return 0.0, "insufficient"


def median(values: Sequence[float]) -> float:
    cleaned = [float(v) for v in values if v is not None and math.isfinite(float(v))]
    return float(statistics.median(cleaned)) if cleaned else 0.0


def percentile(values: Sequence[float], percentile_value: float) -> float:
    cleaned = sorted(float(v) for v in values if v is not None and math.isfinite(float(v)))
    if not cleaned:
        return 0.0
    if len(cleaned) == 1:
        return cleaned[0]
    index = (len(cleaned) - 1) * percentile_value
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return cleaned[lower]
    fraction = index - lower
    return cleaned[lower] * (1 - fraction) + cleaned[upper] * fraction


def estimate_competition(
    total_results: Any,
    returned_count: Any,
    matched_count: Any,
    observed_details_count: Any = 0,
) -> dict[str, Any]:
    """Estimate relevant active listings from a noisy exact-keyword search.

    eBay's search ``total`` is the number of keyword matches, not necessarily
    the number of listings for the same OEM part.  We therefore estimate the
    relevant total from the share of the returned sample whose title contains
    the normalized part number.  The confidence label is deliberately strict
    so the UI does not present a precise-looking competition count when the
    evidence is weak.
    """

    total = max(0, int(safe_float(total_results, 0)))
    returned = max(0, int(safe_float(returned_count, 0)))
    matched = max(0, int(safe_float(matched_count, 0)))
    observed = max(0, int(safe_float(observed_details_count, 0)))
    if returned:
        matched = min(matched, returned)

    if returned <= 0 or matched <= 0:
        known = observed > 0
        return {
            "active_count": observed,
            "known": known,
            "match_rate": 0.0,
            "confidence": "low" if known else "unknown",
            "search_total": total,
            "search_returned": returned,
            "search_matched": matched,
        }

    match_rate = matched / returned
    estimated = max(observed, matched, round(total * match_rate))

    if returned >= 20 and matched >= 10 and match_rate >= 0.80:
        confidence = "high"
    elif returned >= 10 and matched >= 5 and match_rate >= 0.50:
        confidence = "medium"
    else:
        confidence = "low"

    return {
        "active_count": estimated,
        "known": True,
        "match_rate": round(match_rate, 3),
        "confidence": confidence,
        "search_total": total,
        "search_returned": returned,
        "search_matched": matched,
    }


def market_score(sold_90d: float, active_count: int, prices: Sequence[float]) -> int:
    active = max(int(active_count), 0)
    demand_ratio = sold_90d / max(active, 1)
    demand_points = min(35.0, math.log1p(max(sold_90d, 0)) / math.log(21) * 35)
    ratio_points = min(30.0, demand_ratio / 1.5 * 30)
    competition_points = 20.0 / (1.0 + active / 18.0)

    price_points = 0.0
    cleaned = [float(v) for v in prices if v and float(v) > 0]
    if cleaned:
        med = median(cleaned)
        if med >= 25:
            price_points += min(8.0, med / 100 * 8)
        if len(cleaned) >= 2:
            mean = statistics.fmean(cleaned)
            if mean:
                cv = statistics.pstdev(cleaned) / mean
                price_points += max(0.0, 7.0 * (1.0 - min(cv, 1.0)))
        else:
            price_points += 2.0

    return max(0, min(100, round(demand_points + ratio_points + competition_points + price_points)))


def market_judgment(score: int, sold_90d: float, active_count: int, quality: str) -> str:
    if quality == "insufficient" or sold_90d < 1:
        return "データ不足"
    if score >= 72 and sold_90d >= 5 and active_count <= 80:
        return "有望"
    if score >= 55 and sold_90d >= 2:
        return "候補"
    if score >= 40:
        return "監視"
    return "見送り"


@dataclass(frozen=True)
class ProfitInputs:
    sale_price_usd: float
    buyer_shipping_usd: float = 0.0
    exchange_rate: float = 150.0
    procurement_jpy: float = 0.0
    domestic_shipping_jpy: float = 0.0
    international_shipping_jpy: float = 0.0
    packaging_jpy: float = 0.0
    customs_fixed_jpy: float = 0.0
    ebay_fee_rate: float = 0.136
    ebay_fee_threshold_usd: float = 7500.0
    ebay_fee_above_rate: float = 0.0235
    international_fee_rate: float = 0.0135
    promoted_listing_rate: float = 0.0
    fx_spread_rate: float = 0.02
    tariff_rate: float = 0.15
    return_reserve_rate: float = 0.03
    per_order_fee_usd: float = 0.40
    buyer_sales_tax_rate: float = 0.07


def calculate_profit(inputs: ProfitInputs) -> dict[str, float | str]:
    item_revenue_jpy = inputs.sale_price_usd * inputs.exchange_rate
    shipping_revenue_jpy = inputs.buyer_shipping_usd * inputs.exchange_rate
    gross_jpy = item_revenue_jpy + shipping_revenue_jpy
    buyer_sales_tax_usd = (inputs.sale_price_usd + inputs.buyer_shipping_usd) * inputs.buyer_sales_tax_rate
    fee_base_usd = inputs.sale_price_usd + inputs.buyer_shipping_usd + buyer_sales_tax_usd

    fee_threshold = max(inputs.ebay_fee_threshold_usd, 0.0)
    lower_fee_base = min(fee_base_usd, fee_threshold) if fee_threshold else 0.0
    upper_fee_base = max(fee_base_usd - fee_threshold, 0.0) if fee_threshold else fee_base_usd
    percentage_fee_usd = (
        lower_fee_base * inputs.ebay_fee_rate
        + upper_fee_base * inputs.ebay_fee_above_rate
    )
    per_order_fee_usd = 0.30 if fee_base_usd <= 10 else inputs.per_order_fee_usd
    ebay_fee_jpy = (percentage_fee_usd + per_order_fee_usd) * inputs.exchange_rate
    international_fee_jpy = fee_base_usd * inputs.international_fee_rate * inputs.exchange_rate
    promoted_fee_jpy = fee_base_usd * inputs.promoted_listing_rate * inputs.exchange_rate
    fx_cost_jpy = gross_jpy * inputs.fx_spread_rate
    # The declared customs value is modeled as item price only; shipping can be added manually via customs_fixed_jpy if needed.
    tariff_jpy = item_revenue_jpy * inputs.tariff_rate
    return_reserve_jpy = gross_jpy * inputs.return_reserve_rate

    variable_costs = (
        ebay_fee_jpy
        + international_fee_jpy
        + promoted_fee_jpy
        + fx_cost_jpy
        + tariff_jpy
        + return_reserve_jpy
    )
    fixed_costs = (
        inputs.procurement_jpy
        + inputs.domestic_shipping_jpy
        + inputs.international_shipping_jpy
        + inputs.packaging_jpy
        + inputs.customs_fixed_jpy
    )
    total_cost_jpy = variable_costs + fixed_costs
    profit_jpy = gross_jpy - total_cost_jpy
    margin = profit_jpy / gross_jpy if gross_jpy else 0.0

    if inputs.procurement_jpy <= 0 or inputs.international_shipping_jpy <= 0:
        judgment = "仕入・送料未入力"
    elif profit_jpy >= 5000 and margin >= 0.25:
        judgment = "販売候補"
    elif profit_jpy >= 3000 and margin >= 0.18:
        judgment = "条件付き候補"
    elif profit_jpy > 0:
        judgment = "薄利"
    else:
        judgment = "見送り"

    return {
        "gross_jpy": round(gross_jpy),
        "buyer_sales_tax_usd": round(buyer_sales_tax_usd, 2),
        "ebay_fee_jpy": round(ebay_fee_jpy),
        "international_fee_jpy": round(international_fee_jpy),
        "promoted_fee_jpy": round(promoted_fee_jpy),
        "fx_cost_jpy": round(fx_cost_jpy),
        "tariff_jpy": round(tariff_jpy),
        "return_reserve_jpy": round(return_reserve_jpy),
        "fixed_costs_jpy": round(fixed_costs),
        "total_cost_jpy": round(total_cost_jpy),
        "profit_jpy": round(profit_jpy),
        "margin_rate": round(margin, 4),
        "judgment": judgment,
    }
