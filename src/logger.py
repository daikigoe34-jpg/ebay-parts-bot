"""
ログ設定モジュール
コンソール出力とファイル出力（output/bot.log）の両方を設定する
"""

import logging
import os


def setup_logger(name="ebay_bot"):
    """
    ロガーを設定して返す
    - コンソール: INFO以上を表示
    - ファイル: DEBUG以上をoutput/bot.logに記録
    - タイムスタンプ付き

    Args:
        name (str): ロガー名

    Returns:
        logging.Logger: 設定済みロガー
    """
    logger = logging.getLogger(name)

    # 既にハンドラが設定されていたら重複追加しない
    if logger.handlers:
        return logger

    logger.setLevel(logging.DEBUG)

    # フォーマッタ
    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # コンソールハンドラ（INFO以上）
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # ファイルハンドラ（DEBUG以上）
    log_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "bot.log")

    try:
        file_handler = logging.FileHandler(log_path, encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    except (PermissionError, OSError) as e:
        logger.warning(f"ログファイルの作成に失敗しました: {e}")

    return logger


# グローバルロガー
logger = setup_logger()
