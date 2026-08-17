from __future__ import annotations

from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 occurrence, got {count}")
    return text.replace(old, new, 1)


def main() -> None:
    path = Path("web/app.js")
    app = path.read_text(encoding="utf-8")
    if "function isPayloadFresh(" in app:
        print("freshness patch already applied")
        return

    marker = '''function safeExternalUrl(rawUrl, allowedHosts, fallbackUrl) {
'''
    helpers = '''function isPayloadFresh(payload, now = Date.now(), maxAgeMs = 48 * 60 * 60 * 1000) {
  const generatedAt = Date.parse(String(payload?.generated_at || ""));
  const current = Number(now);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(current)) return false;
  const age = current - generatedAt;
  const allowedFutureSkew = 5 * 60 * 1000;
  return age >= -allowedFutureSkew && age <= Math.max(0, Number(maxAgeMs) || 0);
}

function selectRenderableProducts(setupStatus, payload, now = Date.now()) {
  return isPayloadFresh(payload, now) ? selectPayloadProducts(setupStatus, payload) : [];
}

''' + marker
    app = replace_once(app, marker, helpers, "insert freshness helpers")

    app = replace_once(
        app,
        '''function mergeProducts() {\n  state.products = selectPayloadProducts(state.setupStatus, state.apiPayload).map(normalizeProduct);\n}\n''',
        '''function mergeProducts() {\n  state.products = selectRenderableProducts(state.setupStatus, state.apiPayload).map(normalizeProduct);\n}\n''',
        "freshness product gate",
    )

    old_notice = '''    els.qualityNotice.textContent = isDemoPayload(state.apiPayload)
      ? "デモデータは仕入判定に使用しません。Production API接続後に実データへ切り替わります。"
      : (state.apiPayload.method_note || "Production Browse APIの日次差分だけで販売ペースを学習します。");
'''
    new_notice = '''    els.qualityNotice.textContent = isDemoPayload(state.apiPayload)
      ? "デモデータは仕入判定に使用しません。Production API接続後に実データへ切り替わります。"
      : !isPayloadFresh(state.apiPayload)
        ? "調査結果が48時間以上古いため、仕入候補の表示を安全停止しています。次回の自動更新を確認してください。"
        : (state.apiPayload.method_note || "Production Browse APIの日次差分だけで販売ペースを学習します。");
'''
    app = replace_once(app, old_notice, new_notice, "stale data notice")

    export_marker = '''    safeExternalUrl,
    applyCostValuesToControls,
'''
    app = replace_once(
        app,
        export_marker,
        '''    safeExternalUrl,\n    isPayloadFresh,\n    selectRenderableProducts,\n    applyCostValuesToControls,\n''',
        "export freshness helpers",
    )

    path.write_text(app, encoding="utf-8")
    print("freshness patch applied")


if __name__ == "__main__":
    main()
