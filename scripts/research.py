from __future__ import annotations

import base64
import json
import os
import random
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

import requests

from core import (
    estimate_competition,
    estimate_90d_sold,
    extract_part_numbers,
    market_judgment,
    market_score,
    median,
    normalize_part_number,
    percentile,
    safe_float,
    sold_quantity,
)

ROOT = Path(__file__).resolve().parents[1]
SEEDS_PATH = ROOT / "config" / "search_seeds.json"
RESULTS_PATH = ROOT / "web" / "data" / "results.json"
SNAPSHOTS_PATH = ROOT / "state" / "snapshots.json"

TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
BROWSE_ROOT = "https://api.ebay.com/buy/browse/v1"
OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope"


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
            response = self.session.get(url, headers=self.headers, params=params, timeout=35)
            if response.status_code < 400:
                return response.json()
            last_error = f"HTTP {response.status_code}: {response.text[:500]}"
            if response.status_code not in {429, 500, 502, 503, 504}:
                break
            time.sleep(1.5 * (attempt + 1))
        raise EbayApiError(f"GET {url} failed: {last_error}")

    def search(self, query: str, limit: int = 50, category_id: str = "6028") -> dict[str, Any]:
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


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def choose_query(seeds: dict[str, Any], forced: str | None = None) -> tuple[str, str]:
    forced = (forced or "").strip()
    if forced:
        return forced, "手動指定"
    brand = random.choice(seeds["brands"])
    authenticity = random.choice(seeds["authenticity_terms"])
    part_term = random.choice(seeds["small_part_terms"])
    return f"{brand['query']} {authenticity} {part_term}", brand["label_ja"]


def blocked_title(title: str, blocked_terms: Iterable[str]) -> bool:
    upper = str(title or "").upper()
    return any(term.upper() in upper for term in blocked_terms)


def item_price_usd(item: dict[str, Any]) -> float:
    return safe_float((item.get("price") or {}).get("value"), 0.0)


def seller_key(item: dict[str, Any]) -> str:
    seller = item.get("seller") or {}
    return str(seller.get("username") or seller.get("sellerId") or seller.get("userId") or "unknown")


def compact_part_number(value: str) -> str:
    return normalize_part_number(value).replace("-", "")


def title_contains_part_number(title: Any, part_number: str) -> bool:
    compact_title = "".join(ch for ch in str(title or "").upper() if ch.isalnum())
    compact_part = compact_part_number(part_number)
    return bool(compact_part and compact_part in compact_title)


def fetch_details(client: EbayBrowseClient, summaries: list[dict[str, Any]], max_workers: int = 8) -> list[dict[str, Any]]:
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
            except Exception as exc:  # Continue a batch even when a listing disappears mid-run.
                print(f"WARN item {item_id}: {exc}", file=sys.stderr)
                continue
            details.append(detail)
    return details


def append_snapshot(
    snapshots: dict[str, list[dict[str, Any]]], item: dict[str, Any], observed_at: datetime
) -> None:
    item_id = str(item.get("itemId") or "")
    if not item_id:
        return
    cutoff = observed_at - timedelta(days=100)
    rows: list[dict[str, Any]] = []
    for row in snapshots.get(item_id, []):
        try:
            row_dt = datetime.fromisoformat(str(row.get("observed_at", "")).replace("Z", "+00:00"))
            if row_dt.tzinfo is None:
                row_dt = row_dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if row_dt >= cutoff:
            rows.append(row)
    today = observed_at.date().isoformat()
    rows = [row for row in rows if not str(row.get("observed_at", "")).startswith(today)]
    rows.append(
        {
            "item_id": item_id,
            "observed_at": observed_at.isoformat().replace("+00:00", "Z"),
            "sold_quantity": sold_quantity(item),
        }
    )
    snapshots[item_id] = rows[-100:]


def representative_item(items: list[dict[str, Any]]) -> dict[str, Any]:
    if not items:
        return {}
    return max(items, key=lambda item: (sold_quantity(item), item_price_usd(item)))


