# iPhone research assistant implementation plan

Goal: A GitHub-hosted research workspace independent of the user's Mac, usable before eBay API setup.
Approved scope: part search, supplier comparison, SpeedPAK/Japan Post quote comparison, transaction-profit scenarios, persistent research records and backup.

Architecture: Add a static research.html page, a pure research-core.js module and research-ui.js. Reuse existing persistence.js and service worker; keep the current automated research app reachable. No new runtime dependency, paid service, account credentials, shipping orders or purchases. US/new/single-item scope is explicit; other-market tax automation is outside this change.

Tasks:
- [x] Test then implement case validation, search links, quote completeness, cost arithmetic and minimum target price.
- [x] Implement mobile UI, immediate draft persistence, research list, import/export, source/date controls and missing-data indications.
- [x] Wire PWA entry/cache and existing navigation; document the workflow and limitations.
- [x] Run JS/Python regression suites and DOM integration checks for draft reload, saving, restore, quote comparison and unknown costs.
- [ ] Browser/iPhone checks for 390px layout and offline access: blocked by browser download timeout and cloud browser localhost restrictions; documented in IPHONE_RESEARCH_TEST_REPORT.md.
- [x] Commit and save a reviewable feature branch/PR to the existing GitHub repository. PR: https://github.com/daikigoe34-jpg/ebay-parts-bot/pull/10 (draft; iPhone browser checks outstanding).

Review focus: zero versus unknown; all-in quote versus transport-only quote; fee calculation and price changes against dated quotes; untrusted backup/CSV values; storage failure and concurrent tabs.

Implementation decisions: No inferred current tariffs/rates. Shipping is based on user-entered dated quotes, and missing charges block numeric comparisons. Best/Worst and target prices hold quote costs fixed and explicitly require re-quoting at the changed price. Existing mobile data may be imported as observed estimates, never relabeled as actual 90-day sales. No subagents per user preference.
