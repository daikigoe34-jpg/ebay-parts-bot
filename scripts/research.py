from __future__ import annotations

import base64
import json
import os
import re
import statistics
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Iterable
from urllib.parse import quote

import requests

try:
    from .core import (
        count_rate_interval,
        estimate_competition,
        extract_country_of_origin,
        extract_part_numbers,
        market_judgment,
        market_score,
        median,
        normalize_part_number,
        percentile,
        safe_float,
        sold_quantity,
        tariff_scenario,
    )
except ImportError:  # Direct execution: python scripts/research.py
    from core import (
        count_rate_interval,
        estimate_competition,
        extract_country_of_origin,
        extract_part_numbers,
        market_judgment,
        market_score,
        median,
        normalize_part_number,
        percentile,
        safe_float,
        sold_quantity,
        tariff_scenario,
    )


ROOT = Path(__file__).resolve().parents[1]
SEEDS_PATH = ROOT / "config" / "search_seeds.json"
RESULTS_PATH = ROOT / "web" / "data" / "results.json"
SNAPSHOTS_PATH = ROOT / "state" / "snapshots.json"
WATCHLIST_PATH = ROOT / "state" / "watchlist.json"
RESEARCH_STATE_PATH = ROOT / "state" / "research_state.json"
SETUP_STATUS_PATH = ROOT / "web" / "data" / "setup_status.json"

TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
BROWSE_ROOT = "https://api.ebay.com/buy/browse/v1"
OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope"
RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701"
ECB_DAILY_XML = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"


class EbayApiError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, phase: str = "browse") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.phase = phase


class ApiCallBudget:
    """Simple per-run guard below eBay's application quota.

    Retries also consume calls. The guard prevents a bad query or loop from
    exhausting the Production application quota in a single scheduled run.
    """

    def __init__(self, limit: int = 3500) -> None:
        self.limit = max(1, int(limit))
        self.used = 0
        self._lock = Lock()

    def consume(self, label: str = "request") -> None:
        with self._lock:
            if self.used >= self.limit:
                raise EbayApiError(
                    f"Production API call budget exhausted before {label}: {self.used}/{self.limit}",
                    status_code=429,
                    phase="budget",
                )
            self.used += 1

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)