def build_candidate(
    part_number: str,
    items: list[dict[str, Any]],
    competition: dict[str, Any],
    prices: list[float],
    snapshots: dict[str, list[dict[str, Any]]],
    observed_at: datetime,
    query: str,
) -> dict[str, Any]:
    active_count = int(competition.get("active_count") or 0)
    competition_known = bool(competition.get("known"))
    competition_confidence = str(competition.get("confidence") or "unknown")
    sold_estimates: list[float] = []
    qualities: list[str] = []
    for item in items:
        item_id = str(item.get("itemId") or "")
        estimate, quality = estimate_90d_sold(item, snapshots.get(item_id, []), now=observed_at)
        sold_estimates.append(estimate)
        qualities.append(quality)

    sold_90d = round(sum(sold_estimates), 1)
    meaningful_qualities = {quality for estimate, quality in zip(sold_estimates, qualities) if estimate > 0}
    if not meaningful_qualities:
        quality = "insufficient"
    elif len(meaningful_qualities) == 1:
        quality = next(iter(meaningful_qualities))
    else:
        quality = "mixed_estimate"
    score = market_score(sold_90d, active_count, prices)
    # Avoid a high-looking score when the exact-part-number sample is weak.
    score -= {"unknown": 15, "low": 8, "medium": 3}.get(competition_confidence, 0)
    score = max(0, min(100, score))
    rep = representative_item(items)
    unique_sellers = len({seller_key(item) for item in items if seller_key(item) != "unknown"})
    demand_ratio = sold_90d / max(active_count, 1)
    sample_coverage = min(1.0, len(items) / max(active_count, 1)) if competition_known else 0.0
    judgment = (
        market_judgment(score, sold_90d, active_count, quality)
        if competition_known
        else "競合未取得"
    )

    return {
        "part_number": part_number,
        "brand": infer_brand(rep.get("title", "")),
        "title": rep.get("title") or f"{part_number} auto part",
        "image_url": ((rep.get("image") or {}).get("imageUrl") or ""),
        "ebay_url": rep.get("itemWebUrl") or rep.get("itemAffiliateWebUrl") or "",
        "query": query,
        "sold_90d_est": sold_90d,
        "sales_quality": quality,
        "sales_scope": "sampled_active_listings",
        "sales_confirmation_required": True,
        "sampled_listings": len(items),
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
        "price_median_usd": round(median(prices), 2),
        "price_p25_usd": round(percentile(prices, 0.25), 2),
        "price_p75_usd": round(percentile(prices, 0.75), 2),
        "market_score": score,
        "market_judgment": judgment,
        "source": "ebay_browse_snapshot_estimate",
    }


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


