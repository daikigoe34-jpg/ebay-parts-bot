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
    if "function applyCostValuesToControls(" in app:
        print("duplicate-control patch already applied")
        return

    marker = '''function updateAllCardsForProduct(partNumber) {
'''
    helper = '''function applyCostValuesToControls(controls, values) {
  for (const control of controls || []) {
    const key = control?.dataset?.cost;
    if (!key) continue;
    if (control.type === "checkbox") {
      control.checked = values?.[key] === true;
    } else if (control.tagName === "SELECT") {
      const selectValue = String(values?.[key] ?? "");
      const options = Array.from(control.options || []);
      control.value = options.some((option) => option.value === selectValue)
        ? selectValue
        : (selectValue ? "OTHER" : "");
    } else {
      control.value = number(values?.[key], 0) || "";
    }
  }
}

''' + marker
    app = replace_once(app, marker, helper, "insert control sync helper")

    old_init = '''    if (input.type === "checkbox") input.checked = values[key] === true;
    else if (input.tagName === "SELECT") {
      const selectValue = String(values[key] ?? "");
      input.value = Array.from(input.options).some((option) => option.value === selectValue) ? selectValue : (selectValue ? "OTHER" : "");
    } else input.value = number(values[key], 0) || "";

'''
    app = replace_once(
        app,
        old_init,
        '''    applyCostValuesToControls([input], values);\n\n''',
        "reuse control sync helper",
    )

    old_update = '''function updateAllCardsForProduct(partNumber) {
  const product = state.products.find((row) => row.part_number === partNumber);
  if (!product || typeof document === "undefined") return;
  document.querySelectorAll(`.product-card[data-part-number="${CSS.escape(partNumber)}"]`).forEach((card) => updateProfitArea(card, product));
  const sorted = [...state.products].sort((a, b) => productSortValue(b, "profit") - productSortValue(a, "profit"));
  updateGlobalNextTask(sorted);
}
'''
    new_update = '''function updateAllCardsForProduct(partNumber) {
  const product = state.products.find((row) => row.part_number === partNumber);
  if (!product || typeof document === "undefined") return;
  const values = getCostValues(product);
  document.querySelectorAll(`.product-card[data-part-number="${CSS.escape(partNumber)}"]`).forEach((card) => {
    applyCostValuesToControls(card.querySelectorAll("[data-cost]"), values);
    updateProfitArea(card, product);
  });
  const sorted = [...state.products].sort((a, b) => productSortValue(b, "profit") - productSortValue(a, "profit"));
  updateGlobalNextTask(sorted);
}
'''
    app = replace_once(app, old_update, new_update, "sync duplicate cards")

    export_tail = '''    selectPayloadProducts,
    safeExternalUrl,
'''
    app = replace_once(
        app,
        export_tail,
        '''    selectPayloadProducts,\n    safeExternalUrl,\n    applyCostValuesToControls,\n''',
        "export control helper",
    )

    path.write_text(app, encoding="utf-8")
    print("duplicate-control patch applied")


if __name__ == "__main__":
    main()
