"""
Finding API レート制限チェックスクリプト
cronで朝自動実行用。レート制限が解除されていなければメール案内を表示する。
"""

import os
import sys
import requests
from dotenv import load_dotenv

# プロジェクトルートをパスに追加
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import config

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))


def check_finding_api():
    """Finding APIが使えるかチェック"""
    app_id = os.getenv("EBAY_APP_ID")
    if not app_id:
        print("❌ EBAY_APP_ID が .env に未設定")
        return False

    params = {
        "OPERATION-NAME": "findItemsByKeywords",
        "SERVICE-VERSION": "1.0.0",
        "SECURITY-APPNAME": app_id,
        "RESPONSE-DATA-FORMAT": "JSON",
        "keywords": "test",
        "paginationInput.entriesPerPage": "1",
    }

    try:
        resp = requests.get(config.EBAY_FINDING_API_URL, params=params, timeout=30)
    except Exception as e:
        print(f"❌ 接続エラー: {e}")
        return False

    if resp.status_code == 500:
        data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
        errors = str(data)
        if "RateLimiter" in errors:
            print("❌ Finding API: まだレート制限中")
            return False

    if resp.status_code == 200:
        print("✅ Finding API: レート制限解除！使えるようになった")
        return True

    print(f"⚠️ Finding API: 不明なレスポンス (status={resp.status_code})")
    return False


def print_email_draft():
    """eBayテクサポ宛メール案文を表示"""
    print("\n" + "=" * 60)
    print("Finding API レート制限が未解除。以下のメールを送ってください：")
    print("=" * 60)
    print("宛先: ebayjapan-techsupport@ebay.com")
    print("件名: Finding API Rate Limit Issue - New Production Key")
    print("-" * 60)
    print("""
Dear eBay Technical Support,

I recently received my Production API key and am experiencing
rate limiting (HTTP 500 RateLimiter error) on the Finding API,
even though my daily call volume is well under the 5,000/day limit.

My Browse API works correctly with the same credentials.

Could you please check if there are any restrictions on my
Finding API access that need to be adjusted?

App ID: (your app ID)

Thank you for your assistance.
""")
    print("=" * 60)


if __name__ == "__main__":
    ok = check_finding_api()
    if not ok:
        print_email_draft()
        sys.exit(1)