def run() -> int:
    client_id = os.getenv("EBAY_CLIENT_ID", "").strip()
    client_secret = os.getenv("EBAY_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        print("EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are required. Existing demo results were not overwritten.")
        return 2

    max_discovery = int(os.getenv("MAX_DISCOVERY_ITEMS", "50"))
    max_candidates = int(os.getenv("MAX_CANDIDATES", "15"))
    max_exact_details = int(os.getenv("MAX_EXACT_DETAILS", "15"))
    marketplace = os.getenv("EBAY_MARKETPLACE", "EBAY_US")
    category_id = os.getenv("EBAY_CATEGORY_ID", "6028")
    forced_query = os.getenv("RESEARCH_QUERY", "")

    seeds = load_json(SEEDS_PATH, {})
    query, query_label = choose_query(seeds, forced_query)
    print(f"Research query: {query}")

    client = EbayBrowseClient(client_id, client_secret, marketplace=marketplace)
    observed_at = datetime.now(timezone.utc)
    snapshots: dict[str, list[dict[str, Any]]] = load_json(SNAPSHOTS_PATH, {})

    discovery_payload = client.search(query, limit=max_discovery, category_id=category_id)
    discovery_summaries = [
        item
        for item in discovery_payload.get("itemSummaries", [])
        if not blocked_title(item.get("title", ""), seeds.get("blocked_title_terms", []))
    ]
    discovery_details = fetch_details(client, discovery_summaries)

    discovery_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for detail in discovery_details:
        if blocked_title(detail.get("title", ""), seeds.get("blocked_title_terms", [])):
            continue
        for part_number in extract_part_numbers(detail):
            discovery_groups[part_number].append(detail)

    # Prioritize identifiers with repeated listings and/or visible sold quantity.
    ranked_parts = sorted(
        discovery_groups,
        key=lambda part: (
            sum(sold_quantity(item) for item in discovery_groups[part]),
            len(discovery_groups[part]),
            median([item_price_usd(item) for item in discovery_groups[part]]),
        ),
        reverse=True,
    )[:max_candidates]

    candidates: list[dict[str, Any]] = []
    all_observed_items: dict[str, dict[str, Any]] = {
        str(item.get("itemId")): item for item in discovery_details if item.get("itemId")
    }

    for index, part_number in enumerate(ranked_parts, start=1):
        print(f"[{index}/{len(ranked_parts)}] exact search {part_number}")
        try:
            exact_payload = client.search(part_number, limit=50, category_id=category_id)
        except EbayApiError as exc:
            print(f"WARN exact search {part_number}: {exc}", file=sys.stderr)
            exact_payload = {"itemSummaries": [], "total": len(discovery_groups[part_number])}

        returned_summaries = list(exact_payload.get("itemSummaries", []))
        exact_summaries = [
            item
            for item in returned_summaries
            if title_contains_part_number(item.get("title", ""), part_number)
        ]
        exact_prices = [item_price_usd(item) for item in exact_summaries if item_price_usd(item) > 0]
        exact_details = fetch_details(client, exact_summaries[:max_exact_details])

        matching_details: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for item in [*discovery_groups[part_number], *exact_details]:
            item_id = str(item.get("itemId") or "")
            if not item_id or item_id in seen_ids:
                continue
            part_numbers = extract_part_numbers(item)
            if part_number in part_numbers or title_contains_part_number(item.get("title", ""), part_number):
                matching_details.append(item)
                seen_ids.add(item_id)
                all_observed_items[item_id] = item

        if not exact_prices:
            exact_prices = [item_price_usd(item) for item in matching_details if item_price_usd(item) > 0]

        competition = estimate_competition(
            exact_payload.get("total"),
            len(returned_summaries),
            len(exact_summaries),
            len(matching_details),
        )
        candidate = build_candidate(
            part_number,
            matching_details,
            competition,
            exact_prices,
            snapshots,
            observed_at,
            query,
        )
        if candidate["price_median_usd"] > 0:
            candidates.append(candidate)

    for item in all_observed_items.values():
        append_snapshot(snapshots, item, observed_at)

    candidates.sort(
        key=lambda row: (row["market_score"], row["sold_90d_est"], -row["active_competition"]),
        reverse=True,
    )

    output = {
        "schema_version": 2,
        "generated_at": observed_at.isoformat().replace("+00:00", "Z"),
        "marketplace": marketplace,
        "category_id": category_id,
        "query": query,
        "query_label": query_label,
        "result_count": len(candidates),
        "method_note": (
            "Browse APIは現行出品のみです。表示する90日販売数は確認できた出品サンプルの"
            "estimatedSoldQuantityを日次保存し、差分または掲載期間平均から推定した仮値です。"
            "競合数も同一品番一致率から推定します。最終の販売候補判定にはProduct Researchの90日実績と"
            "実際のDDP関税見積の確認が必要です。"
        ),
        "products": candidates,
    }
    save_json(RESULTS_PATH, output)
    save_json(SNAPSHOTS_PATH, snapshots)
    print(f"Wrote {len(candidates)} products to {RESULTS_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
