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
from typing import Any, Iterable
from urllib.parse import quote

import requests

try:
    from .core import (
        count_rate_interval,
        estimate_competition,
        estimate_sales_pace,
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
        estimate_sales_pace,
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

TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
BROWSE_ROOT = "https://api.ebay.com/buy/browse/v1"
MARKETPLACE_INSIGHTS_ROOT = "https://api.ebay.com/buy/marketplace_insights/v1_beta"
OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope"
RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701"
ECB_DAILY_XML = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"


class EbayApiError(RuntimeError):
    pass


class EbayBrowseClient:
    def __init__(self, client_id: str, client_secret: str, marketplace: str = "EBAY_US") -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.marketplace = marketplace
        self.session = requests.Session()
        self.token = self._get_token()

    def _get_token(self) -> str:
        basic = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
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
            raise EbayApiError(f"OAuth failed: HTTP {response.status_code}: {response.text[:500]}")
        payload = response.json()
        token = payload.get("access_token")
        if not token:
            raise EbayApiError("OAuth response did not contain access_token")
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
        for attempt in range(3):
            response = self.session.get(url, headers=self.headers, params=params, timeout=40)
            if response.status_code < 400:
                return response.json()
            last_error = f"HTTP {response.status_code}: {response.text[:500]}"
            if response.status_code not in {429, 500, 502, 503, 504}:
                break
            time.sleep(1.5 * (attempt + 1))
        raise EbayApiError(f"GET {url} failed: {last_error}")

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


class EbayMarketplaceInsightsClient:
    """Optional official 90-day sold-history client.

    Marketplace Insights is restricted. The normal application token is tried
    automatically. If access is denied, the client disables itself for the rest
    of the run and callers fall back to daily Browse snapshot deltas.
    """

    def __init__(self, browse_client: EbayBrowseClient, enabled: bool = True) -> None:
        self.session = browse_client.session
        self.token = browse_client.token
        self.marketplace = browse_client.marketplace
        self.enabled = enabled
        self.attempted = False
        self.available: bool | None = None
        self.status = "not_attempted" if enabled else "disabled"
        self.reason = ""
        self.successful_queries = 0
        self.fallback_queries = 0

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "X-EBAY-C-MARKETPLACE-ID": self.marketplace,
            "Accept-Language": "en-US",
        }

    def _disable(self, status: str, reason: str) -> None:
        self.available = False
        self.status = status
        self.reason = reason[:500]

    def _get_page(self, params: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
        endpoint = f"{MARKETPLACE_INSIGHTS_ROOT}/item_sales/search"
        last_error = ""
        for attempt in range(3):
            response = self.session.get(endpoint, headers=self.headers, params=params, timeout=40)
            if response.status_code < 400:
                self.available = True
                self.status = "available"
                return response.json(), ""
            last_error = f"HTTP {response.status_code}: {response.text[:500]}"
            if response.status_code in {401, 403, 404}:
                self._disable("not_approved", last_error)
                return None, last_error
            if response.status_code == 400 and "filter" in params:
                retry_params = dict(params)
                retry_params.pop("filter", None)
                response = self.session.get(endpoint, headers=self.headers, params=retry_params, timeout=40)
                if response.status_code < 400:
                    self.available = True
                    self.status = "available_filter_fallback"
                    return response.json(), "filter_fallback"
                last_error = f"HTTP {response.status_code}: {response.text[:500]}"
                if response.status_code in {401, 403, 404}:
                    self._disable("not_approved", last_error)
                    return None, last_error
            if response.status_code not in {429, 500, 502, 503, 504}:
                break
            time.sleep(1.5 * (attempt + 1))
        self.status = "temporary_error"
        self.reason = last_error
        return None, last_error

    def search_part(self, part_number: str, observed_at: datetime, max_items: int = 1000) -> dict[str, Any]:
        if not self.enabled:
            self.fallback_queries += 1
            return {"available": False, "status": "disabled", "usable": False, "items": []}
        if self.available is False:
            self.fallback_queries += 1
            return {
                "available": False,
                "status": self.status,
                "reason": self.reason,
                "usable": False,
                "items": [],
            }

        self.attempted = True
        start = observed_at - timedelta(days=90)
        start_text = start.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        end_text = observed_at.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        rows: list[dict[str, Any]] = []
        total = 0
        offset = 0
        filter_fallback = False
        while offset < max_items:
            limit = min(200, max_items - offset)
            params: dict[str, Any] = {
                "q": part_number,
                "limit": limit,
                "offset": offset,
                "filter": f"lastSoldDate:[{start_text}..{end_text}]",
            }
            payload, note = self._get_page(params)
            if payload is None:
                self.fallback_queries += 1
                return {
                    "available": False,
                    "status": self.status,
                    "reason": self.reason,
                    "usable": False,
                    "items": [],
                }
            filter_fallback = filter_fallback or note == "filter_fallback"
            page_rows = payload.get("itemSales") or payload.get("item_sales") or []
            page_rows = [row for row in page_rows if isinstance(row, dict)]
            rows.extend(page_rows)
            total = max(total, int(safe_float(payload.get("total"), len(rows))))
            if len(page_rows) < limit or len(rows) >= total:
                break
            offset += limit

        result = summarize_marketplace_insights(part_number, rows, search_total=total)
        result.update({
            "available": True,
            "status": "available_filter_fallback" if filter_fallback else "available",
            "reason": "",
        })
        if result.get("usable"):
            self.successful_queries += 1
        else:
            self.fallback_queries += 1
        return result

    def summary(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "attempted": self.attempted,
            "available": self.available is True,
            "status": self.status,
            "reason": self.reason,
            "official_90d_queries": self.successful_queries,
            "snapshot_fallback_queries": self.fallback_queries,
            "fallback_method": "daily_snapshot_delta",
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


def _money_value(container: Any, currency: str = "USD") -> float | None:
    if not isinstance(container, dict):
        return None
    value = safe_float(container.get("value"), 0.0)
    code = str(container.get("currency") or container.get("currencyCode") or "").upper()
    if value <= 0 or (code and code != currency):
        return None
    return value


def summarize_marketplace_insights(
    part_number: str,
    rows: Iterable[dict[str, Any]],
    search_total: int | None = None,
) -> dict[str, Any]:
    """Normalize official Marketplace Insights sold-history rows.

    Exact part-number text matching is deliberately required. A successful
    query returning zero rows is an official zero. Returned rows without an
    exact title match are not trusted and trigger the snapshot fallback.
    """
    raw_rows = [row for row in rows if isinstance(row, dict)]
    deduped: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(raw_rows):
        title = row.get("title") or row.get("itemTitle") or ""
        if not title_contains_part_number(title, part_number):
            continue
        item_id = str(row.get("itemId") or row.get("legacyItemId") or f"row-{index}")
        quantity = max(0, int(safe_float(row.get("totalSoldQuantity"), 0)))
        previous = deduped.get(item_id)
        if previous is None or quantity > int(previous["quantity"]):
            price = _money_value(row.get("lastSoldPrice")) or _money_value(row.get("price"))
            seller = row.get("seller") if isinstance(row.get("seller"), dict) else {}
            deduped[item_id] = {
                "quantity": quantity,
                "price_usd": price,
                "seller": str(seller.get("username") or seller.get("userId") or ""),
                "last_sold_date": str(row.get("lastSoldDate") or ""),
            }

    exact_rows = list(deduped.values())
    official_zero = len(raw_rows) == 0 and int(search_total or 0) == 0
    usable = bool(exact_rows) or official_zero
    sold = sum(int(row["quantity"]) for row in exact_rows)
    prices = [float(row["price_usd"]) for row in exact_rows if row.get("price_usd")]
    sellers = {str(row["seller"]) for row in exact_rows if row.get("seller")}
    last_dates = sorted(str(row["last_sold_date"]) for row in exact_rows if row.get("last_sold_date"))
    return {
        "usable": usable,
        "quality": "marketplace_insights_90d" if usable else "marketplace_insights_no_exact_match",
        "confidence": "confirmed" if usable else "unknown",
        "estimate": float(sold),
        "low": float(sold),
        "high": float(sold),
        "observed_days": 90.0,
        "observed_days_min": 90.0,
        "observed_days_max": 90.0,
        "observed_delta": sold,
        "tracked_listings": len(exact_rows),
        "short_history_listings": 0,
        "sampled_listings": len(exact_rows),
        "search_returned": len(raw_rows),
        "search_total": int(search_total or len(raw_rows)),
        "exact_match_count": len(exact_rows),
        "seller_count": len(sellers),
        "prices_usd": prices,
        "last_sold_date": last_dates[-1] if last_dates else "",
        "auto_verified": usable,
        "part_number": part_number,
    }


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

    # Learning-mode fallback: lifetime quantities from currently active listings.
    estimates = [
        estimate_sales_pace(item, snapshots.get(str(item.get("itemId") or ""), []), now=observed_at)
        for item in items
    ]
    total = round(sum(safe_float(row.get("estimate"), 0.0) for row in estimates), 1)
    low = round(sum(safe_float(row.get("low"), 0.0) for row in estimates), 1)
    high = round(sum(safe_float(row.get("high"), 0.0) for row in estimates), 1)
    qualities = {str(row.get("quality")) for row in estimates if safe_float(row.get("estimate"), 0) > 0}
    fallback_days = [safe_float(row.get("observed_days"), 0.0) for row in estimates if safe_float(row.get("observed_days"), 0.0) > 0]
    observed_days = float(statistics.median(fallback_days)) if fallback_days else 0.0
    return {
        "estimate": total,
        "low": low,
        "high": high,
        "confidence": "learning" if total > 0 else "unknown",
        "quality": next(iter(qualities)) if len(qualities) == 1 else "mixed_estimate" if qualities else "insufficient",
        "observed_days": round(observed_days, 1),
        "observed_days_min": round(min(fallback_days), 1) if fallback_days else 0.0,
        "observed_days_max": round(max(fallback_days), 1) if fallback_days else 0.0,
        "observed_delta": 0,
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
    insights: dict[str, Any] | None,
    previous: dict[str, Any] | None,
    default_shipping_jpy: int,
) -> dict[str, Any]:
    previous = previous or {}
    active_count = int(competition.get("active_count") or 0)
    competition_known = bool(competition.get("known"))
    competition_confidence = str(competition.get("confidence") or "unknown")
    snapshot_sales = aggregate_sales_estimate(part_number, items, snapshots, observed_at)
    insights_data = insights or {"available": False, "status": "not_attempted", "usable": False, "prices_usd": []}
    use_official_sales = bool(insights_data.get("available") and insights_data.get("usable"))
    sales = insights_data if use_official_sales else snapshot_sales
    sold_90d = safe_float(sales.get("estimate"), 0.0)
    sold_prices = [safe_float(value) for value in sales.get("prices_usd", []) if safe_float(value) > 0]
    market_prices = sold_prices or prices

    rep = representative_item(items)
    score = market_score(sold_90d, active_count, market_prices)
    score -= {"unknown": 15, "low": 8, "medium": 3}.get(competition_confidence, 0)
    score -= {"unknown": 18, "learning": 12, "low": 8, "medium": 3, "confirmed": 0}.get(str(sales.get("confidence")), 0)
    score = max(0, min(100, score))

    unique_sellers = len({seller_key(item) for item in items if seller_key(item) != "unknown"})
    demand_ratio = sold_90d / max(active_count, 1)
    sample_coverage = min(1.0, len(items) / max(active_count, 1)) if competition_known else 0.0

    raw_sales_confidence = str(sales.get("confidence") or "unknown")
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
    sales_auto_verified = (
        raw_sales_confidence == "confirmed"
        or (sales_confidence == "high" and market_coverage_ok)
    )

    judgment = market_judgment(
        score,
        sold_90d,
        active_count,
        str(sales.get("quality")),
        sales_confidence,
    ) if competition_known else "競合未取得"

    origin_code, origin_confidence = infer_origin(items)
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
    elif sales.get("confidence") in {"unknown", "learning", "low"}:
        next_action = "自動学習中"
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
        "sold_90d_est": sold_90d,
        "sold_90d_low": sales.get("low", 0),
        "sold_90d_high": sales.get("high", 0),
        "sales_quality": sales.get("quality"),
        "sales_confidence": sales_confidence,
        "sales_raw_confidence": raw_sales_confidence,
        "sales_observed_days": sales.get("observed_days", 0),
        "sales_observed_days_min": sales.get("observed_days_min", 0),
        "sales_observed_days_max": sales.get("observed_days_max", 0),
        "sales_observed_delta": sales.get("observed_delta", 0),
        "sales_tracked_listings": tracked_listings,
        "sales_short_history_listings": sales.get("short_history_listings", 0),
        "sales_scope": "marketplace_insights_90d" if use_official_sales else "tracked_listing_90d_run_rate",
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
        "price_p25_usd": round(percentile(market_prices, 0.25), 2),
        "price_p75_usd": round(percentile(market_prices, 0.75), 2),
        "price_source": "marketplace_insights_last_sold" if sold_prices else "browse_active_listing",
        "active_price_median_usd": round(median(prices), 2),
        "sold_price_median_usd": round(median(sold_prices), 2),
        "market_score": score,
        "market_judgment": judgment,
        "source": "ebay_marketplace_insights_90d" if use_official_sales else "ebay_browse_snapshot_run_rate",
        "marketplace_insights": {
            "available": bool(insights_data.get("available")),
            "status": str(insights_data.get("status") or "not_attempted"),
            "used": use_official_sales,
            "search_total": int(safe_float(insights_data.get("search_total"), 0)),
            "search_returned": int(safe_float(insights_data.get("search_returned"), 0)),
            "exact_match_count": int(safe_float(insights_data.get("exact_match_count"), 0)),
            "last_sold_date": str(insights_data.get("last_sold_date") or ""),
        },
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


def run() -> int:
    client_id = os.getenv("EBAY_CLIENT_ID", "").strip()
    client_secret = os.getenv("EBAY_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        print("EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are required. Existing results were not overwritten.")
        return 2

    max_discovery_items = int(os.getenv("MAX_DISCOVERY_ITEMS", "40"))
    max_discovery_details = int(os.getenv("MAX_DISCOVERY_DETAILS", "20"))
    max_candidates = int(os.getenv("MAX_CANDIDATES", "24"))
    max_exact_details = int(os.getenv("MAX_EXACT_DETAILS", "50"))
    queries_per_run = int(os.getenv("QUERIES_PER_RUN", "8"))
    marketplace = os.getenv("EBAY_MARKETPLACE", "EBAY_US")
    category_id = os.getenv("EBAY_CATEGORY_ID", "6028")
    forced_query = os.getenv("RESEARCH_QUERY", "")
    default_shipping_jpy = int(os.getenv("DEFAULT_INTL_SHIPPING_JPY", "2800"))
    fallback_exchange_rate = safe_float(os.getenv("FALLBACK_USDJPY", "150"), 150.0)

    seeds = load_json(SEEDS_PATH, {})
    research_state: dict[str, Any] = load_json(RESEARCH_STATE_PATH, {})
    selected_queries = choose_queries(seeds, research_state, forced_query, count=queries_per_run)
    if not selected_queries:
        print("No search queries configured", file=sys.stderr)
        return 3
    print("Research queries:")
    for query, label in selected_queries:
        print(f"- {label}: {query}")

    client = EbayBrowseClient(client_id, client_secret, marketplace=marketplace)
    insights_enabled = os.getenv("ENABLE_MARKETPLACE_INSIGHTS", "true").strip().lower() not in {"0", "false", "no", "off"}
    insights_client = EbayMarketplaceInsightsClient(client, enabled=insights_enabled)
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

    for query, _label in selected_queries:
        try:
            payload = client.search(query, limit=max_discovery_items, category_id=category_id)
        except EbayApiError as exc:
            print(f"WARN discovery {query}: {exc}", file=sys.stderr)
            continue
        summaries = [
            item for item in payload.get("itemSummaries", [])
            if not blocked_title(item.get("title", ""), seeds.get("blocked_title_terms", []))
        ][:max_discovery_details]
        details = fetch_details(client, summaries)
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
        print(f"[{index}/{len(target_parts)}] exact search {part_number}")
        exact_search_ok = True
        try:
            exact_payload = client.search(part_number, limit=200, category_id=category_id)
        except EbayApiError as exc:
            exact_search_ok = False
            print(f"WARN exact search {part_number}: {exc}", file=sys.stderr)
            exact_payload = {"itemSummaries": [], "total": len(discovery_groups.get(part_number, []))}

        returned_summaries = list(exact_payload.get("itemSummaries", []))
        exact_summaries = [item for item in returned_summaries if title_contains_part_number(item.get("title", ""), part_number)]
        exact_prices = [item_price_usd(item) for item in exact_summaries if item_price_usd(item) > 0]
        exact_details = fetch_details(client, exact_summaries[:max_exact_details])

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

        insights_result = insights_client.search_part(part_number, observed_at)
        official_only_candidate = bool(
            insights_result.get("available")
            and insights_result.get("usable")
            and previous_products.get(part_number)
        )
        if not matching_details and not official_only_candidate:
            continue
        if not exact_prices:
            exact_prices = [item_price_usd(item) for item in matching_details if item_price_usd(item) > 0]

        if not matching_details and exact_search_ok and int(safe_float(exact_payload.get("total"), 0)) == 0:
            competition = {
                "active_count": 0,
                "known": True,
                "match_rate": 1.0,
                "confidence": "confirmed",
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
            insights=insights_result,
            previous=previous_products.get(part_number),
            default_shipping_jpy=default_shipping_jpy,
        )
        if candidate["price_median_usd"] > 0:
            candidates.append(candidate)

    # Save current observation after estimates so each run compares against prior days.
    for item in all_observed_items.values():
        parts = extract_part_numbers(item)
        append_snapshot(snapshots, item, observed_at, parts)

    candidates.sort(
        key=lambda row: (
            row["market_score"],
            row["sales_confidence"] in {"confirmed", "high"},
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
        "schema_version": 3,
        "app_version": "0.3.1",
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
            "marketplace_insights": insights_client.summary(),
            "sales_source_priority": ["marketplace_insights_90d", "daily_snapshot_delta"],
            "product_research_required_for_auto_verified": False,
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
            "Marketplace Insightsの利用承認がある場合は、eBay公式の過去90日成約数と最終成約価格を自動使用します。"
            "未承認の場合は操作不要で日次スナップショット差分へ切り替え、7日未満は換算せず、"
            "30日以上かつ同一品番の市場カバーが十分な場合だけ高精度とします。"
            "Product Researchは任意の照合機能です。関税率はHTSUS・原産国・DDP確認前のスクリーニング仮置きです。"
        ),
        "products": candidates,
    }
    save_json(RESULTS_PATH, output)
    save_json(SNAPSHOTS_PATH, snapshots)
    save_json(WATCHLIST_PATH, watchlist)
    save_json(RESEARCH_STATE_PATH, research_state)
    print(f"Wrote {len(candidates)} products to {RESULTS_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
