# Zero-Tap Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce normal iPhone operation to opening Part Scout with no refresh/save/search taps, fix stale/offline UI bugs, clearly block demo data from purchase decisions, and harden the repository against credential and frontend risks.

**Architecture:** Keep GitHub Actions as the server-side automation boundary and the PWA as a read-mostly decision UI. Add small pure helpers in `web/app.js` so zero-tap behavior is unit-testable, make dynamic data network-first with a stable cache key, and keep secrets only in GitHub Actions. Do not add paid services, new runtime dependencies, or browser-side credentials.

**Tech Stack:** Python 3.13, vanilla JavaScript, PWA/Service Worker, GitHub Actions, eBay Production Browse API, optional Rakuten API.

## Global Constraints

- No paid or metered API/service additions.
- Never expose `EBAY_CLIENT_SECRET`, Rakuten access keys, OAuth tokens, or GitHub tokens to `web/**`.
- Production purchase decisions must never be based on bundled demo data.
- Normal daily operation must require no manual refresh or settings-save tap.
- Existing conservative 30-day sales-confidence gate remains intact.
- Changes land on `agent/zero-tap-security-hardening-v0.5`, not directly on `main`.

---

### Task 1: Regression tests for zero-tap state and demo safety

**Files:**
- Modify: `tests/web_core.test.cjs`
- Modify: `web/app.js`

**Interfaces:**
- Produces: `isDemoPayload(payload) -> boolean`, `shouldUsePayloadProducts(setupStatus, payload) -> boolean`, `normalizeDataCacheUrl(url) -> string`.

- [ ] Add failing tests proving demo payloads are rejected while Production is not ready, real payloads are accepted only when connected, and cache-busted data URLs normalize to stable paths.
- [ ] Run `node tests/web_core.test.cjs` and confirm RED failures are for the missing helpers.
- [ ] Implement the smallest pure helpers and export them.
- [ ] Run the JS tests and confirm GREEN.

### Task 2: Auto-save settings and automatic foreground refresh

**Files:**
- Modify: `tests/web_core.test.cjs`
- Modify: `web/app.js`
- Modify: `web/index.html`

**Interfaces:**
- Produces: `settingsFromForm(form)`, `refreshIfStale(...)` behavior used by DOM event handlers.

- [ ] Add failing tests for form-value conversion where practical and helper-level refresh staleness decisions.
- [ ] Make settings save on `input`/`change` with a short debounce; keep the explicit save button only as an accessibility fallback or remove it if redundant.
- [ ] Refresh data automatically on app startup and `visibilitychange` when the app returns to foreground and data is stale; prevent concurrent duplicate refreshes.
- [ ] Remove the user-facing manual refresh button from the normal header.
- [ ] Run JS tests and syntax checks.

### Task 3: Service Worker data-cache bug

**Files:**
- Create: `tests/sw_core.test.cjs`
- Modify: `web/sw.js`
- Modify: `.github/workflows/research.yml`

**Interfaces:**
- Stable data cache keys: `./data/results.json` and `./data/setup_status.json` regardless of query-string cache busting.

- [ ] Add a failing Node test that exercises extracted Service Worker URL-normalization behavior.
- [ ] Update the Service Worker so dynamic data requests cache under stable keys, network-first fetches fall back to those same keys offline, and stale timestamp query strings do not create unbounded entries.
- [ ] Add `node tests/sw_core.test.cjs` to CI.
- [ ] Run JS tests and syntax checks.

### Task 4: UI synchronization and one-primary-action behavior

**Files:**
- Modify: `tests/web_core.test.cjs`
- Modify: `web/app.js`
- Modify: `web/index.html`
- Modify: `web/styles.css`

**Interfaces:**
- Produces: deterministic `primaryActionForProduct(product, profit)` helper.

- [ ] Add failing tests for which external action should be primary for procurement, tariff confirmation, and purchase-ready states.
- [ ] Ensure editing a duplicated product card updates all visible fields and form controls for the same part number.
- [ ] Visually demote non-next-step external links; expose one primary action according to current state.
- [ ] Keep all final confirmation controls explicit; do not automate irreversible purchase actions.
- [ ] Run tests and syntax checks.

### Task 5: Production/demo boundary and stale-data protection

**Files:**
- Modify: `tests/web_core.test.cjs`
- Modify: `web/app.js`
- Modify: `web/data/results.json` only if metadata is required

**Interfaces:**
- Production payload metadata must distinguish demo/static seed data from live research output.

- [ ] Add failing tests that a not-ready setup cannot surface demo products as actionable candidates.
- [ ] Add explicit demo detection based on payload/source/title metadata and hide purchase/action candidates while setup is not ready.
- [ ] Show a clear non-actionable setup message instead of stale demo rankings.
- [ ] Run JS tests.

### Task 6: Codex Security standard scan and remediation

**Files:**
- Review: repository-wide, especially `.github/workflows/**`, `scripts/**`, `web/**`, `SECURITY.md`.
- Modify only validated findings.

**Interfaces:**
- Trust boundaries: GitHub Secrets -> Actions environment -> server-side Python; static `web/**` is public/untrusted; external marketplace/EC responses are untrusted data.

- [ ] Audit for credential exposure, injection, XSS/DOM sinks, unsafe URL handling, Actions permission overreach, supply-chain pinning risks, cache poisoning, token leakage in logs, insecure external navigation, and data-integrity failures that can create unsafe purchase decisions.
- [ ] Validate each candidate finding against actual source paths and attack paths.
- [ ] For every validated code finding, add a regression test first where feasible, confirm RED, fix minimally, then confirm GREEN.
- [ ] Update `SECURITY.md` with any material operational constraint discovered.

### Task 7: Full verification and PR

**Files:**
- All changed files.

- [ ] Run `python -m pytest -q`.
- [ ] Run `node tests/web_core.test.cjs` and `node tests/sw_core.test.cjs`.
- [ ] Run `python -m py_compile scripts/core.py scripts/research.py`.
- [ ] Run `node --check web/app.js` and `node --check web/sw.js`.
- [ ] Validate JSON files used by the workflow.
- [ ] Compare the branch against `main` and inspect every changed file.
- [ ] Open a draft PR with the security findings, zero-tap behavior, remaining one-time setup steps, and exact verification evidence.
