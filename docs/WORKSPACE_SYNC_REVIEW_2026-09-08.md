# Workspace sync verification (2026-09-08)

Implemented private automatic synchronization of research settings/costs/work position, the standalone shipping draft and a resumable per-part research queue. Existing local saves, backup formats, shipping math and supplier limits are preserved.

## Evidence

- Final data-preservation fixes: 57 focused workspace, queue, persistence and monetary regression tests passed. The affected existing lookup/shipping suites passed 39 tests. Earlier candidate full JavaScript run passed 120 tests; final CI checks the updated branch again. Authenticated API tests pass 5 cases.
- Site combined suite:20 tests passed, plus existing hosted DOM smoke. Actual client modules communicate with the built Worker and real SQLite through the D1 adapter; this covers independent devices, conflicting edits and resolution, account isolation, lost committed response without duplicate write, and login switching between GET and PUT.
- Authenticated API tests cover missing identity, exact namespace/method, same-origin JSON, payload bytes/prototype rejection, missing/broken database and atomic stale revision rejection. All responses are private/no-store.
- DOM/model tests cover immediate local persistence, pending data after reload/offline, two-item draft switching, no supplier fetch on task resume, focus deferral, stale imports, old backup formats, queue import, same-browser stale queue edits, and permanent conflict recovery.
- Important implementation findings fixed before publication: reschedule edits made during a slow PUT; keep conflict history separate from ordinary receive recovery; preserve stale-tab proposals; avoid timestamp/default-only cloud writes; bind each PUT to the preceding GET account; keep actual editor ownership separate from synchronized queue position; guard stale tabs before journal/domain writes and retain both versions permanently.
- Tests use source fixtures only; no supplier requests were made for this feature. No new runtime dependency or paid API was added.

## Practical limits

Cross-device synchronization requires the Sites URL and the same authenticated user. A static GitHub Pages host retains local-only behavior. The queue holds at most 50 tasks; conflict archives hold at most 20 events and fail safely when full. Documents have a 2,000,000-byte request cap. These are capacity limits, not promises of unlimited storage.

Actual iPhone/PC browser use, connected Work computer operation, seller OAuth and real CPaSS transactions were not tested in this change. Signing in and granting the relevant computer/browser access remain necessary. Shipment measurements, packing and handover remain physical work.

The final review reproduced two client data-loss interleavings; both were fixed before publication. Scoped review and exact-branch CI results are recorded with the pull request. Stale tabs deliberately stop for backup/reload; estimates displaced by explicit resume are retained in exportable recovery when they have no associated task.

Final callback correction: the configured workspace suite passes 48 tests, including four RED-to-GREEN delayed-resume cases (focused typing, typing then blur, focus only, and newer explicit resume). Delayed links cancel after newer user intent; untouched initial receive orders still resume. Native build and the 20 built tests plus hosted smoke pass on the integrated source.
