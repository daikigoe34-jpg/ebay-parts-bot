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

ASPECT_ORIGIN_KEYS = {
    "country/region of manufacture",
    "country of origin",
    "country/region of origin",
    "origin",
    "manufacturing country and region",
}

COUNTRY_ALIASES = {
    "JAPAN": "JP",
    "JP": "JP",
    "JPN": "JP",
    "日本": "JP",
    "UNITED STATES": "US",
    "UNITED STATES OF AMERICA": "US",
    "USA": "US",
    "U.S.A.": "US",
    "US": "US",
    "CHINA": "CN",
    "MAINLAND CHINA": "CN",
    "CN": "CN",
    "KOREA": "KR",
    "SOUTH KOREA": "KR",
    "REPUBLIC OF KOREA": "KR",
    "KR": "KR",
    "TAIWAN": "TW",
    "TW": "TW",
    "THAILAND": "TH",
    "TH": "TH",
    "MEXICO": "MX",
    "MX": "MX",
    "CANADA": "CA",
    "CA": "CA",
    "GERMANY": "DE",
    "DE": "DE",
    "UNITED KINGDOM": "GB",
    "UK": "GB",
    "GB": "GB",
}

# OEM-style identifiers seen in Japanese auto parts.
PART_PATTERNS = [
    re.compile(r"(?<![A-Z0-9])\d{5}-[A-Z0-9]{4,6}(?:-[A-Z0-9]{1,4})?(?![A-Z0-9])"),
    re.compile(r"(?<![A-Z0-9])\d{5}-[A-Z0-9]{3}-[A-Z0-9]{3}(?![A-Z0-9])"),
    re.compile(r"(?<![A-Z0-9])[A-Z0-9]{2,7}(?:-[A-Z0-9]{2,8}){1,3}(?![A-Z0-9])"),
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
    if not any(ch.isalpha() for ch in value):
        if not re.fullmatch(r"\d{5}-\d{4,6}(?:-\d{1,4})?", value):
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
    compact_keys = {re.sub(r"[^a-z0-9]", "", key) for key in ASPECT_PART_KEYS}
    for aspect in item.get("localizedAspects") or []:
        name = normalize_text(aspect.get("name", "")).lower()
        compact_name = re.sub(r"[^a-z0-9]", "", name)
        if name in ASPECT_PART_KEYS or compact_name in compact_keys:
            aspect_candidates.extend(split_aspect_values(aspect.get("value", "")))
    aspect_candidates = dedupe(aspect_candidates)
    if aspect_candidates:
        return aspect_candidates[:6]
    return extract_part_numbers_from_text(item.get("title", ""))[:6]


def normalize_country(value: Any) -> str:
    text = normalize_text(value)
    text = re.sub(r"\s*\([^)]*\)\s*", " ", text).strip()
    if text in COUNTRY_ALIASES:
        return COUNTRY_ALIASES[text]
    for alias, code in COUNTRY_ALIASES.items():
        if alias and alias in text:
            return code
    if re.fullmatch(r"[A-Z]{2}", text):
        return text
    return ""


def extract_country_of_origin(item: Mapping[str, Any]) -> tuple[str, str]:
    """Return ISO-like origin code and confidence from structured item aspects.

    Seller/item location is intentionally ignored because it is not country of origin.
    """
    compact_keys = {re.sub(r"[^a-z0-9]", "", key) for key in ASPECT_ORIGIN_KEYS}
    for aspect in item.get("localizedAspects") or []:
        name = normalize_text(aspect.get("name", "")).lower()
        compact_name = re.sub(r"[^a-z0-9]", "", name)
        if name in ASPECT_ORIGIN_KEYS or compact_name in compact_keys:
            code = normalize_country(aspect.get("value"))
            if code:
                return code, "aspect"
    return "", "unknown"


def tariff_scenario(origin_code: str) -> dict[str, Any]:
    """Return a conservative customs screening scenario, never a legal duty rate.

    The exact US duty can change with HTSUS classification, country of origin,
    Section 232 scope, temporary measures, and the carrier's DDP calculation.
    The displayed rate only prevents the tool from overstating profit before
    those facts are confirmed.
    """
    origin = normalize_country(origin_code)
    common = {
        "screening_only": True,
        "is_exact": False,
        "confirmation_required": True,
        "requires_htsus": True,
        "requires_origin_proof": True,
        "requires_ddp_quote": True,
        "de_minimis_exemption_assumed": False,
        "last_verified": "2026-08-15",
    }
    if origin == "JP":
        return {
            **common,
            "rate": 0.15,
            "low_rate": 0.15,
            "high_rate": 0.25,
            "basis": "japan_origin_auto_parts_screening_baseline",
            "confidence": "medium",
            "policy_note": (
                "Japan-origin automotive-parts screening baseline. Exact duty depends on HTSUS, "
                "current Section 232 scope, and any other measures in force on the import date."
            ),
        }
    if origin == "US":
        return {
            **common,
            "rate": 0.0,
            "low_rate": 0.0,
            "high_rate": 0.15,
            "basis": "us_origin_return_screening",
            "confidence": "low",
            "policy_note": "US-origin return screening only; origin proof and other fees still require confirmation.",
        }
    if origin:
        return {
            **common,
            "rate": 0.25,
            "low_rate": 0.15,
            "high_rate": 0.50,
            "basis": "non_japan_origin_conservative_screening",
            "confidence": "low",
            "policy_note": "Conservative placeholder until HTSUS and country of origin are confirmed.",
        }
    return {
        **common,
        "rate": 0.25,
        "low_rate": 0.15,
        "high_rate": 0.50,
        "basis": "unknown_origin_conservative_screening",
        "confidence": "unknown",
        "policy_note": "Unknown-origin placeholder; never use this as the final legal duty rate.",
    }


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
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


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


def count_rate_interval(delta: float, days: float) -> tuple[float, float]:
    """Return a deliberately wide screening interval for a 90-day count rate."""
    days = max(days, 0.01)
    estimate = max(delta, 0.0) / days * 90
    if delta <= 0:
        return 0.0, round(3.0 / days * 90, 2)
    spread = 1.96 * math.sqrt(delta + 1.0) / days * 90
    return round(max(0.0, estimate - spread), 2), round(estimate + spread, 2)


def estimate_sales_pace(
    item: Mapping[str, Any],
    history: Sequence[Mapping[str, Any]] | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Estimate a 90-day sales *pace* for one currently active listing.

    This is not historical completed-listing data. Snapshot deltas are preferred.
    A minimum of seven observed days is required before annualizing a delta; shorter
    histories remain in learning mode to avoid explosive one-day extrapolation.
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
        age_seconds = (now - dt).total_seconds()
        if 0 < age_seconds <= 100 * 86400:
            usable.append((dt, qty))

    usable.sort(key=lambda pair: pair[0])
    if usable:
        earliest_dt, earliest_qty = usable[0]
        observed_days = max((now - earliest_dt).total_seconds() / 86400, 0.01)
        delta = current_qty - earliest_qty
        if observed_days >= 7 and delta >= 0:
            estimate = round(delta / observed_days * 90, 2)
            low, high = count_rate_interval(delta, observed_days)
            confidence = "high" if observed_days >= 30 else "medium" if observed_days >= 14 else "low"
            quality = "observed_delta_30d" if observed_days >= 30 else "observed_delta"
            return {
                "estimate": estimate,
                "low": low,
                "high": high,
                "quality": quality,
                "confidence": confidence,
                "observed_days": round(observed_days, 1),
                "observed_delta": delta,
                "auto_verified": observed_days >= 30,
            }

    created = parse_iso8601(item.get("itemCreationDate") or item.get("itemStartDate"))
    if created and current_qty > 0:
        age_days = max((now - created).total_seconds() / 86400, 1.0)
        estimate = float(current_qty) if age_days <= 90 else round(current_qty / age_days * 90, 2)
        return {
            "estimate": estimate,
            "low": 0.0,
            "high": round(max(estimate * 2.0, estimate + 3.0), 2),
            "quality": "listing_lifetime_under_90d" if age_days <= 90 else "lifetime_velocity_estimate",
            "confidence": "learning",
            "observed_days": round(min(age_days, 90), 1),
            "observed_delta": 0,
            "auto_verified": False,
        }

    return {
        "estimate": 0.0,
        "low": 0.0,
        "high": 0.0,
        "quality": "insufficient",
        "confidence": "unknown",
        "observed_days": 0.0,
        "observed_delta": 0,
        "auto_verified": False,
    }


def estimate_90d_sold(
    item: Mapping[str, Any],
    history: Sequence[Mapping[str, Any]] | None,
    now: datetime | None = None,
) -> tuple[float, str]:
    """Backward-compatible wrapper returning estimate and quality label."""
    result = estimate_sales_pace(item, history, now=now)
    return float(result["estimate"]), str(result["quality"])


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
    """Estimate relevant active listings from a noisy exact-keyword search."""
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

    if returned >= 50 and matched >= 25 and match_rate >= 0.80:
        confidence = "high"
    elif returned >= 20 and matched >= 10 and match_rate >= 0.50:
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


def market_judgment(score: int, sold_90d: float, active_count: int, quality: str, confidence: str = "") -> str:
    if quality == "insufficient" or sold_90d < 1:
        return "データ不足"
    if confidence in {"unknown", "learning", "low"}:
        return "学習中"
    if score >= 72 and sold_90d >= 5 and active_count <= 80:
        return "有望"
    if score >= 55 and sold_90d >= 2:
        return "候補"
    if score >= 40:
        return "監視"
    return "見送り"


def international_fee_rate(monthly_sales_usd: float) -> float:
    """Japan seller international fee after published volume discounts."""
    sales = max(0.0, safe_float(monthly_sales_usd, 0.0))
    if sales >= 100_000:
        return 0.0040
    if sales >= 50_000:
        return 0.0070
    if sales >= 10_000:
        return 0.0095
    if sales >= 3_000:
        return 0.0120
    return 0.0135


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
    ebay_fee_tax_rate: float = 0.10
    payoneer_withdrawal_rate: float = 0.03
    payoneer_fixed_jpy: float = 0.0
    payoneer_annual_allocation_jpy: float = 0.0
    # Deprecated compatibility field. New callers should use payoneer_withdrawal_rate.
    fx_spread_rate: float = 0.0
    tariff_rate: float = 0.15
    return_reserve_rate: float = 0.03
    per_order_fee_usd: float = 0.40
    buyer_sales_tax_rate: float = 0.07
    insertion_fee_usd: float = 0.0
    additional_final_value_fee_rate: float = 0.0


def calculate_profit(inputs: ProfitInputs) -> dict[str, float | str]:
    item_revenue_jpy = inputs.sale_price_usd * inputs.exchange_rate
    shipping_revenue_jpy = inputs.buyer_shipping_usd * inputs.exchange_rate
    gross_jpy = item_revenue_jpy + shipping_revenue_jpy
    buyer_sales_tax_usd = (inputs.sale_price_usd + inputs.buyer_shipping_usd) * inputs.buyer_sales_tax_rate
    fee_base_usd = inputs.sale_price_usd + inputs.buyer_shipping_usd + buyer_sales_tax_usd

    fee_threshold = max(inputs.ebay_fee_threshold_usd, 0.0)
    lower_fee_base = min(fee_base_usd, fee_threshold) if fee_threshold else 0.0
    upper_fee_base = max(fee_base_usd - fee_threshold, 0.0) if fee_threshold else fee_base_usd
    percentage_fee_usd = lower_fee_base * inputs.ebay_fee_rate + upper_fee_base * inputs.ebay_fee_above_rate
    percentage_fee_usd += fee_base_usd * max(inputs.additional_final_value_fee_rate, 0.0)
    per_order_fee_usd = 0.30 if fee_base_usd <= 10 else inputs.per_order_fee_usd
    final_value_fee_jpy = (percentage_fee_usd + per_order_fee_usd) * inputs.exchange_rate
    international_fee_jpy = fee_base_usd * inputs.international_fee_rate * inputs.exchange_rate
    promoted_fee_jpy = fee_base_usd * inputs.promoted_listing_rate * inputs.exchange_rate
    insertion_fee_jpy = max(inputs.insertion_fee_usd, 0.0) * inputs.exchange_rate

    ebay_service_fees_before_tax = final_value_fee_jpy + international_fee_jpy + promoted_fee_jpy + insertion_fee_jpy
    ebay_fee_tax_jpy = ebay_service_fees_before_tax * max(inputs.ebay_fee_tax_rate, 0.0)
    ebay_fees_total_jpy = ebay_service_fees_before_tax + ebay_fee_tax_jpy

    payout_before_payoneer_jpy = max(0.0, gross_jpy - ebay_fees_total_jpy)
    payoneer_rate = max(inputs.payoneer_withdrawal_rate, inputs.fx_spread_rate, 0.0)
    payoneer_fee_jpy = (
        payout_before_payoneer_jpy * payoneer_rate
        + max(inputs.payoneer_fixed_jpy, 0.0)
        + max(inputs.payoneer_annual_allocation_jpy, 0.0)
    )

    # Screening customs value: merchandise price only. Exact DDP quote supersedes this.
    tariff_jpy = item_revenue_jpy * max(inputs.tariff_rate, 0.0)
    return_reserve_jpy = gross_jpy * max(inputs.return_reserve_rate, 0.0)

    variable_costs = ebay_fees_total_jpy + payoneer_fee_jpy + tariff_jpy + return_reserve_jpy
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
        judgment = "仕入・送料未確認"
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
        "fee_base_usd": round(fee_base_usd, 2),
        "final_value_fee_jpy": round(final_value_fee_jpy),
        "international_fee_jpy": round(international_fee_jpy),
        "promoted_fee_jpy": round(promoted_fee_jpy),
        "insertion_fee_jpy": round(insertion_fee_jpy),
        "ebay_fee_tax_jpy": round(ebay_fee_tax_jpy),
        "ebay_fee_jpy": round(ebay_fees_total_jpy),
        "payoneer_fee_jpy": round(payoneer_fee_jpy),
        # Kept for older callers that displayed fx_cost_jpy.
        "fx_cost_jpy": round(payoneer_fee_jpy),
        "tariff_jpy": round(tariff_jpy),
        "return_reserve_jpy": round(return_reserve_jpy),
        "fixed_costs_jpy": round(fixed_costs),
        "total_cost_jpy": round(total_cost_jpy),
        "profit_jpy": round(profit_jpy),
        "margin_rate": round(margin, 4),
        "judgment": judgment,
    }