class EbayBrowseClient:
    def __init__(
        self,
        client_id: str,
        client_secret: str,
        marketplace: str = "EBAY_US",
        call_budget: int = 3500,
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.marketplace = marketplace
        self.session = requests.Session()
        self.budget = ApiCallBudget(call_budget)
        self.token = self._get_token()

    def _get_token(self) -> str:
        basic = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        self.budget.consume("OAuth token")
        response = self.session.post(
            TOKEN_URL,
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"grant_type": "client_credentials", "scope": OAUTH_SCOPE},
            timeout=30,
        )
        if response.status_code >= 400:
            raise EbayApiError(
                f"OAuth failed: HTTP {response.status_code}: {response.text[:500]}",
                status_code=response.status_code,
                phase="oauth",
            )
        payload = response.json()
        token = payload.get("access_token")
        if not token:
            raise EbayApiError("OAuth response did not contain access_token", phase="oauth")
        return str(token)

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "X-EBAY-C-MARKETPLACE-ID": self.marketplace,
            "X-EBAY-C-ENDUSERCTX": "contextualLocation=country%3DUS%2Czip%3D10001",
            "Accept-Language": "en-US",
        }

    def _get_json(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        last_error = ""
        last_status: int | None = None
        for attempt in range(3):
            self.budget.consume("Browse API")
            response = self.session.get(url, headers=self.headers, params=params, timeout=40)
            last_status = response.status_code
            if response.status_code < 400:
                return response.json()
            last_error = f"HTTP {response.status_code}: {response.text[:500]}"
            if response.status_code not in {429, 500, 502, 503, 504}:
                break
            time.sleep(1.5 * (attempt + 1))
        raise EbayApiError(
            f"GET {url} failed: {last_error}",
            status_code=last_status,
            phase="browse",
        )

    def search(self, query: str, limit: int = 100, category_id: str = "6028") -> dict[str, Any]:
        params: dict[str, Any] = {
            "q": query,
            "limit": min(max(limit, 1), 200),
            "fieldgroups": "EXTENDED",
            "filter": "buyingOptions:{FIXED_PRICE|BEST_OFFER},conditions:{NEW|USED},deliveryCountry:US",
        }
        if category_id:
            params["category_ids"] = category_id
        return self._get_json(f"{BROWSE_ROOT}/item_summary/search", params=params)

    def get_item(self, item_id: str) -> dict[str, Any]:
        encoded = quote(item_id, safe="")
        return self._get_json(f"{BROWSE_ROOT}/item/{encoded}")

    def diagnose(self, category_id: str = "6028") -> dict[str, Any]:
        payload = self.search("Nissan genuine switch", limit=1, category_id=category_id)
        return {
            "status": "ready",
            "oauth": "ok",
            "browse": "ok",
            "marketplace": self.marketplace,
            "sample_total": int(safe_float(payload.get("total"), 0)),
            "calls_used": self.budget.used,
            "call_budget": self.budget.limit,
            "calls_remaining": self.budget.remaining,
        }


class RakutenClient:
    def __init__(self, application_id: str, access_key: str) -> None:
        self.application_id = application_id
        self.access_key = access_key
        self.session = requests.Session()

    def search_part(self, part_number: str) -> dict[str, Any]:
        params = {
            "applicationId": self.application_id,
            "keyword": part_number,
            "format": "json",
            "formatVersion": 2,
            "hits": 30,
            "page": 1,
            "sort": "+itemPrice",
            "availability": 1,
            "field": 1,
            "carrier": 2,
            "elements": "itemName,itemPrice,itemUrl,itemCode,shopName,postageFlag,availability,smallImageUrls",
        }
        response = self.session.get(
            RAKUTEN_ENDPOINT,
            headers={"accessKey": self.access_key},
            params=params,
            timeout=35,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"Rakuten HTTP {response.status_code}: {response.text[:300]}")
        payload = response.json()
        raw_items = payload.get("items") or payload.get("Items") or []
        items: list[dict[str, Any]] = []
        compact_part = compact_part_number(part_number)
        for raw in raw_items:
            item = raw.get("Item") or raw.get("item") or raw
            title = str(item.get("itemName") or "")
            if compact_part not in compact_text(title):
                continue
            price = max(0, int(safe_float(item.get("itemPrice"), 0)))
            url = str(item.get("itemUrl") or "")
            if price <= 0 or not url:
                continue
            items.append({
                "title": title,
                "price_jpy": price,
                "url": url,
                "item_code": str(item.get("itemCode") or ""),
                "shop_name": str(item.get("shopName") or ""),
                "postage_included": int(safe_float(item.get("postageFlag"), 0)) == 1,
            })
        items.sort(key=lambda row: (row["price_jpy"], row["shop_name"]))
        return {
            "enabled": True,
            "match_count": len(items),
            "confidence": "exact_part_title" if items else "none",
            "items": items[:3],
        }


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def compact_text(value: Any) -> str:
    return "".join(ch for ch in str(value or "").upper() if ch.isalnum())


def compact_part_number(value: str) -> str:
    return normalize_part_number(value).replace("-", "")


def title_contains_part_number(title: Any, part_number: str) -> bool:
    compact_part = compact_part_number(part_number)
    return bool(compact_part and compact_part in compact_text(title))



def build_query_catalog(seeds: dict[str, Any]) -> list[tuple[str, str]]:
    catalog: list[tuple[str, str]] = []
    authenticity = list(seeds.get("authenticity_terms") or ["OEM", "Genuine"])
    for part_index, part_term in enumerate(seeds.get("small_part_terms") or []):
        auth_term = authenticity[part_index % len(authenticity)]
        for brand in seeds.get("brands") or []:
            catalog.append((f"{brand['query']} {auth_term} {part_term}", str(brand.get("label_ja") or brand["query"])))
    return catalog


def choose_queries(
    seeds: dict[str, Any],
    research_state: dict[str, Any],
    forced: str | None = None,
    count: int = 8,
) -> list[tuple[str, str]]:
    forced = (forced or "").strip()
    if forced:
        return [(forced, "手動指定")]
    catalog = build_query_catalog(seeds)
    if not catalog:
        return []
    cursor = max(0, int(safe_float(research_state.get("query_cursor"), 0))) % len(catalog)
    selected = [catalog[(cursor + index) % len(catalog)] for index in range(max(1, count))]
    research_state["query_cursor"] = (cursor + len(selected)) % len(catalog)
    research_state["query_catalog_size"] = len(catalog)
    return selected


def blocked_title(title: str, blocked_terms: Iterable[str]) -> bool:
    upper = str(title or "").upper()
    return any(term.upper() in upper for term in blocked_terms)


def item_price_usd(item: dict[str, Any]) -> float:
    return safe_float((item.get("price") or {}).get("value"), 0.0)


def seller_key(item: dict[str, Any]) -> str:
    seller = item.get("seller") or {}
    return str(seller.get("username") or seller.get("sellerId") or seller.get("userId") or "unknown")


def fetch_details(client: EbayBrowseClient, summaries: list[dict[str, Any]], max_workers: int = 10) -> list[dict[str, Any]]:
    unique: dict[str, dict[str, Any]] = {}
    for summary in summaries:
        item_id = str(summary.get("itemId") or "")
        if item_id:
            unique[item_id] = summary

    details: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(client.get_item, item_id): item_id for item_id in unique}
        for future in as_completed(futures):
            item_id = futures[future]
            try:
                detail = future.result()
            except Exception as exc:
                if isinstance(exc, EbayApiError) and exc.phase == "budget":
                    for pending in futures:
                        pending.cancel()
                    raise
                print(f"WARN item {item_id}: {exc}", file=sys.stderr)
                continue
            details.append(detail)
    return details


