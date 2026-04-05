"""
品番抽出モジュール
eBayの商品タイトルから自動車部品の品番を抽出し、
モノタロウの検索URLを生成する

※モノタロウのサイトを自動スクレイピングしない（規約違反回避）
　ユーザーがリンクをクリックして手動で確認する方式
"""

import re
import urllib.parse


# 自動車部品の品番パターン（メーカー各社の形式に対応）
# 例: 15208-65F0E, 04465-26420, 17220-5BA-A00, 90916-03100, 72880FG000
PART_NUMBER_PATTERNS = [
    # 英数混在ハイフン区切り（先頭が英字、2〜3セグメント）
    # 例: PE5R-18-110, KL47-20-490A, H210A-4CAMA
    r'\b([A-Z][A-Z0-9]{2,8}-[A-Z0-9]{2,6}(?:-[A-Z0-9]{2,6})?)\b',

    # 数字始まりハイフン区切り（3セグメント）
    # 例: 17220-5BA-A00
    r'\b(\d{3,5}-[A-Z0-9]{2,5}-[A-Z0-9]{2,5})\b',

    # 数字始まりハイフン区切り（2セグメント）
    # 例: 15208-65F0E, 04465-26420, 90916-03100
    r'\b(\d{3,5}-[A-Z0-9]{2,5})\b',

    # ハイフンなし連続型（数字+英字+数字）
    # 例: 72880FG000, 11044AA770, 62320AU300
    r'\b(\d{4,5}[A-Z]{1,3}\d{2,4})\b',

    # 英字始まりハイフンなし（英数混在、8文字以上）
    # 例: N02668670A00, 85022BV80H
    r'\b([A-Z]\d{3,}[A-Z0-9]{2,})\b',
    r'\b(\d{4,}[A-Z]{1,3}\d{1,3}[A-Z])\b',
]

# 品番として誤抽出しやすいワードを除外
EXCLUDE_WORDS = {
    "JDM", "OEM", "JZA80", "EG6", "FJ40", "MK4", "EJ25",
    "LH", "RH", "USA", "NEW", "SET",
}


def extract_part_number(title):
    """
    商品タイトルから品番を抽出する

    Args:
        title (str): eBayの商品タイトル

    Returns:
        str or None: 抽出した品番。見つからなければNone
    """
    if not title:
        return None

    for pattern in PART_NUMBER_PATTERNS:
        match = re.search(pattern, title)
        if match:
            candidate = match.group(1)
            # 車種コードや一般略語を除外
            if candidate.upper() in EXCLUDE_WORDS:
                continue
            # 短すぎる品番は除外（誤検出防止）
            if len(candidate) < 5:
                continue
            return candidate

    return None


def get_monotaro_url(part_number):
    """
    モノタロウの検索URLを生成する（スクレイピングではなくリンク生成のみ）

    Args:
        part_number (str): 品番

    Returns:
        str: モノタロウ検索URL
    """
    if not part_number:
        return ""

    encoded = urllib.parse.quote(part_number)
    return f"https://www.monotaro.com/s/?q={encoded}"


def get_source_info(title):
    """
    商品タイトルから品番を抽出し、仕入れ確認用の情報を返す

    Args:
        title (str): eBayの商品タイトル

    Returns:
        dict: 品番と検索URL
    """
    part_number = extract_part_number(title)
    return {
        "part_number": part_number or "",
        "monotaro_url": get_monotaro_url(part_number) if part_number else "",
    }
