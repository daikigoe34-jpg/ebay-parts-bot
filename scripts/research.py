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
OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope"
RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701"
ECB_DAILY_XML = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
ANALYTICS_RATE_LIMIT_URL = "https://api.ebay.com/developer/analytics/v1_beta/rate_limit/"
APP_VERSION = "0.4.1"


class EbayApiError(RuntimeError):
    """Structured eBay failure without leaking credentials or access tokens."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        stage: str = "",
        response_body: str = "",
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.stage = stage
        self.response_body = response_body[:1000]


class EbayBrowseClient:
    def __init__(self, client_id: str, client_secret: str, marketplace: str = "EBAY_US") -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.marketplace = marketplace
        self.session = requests.Session()
        self.token = self._get_token()

    @staticmethod
    def _error_text(response: requests.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            return str(response.text or "")[:500]
        errors = payload.get("errors") if isinstance(payload, dict) else None
        if isinstance(errors, list) and errors:
            first = errors[0] if isinstance(errors[0], dict) else {}
            code = first.get("errorId") or first.get("errorCode") or ""
            message = first.get("longMessage") or first.get("message") or first.get("domain") or ""
            return f"{code}: {message}".strip(": ")[:500]
        return json.dumps(payload, ensure_ascii=False)[:500]

    def _get_token(self) -> str:
        basic = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        try:
            response = self.session.post(
                TOKEN_URL,
                headers={
                    "Authorization": f"Basic {basic}",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={"grant_type": "client_credentials", "scope": OAUTH_SCOPE},
                timeout=30,
            )
        except requests.RequestException as exc:
            raise EbayApiError(
                "OAuth endpoint could not be reached",
                stage="oauth",
                response_body=str(exc),
            ) from exc
        if response.status_code >= 400:
            detail = self._error_text(response)
            raise EbayApiError(
                f"OAuth failed: HTTP {response.status_code}: {detail}",
                status_code=response.status_code,
                stage="oauth",
                response_body=detail,
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise EbayApiError("OAuth response was not JSON", stage="oauth") from exc
        token = payload.get("access_token")
        if not token:
            raise EbayApiError("OAuth response did not contain access_token", stage="oauth")
        return str(token)

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "X-EBAY-C-MARKETPLACE-ID": self.marketplace,
            "X-EBAY-C-ENDUSERCTX": "contextualLocation=country%3DUS%2Czip%3D10001",
            "Accept-Language": "en-US",
        }

    def _get_json(self, url: str, params: dict[str, Any] | None = None, *, stage: str = "browse") -> dict[str, Any]:
        last_error = ""
        last_status: int | None = None
        for attempt in range(3):
            try:
                response = self.session.get(url, headers=self.headers, params=params, timeout=40)
            except requests.RequestException as exc:
                last_error = str(exc)
                if attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise EbayApiError(
                    f"{stage} endpoint could not be reached",
                    stage=stage,
                    response_body=last_error,
                ) from exc
            if response.status_code < 400:
                try:
                    return response.json()
                except ValueError as exc:
                    raise EbayApiError(f"{stage} response was not JSON", stage=stage) from exc
            last_status = response.status_code
            last_error = self._error_text(response)
            if response.status_code not in {429, 500, 502, 503, 504}:
                break
            time.sleep(1.5 * (attempt + 1))
        raise EbayApiError(
            f"{stage} failed: HTTP {last_status}: {last_error}",
            status_code=last_status,
            stage=stage,
            response_body=last_error,
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
        return self._get_json(f"{BROWSE_ROOT}/item_summary/search", params=params, stage="browse_search")

    def get_item(self, item_id: str) -> dict[str, Any]:
        encoded = quote(item_id, safe="")
        return self._get_json(f"{BROWSE_ROOT}/item/{encoded}", stage="browse_item")

    def rate_limits(self) -> dict[str, Any]:
        """Best-effort Browse quota status; never blocks the research run."""
        try:
            payload = self._get_json(ANALYTICS_RATE_LIMIT_URL, stage="developer_analytics")
        except EbayApiError as exc:
            return {
                "available": False,
                "status": classify_ebay_error(exc),
                "message": str(exc)[:300],
            }
        browse_rows: list[dict[str, Any]] = []
        for row in payload.get("rateLimits") or []:
            if not isinstance(row, dict):
                continue
            if str(row.get("apiContext") or "").lower() != "buy":
                continue
            if str(row.get("apiName") or "").lower() != "browse":
                continue
            for resource in row.get("resources") or []:
                if not isinstance(resource, dict):
                    continue
                for rate in resource.get("rates") or []:
                    if not isinstance(rate, dict):
                        continue
                    browse_rows.append({
                        "resource": str(resource.get("name") or ""),
                        "limit": int(safe_float(rate.get("limit"), 0)),
                        "count": int(safe_float(rate.get("count"), 0)),
                        "remaining": int(safe_float(rate.get("remaining"), 0)),
                        "reset": str(rate.get("reset") or ""),
                        "time_window_seconds": int(safe_float(rate.get("timeWindow"), 0)),
                    })
        if not browse_rows:
            return {"available": True, "status": "no_browse_row", "resources": []}
        remaining_values = [row["remaining"] for row in browse_rows if row["limit"] > 0]
        limit_values = [row["limit"] for row in browse_rows if row["limit"] > 0]
        return {
            "available": True,
            "status": "ok",
            "remaining": min(remaining_values) if remaining_values else 0,
            "limit": min(limit_values) if limit_values else 0,
            "resources": browse_rows,
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

    # Before seven observed days, do not manufacture a 90-day number from the
    # listing's lifetime sold quantity. Keep that total only as a non-ranking
    # signal so the UI can explain why the part is being monitored.
    learning_days: list[float] = []
    for item_id in target_ids:
        dates = [
            parse_snapshot_date(row.get("observed_at"))
            for row in snapshots.get(item_id, [])
            if isinstance(row, dict)
        ]
        dates = [dt for dt in dates if dt and dt < observed_at]
        if dates:
            learning_days.append(max((observed_at - min(dates)).total_seconds() / 86400, 0.0))
    observed_days = float(statistics.median(learning_days)) if learning_days else 0.0
    lifetime_signal = sum(sold_quantity(item) for item in items)
    learning = bool(items or target_ids)
    return {
        "estimate": 0.0,
        "low": 0.0,
        "high": 0.0,
        "confidence": "learning" if learning else "unknown",
        "quality": "learning_baseline" if learning else "insufficient",
        "observed_days": round(observed_days, 1),
        "observed_days_min": round(min(learning_days), 1) if learning_days else 0.0,
        "observed_days_max": round(max(learning_days), 1) if learning_days else 0.0,
        "observed_delta": 0,
        "lifetime_sold_signal": lifetime_signal,
        "days_until_usable": round(max(0.0, 7.0 - observed_days), 1),
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
    market_prices = prices

    rep = representative_item(items)
    score = market_score(sold_90d, active_count, market_prices)
    score -= {"unknown": 15, "low": 8, "medium": 3}.get(competition_confidence, 0)
    score -= {"unknown": 18, "learning": 12, "low": 8, "medium": 3}.get(str(sales.get("confidence")), 0)
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
    sales_auto_verified = sales_confidence == "high" and market_coverage_ok

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

    if sales_confidence in {"unknown", "learning", "low"}:
        next_action = "自動学習中"
    elif procurement_price <= 0:
        next_action = "仕入価格を確認"
    elif not origin_code:
        next_action = "原産国を確認"
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
        "sales_lifetime_signal": sales.get("lifetime_sold_signal", 0),
        "sales_days_until_usable": sales.get("days_until_usable", 0),
        "sales_tracked_listings": tracked_listings,
        "sales_short_history_listings": sales.get("short_history_listings", 0),
        "sales_scope": "production_browse_tracked_listing_run_rate",
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
        "price_source": "browse_active_listing",
        "active_price_median_usd": round(median(prices), 2),
        "sold_price_median_usd": 0.0,
        "market_score": score,
        "market_judgment": judgment,
        "source": "ebay_production_browse_snapshot_run_rate",
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
        "current_active": bool(items),
        "last_seen_at": observed_at.isoformat().replace("+00:00", "Z"),
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


def classify_ebay_error(error: EbayApiError) -> str:
    status = error.status_code
    if error.stage == "oauth":
        if status in {400, 401, 403}:
            return "invalid_credentials"
        return "oauth_temporary_error"
    # Developer Analytics is optional and has separate permissions. A 403 here
    # must not be misreported as missing Browse production access.
    if error.stage == "developer_analytics":
        if status in {401, 403, 404}:
            return "analytics_unavailable"
        if status == 429:
            return "analytics_rate_limited"
        if status and 400 <= status < 500:
            return "analytics_request_rejected"
        return "analytics_temporary_error"
    if status == 403:
        return "browse_not_approved"
    if status == 401:
        return "token_rejected"
    if status == 429:
        return "rate_limited"
    if status and 400 <= status < 500:
        return "request_rejected"
    return "temporary_error"


def research_run_status(
    *,
    selected_query_count: int,
    discovery_failures: int,
    target_part_count: int,
    exact_search_failures: int,
    candidate_count: int,
) -> str:
    """Summarize whether a research run is safe to publish.

    Successful empty searches are valid. We only classify a run as failed when
    API calls themselves failed, so a temporary eBay outage cannot wipe a prior
    candidate list.
    """
    discovery_successes = max(int(selected_query_count) - int(discovery_failures), 0)
    exact_successes = max(int(target_part_count) - int(exact_search_failures), 0)
    if selected_query_count > 0 and discovery_successes == 0 and target_part_count == 0:
        return "discovery_unavailable"
    if target_part_count > 0 and exact_successes == 0:
        return "exact_search_unavailable"
    if discovery_failures or exact_search_failures:
        return "partial_success" if candidate_count > 0 else "partial_failure"
    return "success"


def should_preserve_previous_results(
    previous_payload: dict[str, Any],
    candidates: list[dict[str, Any]],
    research_status: str,
) -> bool:
    previous_products = list(previous_payload.get("products") or [])
    return bool(previous_products) and not candidates and research_status in {
        "discovery_unavailable",
        "exact_search_unavailable",
        "partial_failure",
    }


def ebay_api_health(
    *,
    credentials_configured: bool,
    oauth_ok: bool = False,
    browse_ok: bool = False,
    error: EbayApiError | None = None,
    quota: dict[str, Any] | None = None,
    checked_at: datetime | None = None,
) -> dict[str, Any]:
    checked_at = checked_at or datetime.now(timezone.utc)
    if not credentials_configured:
        status = "missing_credentials"
        action = "GitHub SecretsへEBAY_CLIENT_IDとEBAY_CLIENT_SECRETを登録"
        message = "Productionキーが未登録です。"
    elif error is not None:
        status = classify_ebay_error(error)
        actions = {
            "invalid_credentials": "Production App IDとCert IDの組み合わせを確認",
            "browse_not_approved": "eBayへBuy/Browse APIのProduction利用申請を行う",
            "token_rejected": "Productionキーを再登録して再実行",
            "rate_limited": "割当リセット後に自動再実行",
            "request_rejected": "ActionsログのeBayエラー内容を確認",
            "oauth_temporary_error": "次回の自動実行を待つ",
            "temporary_error": "次回の自動実行を待つ",
        }
        messages = {
            "invalid_credentials": "Production OAuth認証に失敗しました。",
            "browse_not_approved": "OAuthは成功しましたが、Browse APIのProduction利用権限がありません。",
            "token_rejected": "Browse APIがアクセストークンを拒否しました。",
            "rate_limited": "Browse APIの呼出上限に達しました。",
            "request_rejected": "Browse APIがリクエストを拒否しました。",
            "oauth_temporary_error": "OAuth接続で一時エラーが発生しました。",
            "temporary_error": "eBay APIで一時エラーが発生しました。",
        }
        action = actions.get(status, "Actionsログを確認")
        message = messages.get(status, "eBay APIを確認してください。")
    elif oauth_ok and browse_ok:
        status = "ready"
        action = "なし。毎日の自動調査を継続"
        message = "Production OAuthとBrowse APIの両方に接続できています。"
    else:
        status = "checking"
        action = "自動診断中"
        message = "Production APIを確認しています。"
    return {
        "environment": "production",
        "credential_mode": "client_credentials",
        "credentials_configured": credentials_configured,
        "oauth_status": "ok" if oauth_ok else "not_ready",
        "browse_status": "ok" if browse_ok else "not_ready",
        "ready": status == "ready",
        "status": status,
        "message": message,
        "action_required": action,
        "http_status": error.status_code if error else None,
        "error_stage": error.stage if error else "",
        "checked_at": checked_at.isoformat().replace("+00:00", "Z"),
        "quota": quota or {"available": False, "status": "not_checked"},
    }


def merge_watchlist(
    previous: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    observed_at: datetime,
    *,
    max_size: int = 60,
    stale_days: int = 90,
) -> list[dict[str, Any]]:
    today = observed_at.date()
    merged: dict[str, dict[str, Any]] = {}
    for row in previous:
        part = normalize_part_number(row.get("part_number"))
        if not part:
            continue
        last_seen = str(row.get("last_seen") or "")
        try:
            age = (today - datetime.fromisoformat(last_seen).date()).days if last_seen else stale_days + 1
        except ValueError:
            age = stale_days + 1
        if age <= stale_days:
            merged[part] = {
                **row,
                "part_number": part,
                "missed_runs": int(safe_float(row.get("missed_runs"), 0)) + 1,
            }
    for row in candidates:
        part = normalize_part_number(row.get("part_number"))
        if not part:
            continue
        merged[part] = {
            **merged.get(part, {}),
            "part_number": part,
            "market_score": int(safe_float(row.get("market_score"), 0)),
            "last_seen": today.isoformat(),
            "last_checked": observed_at.isoformat().replace("+00:00", "Z"),
            "missed_runs": 0,
        }
    rows = list(merged.values())
    rows.sort(key=lambda row: (int(row.get("missed_runs", 0)) == 0, safe_float(row.get("market_score"), 0), str(row.get("last_seen", ""))), reverse=True)
    return rows[:max_size]


def build_status_payload(
    previous_payload: dict[str, Any],
    api_health: dict[str, Any],
    observed_at: datetime,
    *,
    rakuten_enabled: bool,
    research_status: str = "api_unavailable",
    discovery_failures: int = 0,
    exact_search_failures: int = 0,
    selected_query_count: int = 0,
    target_part_count: int = 0,
) -> dict[str, Any]:
    products = list(previous_payload.get("products") or [])
    previous_automation = dict(previous_payload.get("automation") or {})
    previous_api = dict(previous_automation.get("ebay_api") or {})
    previous_success = previous_automation.get("last_successful_research_at") or (
        previous_payload.get("generated_at") if previous_api.get("ready") is True else ""
    )
    data_status = "previous_real" if previous_success else "sample" if products else "empty"
    if research_status in {"discovery_unavailable", "exact_search_unavailable", "partial_failure"}:
        run_note = "今回の調査は一時障害で完了できなかったため、候補を消さず前回結果を保持しています。次回に自動再試行します。"
    elif research_status == "api_unavailable":
        run_note = "Production APIの初回設定または再接続を待っています。"
    else:
        run_note = ""
    return {
        **previous_payload,
        "schema_version": 4,
        "app_version": APP_VERSION,
        "generated_at": observed_at.isoformat().replace("+00:00", "Z"),
        "result_count": len(products),
        "data_status": data_status,
        "automation": {
            **previous_automation,
            "scheduled": True,
            "ebay_api": api_health,
            "rakuten_enabled": rakuten_enabled,
            "sales_source": "production_browse_daily_snapshot",
            "sales_source_priority": ["daily_snapshot_delta"],
            "product_research_mode": "optional_local_override",
            "high_confidence_after_days": 30,
            "research_status": research_status,
            "selected_query_count": int(selected_query_count),
            "target_part_count": int(target_part_count),
            "discovery_failures": int(discovery_failures),
            "exact_search_failures": int(exact_search_failures),
            "last_successful_research_at": previous_success,
            "last_attempt_at": observed_at.isoformat().replace("+00:00", "Z"),
        },
        "method_note": (
            run_note
            + ("前回の実データを保持しています。" if data_status == "previous_real" else "現在の候補は操作確認用のサンプル表示です。")
            + "eBay Productionキーだけで動く標準構成です。OAuthとBrowse APIの利用可否を自動診断し、"
            "販売ペースはBrowse APIのestimatedSoldQuantityを毎日保存した差分だけから推定します。"
            "観測7日未満は90日換算しません。関税はHTSUS・原産国・DDP確認前の仮計算です。"
        ),
        "products": products,
    }


def run() -> int:
    observed_at = datetime.now(timezone.utc)
    previous_payload = load_json(RESULTS_PATH, {})
    research_state: dict[str, Any] = load_json(RESEARCH_STATE_PATH, {})
    previous_products = {
        str(row.get("part_number")): row
        for row in previous_payload.get("products", [])
        if isinstance(row, dict) and row.get("part_number")
    }
    previous_watchlist = normalize_watchlist(load_json(WATCHLIST_PATH, []))

    client_id = os.getenv("EBAY_CLIENT_ID", "").strip()
    client_secret = os.getenv("EBAY_CLIENT_SECRET", "").strip()
    credentials_configured = bool(client_id and client_secret)
    rakuten_application_id = os.getenv("RAKUTEN_APPLICATION_ID", "").strip()
    rakuten_access_key = os.getenv("RAKUTEN_ACCESS_KEY", "").strip()
    rakuten_enabled = bool(rakuten_application_id and rakuten_access_key)

    if not credentials_configured:
        health = ebay_api_health(credentials_configured=False, checked_at=observed_at)
        save_json(RESULTS_PATH, build_status_payload(previous_payload, health, observed_at, rakuten_enabled=rakuten_enabled))
        print("Production eBay credentials are missing; status JSON was updated and previous products were preserved.")
        return 0

    marketplace = os.getenv("EBAY_MARKETPLACE", "EBAY_US")
    category_id = os.getenv("EBAY_CATEGORY_ID", "6028")
    try:
        client = EbayBrowseClient(client_id, client_secret, marketplace=marketplace)
    except EbayApiError as exc:
        health = ebay_api_health(credentials_configured=True, error=exc, checked_at=observed_at)
        save_json(RESULTS_PATH, build_status_payload(previous_payload, health, observed_at, rakuten_enabled=rakuten_enabled))
        print(f"eBay OAuth diagnostic: {health['status']}")
        return 0

    # A minimal Production Browse call distinguishes valid credentials from a
    # keyset that has not been approved for Buy/Browse production access.
    try:
        client.search("Nissan OEM relay", limit=1, category_id=category_id)
    except EbayApiError as exc:
        health = ebay_api_health(
            credentials_configured=True,
            oauth_ok=True,
            browse_ok=False,
            error=exc,
            checked_at=observed_at,
        )
        save_json(RESULTS_PATH, build_status_payload(previous_payload, health, observed_at, rakuten_enabled=rakuten_enabled))
        print(f"eBay Browse diagnostic: {health['status']}")
        return 0

    quota = client.rate_limits()
    health = ebay_api_health(
        credentials_configured=True,
        oauth_ok=True,
        browse_ok=True,
        quota=quota,
        checked_at=observed_at,
    )

    max_discovery_items = int(os.getenv("MAX_DISCOVERY_ITEMS", "40"))
    max_discovery_details = int(os.getenv("MAX_DISCOVERY_DETAILS", "20"))
    max_candidates = int(os.getenv("MAX_CANDIDATES", "24"))
    max_exact_details = int(os.getenv("MAX_EXACT_DETAILS", "50"))
    queries_per_run = int(os.getenv("QUERIES_PER_RUN", "8"))
    default_shipping_jpy = int(os.getenv("DEFAULT_INTL_SHIPPING_JPY", "2800"))
    fallback_exchange_rate = float(os.getenv("FALLBACK_USDJPY", "150"))
    forced_query = os.getenv("RESEARCH_QUERY", "")

    seeds = load_json(SEEDS_PATH, {})
    selected_queries = choose_queries(seeds, research_state, forced_query, queries_per_run)
    print("Research queries:")
    for query, label in selected_queries:
        print(f"- {label}: {query}")

    rakuten_client = RakutenClient(rakuten_application_id, rakuten_access_key) if rakuten_enabled else None
    snapshots: dict[str, list[dict[str, Any]]] = load_json(SNAPSHOTS_PATH, {})

    discovery_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    part_queries: dict[str, set[str]] = defaultdict(set)
    all_observed_items: dict[str, dict[str, Any]] = {}
    discovery_failures = 0

    for query, _label in selected_queries:
        try:
            payload = client.search(query, limit=max_discovery_items, category_id=category_id)
        except EbayApiError as exc:
            discovery_failures += 1
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

    previous_parts = [
        row["part_number"]
        for row in sorted(
            previous_watchlist,
            key=lambda row: (int(safe_float(row.get("missed_runs"), 0)) == 0, safe_float(row.get("market_score"), 0)),
            reverse=True,
        )
    ]
    target_parts: list[str] = []
    # Keep half of the daily capacity for persistent observation and half for discovery.
    for part in [*previous_parts[: max_candidates // 2], *ranked_new_parts, *previous_parts]:
        if part and part not in target_parts:
            target_parts.append(part)
        if len(target_parts) >= max_candidates:
            break

    candidates: list[dict[str, Any]] = []
    exact_failures = 0
    for index, part_number in enumerate(target_parts, start=1):
        print(f"[{index}/{len(target_parts)}] exact search {part_number}")
        try:
            exact_payload = client.search(part_number, limit=200, category_id=category_id)
        except EbayApiError as exc:
            exact_failures += 1
            print(f"WARN exact search {part_number}: {exc}", file=sys.stderr)
            continue

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

        if not matching_details:
            continue
        if not exact_prices:
            exact_prices = [item_price_usd(item) for item in matching_details if item_price_usd(item) > 0]

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
            previous=previous_products.get(part_number),
            default_shipping_jpy=default_shipping_jpy,
        )
        if candidate["price_median_usd"] > 0:
            candidates.append(candidate)

    candidates.sort(
        key=lambda row: (
            row["sales_confidence"] == "high",
            row["market_score"],
            row["sold_90d_est"],
            -row["active_competition"],
        ),
        reverse=True,
    )
    candidates = candidates[:max_candidates]
    research_status = research_run_status(
        selected_query_count=len(selected_queries),
        discovery_failures=discovery_failures,
        target_part_count=len(target_parts),
        exact_search_failures=exact_failures,
        candidate_count=len(candidates),
    )
    if should_preserve_previous_results(previous_payload, candidates, research_status):
        status_payload = build_status_payload(
            previous_payload,
            health,
            observed_at,
            rakuten_enabled=rakuten_enabled,
            research_status=research_status,
            discovery_failures=discovery_failures,
            exact_search_failures=exact_failures,
            selected_query_count=len(selected_queries),
            target_part_count=len(target_parts),
        )
        save_json(RESULTS_PATH, status_payload)
        print(f"Research status {research_status}; previous products were preserved for automatic retry.")
        return 0

    # Save only after the run is usable, so temporary failures cannot pollute
    # the observation history or erase the prior watchlist.
    for item in all_observed_items.values():
        append_snapshot(snapshots, item, observed_at, extract_part_numbers(item))

    watchlist = merge_watchlist(previous_watchlist, candidates, observed_at, max_size=60, stale_days=90)

    exchange_rate = fetch_usd_jpy_rate(fallback_exchange_rate)
    research_state.update({
        "last_run": observed_at.isoformat().replace("+00:00", "Z"),
        "last_successful_run": observed_at.isoformat().replace("+00:00", "Z"),
        "last_queries": [query for query, _label in selected_queries],
        "runs_completed": int(safe_float(research_state.get("runs_completed"), 0)) + 1,
    })

    output = {
        "schema_version": 4,
        "app_version": APP_VERSION,
        "generated_at": observed_at.isoformat().replace("+00:00", "Z"),
        "marketplace": marketplace,
        "category_id": category_id,
        "queries": [query for query, _label in selected_queries],
        "query": " / ".join(query for query, _label in selected_queries[:3]),
        "query_label": f"自動ローテーション {len(selected_queries)}語",
        "result_count": len(candidates),
        "data_status": "real",
        "automation": {
            "scheduled": True,
            "ebay_api": health,
            "queries_per_run": len(selected_queries),
            "watchlist_size": len(watchlist),
            "snapshot_runs": research_state["runs_completed"],
            "rakuten_enabled": rakuten_client is not None,
            "sales_source": "production_browse_daily_snapshot",
            "sales_source_priority": ["daily_snapshot_delta"],
            "product_research_mode": "optional_local_override",
            "high_confidence_after_days": 30,
            "research_status": research_status,
            "selected_query_count": len(selected_queries),
            "target_part_count": len(target_parts),
            "last_successful_research_at": observed_at.isoformat().replace("+00:00", "Z"),
            "last_attempt_at": observed_at.isoformat().replace("+00:00", "Z"),
            "discovery_failures": discovery_failures,
            "exact_search_failures": exact_failures,
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
            ("一部の検索は一時失敗しましたが、取得できた候補を保存し、次回に自動再試行します。" if research_status == "partial_success" else "")
            + "eBay ProductionキーとBrowse APIだけで自動調査します。販売ペースは同一品番の"
            "estimatedSoldQuantityを毎日保存し、観測開始後の正の増分だけを90日換算します。"
            "7日未満は販売数を表示せず、30日以上かつ市場カバーが十分な場合だけ自動精度・高とします。"
            "Product Researchは日常操作には不要な任意補正です。関税はHTSUS・原産国・DDP確認前の仮計算です。"
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