def append_snapshot(
    snapshots: dict[str, list[dict[str, Any]]],
    item: dict[str, Any],
    observed_at: datetime,
    part_numbers: Iterable[str],
) -> None:
    item_id = str(item.get("itemId") or "")
    if not item_id:
        return
    cutoff = observed_at - timedelta(days=105)
    rows: list[dict[str, Any]] = []
    for row in snapshots.get(item_id, []):
        row_dt = parse_snapshot_date(row.get("observed_at"))
        if row_dt and row_dt >= cutoff:
            rows.append(row)
    today = observed_at.date().isoformat()
    rows = [row for row in rows if not str(row.get("observed_at", "")).startswith(today)]
    rows.append({
        "item_id": item_id,
        "observed_at": observed_at.isoformat().replace("+00:00", "Z"),
        "sold_quantity": sold_quantity(item),
        "part_numbers": sorted(set(part_numbers)),
        "price_usd": round(item_price_usd(item), 2),
        "seller": seller_key(item),
    })
    snapshots[item_id] = rows[-110:]


def parse_snapshot_date(value: Any) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def representative_item(items: list[dict[str, Any]]) -> dict[str, Any]:
    if not items:
        return {}
    return max(items, key=lambda item: (sold_quantity(item), item_price_usd(item)))


def infer_brand(title: str) -> str:
    upper = str(title or "").upper()
    brands = {
        "NISSAN": "Nissan",
        "TOYOTA": "Toyota",
        "HONDA": "Honda",
        "MAZDA": "Mazda",
        "SUBARU": "Subaru",
        "MITSUBISHI": "Mitsubishi",
        "SUZUKI": "Suzuki",
        "ISUZU": "Isuzu",
        "LEXUS": "Lexus",
        "INFINITI": "Infiniti",
        "ACURA": "Acura",
    }
    return next((label for key, label in brands.items() if key in upper), "Unknown")


def infer_origin(items: list[dict[str, Any]]) -> tuple[str, str]:
    origins: list[str] = []
    for item in items:
        code, confidence = extract_country_of_origin(item)
        if code and confidence == "aspect":
            origins.append(code)
    if not origins:
        return "", "unknown"
    counts = Counter(origins)
    code, count = counts.most_common(1)[0]
    confidence = "high" if count >= 3 and count / len(origins) >= 0.75 else "medium" if count >= 2 else "low"
    return code, confidence


def infer_shipping_estimate(title: str, default_jpy: int = 2800) -> dict[str, Any]:
    upper = str(title or "").upper()
    micro = ["CLIP", "RETAINER", "RELAY", "SENSOR", "SWITCH", "KNOB", "CAP", "EMBLEM", "BUTTON", "SOCKET", "SEAL"]
    bulky = ["LAMP", "HANDLE", "GARNISH", "MOLDING", "BEZEL", "BRACKET"]
    if any(term in upper for term in micro):
        return {"profile": "micro", "estimate_jpy": max(1800, default_jpy - 700), "confidence": "low"}
    if any(term in upper for term in bulky):
        return {"profile": "small", "estimate_jpy": max(3200, default_jpy + 500), "confidence": "low"}
    return {"profile": "standard_small", "estimate_jpy": default_jpy, "confidence": "low"}


