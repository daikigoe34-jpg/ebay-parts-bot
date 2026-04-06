"""
eBay 日本車パーツ リサーチBot - Web UI (Streamlit)
iPhoneブラウザからでも操作できるWeb版
"""

import time
from datetime import datetime

import streamlit as st
import pandas as pd

from src import config
from src.ebay_client import search_items, get_demo_data, get_item_description, KEYWORD_INTERVAL
from src.calculator import calculate_profit
from src.part_number import get_source_info, extract_part_number

# ページ設定
st.set_page_config(
    page_title="eBay パーツリサーチBot",
    page_icon="🔧",
    layout="wide",
)

st.title("eBay 日本車パーツ リサーチBot")

# ========== サイドバー: パラメータ設定 ==========
st.sidebar.header("パラメータ設定")

# データソース選択
mode = st.sidebar.radio(
    "データソース",
    ["デモデータ", "eBay API（本番）"],
    index=0,
)

# 宛先国
country_options = {
    "us": "アメリカ（本土48州）",
    "us_remote": "アメリカ（アラスカ・ハワイ等）",
    "uk": "イギリス",
    "de": "ドイツ",
    "au": "オーストラリア",
}
country = st.sidebar.selectbox(
    "宛先国",
    options=list(country_options.keys()),
    format_func=lambda x: country_options[x],
    index=0,
)

# 仕入原価
cost_jpy = st.sidebar.number_input(
    "仕入原価（円）",
    min_value=0,
    max_value=100000,
    value=config.DEFAULT_COST_JPY,
    step=100,
)

# 商品重量
weight_g = st.sidebar.number_input(
    "商品重量（g）",
    min_value=10,
    max_value=25000,
    value=config.DEFAULT_WEIGHT_G,
    step=100,
)

# ========== サイドバー: 現在の手数料率 ==========
st.sidebar.markdown("---")
st.sidebar.subheader("現在の手数料率")
effective_rate = config.USD_TO_JPY * (1 - config.PAYONEER_FX_MARKUP)
st.sidebar.text(f"FVF: {config.FVF_RATE*100:.2f}% + ${config.FVF_FIXED_FEE_USD:.2f}")
st.sidebar.text(f"海外決済: {config.INTERNATIONAL_FEE_RATE*100:.2f}%")
st.sidebar.text(f"Payoneer: {config.PAYONEER_FX_MARKUP*100:.0f}%")
st.sidebar.text(f"為替: ¥{config.USD_TO_JPY} → 実効¥{effective_rate:.2f}")
if country in ("us", "us_remote"):
    st.sidebar.text(f"DDP関税: {config.DDP_TARIFF_RATE*100:.0f}%")
else:
    st.sidebar.text("DDP関税: なし（買い手負担）")

