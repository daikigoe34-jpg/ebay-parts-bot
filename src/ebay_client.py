"""
eBay API クライアント
Browse API を使って、出品中の商品を検索する
OAuth認証（Client Credentials Grant）でアクセストークンを取得
"""

import os
import base64
import time

import requests
from requests.exceptions import ConnectionError, Timeout, RequestException
from dotenv import load_dotenv

from src import config
from src.logger import logger

# .envファイルからAPIキーを読み込む
load_dotenv()

# API呼び出しのタイムアウト（秒）
API_TIMEOUT = 30

# レート制限対策
MAX_RETRIES = 3
RETRY_BASE_WAIT = 5
KEYWORD_INTERVAL = 2

# OAuthトークンのキャッシュ
_cached_token = None
_token_expires_at = 0


def _mask_key(key):
    """APIキーをマスキングする（先頭4文字だけ表示）"""
    if not key or len(key) < 8:
        return "****"
    return key[:4] + "****" + key[-4:]


def get_oauth_token():
    """
    eBay OAuth認証（Client Credentials Grant）
    トークンをキャッシュして、期限切れまで再利用する

    Returns:
        str: アクセストークン
    Raises:
        ValueError: APIキー未設定
        ConnectionError: ネットワーク接続失敗
        RuntimeError: 認証失敗
    """
    global _cached_token, _token_expires_at

    # キャッシュが有効ならそのまま返す（期限の60秒前に更新）
    if _cached_token and time.time() < _token_expires_at - 60:
        return _cached_token

    # Streamlit Cloud対応: st.secretsを優先、なければ.envから取得
    app_id = None
    cert_id = None
    try:
        import streamlit as st
        app_id = st.secrets.get("EBAY_APP_ID")
        cert_id = st.secrets.get("EBAY_CERT_ID")
    except Exception:
        pass
    if not app_id:
        app_id = os.getenv("EBAY_APP_ID")
    if not cert_id:
        cert_id = os.getenv("EBAY_CERT_ID")

    if not app_id or not cert_id:
        raise ValueError(
            "EBAY_APP_ID と EBAY_CERT_ID が .env に設定されていません。\n"
            "対処法: .env.example を .env にコピーして、APIキーを入力してください。"
        )

    logger.debug(f"OAuth認証を開始: APP_ID={_mask_key(app_id)}")

    # Basic認証のヘッダーを作成（Base64エンコード）
    credentials = f"{app_id}:{cert_id}"
    encoded = base64.b64encode(credentials.encode()).decode()

    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": f"Basic {encoded}",
    }

    data = {
        "grant_type": "client_credentials",
        "scope": "https://api.ebay.com/oauth/api_scope",
    }

    try:
        response = requests.post(
            config.EBAY_OAUTH_URL, headers=headers, data=data, timeout=API_TIMEOUT
        )
    except Timeout:
        raise ConnectionError(
            "OAuth認証がタイムアウトしました。\n"
            "対処法: ネットワーク接続を確認してください。"
        )
    except ConnectionError:
        raise ConnectionError(
            "eBay APIに接続できません。\n"
            "対処法: インターネット接続を確認してください。"
        )

    if response.status_code != 200:
        raise RuntimeError(
            f"OAuth認証に失敗しました（ステータス: {response.status_code}）\n"
            f"原因: APIキーが正しくない可能性があります。\n"
            f"対処法: .envのEBAY_APP_IDとEBAY_CERT_IDを確認してください。"
        )

    try:
        token_data = response.json()
        _cached_token = token_data["access_token"]
        # expires_in（秒）からキャッシュ期限を計算
        _token_expires_at = time.time() + token_data.get("expires_in", 7200)
        logger.debug("OAuthトークン取得成功")
        return _cached_token
    except (ValueError, KeyError) as e:
        raise RuntimeError(f"OAuth認証レスポンスの解析に失敗しました: {e}")