def aggregate_sales_estimate(
    part_number: str,
    items: list[dict[str, Any]],
    snapshots: dict[str, list[dict[str, Any]]],
    observed_at: datetime,
) -> dict[str, Any]:
    """Estimate the sampled market's 90-day sales pace from persistent deltas.

    Each listing is annualized over *its own* observation window and the listing
    rates are then summed. This avoids understating newer listings by dividing all
    deltas by the oldest listing's window. Historical listings remain in the
    calculation after they disappear, reducing survivorship bias. A listing's
    pre-observation lifetime quantity is never counted as an observed sale.
    """
    current_by_id = {
        str(item.get("itemId")): item
        for item in items
        if item.get("itemId")
    }
    target_ids = set(current_by_id)
    for item_id, rows in snapshots.items():
        if any(part_number in (row.get("part_numbers") or []) for row in rows if isinstance(row, dict)):
            target_ids.add(str(item_id))

    listing_estimates: list[dict[str, float | int | str]] = []
    short_history_ids: set[str] = set()

    for item_id in target_ids:
        series: list[tuple[datetime, int]] = []
        for row in snapshots.get(item_id, []):
            if not isinstance(row, dict):
                continue
            row_parts = row.get("part_numbers") or []
            # Legacy rows have no part_numbers; accept them only when the item is
            # currently confirmed as this part number.
            if row_parts and part_number not in row_parts:
                continue
            if not row_parts and item_id not in current_by_id:
                continue
            dt = parse_snapshot_date(row.get("observed_at"))
            if dt is None or not (observed_at - timedelta(days=100) <= dt < observed_at):
                continue
            try:
                qty = max(0, int(row.get("sold_quantity", 0)))
            except (TypeError, ValueError):
                continue
            series.append((dt, qty))

        current = current_by_id.get(item_id)
        if current is not None:
            series.append((observed_at, sold_quantity(current)))
        if len(series) < 2:
            continue

        # Keep one quantity per timestamp and sum only positive increments. A
        # negative change can occur after a relist/reset and is not treated as a
        # negative sale.
        deduped = sorted({dt: qty for dt, qty in series}.items(), key=lambda pair: pair[0])
        first_dt = deduped[0][0]
        last_dt = deduped[-1][0]
        listing_days = max((last_dt - first_dt).total_seconds() / 86400, 0.0)
        item_delta = sum(
            max(0, next_qty - prev_qty)
            for (_prev_dt, prev_qty), (_next_dt, next_qty) in zip(deduped, deduped[1:])
        )
        if listing_days < 7:
            short_history_ids.add(item_id)
            continue

        estimate = item_delta / listing_days * 90
        low, high = count_rate_interval(item_delta, listing_days)
        listing_estimates.append({
            "item_id": item_id,
            "days": listing_days,
            "delta": item_delta,
            "estimate": estimate,
            "low": low,
            "high": high,
        })

    if listing_estimates:
        observed_days_values = sorted(float(row["days"]) for row in listing_estimates)
        observed_days = float(statistics.median(observed_days_values))
        estimate = round(sum(float(row["estimate"]) for row in listing_estimates), 1)
        low = round(sum(float(row["low"]) for row in listing_estimates), 1)
        high = round(sum(float(row["high"]) for row in listing_estimates), 1)
        observed_units = sum(int(row["delta"]) for row in listing_estimates)
        confidence = "high" if observed_days >= 30 else "medium" if observed_days >= 14 else "low"
        quality = "observed_delta_30d" if confidence == "high" else "observed_delta"
        return {
            "estimate": estimate,
            "low": low,
            "high": high,
            "confidence": confidence,
            "quality": quality,
            "observed_days": round(observed_days, 1),
            "observed_days_min": round(min(observed_days_values), 1),
            "observed_days_max": round(max(observed_days_values), 1),
            "observed_delta": observed_units,
            "auto_verified": confidence == "high",
            "sampled_listings": len(items),
            "tracked_listings": len(listing_estimates),
            "short_history_listings": len(short_history_ids),
            "part_number": part_number,
        }

    # Learning mode deliberately does not extrapolate pre-observation lifetime
    # sales. The cumulative value is retained only as a non-decision reference.
    lifetime_reference = sum(sold_quantity(item) for item in items)
    return {
        "estimate": 0.0,
        "low": 0.0,
        "high": 0.0,
        "confidence": "learning" if items or short_history_ids else "unknown",
        "quality": "tracking_not_ready" if items or short_history_ids else "insufficient",
        "observed_days": 0.0,
        "observed_days_min": 0.0,
        "observed_days_max": 0.0,
        "observed_delta": 0,
        "lifetime_sold_reference": lifetime_reference,
        "auto_verified": False,
        "sampled_listings": len(items),
        "tracked_listings": 0,
        "short_history_listings": len(short_history_ids),
        "part_number": part_number,
    }


