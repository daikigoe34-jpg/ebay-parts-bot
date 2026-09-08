# Workspace synchronization implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Continue private eBay research from iPhone to PC with durable synchronized edits and explicit resumable tasks.
**Architecture:** Keep the existing framework-free client and immediate localStorage saves. Add a reusable revision-based sync client for three documents and a small D1 API gated by Sites identity. Preserve conflicting edits instead of choosing silently.
**Tech Stack:** JavaScript, HTML, Worker ESM, D1 SQLite, Node/jsdom tests; no production dependencies.
**Spec:** docs/superpowers/specs/2026-09-08-workspace-sync.md

## Global Constraints
- Preserve old backup formats, localStorage keys, shipping calculations and supplier acquisition limits.
- No new paid API, automatic purchases/listings/messages or background supplier fetching.
- Only the root Site owner edits the Site, runs Sites tools or deploys. The client implementer edits only the original repository.
- Missing auth/storage fails closed. Use dispatch authenticated user ID for ownership and atomic revisions for writes.
- Data must survive offline/reload and visible conflicts without silently overwriting edits. No private runtime data in git.

### Task 1: Client sync and research queue

**Files:** create `web/workspace-sync.js`, `web/research-queue.js`; modify `web/app.js`, `web/shipping-calculator.js`, both HTML pages, `styles.css`, `sw.js`; create focused `tests/workspace_sync.test.cjs`, `tests/research_queue.test.cjs` (and DOM integration test if useful); add test scripts and CI coverage. Avoid broad rewrites of app.js. Preserve existing dependencies.

**Interfaces:** consume the exact HTTP contract in the spec. The sync module may expose an appropriate UMD/CommonJS API for `{namespace,storage,getLocal,validate,applyRemote,onStatus}` with explicit change notification and conflict resolution. The shipping screen exposes a bounded adapter to the queue for current draft capture/application, invalidating lookup generations before restoration. Existing main and shipping localStorage keys remain `part-scout-user-v1` and `part-scout-shipping-draft-v1`; queue uses a new versioned key.

- [ ] Write focused failing behavioral tests. Start with a fake transport that implements the HTTP contract and two independent storage instances: `await a.flush(); await b.flush(); assert.deepEqual(b.getLocal(), a.getLocal())`. Next test concurrent different edits: `assert.equal(b.status, 'conflict')` and prove both copies remain after new client construction. Assert late replies never replace edits made after the request, lost PUT responses do not loop forever, account change does not upload, and quota failure blocks any overwrite requiring a recovery copy. Use real sync logic, not assertions solely on mocks.
- [ ] Run these focused tests and record RED evidence.
- [ ] Implement sync with durable base/pending metadata, valid server envelope checks, same-origin fetch, initial GET before upload, bounded debounce/visible refresh and manual sync action. Do not write initial defaults over existing cloud data. Keep active field input intact; invalidate old import/lookup callbacks on remote application. Integrate main snapshots and standalone drafts through explicit adapters rather than intercepting arbitrary localStorage calls.
- [ ] Implement a mobile usable research queue independent of eBay connection. Exact manufacturer/part, stable deduplication, four explicit statuses, note, resume estimate, per-item saved draft when switching, and copyable Work handoff. At most 50 items; surface storage/size failures and keep the old draft rather than discarding it. Do not auto-run lookups when opening or resuming tasks. Retain both sides of conflicts with backup controls before resolving.
- [ ] Add loaded scripts to both pages and offline shell, bump shell version, and ensure `/api/` requests bypass caches entirely. Retain exact backup compatibility. Add focused DOM tests for immediate save, reopen/pending sync, queue resumption and stale remote/import interactions. Preserve sample-free results with absent eBay keys.
- [ ] Run affected suites, then the existing JS tests once; update CI to include new tests. Self-review, commit client work, and write task report with actual commands/results and RED/GREEN evidence.

### Task 2: Authenticated Site storage and integration (root owner)

**Files:** Site `server/workspace.mjs`, `drizzle/0001_workspace.sql`, journal, `worker/router.mjs`, `worker/index.js`, `scripts/build.mjs`, tests. Integrate Task 1 web source with the existing two absolute GitHub data URL adaptations. Copy reviewed server module and migration to original repo for reviewable source tracking after Task 1 commits; do not put Site credentials/runtime data there.
**Interfaces:** produce the exact HTTP contract in the spec. `handleWorkspace(request, env)` uses `env.DB` and the trusted dispatch user ID. An optional clock dependency in a factory is permissible for deterministic tests. Atomic INSERT/UPDATE ... WHERE revision semantics implement optimistic concurrency. Namespaces are fixed, request size is 2,000,000 UTF-8 bytes.

- [ ] Test 401 without identity, separate data for two users, initial revision zero, successful round trip and exactly one of two writes at the same base revision succeeding. Test old revisions, malformed/oversize/prototype JSON, bad Origin, missing DB, wrong method and unknown namespace.
- [ ] Run failing tests, implement the minimal ESM API, then run them against real SQLite via D1 adapter. `INSERT ... ON CONFLICT DO UPDATE ... WHERE workspace_documents.revision = ? RETURNING ...` may implement atomic compare-and-swap; never pre-read followed by unconditional update.
- [ ] Append migration 0001 and journal entry, preserve applied migration 0000, route exact APIs before static fallthrough, and add module to deterministic Worker build. Ensure private no-store on all responses.
- [ ] Integrate validated client changes, run native build and hosted tests. Review combined source, fix real findings and run affected regressions. Push reviewed public source via a new PR/CI, merge as already authorized; push same-Site source, package, save/deploy existing project and verify terminal deployment.
- [ ] Verify limited authenticated sync API behavior without supplier calls or private-data alteration; update Notion with actual features, URL, tests and remaining account/physical limitations.