def search_items(keyword):
    """
    eBay Browse API で商品を検索する
    現在出品中の商品を価格順に取得

    Args:
        keyword (str): 検索キーワード

    Returns:
        list: 商品のリスト（辞書のリスト）
    """
    logger.info(f"検索中: 「{keyword}」...")

    # OAuthトークンを取得
    try:
        token = get_oauth_token()
    except (ValueError, ConnectionError, RuntimeError) as e:
        logger.error(f"認証エラー: {e}")
        raise

    headers = {
        "Authorization": f"Bearer {token}",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",  # アメリカのマーケットプレイス
    }

    params = {
        "q": keyword,
        "category_ids": config.EBAY_CATEGORY_ID,
        "limit": str(config.ITEMS_PER_KEYWORD),
        "sort": "-price",  # 価格の高い順
        # 現実的な価格帯にフィルタ
        "filter": f"price:[{config.MIN_PRICE_USD}..{config.MAX_PRICE_USD}],priceCurrency:USD",
    }

    # リトライ付きでAPI呼び出し
    response = None
    for attempt in range(MAX_RETRIES):
        try:
            response = requests.get(
                config.EBAY_BROWSE_API_URL,
                headers=headers,
                params=params,
                timeout=API_TIMEOUT,
            )
        except Timeout:
            logger.warning(f"検索がタイムアウトしました: 「{keyword}」")
            return []
        except ConnectionError:
            logger.warning(f"ネットワーク接続エラー: 「{keyword}」")
            return []
        except RequestException as e:
            logger.warning(f"API呼び出しエラー: 「{keyword}」 - {e}")
            return []

        # レート制限チェック（429）
        if response.status_code == 429:
            wait_sec = RETRY_BASE_WAIT * (2 ** attempt)
            if attempt < MAX_RETRIES - 1:
                logger.warning(
                    f"レート制限検出。{wait_sec}秒待ってリトライします "
                    f"({attempt+1}/{MAX_RETRIES}): 「{keyword}」"
                )
                time.sleep(wait_sec)
                continue
            else:
                logger.error(
                    f"レート制限: {MAX_RETRIES}回リトライしても解除されませんでした: 「{keyword}」\n"
                    f"  対処法: 数分待ってから再実行してください。"
                )
                return []

        # その他のエラー
        if response.status_code != 200:
            logger.warning(f"API呼び出し失敗（ステータス: {response.status_code}）: 「{keyword}」")
            return []

        # 成功 → ループを抜ける
        break

    if response is None:
        return []

    # JSONの解析
    try:
        data = response.json()
    except ValueError:
        logger.warning(f"APIレスポンスのJSON解析に失敗: 「{keyword}」")
        return []

    # レスポンスからアイテムリストを取り出す
    total = data.get("total", 0)
    if total == 0:
        logger.info(f"結果なし: 「{keyword}」")
        return []

    raw_items = data.get("itemSummaries", [])

    # 必要な情報を整理してリストにする
    items = []
    skipped = 0
    for item in raw_items:
        try:
            title = item.get("title", "")

            # 価格の取得
            price_info = item.get("price", {})
            price_usd = float(price_info.get("value", 0))
            currency = price_info.get("currency", "USD")

            # USD以外はスキップ
            if currency != "USD":
                skipped += 1
                continue

            # 送料の取得（あれば）
            shipping_usd = 0.0
            shipping_options = item.get("shippingOptions", [])
            if shipping_options:
                ship_cost = shipping_options[0].get("shippingCost", {})
                shipping_usd = float(ship_cost.get("value", 0))

            # 商品URL
            url = item.get("itemWebUrl", "")

            # 出品場所
            location = item.get("itemLocation", {}).get("country", "")

            items.append({
                "title": title,
                "price_usd": price_usd,
                "shipping_usd": shipping_usd,
                "sold_date": "出品中",
                "url": url,
                "keyword": keyword,
                "location": location,
            })
        except (KeyError, ValueError, TypeError):
            skipped += 1
            continue

    if skipped > 0:
        logger.warning(f"データ欠損でスキップした商品: {skipped}件（「{keyword}」）")

    logger.info(f"{len(items)}件 取得: 「{keyword}」")
    return items


def get_demo_data():
    """
    デモ用のダミーデータを返す
    APIキーがなくても動作確認ができるように用意
    関税15%+手数料14.6%を考慮して$40〜$100の価格帯

    Returns:
        list: ダミー商品データのリスト
    """
    demo_items = [
        {
            "title": "Genuine Nissan Oil Filter 15208-65F0E Japan OEM",
            "price_usd": 42.00,
            "shipping_usd": 0.0,
            "sold_date": "2026-03-28",
            "url": "https://www.ebay.com/itm/example1",
            "keyword": "genuine Nissan Japan",
        },
        {
            "title": "OEM Toyota Brake Pad Front 04465-26420 JDM Genuine",
            "price_usd": 68.50,
            "shipping_usd": 0.0,
            "sold_date": "2026-03-27",
            "url": "https://www.ebay.com/itm/example2",
            "keyword": "OEM Toyota Japan",
        },
        {
            "title": "Genuine Honda Civic Air Filter 17220-5BA-A00 Japan",
            "price_usd": 45.00,
            "shipping_usd": 0.0,
            "sold_date": "2026-03-29",
            "url": "https://www.ebay.com/itm/example3",
            "keyword": "genuine Honda Japan JDM",
        },
        {
            "title": "Mazda Genuine Spark Plug Set PE5R-18-110 x4 Japan",
            "price_usd": 55.00,
            "shipping_usd": 0.0,
            "sold_date": "2026-03-26",
            "url": "https://www.ebay.com/itm/example4",
            "keyword": "Mazda genuine parts Japan",
        },
        {
            "title": "Subaru OEM Cabin Filter 72880FG000 Forester Japan",
            "price_usd": 48.00,
            "shipping_usd": 0.0,
            "sold_date": "2026-03-25",
            "url": "https://www.ebay.com/itm/example5",
            "keyword": "Subaru OEM Japan",
        },
        {
            "title": "Toyota Genuine Thermostat 90916-03100 Japan OEM",
            "price_usd": 38.00,
            "shipping_usd": 0.0,
            "sold_date": "2026-03-30",
            "url": "https://www.ebay.com/itm/example6",
            "keyword": "OEM Toyota Japan",
        },
        {
            "title": "Nissan Genuine Water Pump 21010-AD226 JDM Japan",
            "price_usd": 85.00,
            "shipping_usd": 0.0,
            "sold_date": "2026-03-24",
            "url": "https://www.ebay.com/itm/example7",
            "keyword": "genuine Nissan Japan",
        },
        {
            "title": "Honda OEM Timing Belt 14400-RCA-A01 Genuine Japan",
            "price_usd": 95.00,
            "shipping_usd": 0.0,
            "sold_date": "2026-03-23",
            "url": "https://www.ebay.com/itm/example8",
            "keyword": "genuine Honda Japan JDM",
        },
        {
            "title": "Mazda Genuine Fuel Filter KL47-20-490A Japan OEM",
            "price_usd": 52.00,
            "shipping_usd": 0.0,
            "sold_date": "2026-03-22",
            "url": "https://www.ebay.com/itm/example9",
            "keyword": "Mazda genuine parts Japan",
        },
        {
            "title": "Subaru Genuine Head Gasket 11044AA770 EJ25 Japan",
            "price_usd": 99.00,
            "shipping_usd": 0.0,
            "sold_date": "2026-03-21",
            "url": "https://www.ebay.com/itm/example10",
            "keyword": "Subaru OEM Japan",
        },
    ]
    return demo_items