def build_candidate(
    part_number: str,
    items: list[dict[str, Any]],
    competition: dict[str, Any],
    prices: list[float],
    snapshots: dict[str, list[dict[str, Any]]],
    observed_at: datetime,
    queries: list[str],
    rakuten: dict[str, Any] | None,
    previous: dict[str, Any] | None,
    default_shipping_jpy: int,
) -> dict[str, Any]:
    previous = previous or {}
    active_count = int(competition.get("active_count") or 0)
    competition_known = bool(competition.get("known"))
    competition_confidence = str(competition.get("confidence") or "unknown")
    sales = aggregate_sales_estimate(part_number, items, snapshots, observed_at)
    sold_90d = safe_float(sales.get("estimate"), 0.0)
    sold_low = safe_float(sales.get("low"), 0.0)
    sold_high = safe_float(sales.get("high"), 0.0)
    raw_sales_confidence = str(sales.get("confidence") or "unknown")

    # Ranking and purchase gates use the conservative lower confidence bound.
    # During learning mode this is zero, so lifetime cumulative sales can never
    # create a false high-demand candidate.
    sold_for_decision = sold_low if raw_sales_confidence in {"low", "medium", "high"} else 0.0
    previous_price = safe_float(previous.get("price_median_usd"), 0.0)
    market_prices = prices or ([previous_price] if previous_price > 0 else [])
    rep = representative_item(items)
    score = market_score(sold_for_decision, active_count, market_prices)
    score -= {"unknown": 15, "low": 8, "medium": 3}.get(competition_confidence, 0)
    score -= {"unknown": 18, "learning": 12, "low": 8, "medium": 3, "high": 0}.get(raw_sales_confidence, 0)
    score = max(0, min(100, score))

    unique_sellers = len({seller_key(item) for item in items if seller_key(item) != "unknown"})
    sample_coverage = min(1.0, len(items) / max(active_count, 1)) if competition_known else 0.0
    tracked_listings = int(safe_float(sales.get("tracked_listings"), 0))
    required_tracked = min(3, max(active_count, 1))
    market_coverage_ok = (
        competition_known
        and competition_confidence in {"high", "confirmed"}
        and sample_coverage >= 0.50
        and tracked_listings >= required_tracked
    )
    sales_confidence = raw_sales_confidence
    if raw_sales_confidence == "high" and not market_coverage_ok:
        sales_confidence = "medium"
    sales_auto_verified = sales_confidence == "high" and market_coverage_ok
    demand_ratio = sold_for_decision / max(active_count, 1)

    judgment = market_judgment(
        score,
        sold_for_decision,
        active_count,
        str(sales.get("quality")),
        sales_confidence,
    ) if competition_known else "競合未取得"

    origin_code, origin_confidence = infer_origin(items)
    if not origin_code and previous.get("country_of_origin"):
        origin_code = str(previous.get("country_of_origin"))
        origin_confidence = str(previous.get("origin_confidence") or "previous")
    tariff = tariff_scenario(origin_code)
    title = str(rep.get("title") or previous.get("title") or f"{part_number} auto part")
    shipping = infer_shipping_estimate(title, default_shipping_jpy)

    rakuten_data = rakuten or previous.get("rakuten") or {"enabled": False, "match_count": 0, "confidence": "disabled", "items": []}
    rakuten_items = list(rakuten_data.get("items") or [])
    best_rakuten = rakuten_items[0] if rakuten_items else {}
    procurement_price = int(safe_float(best_rakuten.get("price_jpy"), 0))
    domestic_shipping = 0 if best_rakuten.get("postage_included") is True else (800 if procurement_price else 0)

    if procurement_price <= 0:
        next_action = "仕入価格を確認"
    elif not origin_code:
        next_action = "原産国を確認"
    elif sales_confidence in {"unknown", "learning", "low"}:
        next_action = "自動観測中"
    else:
        next_action = "最終利益を確認"

    return {
        "part_number": part_number,
        "brand": infer_brand(title),
        "title": title,
        "category_id": str(rep.get("categoryId") or previous.get("category_id") or ""),
        "category_path": str(rep.get("categoryPath") or previous.get("category_path") or ""),
        "image_url": ((rep.get("image") or {}).get("imageUrl") or previous.get("image_url") or ""),
        "ebay_url": rep.get("itemWebUrl") or rep.get("itemAffiliateWebUrl") or previous.get("ebay_url") or "",
        "queries": queries,
        "query": queries[0] if queries else previous.get("query", ""),
        "sold_90d_est": round(sold_90d, 1),
        "sold_90d_low": round(sold_low, 1),
        "sold_90d_high": round(sold_high, 1),
        "sold_90d_decision": round(sold_for_decision, 1),
        "sales_quality": sales.get("quality"),
        "sales_confidence": sales_confidence,
        "sales_raw_confidence": raw_sales_confidence,
        "sales_observed_days": sales.get("observed_days", 0),
        "sales_observed_days_min": sales.get("observed_days_min", 0),
        "sales_observed_days_max": sales.get("observed_days_max", 0),
        "sales_observed_delta": sales.get("observed_delta", 0),
        "sales_lifetime_reference": sales.get("lifetime_sold_reference", 0),
        "sales_tracked_listings": tracked_listings,
        "sales_short_history_listings": sales.get("short_history_listings", 0),
        "sales_scope": "browse_estimated_sold_quantity_daily_delta",
        "sales_auto_verified": sales_auto_verified,
        "sales_confirmation_required": not sales_auto_verified,
        "sampled_listings": sales.get("sampled_listings", len(items)),
        "active_competition": int(active_count),
        "competition_known": competition_known,
        "competition_confidence": competition_confidence,
        "competition_match_rate": safe_float(competition.get("match_rate"), 0.0),
        "competition_search_total": int(competition.get("search_total") or 0),
        "competition_search_returned": int(competition.get("search_returned") or 0),
        "competition_search_matched": int(competition.get("search_matched") or 0),
        "sample_coverage": round(sample_coverage, 3),
        "sampled_sellers": unique_sellers,
        "demand_ratio": round(demand_ratio, 3),
        "price_median_usd": round(median(market_prices), 2),
        "price_p25_usd": round(
            percentile(market_prices, 0.25)
            if prices else safe_float(previous.get("price_p25_usd"), previous_price),
            2,
        ),
        "price_p75_usd": round(
            percentile(market_prices, 0.75)
            if prices else safe_float(previous.get("price_p75_usd"), previous_price),
            2,
        ),
        "price_source": "browse_active_listing" if prices else "previous_browse_listing",
        "active_price_median_usd": round(median(prices) if prices else previous_price, 2),
        "market_score": score,
        "market_judgment": judgment,
        "source": "ebay_production_browse_daily_delta",
        "country_of_origin": origin_code,
        "origin_confidence": origin_confidence,
        "tariff": tariff,
        "rakuten": rakuten_data,
        "auto_costs": {
            "procurement_jpy": procurement_price,
            "domestic_shipping_jpy": domestic_shipping,
            "international_shipping_jpy": int(shipping["estimate_jpy"]),
            "packaging_jpy": 150,
            "shipping_profile": shipping["profile"],
            "shipping_confidence": shipping["confidence"],
            "tariff_rate": tariff["rate"],
        },
        "next_action": next_action,
    }