# ========== メイン: 検索実行 ==========
if st.button("検索開始", type="primary", use_container_width=True):

    # 商品データ取得
    if mode == "デモデータ":
        with st.spinner("デモデータを読み込み中..."):
            all_items = get_demo_data()
    else:
        all_items = []
        progress = st.progress(0, text="eBay APIから検索中...")
        for i, keyword in enumerate(config.SEARCH_KEYWORDS):
            progress.progress(
                (i + 1) / len(config.SEARCH_KEYWORDS),
                text=f"検索中: 「{keyword}」 ({i+1}/{len(config.SEARCH_KEYWORDS)})",
            )
            items = search_items(keyword)
            all_items.extend(items)
            if i < len(config.SEARCH_KEYWORDS) - 1:
                time.sleep(KEYWORD_INTERVAL)
        progress.empty()

    if not all_items:
        st.warning("商品が見つかりませんでした。")
    else:
        st.success(f"{len(all_items)}件の商品を取得しました。")

        # 品番なし商品: 説明文から品番を補完（API本番のみ）
        if mode != "デモデータ":
            no_pn_items = [item for item in all_items
                           if item.get("item_id") and not extract_part_number(item["title"])]
            if no_pn_items:
                desc_progress = st.progress(0, text="品番なし商品の説明文を確認中...")
                found = 0
                for i, item in enumerate(no_pn_items):
                    desc_progress.progress(
                        (i + 1) / len(no_pn_items),
                        text=f"説明文から品番検索中... ({i+1}/{len(no_pn_items)})",
                    )
                    desc = get_item_description(item["item_id"])
                    if desc:
                        pn = extract_part_number(desc)
                        if pn:
                            item["_desc_part_number"] = pn
                            found += 1
                    if i < len(no_pn_items) - 1:
                        time.sleep(1)
                desc_progress.empty()
                if found:
                    st.info(f"説明文から {found}件 の品番を追加抽出しました。")

        # 利益計算
        results = []
        for item in all_items:
            calc = calculate_profit(
                price_usd=item["price_usd"],
                cost_jpy=cost_jpy,
                weight_g=weight_g,
                country=country,
            )
            # 品番抽出・モノタロウURL生成（タイトル→説明文の順で試行）
            source = get_source_info(item["title"])
            if not source["part_number"] and item.get("_desc_part_number"):
                source = get_source_info(item["_desc_part_number"])

            results.append({
                "商品名": item["title"][:50],
                "品番": source["part_number"],
                "販売価格(USD)": item["price_usd"],
                "販売価格(JPY)": calc["sale_jpy"],
                "eBay手数料(USD)": calc["ebay_fee_total_usd"],
                "受取額(JPY)": calc["payout_jpy"],
                "DDP関税(JPY)": calc["tariff_jpy"],
                "送料(JPY)": calc["shipping_jpy"],
                "仕入(JPY)": calc["cost_jpy"],
                "利益(JPY)": calc["profit_jpy"],
                "利益率(%)": calc["profit_margin"],
                "URL": item.get("url", ""),
                "モノタロウ": source["monotaro_url"],
            })

        # ソート
        results.sort(key=lambda x: x["利益率(%)"], reverse=True)

        df = pd.DataFrame(results)
        profitable = df[df["利益(JPY)"] > 0]

        # ========== サマリー ==========
        col1, col2, col3, col4 = st.columns(4)
        col1.metric("検索商品数", f"{len(df)}件")
        col2.metric("黒字商品数", f"{len(profitable)}件")
        if len(profitable) > 0:
            avg_margin = profitable["利益率(%)"].mean()
            max_profit = profitable["利益(JPY)"].max()
            col3.metric("平均利益率", f"{avg_margin:.1f}%")
            col4.metric("最大利益", f"¥{max_profit:,.0f}")
        else:
            col3.metric("平均利益率", "-")
            col4.metric("最大利益", "-")

        # ========== TOP5 ==========
        st.subheader("利益率 TOP5")
        if len(profitable) > 0:
            top5 = profitable.head(5)
            for _, row in top5.iterrows():
                mono_link = ""
                if row.get("モノタロウ"):
                    mono_link = f"  \n[モノタロウで確認]({row['モノタロウ']})"
                part = f"（{row['品番']}）" if row.get("品番") else ""
                st.markdown(
                    f"**{row['商品名']}** {part}  \n"
                    f"販売 ${row['販売価格(USD)']:.2f} → "
                    f"利益 ¥{row['利益(JPY)']:,.0f}（利益率 {row['利益率(%)']:.1f}%）"
                    f"{mono_link}"
                )
        else:
            st.info("黒字商品がありません。仕入原価を下げるか、より高額な商品を狙ってみてください。")

        # ========== 全商品テーブル ==========
        st.subheader("全商品一覧")

        # URLをリンクに変換した表示用DataFrame
        display_df = df.copy()
        display_df["販売価格(USD)"] = display_df["販売価格(USD)"].map("${:.2f}".format)
        display_df["販売価格(JPY)"] = display_df["販売価格(JPY)"].map("¥{:,.0f}".format)
        display_df["eBay手数料(USD)"] = display_df["eBay手数料(USD)"].map("${:.2f}".format)
        display_df["受取額(JPY)"] = display_df["受取額(JPY)"].map("¥{:,.0f}".format)
        display_df["DDP関税(JPY)"] = display_df["DDP関税(JPY)"].map("¥{:,.0f}".format)
        display_df["送料(JPY)"] = display_df["送料(JPY)"].map("¥{:,.0f}".format)
        display_df["仕入(JPY)"] = display_df["仕入(JPY)"].map("¥{:,.0f}".format)
        display_df["利益(JPY)"] = display_df["利益(JPY)"].map("¥{:,.0f}".format)
        display_df["利益率(%)"] = display_df["利益率(%)"].map("{:.1f}%".format)

        st.dataframe(display_df, use_container_width=True, hide_index=True)

        # ========== CSVダウンロード ==========
        csv = df.to_csv(index=False).encode("utf-8-sig")
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        st.download_button(
            label="CSVダウンロード",
            data=csv,
            file_name=f"ebay_research_{timestamp}.csv",
            mime="text/csv",
            use_container_width=True,
        )