def fetch_usd_jpy_rate(fallback: float) -> dict[str, Any]:
    try:
        response = requests.get(ECB_DAILY_XML, timeout=20)
        response.raise_for_status()
        root = ET.fromstring(response.content)
        rates: dict[str, float] = {}
        date = ""
        for node in root.iter():
            if node.tag.endswith("Cube"):
                if node.attrib.get("time"):
                    date = node.attrib["time"]
                currency = node.attrib.get("currency")
                rate = node.attrib.get("rate")
                if currency and rate:
                    rates[currency] = float(rate)
        if rates.get("USD") and rates.get("JPY"):
            return {
                "rate": round(rates["JPY"] / rates["USD"], 4),
                "source": "ECB reference rate",
                "date": date,
                "fallback": False,
            }
    except Exception as exc:
        print(f"WARN ECB exchange rate: {exc}", file=sys.stderr)
    return {"rate": fallback, "source": "fallback", "date": "", "fallback": True}


def normalize_watchlist(payload: Any) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for row in payload if isinstance(payload, list) else []:
        if isinstance(row, str):
            part = normalize_part_number(row)
            if part:
                output.append({"part_number": part, "market_score": 0})
        elif isinstance(row, dict):
            part = normalize_part_number(row.get("part_number"))
            if part:
                output.append({**row, "part_number": part})
    return output


def classify_setup_error(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, EbayApiError):
        if exc.phase == "oauth":
            return "auth_failed", "Production App ID / Cert IDを確認してください"
        if exc.phase == "budget":
            return "call_budget_exceeded", "本日の安全上限に達しました。次回の自動実行まで待ってください"
        if exc.status_code == 403:
            return "browse_access_denied", "Productionキーは有効ですが、Browse APIのProduction利用承認が必要です"
        if exc.status_code == 401:
            return "auth_failed", "ProductionキーまたはOAuth設定を確認してください"
        if exc.status_code == 429:
            return "rate_limited", "eBay APIの利用上限です。次回の自動実行まで待ってください"
    return "temporary_error", "一時的なAPIエラーです。既存結果は保持しました"


def write_setup_status(
    status: str,
    observed_at: datetime,
    *,
    ready: bool = False,
    message: str = "",
    action: str = "",
    details: dict[str, Any] | None = None,
) -> None:
    payload = {
        "schema_version": 1,
        "app_version": "0.4.0",
        "checked_at": observed_at.isoformat().replace("+00:00", "Z"),
        "ready": ready,
        "status": status,
        "mode": "production_browse_only",
        "message": message,
        "next_action": action,
        "links": {
            "secrets": "https://github.com/daikigoe34-jpg/ebay-parts-bot/settings/secrets/actions",
            "pages": "https://github.com/daikigoe34-jpg/ebay-parts-bot/settings/pages",
            "workflow": "https://github.com/daikigoe34-jpg/ebay-parts-bot/actions/workflows/research.yml",
            "buy_api_access": "https://developer.ebay.com/api-docs/buy/static/buy-requirements.html",
        },
        "details": details or {},
    }
    save_json(SETUP_STATUS_PATH, payload)


def run() -> int:
    observed_at = datetime.now(timezone.utc)
    client_id = os.getenv("EBAY_CLIENT_ID", "").strip()
    client_secret = os.getenv("EBAY_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        write_setup_status(
            "missing_secrets",
            observed_at,
            message="eBay Production APIキーが未登録です",
            action="GitHub SecretsへEBAY_CLIENT_IDとEBAY_CLIENT_SECRETを登録",
        )
        print("Production API secrets are missing. Existing research results were preserved.")
        return 0

    max_discovery_items = int(os.getenv("MAX_DISCOVERY_ITEMS", "40"))
    max_discovery_details = int(os.getenv("MAX_DISCOVERY_DETAILS", "20"))
    max_candidates = int(os.getenv("MAX_CANDIDATES", "24"))
    max_exact_details = int(os.getenv("MAX_EXACT_DETAILS", "50"))
    queries_per_run = int(os.getenv("QUERIES_PER_RUN", "8"))
    api_call_budget = int(os.getenv("API_CALL_BUDGET", "3500"))
    marketplace = os.getenv("EBAY_MARKETPLACE", "EBAY_US")
    category_id = os.getenv("EBAY_CATEGORY_ID", "6028")
    forced_query = os.getenv("RESEARCH_QUERY", "")
    default_shipping_jpy = int(os.getenv("DEFAULT_INTL_SHIPPING_JPY", "2800"))
    fallback_exchange_rate = safe_float(os.getenv("FALLBACK_USDJPY", "150"), 150.0)

    seeds = load_json(SEEDS_PATH, {})
    research_state: dict[str, Any] = load_json(RESEARCH_STATE_PATH, {})
    selected_queries = choose_queries(seeds, research_state, forced_query, count=queries_per_run)
    if not selected_queries:
        write_setup_status(
            "configuration_error",
            observed_at,
            message="検索語設定が空です",
            action="config/search_seeds.jsonを確認",
        )
        print("No search queries configured", file=sys.stderr)
        return 0
    print("Research queries:")
    for query, label in selected_queries:
        print(f"- {label}: {query}")

    try:
        client = EbayBrowseClient(
            client_id,
            client_secret,
            marketplace=marketplace,
            call_budget=api_call_budget,
        )
        diagnostic = client.diagnose(category_id=category_id)
    except Exception as exc:
        status, action = classify_setup_error(exc)
        write_setup_status(
            status,
            observed_at,
            message=str(exc)[:500],
            action=action,
            details={"error_type": type(exc).__name__},
        )
        print(f"Production API diagnostic failed: {exc}", file=sys.stderr)
        return 0

    write_setup_status(
        "ready",
        observed_at,
        ready=True,
        message="Production OAuthとBrowse APIの接続に成功しました",
        action="以後は毎日自動調査します",
        details=diagnostic,
    )

    rakuten_application_id = os.getenv("RAKUTEN_APPLICATION_ID", "").strip()
    rakuten_access_key = os.getenv("RAKUTEN_ACCESS_KEY", "").strip()
    rakuten_client = RakutenClient(rakuten_application_id, rakuten_access_key) if rakuten_application_id and rakuten_access_key else None

    observed_at = datetime.now(timezone.utc)
    snapshots: dict[str, list[dict[str, Any]]] = load_json(SNAPSHOTS_PATH, {})
    previous_payload = load_json(RESULTS_PATH, {})
    previous_products = {
        str(row.get("part_number")): row
        for row in previous_payload.get("products", [])
        if isinstance(row, dict) and row.get("part_number")
    }
    previous_watchlist = normalize_watchlist(load_json(WATCHLIST_PATH, []))

    discovery_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    part_queries: dict[str, set[str]] = defaultdict(set)
    all_observed_items: dict[str, dict[str, Any]] = {}
    budget_exhausted = False

    for query, _label in selected_queries:
        try:
            payload = client.search(query, limit=max_discovery_items, category_id=category_id)
            summaries = [
                item for item in payload.get("itemSummaries", [])
                if not blocked_title(item.get("title", ""), seeds.get("blocked_title_terms", []))
            ][:max_discovery_details]
            details = fetch_details(client, summaries)
        except EbayApiError as exc:
            print(f"WARN discovery {query}: {exc}", file=sys.stderr)
            if exc.phase == "budget":
                budget_exhausted = True
                break
            continue
        for detail in details:
            if blocked_title(detail.get("title", ""), seeds.get("blocked_title_terms", [])):
                continue
            item_id = str(detail.get("itemId") or "")
            if item_id:
                all_observed_items[item_id] = detail
            for part_number in extract_part_numbers(detail):
                discovery_groups[part_number].append(detail)
                part_queries[part_number].add(query)

    ranked_new_parts = sorted(
        discovery_groups,
        key=lambda part: (
            sum(sold_quantity(item) for item in discovery_groups[part]),
            len(discovery_groups[part]),
            median([item_price_usd(item) for item in discovery_groups[part]]),
        ),
        reverse=True,
    )

    previous_parts = [row["part_number"] for row in sorted(previous_watchlist, key=lambda row: safe_float(row.get("market_score"), 0), reverse=True)]
    target_parts: list[str] = []
    for part in [*previous_parts[: max_candidates // 2], *ranked_new_parts, *previous_parts]:
        if part and part not in target_parts:
            target_parts.append(part)
        if len(target_parts) >= max_candidates:
            break

    candidates: list[dict[str, Any]] = []
    for index, part_number in enumerate(target_parts, start=1):
        if budget_exhausted:
            break
        print(f"[{index}/{len(target_parts)}] exact search {part_number}")
        exact_search_ok = True
        try:
            exact_payload = client.search(part_number, limit=200, category_id=category_id)
            returned_summaries = list(exact_payload.get("itemSummaries", []))
            exact_summaries = [item for item in returned_summaries if title_contains_part_number(item.get("title", ""), part_number)]
            exact_prices = [item_price_usd(item) for item in exact_summaries if item_price_usd(item) > 0]
            exact_details = fetch_details(client, exact_summaries[:max_exact_details])
        except EbayApiError as exc:
            exact_search_ok = False
            print(f"WARN exact search {part_number}: {exc}", file=sys.stderr)
            if exc.phase == "budget":
                budget_exhausted = True
                break
            exact_payload = {"itemSummaries": [], "total": len(discovery_groups.get(part_number, []))}
            returned_summaries = []
            exact_summaries = []
            exact_prices = []
            exact_details = []

        matching_details: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for item in [*discovery_groups.get(part_number, []), *exact_details, *exact_summaries]:
            item_id = str(item.get("itemId") or "")
            if not item_id or item_id in seen_ids:
                continue
            part_numbers = extract_part_numbers(item)
            if part_number in part_numbers or title_contains_part_number(item.get("title", ""), part_number):
                matching_details.append(item)
                seen_ids.add(item_id)
                all_observed_items[item_id] = item
                part_queries[part_number].add(part_number)

        previous_candidate = previous_products.get(part_number)
        if not matching_details and not previous_candidate:
            continue
        if not exact_prices:
            exact_prices = [item_price_usd(item) for item in matching_details if item_price_usd(item) > 0]

        if exact_search_ok and int(safe_float(exact_payload.get("total"), 0)) == 0:
            competition = {
                "active_count": 0,
                "known": True,
                "match_rate": 1.0,
                "confidence": "high",
                "search_total": 0,
                "search_returned": 0,
                "search_matched": 0,
            }
        else:
            competition = estimate_competition(
                exact_payload.get("total"),
                len(returned_summaries),
                len(exact_summaries),
                len(matching_details),
            )

        rakuten_result: dict[str, Any] | None = None
        if rakuten_client:
            try:
                rakuten_result = rakuten_client.search_part(part_number)
            except Exception as exc:
                print(f"WARN Rakuten {part_number}: {exc}", file=sys.stderr)

        candidate = build_candidate(
            part_number=part_number,
            items=matching_details,
            competition=competition,
            prices=exact_prices,
            snapshots=snapshots,
            observed_at=observed_at,
            queries=sorted(part_queries.get(part_number, {part_number})),
            rakuten=rakuten_result,
            previous=previous_candidate,
            default_shipping_jpy=default_shipping_jpy,
        )
        if candidate["price_median_usd"] > 0:
            candidates.append(candidate)

    if budget_exhausted:
        merged_candidates = {
            str(row.get("part_number")): {**row, "data_stale": True}
            for row in previous_payload.get("products", [])
            if isinstance(row, dict) and row.get("part_number")
        }
        for row in candidates:
            merged_candidates[str(row.get("part_number"))] = row
        candidates = list(merged_candidates.values())

    # Save current observation after estimates so each run compares against prior days.
    for item in all_observed_items.values():
        parts = extract_part_numbers(item)
        append_snapshot(snapshots, item, observed_at, parts)

    candidates.sort(
        key=lambda row: (
            row["market_score"],
            row["sales_confidence"] == "high",
            row["sold_90d_est"],
            -row["active_competition"],
        ),
        reverse=True,
    )
    candidates = candidates[:max_candidates]

    watchlist = [
        {
            "part_number": row["part_number"],
            "market_score": row["market_score"],
            "last_seen": observed_at.date().isoformat(),
        }
        for row in candidates
    ]

    exchange_rate = fetch_usd_jpy_rate(fallback_exchange_rate)
    research_state.update({
        "last_run": observed_at.isoformat().replace("+00:00", "Z"),
        "last_queries": [query for query, _label in selected_queries],
        "runs_completed": int(safe_float(research_state.get("runs_completed"), 0)) + 1,
    })

    output = {
        "schema_version": 4,
        "app_version": "0.4.0",
        "generated_at": observed_at.isoformat().replace("+00:00", "Z"),
        "marketplace": marketplace,
        "category_id": category_id,
        "queries": [query for query, _label in selected_queries],
        "query": " / ".join(query for query, _label in selected_queries[:3]),
        "query_label": f"自動ローテーション {len(selected_queries)}語",
        "result_count": len(candidates),
        "automation": {
            "scheduled": True,
            "queries_per_run": len(selected_queries),
            "watchlist_size": len(watchlist),
            "snapshot_runs": research_state["runs_completed"],
            "rakuten_enabled": rakuten_client is not None,
            "production_api": {
                **diagnostic,
                "calls_used": client.budget.used,
                "calls_remaining": client.budget.remaining,
                "safe_budget_exhausted": budget_exhausted,
            },
            "sales_source_priority": ["daily_snapshot_delta"],
            "manual_sales_entry_required": False,
            "high_confidence_after_days": 30,
        },
        "cost_defaults": {
            "exchange_rate": exchange_rate,
            "seller_plan": "no_store_or_starter",
            "ebay_fee_rate": 0.136,
            "ebay_fee_threshold_usd": 7500,
            "ebay_fee_above_rate": 0.0235,
            "international_fee_rate": 0.0135,
            "ebay_fee_tax_rate": 0.10,
            "payoneer_withdrawal_rate": 0.03,
            "payoneer_rate_range": [0.01, 0.04],
            "return_reserve_rate": 0.03,
            "default_international_shipping_jpy": default_shipping_jpy,
            "default_packaging_jpy": 150,
        },
        "method_note": (
            "eBay Production Browse APIのestimatedSoldQuantityを毎日保存し、観測開始後の正の増分だけから"
            "90日販売ペースを推定します。7日未満は販売数を0として学習中表示にし、購入判定とランキングは"
            "推定値ではなく保守的な信頼区間下限を使います。販売数の手入力は不要です。"
            "関税率はHTSUS・原産国・DDP確認前のスクリーニング仮置きです。"
        ),
        "products": candidates,
    }
    save_json(RESULTS_PATH, output)
    save_json(SNAPSHOTS_PATH, snapshots)
    save_json(WATCHLIST_PATH, watchlist)
    save_json(RESEARCH_STATE_PATH, research_state)
    write_setup_status(
        "ready_partial" if budget_exhausted else "ready",
        observed_at,
        ready=True,
        message=(
            "安全なAPI上限で停止し、取得済みデータを保存しました"
            if budget_exhausted else "Production API調査が完了しました"
        ),
        action=(
            "操作不要です。次回の自動実行で続きを調査します"
            if budget_exhausted else "iPhoneの『今日やる』を上から確認"
        ),
        details={
            **diagnostic,
            "calls_used": client.budget.used,
            "calls_remaining": client.budget.remaining,
            "safe_budget_exhausted": budget_exhausted,
            "result_count": len(candidates),
            "snapshot_runs": research_state["runs_completed"],
        },
    )
    print(f"Wrote {len(candidates)} products to {RESULTS_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
