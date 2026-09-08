# failure-mode-tests audit — 2026-09-08

Theme: **Rule R4 — failure-mode test coverage.** Every test file for a fetch wrapper, cron, endpoint, or DB writer must cover (a) upstream non-2xx / thrown / timeout, (b) malformed or empty payload, (c) the DB write rejecting, and each must assert the failure is *surfaced* (thrown, 5xx, `logger.error({ err })` + `Sentry.captureException`) rather than swallowed into a default value.

Worktree audited: `.worktrees/llm-antipattern-audit` (clean checkout of `origin/main` @ `3dd9dd60`). Read-only; no source file was modified. Five files under edit in another session are tagged **IN-FLIGHT** wherever they appear: `api/_lib/uw-rate-limit.ts`, `api/_lib/uw-fetch.ts`, `api/_lib/sentry.ts`, `api/__tests__/uw-rate-limit.test.ts`, `api/__tests__/api-helpers.test.ts`.

## Method — how the matrix was built, counts

**Step 1 — mechanical matrix (grep).** A script enumerated every handler in scope and mapped each to the test file(s) that `import` it from `api/__tests__/` **and do not `vi.mock()` it** (a test that mocks a module out is not a test *of* that module — this exclusion removed ~90 phantom "importers" of `db.ts`, `sentry.ts`, `api-helpers.ts`). Within those tests it grepped for evidence of each failure class:

| column | markers (any hit → Y) |
|---|---|
| (a) upstream-error | `mockRejectedValue(Once)`, `rejects.toThrow`, `ok: false`, `status: 4xx/5xx`, `AbortError`, `timeout`, `mockImplementation(() => { throw`, `new Response(..., {status: 4xx/5xx})` |
| (b) malformed/empty† | `mockResolvedValue([] / null / {} / undefined)`, `json: () => [] / null`, `data: []`, `it('… empty|missing|null|invalid|garbage|non-array|NaN …')`, `SyntaxError`, `JSON.parse`, `rejects.toThrow(/parse|JSON|shape|schema/)` |
| (c) db-reject | `mockRejectedValue(new Error('…db|insert|upsert|sql|neon|connection|timeout…'))`, `it('… db|insert|write|sql|neon … fail|reject|throw|error|blip …')`, `sql = vi.fn()…mockRejectedValue`, `withDbReader…mockRejectedValue`, `isTransientDbError` |
| asserts-surfacing | `expect(captureException)…`, `expect(*capture*)`, `expect(logger.error)`, `status).toHaveBeenCalledWith(5xx)`, `_status).toBe(5xx)`, `toMatchObject({status: 5xx`, `rejects.toThrow`, `toThrow(` |

† **(b) is over-counted by construction**: the standard cron fixture `sql.mockResolvedValueOnce([])` (empty DB read) trips the empty-payload marker in nearly every cron test, so the column says "an empty payload was *fed*", not "the empty-payload branch was *asserted*". Treat (b)=Y as "partial" unless a Finding says otherwise. The other three columns are conservative.

**Step 2 — reading, then correcting the matrix.** Six readers covered every cron, every write endpoint, every wrapper/token/LLM module, the swallow-pattern inventory, and the `uw-stream/` + `sidecar/` Python tests. Each ranked Finding names the exact branch (line numbers from this worktree) and what its test asserts. Where a reader's verified reading contradicted the mechanical row, the row was corrected and annotated (the `notes` column carries the Finding ID). Three mechanical "no test file" rows were import-depth artifacts (`api/__tests__/ml/`, `[id].js` paths) and are fixed. Two new values appear after correction: **`partial`** (branch is fed but not asserted, or mocks make it unreachable) and **`Y (codifies)`** — the test *does* reject the write, then asserts the swallowed 200/`success` outcome, locking the defect in. The 20 highest-stakes claims were re-verified against source by the lead before ranking.

**Scope counts (after correction; Y = exactly Y or `Y (codifies)`):**

| kind | handlers | with test file | (a) upstream Y | (b) malformed/empty Y† | (c) db-reject Y | asserts-surfacing Y | all four Y | (c) tests that *codify* a swallow |
|---|---|---|---|---|---|---|---|---|
| cron (`api/cron/*.ts`) | 77 | 77 (100%) | 53 (69%) | 72† | 43 (56%) | 52 (68%) | 29 (38%) | **10** |
| endpoint (`api/**/*.ts` excl. `_lib`, `__tests__`, `cron`) | 91 | 91 (100%) | 78 (86%) | 83† | 61 (67%) | 76 (84%) | 55 (60%) | 0 (2 assert a deliberate `saved:false` 200) |
| `_lib` I/O module (fetch/UW/Schwab/OpenAI/Anthropic/Blob/Redis callers + DB writers) | 52 | 50 (96%) | 38 (73%) | 41† | 26 (50%) | 28 (54%) | 14 (27%) | 0 |
| **total** | **220** | **218 (99%)** | **169 (77%)** | **196†** | **130 (59%)** | **156 (71%)** | **98 (45%)** | **10** |

Handlers with **no test file** (2): `api/_lib/build-features-upsert.ts`, `api/_lib/greek-flow-etf-store.ts` (both exercised only through their cron's test with `sql` mocked). Modules tested only *indirectly* (annotated, not counted as gaps): `uw-fetch.ts`, `schwab-fetch.ts` (via `export *` in `api-helpers.ts` → `api-helpers.test.ts`), `auth-helpers.ts`, `rollup-ws-gex-strike-expiry.ts`.

Python: `uw-stream/tests/` (13 files) and `sidecar/tests/` (22 files) — see FM-29, FM-40 and "Already good".

**Findings by severity: P1 = 6 · P2 = 25 · P3 = 10 (capped; the rest live in the matrix `notes`). 30 of 41 carry the `code-defect` tag** — in this codebase the missing failure test is usually sitting on top of a branch that swallows.

## Coverage matrix — the full table

Legend: Y = marker found in the handler's own test(s); `Y (codifies)` = the failure is triggered and the *swallowed* outcome is asserted; `partial` = branch fed but not asserted / unreachable; N = not found; `-` = n/a or no test file. † see Method. Rows 1–77 crons, 78–168 endpoints, 169–220 `_lib` I/O modules. `notes` carries the Finding ID (FM-nn) where one applies.

| # | kind | handler | test file(s) | (a) upstream-error | (b) malformed/empty† | (c) db-reject | asserts-surfacing | notes |
|---|---|---|---|---|---|---|---|---|
| 1 | cron | `cron/archive-gexbot.ts` | archive-gexbot.test.ts | Y | Y | N | Y |  |
| 2 | cron | `cron/audit-gexbot-health.ts` | audit-gexbot-health.test.ts | N | Y | N | Y |  |
| 3 | cron | `cron/audit-migration-drift.ts` | cron-audit-migration-drift.test.ts | Y | Y | Y | Y |  |
| 4 | cron | `cron/audit-takeit-calibration.ts` | audit-takeit-calibration.test.ts | Y | Y | N | Y |  |
| 5 | cron | `cron/audit-takeit-health.ts` | audit-takeit-health.test.ts | Y | Y | Y | Y |  |
| 6 | cron | `cron/auto-prefill-premarket.ts` | auto-prefill-premarket.test.ts | Y | Y | Y | Y |  |
| 7 | cron | `cron/backfill-futures-gaps.ts` | backfill-futures-gaps.test.ts | Y | Y | N | Y |  |
| 8 | cron | `cron/backfill-gamma-setup-outcomes.ts` | cron-backfill-gamma-setup-outcomes.test.ts | N | Y | N | N | FM-14/FM-41. Not in SCHEDULE_MAP; comment L146-148 claims per-fire swallow + Sentry but no catch exists. |
| 9 | cron | `cron/backup-tables.ts` | backup-tables.test.ts | Y | Y | Y | Y |  |
| 10 | cron | `cron/build-features.ts` | build-features.test.ts | Y | Y | Y | partial | Per-date reject T259-292 asserts counts only; Sentry not mocked. |
| 11 | cron | `cron/capture-flow-regime-daily.ts` | capture-flow-regime-daily.test.ts | N | Y | N | N | Zero mockRejected; weekday both-days-empty → `skipped` info-only. |
| 12 | cron | `cron/capture-flow-regime.ts` | capture-flow-regime.test.ts | N | Y | N | N | FM-13. nTrades=0 at slot≥1 (uw-stream dead) → `success`; zero mockRejected. |
| 13 | cron | `cron/capture-opening-flow-signal.ts` | capture-opening-flow-signal.test.ts | Y | Y | N | Y | InvalidTradingDateError → captureException + `success` (L62-76). |
| 14 | cron | `cron/capture-regime-0dte.ts` | capture-regime-0dte.test.ts | N | Y | N | Y | FM-21. Swallowed fetchDayOhlc error → NULL-outcome row as `success`. |
| 15 | cron | `cron/check-cone-breach.ts` | cron-check-cone-breach.test.ts | N | Y | N | N | FM-08. `error` branches L80-86 / L112-118 warn-only, untested. |
| 16 | cron | `cron/check-gamma-setup-drift.ts` | cron-check-gamma-setup-drift.test.ts | N | Y | N | Y | FM-14. Not in SCHEDULE_MAP (read-only). |
| 17 | cron | `cron/cleanup-gexbot.ts` | cleanup-gexbot.test.ts | Y | Y | Y | Y |  |
| 18 | cron | `cron/cleanup-ws-gex-strike-expiry.ts` | cleanup-ws-gex-strike-expiry.test.ts | Y | Y | Y | Y |  |
| 19 | cron | `cron/cleanup-ws-option-trades.ts` | cleanup-ws-option-trades.test.ts | Y | Y | Y | Y |  |
| 20 | cron | `cron/compute-cone.ts` | cron-compute-cone.test.ts | partial | Y | N | N | FM-08. Schwab `!ok` → returned `error` warn-only (L175-183), no Sentry; T336-347 asserts only `mockSql` not called. |
| 21 | cron | `cron/compute-es-overnight.ts` | compute-es-overnight.test.ts | partial | Y | Y | Y | FM-10. Zero bars → `skipped` info-only L168-177; Schwab `ok:false` L208 falls through silently. |
| 22 | cron | `cron/compute-zero-gamma.ts` | cron-compute-zero-gamma.test.ts | Y | Y | Y | N | FM-13. T344-370 assert `body.status` only, never captureException; all-tickers-empty → success. |
| 23 | cron | `cron/curate-lessons.ts` | curate-lessons.test.ts<br>lessons-integration.test.ts | Y | Y | Y | Y | FM-37. Malformed Claude output → 200 errors[], no Sentry (L316-326). |
| 24 | cron | `cron/curate-periscope-lessons.ts` | curate-periscope-lessons.test.ts | Y | Y | Y | Y |  |
| 25 | cron | `cron/detect-gamma-setups.ts` | cron-detect-gamma-setups.test.ts | N | Y | N | N | FM-13/FM-14. Not in SCHEDULE_MAP; empty bars/nodes → success `no_data`. |
| 26 | cron | `cron/detect-lottery-fires.ts` | detect-lottery-fires.test.ts | Y | Y | partial | partial | FM-17. Tick SELECT reject + INSERT reject untested; macro throw T768-801 asserts only success; GexBot capture asserted T1423. Empty-window captureMessage L259-286 is the template. |
| 27 | cron | `cron/detect-periscope-call-lottery.ts` | detect-periscope-call-lottery.test.ts | N | Y | N | N | FM-13/FM-26. Neither test asserts `res._status`; empty window → success. |
| 28 | cron | `cron/detect-periscope-put-lottery.ts` | detect-periscope-put-lottery.test.ts | N | Y | N | N | FM-13/FM-26. Same as call-lottery. |
| 29 | cron | `cron/detect-silent-boom.ts` | detect-silent-boom.test.ts | Y | Y | N | Y | FM-18. Best-covered detector on (a); INSERT / bucket SELECT reject untested. |
| 30 | cron | `cron/embed-yesterday.ts` | embed-yesterday.test.ts | N | Y | Y | Y |  |
| 31 | cron | `cron/enrich-lottery-outcomes.ts` | enrich-lottery-outcomes.test.ts | partial | Y | N | N | FM-19. Flow-inversion catch L345-349 warn-only → NULL; T503-574 codifies; SELECT/UPDATE reject untested. |
| 32 | cron | `cron/enrich-periscope-lottery-outcomes.ts` | enrich-periscope-lottery-outcomes.test.ts | N | Y | N | N | FM-09. Empty tape → realized_r=-1 + locked (L227-266); T156-186 codifies `[-1]`; no reject test. |
| 33 | cron | `cron/enrich-silent-boom-outcomes.ts` | enrich-silent-boom-outcomes.test.ts | N | Y | N | N | FM-26. No catch → 500 correct; reject untested. |
| 34 | cron | `cron/enrich-vega-spike-returns.ts` | enrich-vega-spike-returns.test.ts | Y | Y | Y | Y | Reference implementation; T382 lacks captureException assertion. |
| 35 | cron | `cron/evaluate-round-trip.ts` | evaluate-round-trip.test.ts | N | Y | N | N | FM-26. No catch → 500 correct; reject untested. |
| 36 | cron | `cron/fetch-day-ohlc.ts` | fetch-day-ohlc.test.ts | partial | Y | N | Y | FM-22. postgres-day-summary L207-210 DB error → `skipped` 200 warn-only; malformed sidecar row silent. |
| 37 | cron | `cron/fetch-economic-calendar.ts` | fetch-economic-calendar.test.ts | Y | Y | N | Y |  |
| 38 | cron | `cron/fetch-es-options-eod.ts` | fetch-es-options-eod.test.ts | Y | Y | Y | Y |  |
| 39 | cron | `cron/fetch-etf-candles-1m.ts` | fetch-etf-candles-1m.test.ts | Y | Y | Y | Y |  |
| 40 | cron | `cron/fetch-etf-tide.ts` | fetch-etf-tide.test.ts | Y | Y | Y | Y |  |
| 41 | cron | `cron/fetch-flow-alerts.ts` | fetch-flow-alerts.test.ts | Y | Y | Y | Y |  |
| 42 | cron | `cron/fetch-flow.ts` | fetch-flow.test.ts | Y | Y | Y | Y |  |
| 43 | cron | `cron/fetch-futures-snapshot.ts` | fetch-futures-snapshot.test.ts | partial | Y (codifies) | Y | Y | FM-11. All-null during open market → 200 ok (L110); T424-444 asserts 200 only; L131 `ok` with errors. |
| 44 | cron | `cron/fetch-gex-0dte.ts` | fetch-gex-0dte.test.ts | Y | Y | Y (codifies) | Y | FM-07. Batch fail L244-249 → Sentry + 200 `success:true, skipped:N` (failure counted as duplicates); T392-416 asserts it. Stale-cache branch L287-303 never exercised. |
| 45 | cron | `cron/fetch-gex-strike-expiry-etfs.ts` | fetch-gex-strike-expiry-etfs.test.ts | Y | Y | Y (codifies) | Y | FM-07. Batch INSERT fail → Sentry, then status `success` (L389, L465-472); T654-692 asserts `rows:0, status:'success'`. |
| 46 | cron | `cron/fetch-gexbot-fast.ts` | fetch-gexbot-fast.test.ts | Y | N | N | Y | FM-12. Same `partial` defect L393; per-row INSERT abort skips insertCaptureRows (L371). |
| 47 | cron | `cron/fetch-gexbot-strikes.ts` | fetch-gexbot-strikes.test.ts | Y | N | N | Y | FM-12. 128/128 failures → `partial` (L151); T263-268 codifies. No insert-reject test. |
| 48 | cron | `cron/fetch-greek-exposure-strike.ts` | fetch-greek-exposure-strike.test.ts | N | partial | Y (codifies) | partial | uwFetch mocked wholesale (T31-36), never rejects; 'DB error' test T297-332 throws from the withRetry mock, not sql. FM-07. |
| 49 | cron | `cron/fetch-greek-exposure.ts` | fetch-greek-exposure.test.ts | Y | Y | Y (codifies) | partial | FM-07. Sentry mocked T41-50, never asserted; aggregate INSERT reject untested; `partial` L218 ignores DB outcome. |
| 50 | cron | `cron/fetch-greek-flow-etf.ts` | fetch-greek-flow-etf.test.ts | Y | Y | Y | Y | Best of the greek-flow family; (a) tests lack captureException; Phase C rejected branch unreachable with mocks. |
| 51 | cron | `cron/fetch-greek-flow.ts` | fetch-greek-flow.test.ts | Y | partial | Y (codifies) | partial | FM-01. Store catch L122-126 = logger.warn + metric, NO Sentry; L171 returns `success`. T408-427 asserts 200 + {stored:0,skipped:1}. |
| 52 | cron | `cron/fetch-market-internals.ts` | fetch-market-internals.test.ts | partial | Y | Y (codifies) | Y | FM-02. Quotes `!ok` L272-281 swallowed, no log/Sentry; 4/4 fail → `partial` L430; T451-473 codifies. |
| 53 | cron | `cron/fetch-net-flow-history.ts` | fetch-net-flow-history.test.ts | Y | Y | N | Y |  |
| 54 | cron | `cron/fetch-net-flow.ts` | fetch-net-flow.test.ts | Y | Y | N | Y |  |
| 55 | cron | `cron/fetch-nope.ts` | fetch-nope.test.ts | Y | Y | N | Y |  |
| 56 | cron | `cron/fetch-oi-change.ts` | fetch-oi-change.test.ts | Y | Y | Y | Y |  |
| 57 | cron | `cron/fetch-oi-per-strike.ts` | fetch-oi-per-strike.test.ts | Y | Y | Y | Y |  |
| 58 | cron | `cron/fetch-outcomes.ts` | fetch-outcomes.test.ts | Y | Y | Y | Y |  |
| 59 | cron | `cron/fetch-spot-gex.ts` | fetch-spot-gex.test.ts | Y | partial | Y | Y | Cleanest of the family; malformed `time` → RangeError 500 untested. |
| 60 | cron | `cron/fetch-spx-candles-1m.ts` | fetch-spx-candles-1m.test.ts | Y | Y | Y | Y |  |
| 61 | cron | `cron/fetch-strike-all.ts` | fetch-strike-all.test.ts | Y | Y | Y (codifies) | Y | FM-07. Txn catch L155-159 → 200 `success:true`; T349-367 hollow. |
| 62 | cron | `cron/fetch-strike-exposure.ts` | fetch-strike-exposure.test.ts | Y | Y | Y (codifies) | partial | FM-07. Txn catch L205-209 Sentry + warn → 200 `success:true` L376; T392-416 asserts no Sentry. |
| 63 | cron | `cron/fetch-strike-iv.ts` | cron-fetch-strike-iv.test.ts | Y | Y | N | Y |  |
| 64 | cron | `cron/fetch-strike-trade-volume.ts` | cron-fetch-strike-trade-volume.test.ts | Y | Y | Y | N |  |
| 65 | cron | `cron/fetch-vol-surface.ts` | fetch-vol-surface.test.ts | Y | Y | Y (codifies) | Y | FM-07. Txn fail L116-120 → Sentry but status stays `ok` (failureCount not bumped); all-three-legs-empty → ok, no Sentry (T451-468). |
| 66 | cron | `cron/fetch-zero-dte-flow.ts` | fetch-zero-dte-flow.test.ts | Y | Y | Y | Y |  |
| 67 | cron | `cron/monitor-flow-ratio.ts` | monitor-flow-ratio.test.ts | Y | Y | Y | Y | Good; empty/NaN tick on 1-min cron info/warn only. |
| 68 | cron | `cron/monitor-vega-spike.ts` | monitor-vega-spike.test.ts | Y | Y | N | partial | FM-03. Per-ticker catch L239-247 logger.error only, no Sentry; reportCronRun `ok` L296; T403-428 asserts the swallow. |
| 69 | cron | `cron/populate-periscope-from-gexbot.ts` | populate-periscope-from-gexbot.test.ts | N | Y | N | N | FM-14. Not in SCHEDULE_MAP; `partial` when panelsWritten=0 (L160-164). |
| 70 | cron | `cron/reconcile-greek-flow-etf.ts` | reconcile-greek-flow-etf.test.ts | Y | Y | Y | N |  |
| 71 | cron | `cron/refresh-current-snapshot.ts` | refresh-current-snapshot.test.ts | N | Y | Y | Y | Upsert false → 500 without Sentry (current-snapshot.ts L73-76). |
| 72 | cron | `cron/refresh-tracker-contracts.ts` | refresh-tracker-contracts.test.ts | Y | Y | N | Y | FM-20. Always `success` L753; tick INSERT reject untested; malformed spot_alerts → [] silently L175-190. |
| 73 | cron | `cron/refresh-vix1d.ts` | refresh-vix1d.test.ts | Y | Y | N | partial | redis.set reject untested; no mockReset → captureException accumulates, T233 vacuous. |
| 74 | cron | `cron/rollup-ws-gex-strike-expiry.ts` | rollup-ws-gex-strike-expiry.test.ts | Y | Y | Y | Y | FM-14. (a)/(c) Y T150-163. Not in SCHEDULE_MAP; lib INSERT…SELECT has no withDbRetry/timeout. |
| 75 | cron | `cron/takeit-fill-shap.ts` | takeit-fill-shap.test.ts | Y | Y | Y | Y |  |
| 76 | cron | `cron/warm-tbbo-percentile.ts` | warm-tbbo-percentile.test.ts | partial | Y | N | N | Tests resolve `null`, never reject; Sentry not mocked. |
| 77 | cron | `cron/wave2-confirmation.ts` | cron-wave2-confirmation.test.ts | Y | Y | Y | Y | Best-covered detector on (c). |
| 78 | endpoint | `alerts-ack.ts` | alerts-ack.test.ts | Y | Y | Y | Y |  |
| 79 | endpoint | `alerts.ts` | alerts.test.ts | Y | Y | Y | Y |  |
| 80 | endpoint | `analyses.ts` | analyses.test.ts | Y | Y | Y | Y |  |
| 81 | endpoint | `analyze.ts` | analyze.test.ts<br>lessons-integration.test.ts | Y | Y | partial | Y | FM-24. DB save 3× fail → logger.error only (L469-482), no Sentry; T695-719 asserts 200 + call count. |
| 82 | endpoint | `auth/callback.ts` | auth-callback.test.ts | N | Y | N | Y |  |
| 83 | endpoint | `auth/guest-key.ts` | guest-key.test.ts | N | Y | N | N |  |
| 84 | endpoint | `auth/guest-logout.ts` | guest-logout.test.ts | N | N | N | N |  |
| 85 | endpoint | `auth/init.ts` | auth-init.test.ts | Y | Y | N | Y |  |
| 86 | endpoint | `auth/whoami.ts` | auth-whoami.test.ts | N | N | N | N |  |
| 87 | endpoint | `bwb-anchor.ts` | bwb-anchor.test.ts | N | N | N | N |  |
| 88 | endpoint | `chain.ts` | chain.test.ts | Y | Y | N | N | FM-35. No 500 test. |
| 89 | endpoint | `darkpool-levels.ts` | darkpool-levels.test.ts | Y | Y | Y | Y |  |
| 90 | endpoint | `dealer-regime.ts` | endpoint-dealer-regime.test.ts | Y | Y | Y | Y |  |
| 91 | endpoint | `events.ts` | events.test.ts | Y | Y | Y | Y |  |
| 92 | endpoint | `flow-regime.ts` | flow-regime-endpoint.test.ts | N | Y | Y | N |  |
| 93 | endpoint | `futures/snapshot.ts` | futures-snapshot-historical.test.ts<br>futures-snapshot.test.ts | Y | Y | Y | Y |  |
| 94 | endpoint | `gamma-setups/active.ts` | endpoint-gamma-setups-active.test.ts | Y | Y | Y | Y |  |
| 95 | endpoint | `gamma-setups/export.ts` | endpoint-gamma-setups-export.test.ts | Y | Y | Y | Y |  |
| 96 | endpoint | `gamma-setups/weekly-stats.ts` | endpoint-gamma-setups-weekly-stats.test.ts | Y | Y | Y | Y |  |
| 97 | endpoint | `gex-landscape.ts` | gex-landscape.test.ts | Y | Y | Y | Y |  |
| 98 | endpoint | `gex-strike-expiry.ts` | endpoint-gex-strike-expiry.test.ts | Y | Y | partial | Y | FM-23. Stale-on-error L202-211: no log/Sentry/metric; untested. |
| 99 | endpoint | `gex-target-history.ts` | gex-target-history.test.ts | Y | Y | Y | Y |  |
| 100 | endpoint | `gexbot.ts` | gexbot-endpoint.test.ts | Y | Y | Y | Y |  |
| 101 | endpoint | `greek-exposure-strike.ts` | greek-exposure-strike.test.ts | Y | Y | Y | Y |  |
| 102 | endpoint | `greek-flow.ts` | endpoint-greek-flow.test.ts | Y | Y | Y | Y |  |
| 103 | endpoint | `greek-heatmap.ts` | greek-heatmap.test.ts | Y | Y | Y | Y |  |
| 104 | endpoint | `health.ts` | health.test.ts | Y | N | Y | Y |  |
| 105 | endpoint | `history.ts` | history.test.ts | partial | Y | N | N | FM-35. No 500 test, no Redis-failure test (history.ts:274 empty catch, :335 logger.error only). |
| 106 | endpoint | `interval-ba-alerts-ack.ts` | interval-ba-alerts.test.ts | Y | Y | Y | Y |  |
| 107 | endpoint | `interval-ba-alerts.ts` | interval-ba-alerts.test.ts | Y | Y | Y | Y |  |
| 108 | endpoint | `interval-ba-feed.ts` | interval-ba-feed.test.ts | Y | Y | Y | Y |  |
| 109 | endpoint | `intraday.ts` | intraday.test.ts | Y | Y | N | Y | Bare Sentry+500, no logger.error, no transient split. |
| 110 | endpoint | `iv-term-structure.ts` | iv-term-structure.test.ts | Y | Y | N | Y |  |
| 111 | endpoint | `journal/backfill-features.ts` | backfill-features.test.ts | Y | N | N | Y | FM-36. Leaks err.message (L59-61); T100-107 locks it in. |
| 112 | endpoint | `journal/init.ts` | journal-init.test.ts | Y | Y | N | Y | Sentry only; test asserts 500 + body. |
| 113 | endpoint | `journal/migrate.ts` | journal-migrate.test.ts | Y | N | Y | Y | Sentry only; test asserts 500 + body. |
| 114 | endpoint | `journal/status.ts` | journal-status.test.ts | Y | Y | Y | Y |  |
| 115 | endpoint | `journal.ts` | journal.test.ts | Y | Y | Y | Y |  |
| 116 | endpoint | `lottery-contract-tape.ts` | lottery-contract-tape.test.ts | N | Y | N | N |  |
| 117 | endpoint | `lottery-export.ts` | lottery-export.test.ts | Y | Y | Y | Y |  |
| 118 | endpoint | `lottery-finder-ticker-counts.ts` | lottery-finder-ticker-counts.test.ts | Y | Y | Y | Y |  |
| 119 | endpoint | `lottery-finder.ts` | lottery-finder-endpoint.test.ts | Y | Y | Y | Y | Handler catch L1747-1753 has no 500/503 test; done(500) ordering as positions. |
| 120 | endpoint | `ml/analyze-plots.ts` | analyze-plots.test.ts | Y | Y | N | Y | NDJSON top-level error written as 200 body with err.message; done(500) disagrees with wire status. |
| 121 | endpoint | `ml/export.ts` | export.test.ts | Y | Y | Y | Y |  |
| 122 | endpoint | `ml/plot-image.ts` | plot-image.test.ts | Y | Y | N | Y |  |
| 123 | endpoint | `ml/plots.ts` | plots.test.ts | Y | Y | Y | Y |  |
| 124 | endpoint | `ml/prediction.ts` | prediction.test.ts | Y | Y | Y | Y |  |
| 125 | endpoint | `ml/trigger-analyze.ts` | ml/trigger-analyze.test.ts | partial | - | - | partial | FM-32. Import-depth artifact fixed. Reject → logger.error asserted (T153); non-2xx never inspected (L41-46) → 202. |
| 126 | endpoint | `movers.ts` | movers.test.ts | Y | Y | N | Y |  |
| 127 | endpoint | `net-flow-history.ts` | net-flow-history.test.ts | Y | Y | Y | Y |  |
| 128 | endpoint | `nope-intraday.ts` | nope-intraday.test.ts | Y | Y | Y | Y |  |
| 129 | endpoint | `opening-flow-signal.ts` | opening-flow-signal.test.ts | Y | Y | Y | Y |  |
| 130 | endpoint | `panel-prefs.ts` | panel-prefs.test.ts | Y | Y | partial | Y | PUT DB reject untested. |
| 131 | endpoint | `periscope-chat-detail.ts` | periscope-chat-detail.test.ts<br>periscope-chat-meta.test.ts | Y | Y | Y | Y |  |
| 132 | endpoint | `periscope-chat-image.ts` | periscope-chat-meta.test.ts | Y | Y | Y | Y |  |
| 133 | endpoint | `periscope-chat-list.ts` | periscope-chat-list.test.ts<br>periscope-chat-meta.test.ts | Y | Y | Y | Y |  |
| 134 | endpoint | `periscope-chat-update.ts` | periscope-chat-meta.test.ts | Y | Y | partial | Y | DB reject untested. |
| 135 | endpoint | `periscope-exposure.ts` | periscope-exposure.test.ts | Y | Y | Y | Y |  |
| 136 | endpoint | `periscope-lessons-list.ts` | periscope-lessons-list.test.ts | Y | Y | Y | Y |  |
| 137 | endpoint | `periscope-lessons-update.ts` | periscope-lessons-update.test.ts | N | Y | N | N |  |
| 138 | endpoint | `periscope-lottery-feed.ts` | periscope-lottery-feed.test.ts | Y | Y | Y | Y | FM-25. Error path omits done() (L181-186). |
| 139 | endpoint | `periscope-map.ts` | periscope-map.test.ts | Y | Y | Y | Y |  |
| 140 | endpoint | `periscope-playbook.ts` | periscope-playbook.test.ts | N | Y | N | N |  |
| 141 | endpoint | `periscope-strikes.ts` | periscope-strikes.test.ts | Y | Y | Y | Y |  |
| 142 | endpoint | `pin-setup-status.ts` | endpoint-pin-setup-status.test.ts | Y | Y | Y | Y |  |
| 143 | endpoint | `positions.ts` | positions-upload.test.ts<br>positions.test.ts | Y | Y | Y | Y | FM-25. persistPositions L158-183 `saved:false` 200 no Sentry; `done(500)` before sendDbErrorResponse L423-427. |
| 144 | endpoint | `pre-market.ts` | overnight-gap.test.ts<br>pre-market.test.ts | Y | Y | Y | Y | POST catch logger.error + 500, no Sentry (L120-124). |
| 145 | endpoint | `push/notify.ts` | push-endpoints.test.ts | Y | Y | N | Y | FM-33. All-devices-failed → 200 no Sentry (push.ts L138-151). |
| 146 | endpoint | `push/subscribe.ts` | push-endpoints.test.ts | Y | Y | N | Y |  |
| 147 | endpoint | `push/unsubscribe.ts` | push-endpoints.test.ts | Y | Y | N | Y |  |
| 148 | endpoint | `quotes.ts` | quotes.test.ts | Y | Y | N | Y | Bare Sentry+500, no logger.error. |
| 149 | endpoint | `regime-0dte.ts` | regime-0dte-endpoint.test.ts | N | Y | Y | N |  |
| 150 | endpoint | `silent-boom-export.ts` | silent-boom-export.test.ts | Y | Y | Y | Y |  |
| 151 | endpoint | `silent-boom-feed.ts` | silent-boom-feed.test.ts | Y | Y | Y | Y | FM-25. Error path omits done() (L710-715) → never in api.request metric. |
| 152 | endpoint | `silent-boom-ticker-counts.ts` | silent-boom-ticker-counts.test.ts | Y | Y | Y | Y |  |
| 153 | endpoint | `snapshot.ts` | snapshot.test.ts | Y | Y | Y | N | FM-34. Write fail → 200 `saved:false` WITH Sentry + logger.error (deliberate); T130 asserts 200 only. |
| 154 | endpoint | `strike-trade-volume.ts` | endpoint-strike-trade-volume.test.ts | Y | Y | Y | Y |  |
| 155 | endpoint | `system-status.ts` | system-status.test.ts | Y | Y | Y | Y |  |
| 156 | endpoint | `ticker-candles.ts` | ticker-candles.test.ts | Y | Y | N | Y |  |
| 157 | endpoint | `ticker-net-flow-current.ts` | ticker-net-flow-current.test.ts | Y | Y | Y | Y |  |
| 158 | endpoint | `tracker/alerts/[id]/ack.ts` | tracker-alerts.test.ts | Y | Y | Y | Y | Import-path artifact fixed; 500 + Sentry covered. |
| 159 | endpoint | `tracker/alerts/unread.ts` | tracker-alerts.test.ts | Y | Y | Y | Y |  |
| 160 | endpoint | `tracker/contracts/[id].ts` | tracker-contracts.test.ts | Y | Y | Y | partial | Import-path artifact fixed; DELETE asserts 500 only. |
| 161 | endpoint | `tracker/contracts.ts` | tracker-contracts.test.ts | Y | Y | Y | Y |  |
| 162 | endpoint | `vega-spikes.ts` | vega-spikes.test.ts | Y | Y | Y | Y |  |
| 163 | endpoint | `version.ts` | version.test.ts | N | N | N | N |  |
| 164 | endpoint | `vix-ohlc.ts` | vix-ohlc.test.ts | Y | Y | Y | Y |  |
| 165 | endpoint | `vix-snapshots-recent.ts` | vix-snapshots-recent.test.ts | Y | Y | Y | Y |  |
| 166 | endpoint | `vix1d-daily.ts` | vix1d-daily.test.ts | Y | Y | Y | Y |  |
| 167 | endpoint | `yesterday.ts` | yesterday.test.ts | Y | Y | N | Y | Bare Sentry+500, no logger.error. |
| 168 | endpoint | `zero-gamma.ts` | endpoint-zero-gamma.test.ts | Y | Y | Y | Y |  |
| 169 | lib | `_lib/uw-fetch.ts` | (api-helpers.test.ts via `export *`) | partial | partial | - | Y | IN-FLIGHT. FM-15/16. Exercised via api-helpers.ts re-export (429/5xx/text() failure). No test where fetch itself rejects; L264 res.json() uncaught → raw SyntaxError; `data` missing → [] with captureMessage unasserted. |
| 170 | lib | `_lib/uw-fetch-paged.ts` | uw-fetch-paged.test.ts | N | Y | N | Y | FM-16. Zero ok:false / rejection cases. |
| 171 | lib | `_lib/uw-rate-limit.ts` | uw-rate-limit.test.ts | Y | N | N | Y | IN-FLIGHT. Redis throw asserts metric only; captureException never asserted. |
| 172 | lib | `_lib/uw-concurrency.ts` | uw-concurrency.test.ts | Y | Y | N | Y | captureException not asserted; null eval result untested. |
| 173 | lib | `_lib/uw-stock-candles.ts` | uw-stock-candles.test.ts | N | N | - | N | FM-04. fetchStockCandles1m untested (mocked out in detect-lottery-fires.test.ts:66-73); L34-41 `catch { return [] }` no log/Sentry. |
| 174 | lib | `_lib/schwab.ts` | schwab.test.ts | Y | N | partial | Y | FM-05/06/31. Redis GET fail → null → expired_refresh/401 (L84-92, L334-349); token JSON bare cast L209/L430; T256-271 non-deterministic. |
| 175 | lib | `_lib/schwab-fetch.ts` | (api-helpers.test.ts via `export *`) | Y | N | - | Y | IN-FLIGHT (test). FM-15. 401 / non-ok / AbortSignal retry / 504 covered; L135 res.json() uncaught after done(true). |
| 176 | lib | `_lib/auth-helpers.ts` | (api-helpers.test.ts L1618-1628, indirect) | - | - | partial | N | isRateLimited Redis throw asserts only `rejected===false`. |
| 177 | lib | `_lib/redis.ts` | redis.test.ts | Y | Y | N | N | safeRedis swallow → metric only (by design); createRedis fallback untested. |
| 178 | lib | `_lib/last-good-cache.ts` | last-good-cache.test.ts | Y | Y | N | N |  |
| 179 | lib | `_lib/embeddings.ts` | analog-range-forecast.test.ts<br>embeddings.test.ts | Y | Y | partial | Y | DB propagation untested; T76-82 asserts null only. |
| 180 | lib | `_lib/day-embeddings.ts` | day-embeddings.test.ts | Y | Y | Y | N | FM-38. L85-89 / L142-146 logger.error only, no Sentry; tests assert nothing about logging. |
| 181 | lib | `_lib/day-features.ts` | day-features.test.ts | Y | N | Y | N |  |
| 182 | lib | `_lib/analog-range-forecast.ts` | analog-range-forecast.test.ts | Y | Y | N | N |  |
| 183 | lib | `_lib/periscope-retrieval.ts` | periscope-retrieval.test.ts | Y | Y | Y | N | FM-38. L112-115 DB catch → [] no Sentry. |
| 184 | lib | `_lib/anthropic-call.ts` | anthropic-call.test.ts | Y | Y | N | Y | Fallback-also-fails / socket-terminated retry (L287-298) untested. |
| 185 | lib | `_lib/analyze-precheck.ts` | analyze-precheck.test.ts | Y | Y | Y | N |  |
| 186 | lib | `_lib/analyze-context-fetchers.ts` | analyze-context-fetchers.test.ts<br>analyze-context-microstructure.test.ts | Y | Y | Y | Y |  |
| 187 | lib | `_lib/claude-tools.ts` | claude-tools.test.ts | Y | Y | Y | N |  |
| 188 | lib | `_lib/periscope-lessons.ts` | periscope-lessons.test.ts | Y | Y | Y | Y |  |
| 189 | lib | `_lib/periscope-extract.ts` | periscope-extract.test.ts | Y | Y | N | N | FM-38. JSON parse fail L455-463 → null no Sentry. |
| 190 | lib | `_lib/periscope-blob.ts` | periscope-blob.test.ts | Y | Y | N | Y | Best-in-class (c): asserts captureException with err + context. |
| 191 | lib | `_lib/gexbot-parquet.ts` | gexbot-parquet.test.ts | N | Y | N | N |  |
| 192 | lib | `_lib/takeit-bundle-loader.ts` | takeit-bundle-loader.test.ts | Y | Y | Y | Y | res.json() reject untested; test title T420 wrong (asserts null+warn, not throw). |
| 193 | lib | `_lib/alerts.ts` | alerts-lib.test.ts | Y | Y | N | Y | FM-30. writeAlertIfNew INSERT / isOnCooldown throw never tested. |
| 194 | lib | `_lib/archive-sidecar.ts` | archive-sidecar.test.ts | Y | Y | N | Y | fetchDayFeatures L83-91 untested; res.json() throw untested. |
| 195 | lib | `_lib/cron-instrumentation.ts` | cron-instrumentation.test.ts<br>cron-schedules.test.ts | Y | Y | Y | Y | Solid; Sentry.flush rejection swallow untested. See FM-08 for the returned-`error` semantics. |
| 196 | lib | `_lib/darkpool.ts` | darkpool.test.ts | Y | Y | Y | Y |  |
| 197 | lib | `_lib/gexbot-client.ts` | fetch-gexbot-fast.test.ts<br>fetch-gexbot-strikes.test.ts<br>gexbot-client.test.ts | Y | Y | Y | Y | res.json() SyntaxError + timeout untested. |
| 198 | lib | `_lib/multileg-client.ts` | multileg-client.test.ts | Y | Y | Y | Y | `invalid_json` L661-681 and 15 s timeout untested. |
| 199 | lib | `_lib/option-intraday.ts` | option-intraday.test.ts | Y | Y | Y | N |  |
| 200 | lib | `_lib/bulk-upsert.ts` | bulk-upsert.test.ts | Y | Y | Y | Y |  |
| 201 | lib | `_lib/build-features-upsert.ts` | **NONE** | - | - | - | - | Only exercised via build-features.test.ts with sql mocked. |
| 202 | lib | `_lib/build-features-labels.ts` | build-features-labels.test.ts | N | Y | N | Y |  |
| 203 | lib | `_lib/current-snapshot.ts` | current-snapshot.test.ts | Y | Y | Y | N | Upsert fail → false with logger.error + metric, no Sentry. |
| 204 | lib | `_lib/db-analyses.ts` | db-analyses.test.ts | N | Y | N | N |  |
| 205 | lib | `_lib/db-positions.ts` | db-positions.test.ts | N | Y | N | N |  |
| 206 | lib | `_lib/db-snapshots.ts` | db-snapshots.test.ts | N | Y | N | N |  |
| 207 | lib | `_lib/db.ts` | analog-range-forecast.test.ts<br>db-retry.test.ts<br>db.test.ts<br>embeddings.test.ts<br>lessons.test.ts<br>positions-spreads.test.ts<br>request-scope.test.ts<br>safe-db.test.ts<br>transient-db-response.test.ts | Y | Y | Y | Y | Solid — withDbRetry / safeDb / TransientDbError tested. |
| 208 | lib | `_lib/gamma-detector.ts` | gamma-detector.test.ts<br>gamma-stats.test.ts | N | Y | N | N |  |
| 209 | lib | `_lib/gex-target-features.ts` | gex-target-features.test.ts | Y | Y | Y | N |  |
| 210 | lib | `_lib/gexbot-store.ts` | gexbot-store.test.ts | N | Y | N | N |  |
| 211 | lib | `_lib/greek-flow-etf-store.ts` | **NONE** | - | - | - | - | L134-140 swallows INSERT error warn+metric; exercised via fetch-greek-flow-etf.test.ts. |
| 212 | lib | `_lib/kept-tickers.ts` | kept-tickers.test.ts | Y | Y | Y | N |  |
| 213 | lib | `_lib/lessons.ts` | lessons.test.ts | N | Y | Y | N |  |
| 214 | lib | `_lib/periscope-db.ts` | periscope-db.test.ts<br>periscope-prompts.test.ts | Y | Y | Y | Y |  |
| 215 | lib | `_lib/push.ts` | push.test.ts | Y | Y | Y | Y |  |
| 216 | lib | `_lib/rollup-ws-gex-strike-expiry.ts` | (rollup-ws-gex-strike-expiry.test.ts via cron) | Y | partial | Y | Y | Raw db.query, no withDbRetry/timeout on ~490K-row INSERT…SELECT. |
| 217 | lib | `_lib/spx-candles.ts` | spx-candles.test.ts | Y | Y | Y | Y |  |
| 218 | lib | `_lib/sentry.ts` | analyze.test.ts<br>sentry.test.ts | Y | Y | Y | Y | IN-FLIGHT. Fingerprint regex L63 only matches `^UW API 5\d\d`. |
| 219 | lib | `_lib/api-helpers.ts` | api-helpers.test.ts | Y | Y | Y | Y | IN-FLIGHT (test). Hosts the uwFetch/schwabFetch/withRetry failure suites. |
| 220 | lib | `_lib/request-scope.ts` | request-scope.test.ts | Y | N | Y | Y | Solid — transient 503 vs genuine 500 split tested. |

## Findings — ranked gaps

Ranking: blast radius first (market-data writes the trader acts on → detectors → Schwab/UW wrappers and tokens → journal/positions → read-only). Severity per the brief: **P1** = trader-dependent write path with no failure-mode test *and* a catch/fallback that swallows or reports partial/empty as success; **P2** = missing/hollow failure test where the code is otherwise sound, or a surfaced-but-misreported failure; **P3** = read-only or low-stakes. `code-defect` = the untested branch itself is wrong. Line numbers are from this worktree.

### FM-01: fetch-greek-flow — batch INSERT failure is warn-only, no Sentry, and the cron returns `success`  [P1] [confidence: high] [effort: S] [code-defect]
- Where: `api/cron/fetch-greek-flow.ts:122-126` (store catch), `:171` (`status: 'success'`); test `api/__tests__/fetch-greek-flow.test.ts:408-427`
- What: `catch (err) { logger.warn({ err }); metrics.increment('fetch_greek_flow.store_error'); return { stored: 0, skipped: entries.length } }` — no `Sentry.captureException`, no `logger.error`; the handler then returns `status: 'success'` → HTTP 200, check-in `ok`. `withRetry(() => storeLatest(...))` at L137 is dead because `storeLatest` never throws. Sentry is not even mocked in the test.
- Failure scenario: Neon rejects the greek-flow INSERT for an hour during RTH → every 5-min run reports `success` with `stored: 0`; the Greek Flow panel silently goes stale with no Sentry issue, no red check-in. Compare `fetch-greek-flow-etf.ts:294-305`, which escalates the identical case.
- Test needed: `vi.mock('../_lib/sentry.js')`; `mockTransaction.mockRejectedValueOnce(new Error('insert failed'))` with 1 tick. Assert `Sentry.captureException` called with that error and `res._json.status !== 'success'` (fails today — the current test asserts `200 + {stored:0, skipped:1}`, i.e. it codifies the swallow).

### FM-02: fetch-market-internals — Schwab quotes non-2xx swallowed with no log or Sentry; 4/4 symbol failure still reports `partial`  [P1] [confidence: high] [effort: S] [code-defect]
- Where: `api/cron/fetch-market-internals.ts:272-281` (quotes `!result.ok` → error rows, no `logger`, no `Sentry`), `:430` (`status: failures.length === 0 ? 'success' : 'partial'` — never `'error'`); test `api/__tests__/fetch-market-internals.test.ts:254-282`, `:451-473`
- What: a Schwab 401/5xx on the quotes call is turned into per-symbol `{error: ...}` objects and counted, but nothing is logged or captured; the pricehistory branch (L237-250) does capture. Even total failure (every symbol) maps to `'partial'` → HTTP 200 → check-in `ok`.
- Failure scenario: Schwab token expires mid-session → `$ADD`/`$VOLD`/`$TICK` quotes fail every run; the market-internals panel freezes; Sentry sees nothing from this cron; Axiom shows `partial` indefinitely. Test L451-473 rejects the whole-symbol transaction and asserts `200`, `failureCount: 4` — codifying (2).
- Test needed: quotes → `{ok:false, status:502}` and pricehistory → reject. Assert `body.status === 'error'`, `captureException` called ≥ 1 for the quotes path, `logger.warn/error` called with `symbols` — the quotes assertion fails today.

### FM-03: monitor-vega-spike — per-ticker DB failure is `logger.error` only; `reportCronRun` always `'ok'`  [P1] [confidence: high] [effort: S] [code-defect]
- Where: `api/cron/monitor-vega-spike.ts:239-247` (per-ticker catch → `logger.error({ err, ticker })`, no Sentry, continue), `:296` (`status: 'ok'` unconditionally); test `api/__tests__/monitor-vega-spike.test.ts:403-428`
- What: a 1-minute RTH cron that raises the trader's vega-spike alerts. A SELECT/INSERT failure for SPY is logged and the ticker gets `{fired:false, error}`; the run returns 200, Axiom `ok`, check-in `ok`. No Sentry issue is ever created.
- Failure scenario: Neon blip at 09:31 → SPY bars query rejects for N minutes → no vega alerts, no page. The existing test rejects the SELECT and asserts `200 + error field + logger.error` — it asserts the swallow.
- Test needed: SPY SELECT `mockRejectedValueOnce`; assert `captureException` called with `{tags:{ticker:'SPY'}}` and `reportCronRun` status `!== 'ok'` (both fail today until the catch is fixed).

### FM-04: `fetchStockCandles1m` bare `catch { return [] }` feeds `detect-lottery-fires` range_pos with silent NULLs  [P1] [confidence: high] [effort: S] [code-defect]
- Where: `api/_lib/uw-stock-candles.ts:34-41`; consumer `api/cron/detect-lottery-fires.ts:686`; tests: `api/__tests__/uw-stock-candles.test.ts` covers only `computeRangePos`; the fetch is mocked out in `detect-lottery-fires.test.ts:66-73`
- What: `try { return await uwFetch(...) } catch { return []; }` — no log, no metric, no Sentry. The doc comment says failures are "logged by uwFetch", but `uwFetch` throws bare `UW API 401/429/5xx` and timeouts; nothing logs them here.
- Failure scenario: UW 429 storm or key rotation → every lottery fire's `range_pos` lands NULL; the scoring feature silently degrades; no Sentry event distinguishes "no candles" from "UW down". This is the exact class the 2026-08 UW key-rotation incident hit.
- Test needed: `vi.mocked(uwFetch).mockRejectedValueOnce(new Error('UW API 429: x'))` → `await expect(fetchStockCandles1m(...)).resolves.toEqual([])` **and** `expect(captureException).toHaveBeenCalled()` — the second assertion fails today.

### FM-05: schwab.ts — a Redis GET blip is reported as `expired_refresh` → 401 `SCHWAB_TOKEN_EXPIRED` on every Schwab endpoint  [P1] [confidence: high] [effort: M] [code-defect]
- Where: `api/_lib/schwab.ts:84-92` (`getStoredTokens` catch → `logger.warn` + `metrics.increment('redis.error')` → `null`), `:334-349` (null tokens → `expired_refresh` "No tokens found. Run /api/auth/init"), `api/_lib/schwab-fetch.ts:36-50` (maps to **401**); test `api/__tests__/schwab.test.ts:256-271`
- What: only the in-memory cache (L336-341) stands between a KV read failure and a 401. On a cold Fluid instance every data endpoint tells the owner to re-authenticate. No Sentry, warn-level only.
- Failure scenario: Upstash 30-second blip at the open → chain, quotes, intraday, internals all 401 with `SCHWAB_TOKEN_EXPIRED`; the UI shows "re-auth" prompts; the trader re-runs OAuth for nothing. Test L256-271 is **non-deterministic** (`if ('token' in result) … else …`) so it can't catch this.
- Test needed: `mockRedis.get.mockRejectedValueOnce(new Error('ECONNRESET'))` with empty in-memory cache; assert result is `{error:{type:'token_error'}}` (→ 500, not 401) and `captureException` called — both fail today.

### FM-06: schwab.ts — token-response JSON is a bare cast; a 200 with `{}` caches `undefined` tokens  [P1] [confidence: high] [effort: S] [code-defect]
- Where: `api/_lib/schwab.ts:209-217` (`(await res.json()) as SchwabTokenResponse`), `:430-438` (same in `storeInitialTokens`), `:275-279` (written to Redis and `inMemoryTokenCache`); test `schwab.test.ts` — no test for `res.json()` rejecting or a 200 with a missing field
- What: no zod/shape guard. `expiresAt = now + undefined * 1000 = NaN`; `accessToken: undefined` is stored; every subsequent call refreshes with `refreshToken: undefined`.
- Failure scenario: Schwab returns 200 with an HTML/empty body (their maintenance page does this) → tokens overwritten with garbage in Redis → all endpoints fail until manual re-auth, with the *stored* good refresh token destroyed.
- Test needed: `fetch → {ok:true, json: () => Promise.resolve({})}`; assert `toMatchObject({error:{type:'token_error'}})` and `mockRedisSet` **not** called with `accessToken: undefined` — fails today.

### FM-07: GEX family — store-catch captures to Sentry, then the cron reports `success`/`ok` with `stored: 0`; the `withRetry` around each store is dead  [P2] [confidence: high] [effort: M] [code-defect]
- Where (all `api/cron/`): `fetch-strike-exposure.ts:205-209` → `:376 success:true`; `fetch-strike-all.ts:155-159` → 200 `success:true`; `fetch-greek-exposure.ts:151-155` → `:218` `partial` derived only from fetch rejection → `:266 'success'`; `fetch-gex-0dte.ts:244-249` → `:402-405 success:true` (the failed batch is reported as `skipped: N`, i.e. counted as *duplicates*); `fetch-gex-strike-expiry-etfs.ts:373-390` → `:465-472` status from `failureCount` only → `'success'`; `fetch-vol-surface.ts:116-120` → `failureCount` not incremented → `'ok'`. Dead retry wrappers: `gex-0dte:305`, `greek-exposure:215`, `greek-exposure-strike:174`, `strike-exposure:231`, `strike-all:179` (`withRetry(() => storeX())` around a function that catches internally and returns `{stored:0}` — the retry can never engage). Tests that codify: `fetch-strike-exposure.test.ts:392-416`, `fetch-strike-all.test.ts:349-367`, `fetch-greek-exposure.test.ts:488-520`, `fetch-gex-0dte.test.ts:392-416`, `fetch-gex-strike-expiry-etfs.test.ts:654-692`, `fetch-vol-surface.test.ts:545-570`.
- What: Sentry **is** told (unlike FM-01), but the HTTP body, Axiom row, and Sentry Crons check-in all say success, so the on-call signal is a lone exception with no red monitor; a persistent Neon failure is indistinguishable from a healthy run in every dashboard. Six tests reject the write and then assert `200 + success:true` — five of them without asserting `captureException`.
- Failure scenario: `strike_exposures` INSERT rejects for a session → Periscope-adjacent GEX walls, zero-gamma, and `compute-zero-gamma` (which reads today's `strike_exposures`) all run on yesterday's rows; every cron says green.
- Test needed (per cron, 3 lines): `mockTransaction.mockRejectedValueOnce(new Error('x'))` with ≥1 row → assert `captureException` called **and** `res._json.status` is `'partial'`/`'error'` (or `success:false`). Then delete the dead `withRetry` wrappers or make the store throw so they engage.

### FM-08: `withCronInstrumentation` treats a *returned* `status:'error'` as HTTP 200 with no `captureException` — compute-cone / check-cone-breach never reach Sentry  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/_lib/cron-instrumentation.ts:686-712` (returned `'error'` → check-in `error`, `reportCronRun`, `res.status(200)`; only a *thrown* error hits `captureException` at L717-730); `api/cron/compute-cone.ts:175-183` (Schwab `!ok` → `logger.warn` + return `'error'`); `api/cron/check-cone-breach.ts:80-86`, `:112-118` (unparseable cone/close → `logger.warn` + `'error'`); tests `cron-compute-cone.test.ts:336-347` (asserts only `mockSql` not called), `cron-check-cone-breach.test.ts` (both `'error'` branches untested)
- What: the wrapper comment says a returned `'error'` "goes red" — it does, on the Sentry Crons monitor — but no *issue* is created and the log line is warn-level, so nothing pages and nothing is fingerprinted. Handlers relying on the wrapper for surfacing therefore have zero Sentry issues on their primary failure path.
- Failure scenario: Schwab chain fetch 500s at 09:35 → no cone for the day → `check-cone-breach` reports `skipped` all session (empty cone SELECT) → the trader's breakeven cone never appears and nobody is paged.
- Test needed: `schwabFetch → {ok:false, status:500}` → assert `status:'error', reason:'schwab_fetch_failed'` **and** `captureException` (or `captureMessage`) called. Consider making the wrapper itself call `captureMessage(..., 'error')` on a returned `'error'`.

### FM-09: enrich-periscope-lottery-outcomes writes an *empty tape* as a real, permanently locked −100 % outcome  [P2] [confidence: high] [effort: M] [code-defect]
- Where: `api/cron/enrich-periscope-lottery-outcomes.ts:224-232` (comment: "leave outcome NULL but still lock the row … realized R = −1"), `:257-266` (`realizedRPeak = -1`, `realizedREod = -1`, `outcome_locked = TRUE`); test `api/__tests__/enrich-periscope-lottery-outcomes.test.ts:156-186` asserts `[-1]`
- What: "no trades in window" is treated as expiry-worthless by design, but the same `[]` arrives when the `ws_option_trades` read hits a Neon blip (the SELECT is not wrapped in a retry that distinguishes empty from failed) or when `cleanup-ws-option-trades` purged the window before enrichment. The lottery and silent-boom enrichers stamp NULL for the identical condition. No (a)/(c) reject test exists.
- Failure scenario: one bad Neon minute during enrichment → a batch of periscope-lottery fires scored −1 and locked forever; the calibration audit and ML retrain ingest them as losses.
- Test needed: trade-read `mockRejectedValueOnce` → 500 + `captureException`; and (after fix) a fire whose tape is `[]` stays NULL / unlocked so it can be re-enriched.

### FM-10: compute-es-overnight — zero ES bars at 09:35 ET is `skipped` info-only; Schwab `ok:false` falls through silently  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/cron/compute-es-overnight.ts:168-177` (`logger.info` + `'skipped'`), `:208` (`if (intradayResult.ok && …)` — a Schwab error is neither logged nor captured; only a *thrown* error reaches the catch at L211-215); test `compute-es-overnight.test.ts:158-167` asserts 200 + skipped only; `ok:false` untested
- What: on a weekday, zero overnight ES bars means the Databento sidecar is dead (memory: `uw-stream-lease-death` pattern) — this is the cheapest possible sidecar health check and it logs at info.
- Failure scenario: Railway sidecar OOM overnight → no bars → `skipped` → the overnight-gap context Claude reads is absent and the trader learns of it from the empty pre-market panel.
- Test needed: bars `[]` on a weekday → assert `captureMessage`/`logger.warn`; `schwabFetch → {ok:false,status:500}` → assert warn + gap computed from globex close (the warn assertion fails today).

### FM-11: fetch-futures-snapshot — every symbol null during open market → 200 `ok`  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/cron/fetch-futures-snapshot.ts:110` (`snapshots.length === 0 && errors.length > 0` — all-null with zero errors passes), `:131` (`status:'ok'` even when `errors.length > 0`); test `fetch-futures-snapshot.test.ts:424-444` asserts 200 only; L342-383 rejects NQ and never asserts `captureException`
- What: `computeSnapshot` returns `null` on no bars (not an error), so a dead sidecar → 9 nulls → "nothing to store" → success.
- Failure scenario: same as FM-10, but this is the 5-minute RTH job feeding the futures panel and the analyze context.
- Test needed: all-null with `isFuturesMarketOpen → true` → assert `captureMessage` and `stored: 0` with `status !== 'ok'`; add a `captureException` assertion to the NQ-reject test.

### FM-12: fetch-gexbot-strikes / fetch-gexbot-fast — 128/128 failures report `partial`; no INSERT-reject test; per-row abort loses capture rows  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/cron/fetch-gexbot-strikes.ts:151` and `fetch-gexbot-fast.ts:393` (`failed === 0 ? 'success' : 'partial'`); `fetch-gexbot-fast.ts:145-186` (sequential per-row `withDbRetry` INSERT — first rejection aborts the loop and skips `insertCaptureRows` at L371); tests `fetch-gexbot-strikes.test.ts:263-268` codifies `partial`; neither test rejects `mockSql`
- What: `deriveCronStatus` exists in `cron-instrumentation.ts:467-472` and is not used here. (b) malformed body (non-object / missing `timestamp`) untested in both.
- Failure scenario: GexBot outage → every task fails → `partial`, check-in `ok`; Neon rejects one snapshot INSERT → up to 96 capture rows dropped with a 500 that hides the partial commit.
- Test needed: `mockSql.mockRejectedValueOnce(new Error('neon down'))` on the first snapshot INSERT → assert 500, `captureException`, and the captures UNNEST **not** called; all-fail → `status === 'error'`.

### FM-13: empty upstream during RTH is invisible across the GEX family, capture-flow-regime, compute-zero-gamma, the periscope detectors and detect-gamma-setups  [P2] [confidence: medium] [effort: M] [code-defect]
- Where: `api/_lib/cron-helpers.ts:288` (`checkDataQuality` fires only when `total > minRows && nonzero === 0` — an *empty* table never alerts); `fetch-strike-exposure.ts:147`, `fetch-strike-all.ts:174-176`, `fetch-greek-exposure-strike.ts:84`, `fetch-gex-0dte.ts:265-271` (`'skipped'`), `fetch-spot-gex.ts:72/100`, `fetch-vol-surface.ts:73/94`; `capture-flow-regime.ts` (nTrades=0 at slot ≥ 1 → `success` — the uw-stream-dead signature); `compute-zero-gamma.ts` (all three tickers without today's `strike_exposures` → `success`, `logger.info`); `detect-periscope-{call,put}-lottery.ts` and `detect-gamma-setups.ts:70-81` (empty window → `success`/`no_data`, no staleness gate on `latest_slot`). Tests: every one of these has an "empty → 200" test that asserts the silence (e.g. `fetch-vol-surface.test.ts:451-468`, `capture-flow-regime.test.ts:307-336`, `cron-detect-gamma-setups.test.ts:196-216`).
- What: `uwFetch` returns `[]` both for a genuine empty `data: []` **and** for a body with `data` missing (L266-273, with only a `captureMessage` warning), so a UW schema drift or frozen cache collapses into every handler's "empty" path.
- Failure scenario: UW freezes `/spot-exposures` mid-session (this happened — see the file-level JSDoc in `fetch-gex-0dte.ts`) → every 5-min GEX cron stores nothing and reports green; the trader sees frozen walls.
- Test needed (template exists): `detect-lottery-fires.ts:259-286` raises `captureMessage('warning', {cron.anomaly:'empty-window'})` gated on `isPastCashOpen(2)`. Each listed cron needs one test: `uwFetch → []` during RTH → assert `captureMessage`/`logger.warn` and a non-`success` status or explicit `skipped` reason.

### FM-14: five crons are missing from `SCHEDULE_MAP` — a returned `'error'` or a missed run is Axiom-only  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/_lib/cron-schedules.ts` (61 keys); missing: `detect-gamma-setups`, `populate-periscope-from-gexbot`, `check-gamma-setup-drift`, `backfill-gamma-setup-outcomes`, `rollup-ws-gex-strike-expiry`; `api/__tests__/cron-schedules.test.ts` does not cross-check `vercel.json`
- What: without a schedule entry there is no Sentry Crons monitor, so FM-08's "check-in goes red" safety net does not exist for these; combined with their zero (a)/(c) tests they are fully unmonitored write jobs.
- Failure scenario: `populate-periscope-from-gexbot` INSERT rejects nightly → Periscope panels stay on stale GexBot data indefinitely with no signal anywhere but an Axiom row nobody reads.
- Test needed: in `cron-schedules.test.ts`, read `vercel.json` `crons[]`, assert every `path` basename has a `SCHEDULE_MAP` entry (fails today with these five).

### FM-15: `res.json()` on a 2xx is never tested to reject — a non-JSON body escapes the wrapper contract as a raw `SyntaxError`  [P2] [confidence: high] [effort: S] [code-defect] [IN-FLIGHT: uw-fetch.ts]
- Where: `api/_lib/uw-fetch.ts:264` (inside `try … finally`, no catch — not retryable by `withRetry` L75, not fingerprinted by `sentry.ts:63` which only matches `^UW API 5\d\d`); `api/_lib/schwab-fetch.ts:135` (`await res.json()` after `done(true)`, in a function whose return type is `ApiResult<T>`); `api/_lib/schwab.ts:209`, `:430`; `api/_lib/takeit-bundle-loader.ts:128/143`; `api/_lib/archive-sidecar.ts:50`; `api/_lib/gexbot-client.ts:168`. Tests: none in the repo mock `json: () => Promise.reject(...)` on an `ok: true` response.
- What: UW and Schwab both serve HTML maintenance pages with 200 and Cloudflare challenge pages with 200. Today that is an unfingerprinted `SyntaxError: Unexpected token '<'` that groups with nothing.
- Failure scenario: UW edge returns a 200 HTML challenge (memory: `uw-blocks-python-urllib-ua` — the edge/WAF does this) → every UW cron 500s with a generic SyntaxError; Sentry shows 30 distinct issues instead of one `UW API` group.
- Test needed: `fetch → {ok:true, json: () => Promise.reject(new SyntaxError('Unexpected token <'))}` → for `schwabFetch` assert `resolves.toMatchObject({ok:false, status:502})`; for `uwFetch` assert it rejects with a wrapped `UW API` error (both fail today).

### FM-16: `uwFetch` has no test where `fetch` itself rejects (slot release in `finally` unproven); `uwFetchPaged` has zero non-2xx tests  [P2] [confidence: high] [effort: S] [IN-FLIGHT: uw-fetch.ts, api-helpers.test.ts]
- Where: `api/_lib/uw-fetch.ts:225-228` (fetch rejection propagates raw), `:275-277` (`finally { releaseConcurrencySlot }`); `api/_lib/uw-fetch-paged.ts`; tests `api-helpers.test.ts:628-970` (only `ok:false` bodies), `uw-fetch-paged.test.ts` (no `ok:false`, no reject)
- What: the concurrency slot (memory: `uw-50-channel-cap`, sharded connections) leaks if `finally` ever misbehaves on an `AbortError`; nothing proves it. Paged fetch on page 2 returning 503 has no test at all.
- Failure scenario: UW timeout storm → if a slot leaks, `acquireUWSlot` starves every later cron for the rest of the window.
- Test needed: `vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted','TimeoutError')))` → `rejects` **and** `mockReleaseConcurrencySlot` called once; paged: page 2 → 503 → `rejects.toThrow('UW API 503')`.

### FM-17: detect-lottery-fires — tick SELECT reject and INSERT reject (mid-batch abort) untested; macro-throw test asserts only `success`  [P2] [confidence: high] [effort: S]
- Where: `api/cron/detect-lottery-fires.ts:235-256` (3× tick SELECT via `withDbRetry` → 500), `:858` (INSERT → 500, prior rows already committed), `:657-673` (macro catch → warn + `captureException(warning)`); test `detect-lottery-fires.test.ts:768-801` (macro throw → asserts `success` only), `:1423-1458` (GexBot capture asserted — good)
- What: the code is right (everything propagates to the wrapper's 500 + Sentry) but the matrix's (c)=Y came from the macro-reject test; the write path itself is never rejected. `withDbRetry` is a pass-through in the test so `TransientDbError` handling is unproven at the cron level.
- Failure scenario: INSERT rejects on row 3 of 12 → rows 1-2 committed, 3-12 lost, 500 + Sentry (correct) — but nothing proves the cooldown seed survives (memory: `replay-cooldown-bug-corrupted-days`).
- Test needed: `mockSql` INSERT `mockRejectedValueOnce` → assert 500 + `captureException`; add `captureException` assertion to T768.

### FM-18: detect-silent-boom — INSERT reject and bucket SELECT reject untested  [P2] [confidence: high] [effort: S]
- Where: `api/cron/detect-silent-boom.ts` (macro path covered at `detect-silent-boom.test.ts:1410-1476`, `:1576-1640`; no `mockSql` rejection on the alert INSERT or the bucket SELECT)
- What: best-covered detector on (a); the (c) write path is the gap. Code propagates correctly.
- Test needed: alert INSERT `mockRejectedValueOnce` → 500 + `captureException`.

### FM-19: enrich-lottery-outcomes — flow-inversion failure NULLs the whole batch with `logger.warn`; test codifies it; SELECT/UPDATE reject untested  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/cron/enrich-lottery-outcomes.ts:345-349` (catch → `logger.warn`, `flowInversion = null`, not counted, no Sentry); test `enrich-lottery-outcomes.test.ts:503-574` asserts `success`
- Failure scenario: a systematic error in the inversion query → `realized_flow_inversion_pct` NULL for every fire, silently, for as long as it takes someone to notice in the feature audit. Compare `enrich-vega-spike-returns.ts:220-235` (counts + captures + `partial`).
- Test needed: inversion throw → assert `captureException` and `status:'partial'` (fails today); batched UPDATE reject → 500 + `captureException`.

### FM-20: refresh-tracker-contracts — always returns `'success'` even when every contract fetch fails; tick INSERT reject untested  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/cron/refresh-tracker-contracts.ts:753` (`status: 'success'` unconditionally), `:175-190` (`parseSpotAlerts` malformed JSON → `[]` silently); test `refresh-tracker-contracts.test.ts:500-583` (a) good; no spot-fetch reject, no INSERT reject
- Test needed: all UW fetches reject → assert `status:'partial'`, `ticks_inserted:0` (fails today); tick INSERT reject → 500.

### FM-21: capture-regime-0dte — a swallowed OHLC DB error lands a NULL-outcome scorecard row as `success`, never re-run  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/_lib/postgres-day-summary.ts:43-46` (`fetchDayOhlcFromPostgres` catch → warn + `null`); `api/cron/capture-regime-0dte.ts` (null → all realized columns NULL, UPSERT proceeds, `success`); tests: `capture-regime-0dte.test.ts` has zero (a)/(c) reject cases
- Test needed: `mockFetchDayOhlc → null` → assert UPSERT params are null **and** (after fix) `captureMessage`/`'partial'`; UPSERT reject → 500.

### FM-22: fetch-day-ohlc — a Neon read failure becomes a "holiday" `skipped` with `logger.warn`; malformed sidecar row is silent  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/_lib/postgres-day-summary.ts:207-210` (catch → warn + `null`), `api/cron/fetch-day-ohlc.ts:126-141` (null → `'skipped'`, check-in `ok`), `:103-120` (malformed row → fallback, only `metrics.increment` L152); test `fetch-day-ohlc.test.ts` — helper fully mocked, no UPDATE reject
- Test needed: malformed sidecar row (string numbers) + pg → null → assert warn/`captureMessage` and body not `skipped`; UPDATE reject → 500 + `captureException`.

### FM-23: gex-strike-expiry endpoint — stale-on-error serves the cached body with **no** log, Sentry, or metric  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/gex-strike-expiry.ts:202-211` (`if (cached) { … X-Cache-Stale … return 200 }` before the `captureException` at L212-218); test `endpoint-gex-strike-expiry.test.ts:604` covers only the no-cache branch
- What: the live GEX strike panel the trader watches. Once any payload is cached, a permanent DB failure is 200 + `X-Cache-Stale: 1` forever, invisible server-side.
- Failure scenario: `ws_gex_strike_expiry` table locked by the rollup (FM-14, no timeout) → panel silently frozen for the session.
- Test needed: seed cache, then `getDb` reject → assert 200 + `X-Cache-Stale` **and** `logger.warn`/`captureMessage` (the latter fails today).

### FM-24: analyze.ts — the analysis DB save exhausting all retries is `logger.error` only; the 200 has already told the trader it worked  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/analyze.ts:469-471` (per-attempt catch → `logger.error({ err, attempt })`, no Sentry), `:479-482` (exhaustion → `metrics.dbSave(false)` + `logger.error`); `captureException` fires only for the dark-pool (L430) and embedding (L459) sub-saves; test `analyze.test.ts:695-719` asserts 200 + call count
- Test needed: `saveAnalysis` `mockRejectedValue` ×3 → assert `metrics.dbSave('analyses', false)` **and** `captureException` called (second fails today).

### FM-25: positions / feeds — `persistPositions` swallows to `saved:false` 200 with no Sentry; `done()` mis-ordered or omitted on error paths  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/positions.ts:158-183` (`savePositions` reject → `logger.error` + `metrics.dbSave(false)` + `saved:false`, 200, no Sentry), `:423-427` (`done({status:500})` fires before `sendDbErrorResponse`, which may answer 503 → metric records 500); `api/lottery-finder.ts:1748-1752` (same ordering); `api/silent-boom-feed.ts:710-715`, `api/periscope-lottery-feed.ts:181-186` (error path omits `done` → error responses never recorded in `api.request`); tests `positions.test.ts` assert `saved:false` only; no feed test asserts the metric
- Failure scenario: the two live feeds' 5xx rate is invisible in the request metric — exactly the signal you'd use to notice FM-23.
- Test needed: `savePositions` reject → assert `captureException`; feed handler `getDb` reject → assert `done` called with `{status:500|503}`.

### FM-26: DB-write rejection (c) is untested in 22 of 31 detector/enrichment crons — code propagates correctly, coverage is the gap  [P2] [confidence: high] [effort: M]
- Where (no `mockRejected` on any write): `detect-periscope-call-lottery`, `detect-periscope-put-lottery` (neither test asserts `res._status` at all), `detect-gamma-setups`, `populate-periscope-from-gexbot` (also `'partial'` when `panelsWritten === 0`, L160-164), `check-cone-breach`, `check-gamma-setup-drift`, `backfill-gamma-setup-outcomes`, `enrich-silent-boom-outcomes`, `evaluate-round-trip`, `capture-flow-regime`, `capture-flow-regime-daily`, `capture-opening-flow-signal`, `compute-cone`, `refresh-vix1d` (`redis.set`), `fetch-day-ohlc`, `fetch-gexbot-*`, `enrich-lottery-outcomes`, `enrich-periscope-lottery-outcomes`, `capture-regime-0dte`, `monitor-vega-spike`, `refresh-tracker-contracts`
- What: these handlers have no local catch, so the wrapper's 500 + `captureException` is correct — but every test replaces `withDbRetry` with a pass-through, so `TransientDbError` → 503 vs genuine → 500 is never exercised at the cron level, and nothing proves a mid-loop rejection doesn't leave a half-written batch reported as success.
- Test needed (one per cron, 3 lines): `mockSql.mockRejectedValueOnce(new Error('insert failed'))` on the first write → `expect(res._status).toBe(500)` + `expect(captureException).toHaveBeenCalledWith(expect.any(Error))`.

### FM-27: `mockResponse()` defaults `_status: 200`, so `expect(res._status).toBe(200)` is vacuous  [P2] [confidence: high] [effort: S] [code-defect: test infra]
- Where: `api/__tests__/helpers.ts:43`; used by essentially every endpoint/cron test's happy-path and "graceful" assertions (e.g. `detect-periscope-*-lottery.test.ts` never call `status()` at all and still "pass" 200)
- What: a handler that returns without ever calling `res.status()` passes every `toBe(200)` assertion. Combined with FM-07's `success:true` bodies, a test can "prove" a graceful path that never ran.
- Test needed: default `_status` to `0` (or `undefined`) in `mockResponse()`, run the suite, and fix the tests that were asserting a status nobody set.

### FM-28: tests that trigger a failure and assert nothing that proves it was surfaced  [P2] [confidence: high] [effort: M]
- Where: LLM/embedding modules asserting only `toBeNull()`/`toEqual([])` with Sentry/logger mocked-but-unasserted — `embeddings.test.ts:76`, `periscope-extract.test.ts:193,365`, `periscope-lessons.test.ts:209`, `periscope-retrieval.test.ts:43`, `anthropic-call.test.ts:179` (fallback), `uw-rate-limit.test.ts:127` (IN-FLIGHT), `uw-concurrency.test.ts:129`, `api-helpers.test.ts:1619` (IN-FLIGHT); crons asserting only status/counts after a rejection — `fetch-greek-flow-etf.test.ts:471-498, 532-561`, `build-features.test.ts:259-292` (Sentry not mocked), `warm-tbbo-percentile.test.ts` (resolves `null`, never rejects; Sentry not mocked), `compute-zero-gamma.test.ts:344-370` (`body.status` only), `fetch-strike-exposure.test.ts:309-333`, `fetch-futures-snapshot.test.ts:342-383`, `curate-periscope-lessons.test.ts`, `enrich-vega-spike-returns.test.ts:382`; mock-hygiene: `refresh-vix1d.test.ts` never `mockReset`s so `captureException` accumulates and T233 is vacuous; `takeit-bundle-loader.test.ts:420` title says "throws" but asserts null + warn.
- Test needed: each gets one added line — `expect(captureException).toHaveBeenCalledWith(expect.any(Error))` or `expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.any(String))` — plus `vi.mock('../_lib/sentry.js')` where absent and `mockReset()` in `beforeEach`.

### FM-29: uw-stream sink — chunk-2 rollback, partial batch, and `_safe_flush`'s capture are exercised but never asserted; `_parse_insert_status` masks driver drift  [P2] [confidence: medium] [effort: M]
- Where: `uw-stream/src/db.py:327-339` (`bulk_insert_ignore_conflict` runs all chunks in one transaction), `:225-228` (`_parse_insert_status` → `0` on unparseable — a driver format change silently reports zero inserts); `handlers/base.py:308-337` (`_safe_flush` catches everything → `capture_exception` + `log.error`, rows **dropped**), `:161-177` (`_transform` exception → `capture_exception` only), `:204-218` (`drain()` timeout → warning, no Sentry); tests `test_db_bulk.py:485-582` (db retry — good), `test_handlers.py:337,592` (flush raises — asserts no-raise only), `test_router.py:63-99` (malformed frame — asserts no-raise only); no test for a chunk-2 failure rolling back chunk 1, none for one bad row in a chunk, none for `run()` with a raising `_transform`.
- What: this is the upstream of both the Lottery Finder and Silent Boom (memory: `uw-stream-lease-death`). Dropping a flush batch is by design; the gap is that nothing proves the drop is *reported*.
- Test needed: `execute` raising on chunk 2 of 3 → assert chunk 1 not committed and `capture_exception` called once; `_safe_flush` raising → `assert sentry_sdk.capture_exception.called` and rows-dropped metric.

### FM-30: `alerts.ts` — `writeAlertIfNew` INSERT and `isOnCooldown` throwing are never tested  [P2] [confidence: medium] [effort: S]
- Where: `api/_lib/alerts.ts:124-160` (write path; `logger.warn` at L153 for the cooldown branch); test `alerts-lib.test.ts` covers Twilio/SMS (a) at L199-282 only
- Test needed: `sql` reject inside `writeAlertIfNew` → assert it rejects (or returns false **and** captures) — establish which contract callers rely on.

### FM-31: schwab.ts `acquireLock` exhaustion proceeds unlocked with `logger.error` only  [P2] [confidence: high] [effort: S] [code-defect]
- Where: `api/_lib/schwab.ts:147-160` (retry exhaustion → `logger.error` → `return true`); test `schwab.test.ts:332-375` asserts only the token
- Failure scenario: Redis lock unavailable → two Fluid instances refresh concurrently → Schwab invalidates one refresh token → the other instance's stored token is now dead (the FM-06 class again).
- Test needed: `redis.set(NX)` failing 3× → assert `captureException` called and a `metrics` counter; decide whether proceeding unlocked is acceptable.

### FM-32: ml/trigger-analyze — fire-and-forget never inspects `res.ok`; a 401/500 from analyze-plots is `202 Analysis started`  [P3] [confidence: high] [effort: S] [code-defect]
- Where: `api/ml/trigger-analyze.ts:41-46`; test `api/__tests__/ml/trigger-analyze.test.ts:153` (reject → `logger.error`, no non-2xx test). Test needed: `fetch → {ok:false,status:401}` → assert `logger.error` + `captureMessage`.

### FM-33: push — all-devices-failed notify is 200 with no Sentry; subscribe/unsubscribe have no DB-reject test  [P3] [confidence: high] [effort: S]
- Where: `api/_lib/push.ts:138-151` (non-410/404 → warn + `failed++`), `api/push/notify.ts:65-70`; tests `push-endpoints.test.ts` no `getDb` reject for subscribe/unsubscribe. Test needed: all sends reject → assert `captureMessage`; subscribe `getDb` reject → 500 + Sentry.

### FM-34: snapshot.ts — deliberate `200 {saved:false}` on write failure is captured to Sentry, but the test asserts only the 200  [P3] [confidence: high] [effort: S]
- Where: `api/snapshot.ts:51-57` (Sentry + `logger.error` + `done(200)` + 200 — surfaced, by design); test `snapshot.test.ts:130`. Test needed: add `expect(captureException).toHaveBeenCalled()` so the deliberate swallow can't lose its Sentry line.

### FM-35: history / chain have no 500 test; history's Redis failures untested; 9 feed endpoints hand-roll `Sentry+500` without the transient 503 split  [P3] [confidence: high] [effort: M]
- Where: `api/history.ts:274` (empty catch on Redis read), `:335` (`logger.error` only), `:347-351`; `api/chain.ts:260-264`; `api/intraday.ts:196-200`, `api/quotes.ts:130-134`, `api/yesterday.ts:167-171` (bare `captureException` + 500, no `logger.error`); of 15 feed endpoints only `api/zero-gamma.ts:86` uses `withDbReader` (CLAUDE.md convention); tests `history.test.ts`, `chain.test.ts` have zero `mockRejected` and zero 5xx assertions. Test needed: `getDb` reject → 500 + Sentry for each; migrate readers to `withDbReader` so `request-scope.test.ts` covers the split.

### FM-36: journal/backfill-features leaks `err.message` to the client and the test locks it in  [P3] [confidence: high] [effort: S] [code-defect]
- Where: `api/journal/backfill-features.ts:59-61`; test `backfill-features.test.ts:100-107`. Test needed: assert body is `{error:'Internal error'}` and `captureException` called; `headersSent` branch untested.

### FM-37: curate-lessons — systematically malformed Claude output → 200 with `errors[]`, no Sentry  [P3] [confidence: high] [effort: S] [code-defect]
- Where: `api/cron/curate-lessons.ts:316-326` (`errors.push('Malformed Claude response')`), `:623-637` (`logger.error` printf-string, no `{ err }`, returns null); tests `curate-lessons.test.ts:499-584` assert 200 + errors. Test needed: all reviews malformed → assert `captureMessage` and `status:'partial'`.

### FM-38: LLM/embedding helpers swallow to `null`/`[]` with `logger.error` only (no Sentry) — day-embeddings, periscope-retrieval, periscope-extract parse  [P3] [confidence: high] [effort: S] [code-defect]
- Where: `api/_lib/day-embeddings.ts:85-89`, `:142-146`; `api/_lib/periscope-retrieval.ts:112-115` (pgvector failure never reaches Sentry); `api/_lib/periscope-extract.ts:455-463` (JSON parse → null); tests assert `null`/`[]` only (FM-28). Test needed: DB reject → assert `captureException` in each.

### FM-39: `db-flow-alerts.ts` / `periscope-flow-context.ts` — a DB error is folded into the `NO_ALERTS` sentinel with no Sentry, the test enshrines it, and the module has no production caller  [P3] [confidence: high] [effort: S] [possibly-dead]
- Where: `api/_lib/db-flow-alerts.ts:157-159`, `:233-236` (`logger.error` → `[]`, no Sentry; no test file); `api/_lib/periscope-flow-context.ts:140-181`; test `periscope-flow-context.test.ts:251-264` ("returns the NO_ALERTS sentinel on DB error rather than throwing"). Repo-wide grep: `buildFlowContextBlock` / `fetchRecentFlowAlerts` are referenced only by a comment in `periscope-prompts.ts:66`; `flowBlock` is never populated. The fold is the documented 2026-05-16 hallucination fix, so it is design — but if this is ever wired in, a Neon blip tells Claude "no flow" as fact with no Sentry. Either wire it or delete it; if wired, add `captureException` and assert it.

### FM-40: sidecar — Databento `_on_error` / `_handle_system` are `log.error` only; three `except Exception: pass`  [P3] [confidence: medium] [effort: S] [code-defect]
- Where: `sidecar/src/databento_client.py:452-455`, `:795-803` (no `capture_exception`; test asserts a flag only); `sidecar/src/main.py:239-240`, `quote_processor.py:143-144`, `theta_launcher.py:234-235`. `batched_writer.py:217-238` (capture + bounded re-queue) and `db.py:239-283` (OperationalError retry) are tested (`test_batched_writer.py:377-432`, `test_db.py:329-380`) — good. Test needed: `_on_error` → assert `sentry_sdk.capture_exception` called.

### FM-41: backfill-gamma-setup-outcomes — stale comment claims "we swallow per-fire errors … Sentry sees the exception"; there is no catch  [P3] [confidence: high] [effort: S] [code-defect: stale comment]
- Where: `api/cron/backfill-gamma-setup-outcomes.ts:146-148` vs. zero `catch`/`captureException` in the file — a rejection on fire *k* aborts *k+1..n* with no partial-progress record; no (a)/(c) test. Fix the comment or implement it; add an UPDATE-reject test either way.

## Already good — test files that cover failure modes well (use as templates)

- **`api/__tests__/request-scope.test.ts`** — `withDbReader` / `sendDbErrorResponse`: transient Neon → `logger.warn` + metric + **503** + `Retry-After` + `done(503)`, no Sentry; genuine → `captureException` + `logger.error` + 500. The reference for the 503/500 split; readers that adopt `withDbReader` inherit it.
- **`api/__tests__/fetch-vol-surface.test.ts:472-521`** — all-legs-fail → 500 + `status:'error'` + `captureException` ×3; one-leg-fail → `partial`. (Its txn-reject test L545-570 codifies FM-07, so copy the *upstream* block, not the store block.)
- **`api/__tests__/fetch-greek-flow-etf.test.ts:563-622`** — store-swallowed total loss → `logger.error` + `captureException` asserted with the error; the handler (`fetch-greek-flow-etf.ts:294-305`) is the fix template for FM-01.
- **`api/__tests__/cron-wave2-confirmation.test.ts:334-385`** and **`enrich-vega-spike-returns.test.ts:277-442`** — per-table / per-row catch → `captureException` with tags → `'partial'`/`'error'` derived from counts; the reference shape for FM-12/FM-19/FM-20.
- **`api/__tests__/detect-silent-boom.test.ts:1410-1640`** — macro reject asserts `captureException` and the "land the alerts, but page" contract; **`detect-lottery-fires.ts:259-286`** (code) — the `captureMessage('empty-window')` gate on `isPastCashOpen(2)` is the template for FM-13.
- **`api/__tests__/periscope-blob.test.ts:107-137`** — Blob write reject → asserts `captureException` called with the error **and** the context object. Best-in-class (c).
- **`api/__tests__/api-helpers.test.ts:240-372, 459-626`** (IN-FLIGHT) — `schwabFetch` 401 / non-ok / `AbortSignal` timeout-then-success / all-attempts-timeout → 504 `ApiResult`; `withRetry` retry taxonomy (`UW API 502/503/504` yes, bare `502` no, non-Error no, 429 backoff tiers). Missing only the `res.json()` case (FM-15).
- **`api/__tests__/fetch-gex-strike-expiry-etfs.test.ts:320-414`** — one-ticker 500 → `partial` + `captureException` ×1; all tickers → `'error'` ×3 (upstream half only — its store half codifies FM-07).
- **`api/__tests__/multileg-client.test.ts:288-393, 1338-1395`** and **`takeit-bundle-loader.test.ts:125-141, 463-590`** — non-2xx, schema/length rejection, zod failure surfaced.
- **`api/__tests__/db-retry.test.ts`, `safe-db.test.ts`, `transient-db-response.test.ts`** — `withDbRetry`/`safeDb`/`TransientDbError` classification.
- **Python:** `uw-stream/tests/test_db_bulk.py:485-582` (asyncpg retry: transient ×3 then re-raise; non-transient re-raise), `test_ws_lease.py:293-583` + `test_main.py:142-355` (lease-renewal failure → graceful exit); `sidecar/tests/test_batched_writer.py:377-432` (write raises → capture + bounded re-queue), `test_db.py:329-380` (OperationalError retry).

## Rule tweaks — how to reword R4 so it does not misfire

1. **Scope it to I/O.** "Applies to any module that imports `getDb`, `uwFetch`/`schwabFetch`/global `fetch`, `redis`, `@vercel/blob`, `openai`, or `@anthropic-ai/sdk`, or that is a cron/endpoint handler. Pure utilities (`src/utils/*`, `api/_lib/*-score*`, formatters, parsers with no I/O) are exempt — their failure mode is a thrown/returned value, covered by ordinary input/output table tests." Otherwise R4 flags ~100 pure modules and the signal drowns.
2. **Define "surfaced" so the vacuous cases fail.** "A test *asserts surfacing* only if it asserts at least one of: `rejects.toThrow`; `res.status` ∈ 5xx (via a `mockResponse` whose default status is **not** 200 — see FM-27); body `status` ∈ {`'error'`, `'partial'`} **together with** `captureException`/`captureMessage` called; or `logger.error` called with `expect.objectContaining({ err })`. `expect(res._status).toBe(200)` after a rejection never counts." Ten cron tests in this repo currently 'cover' (c) by asserting the swallow.
3. **Split (c) by who owns the write.** "(c) applies to the module that issues the write. A reader endpoint wrapped in `withDbReader` inherits (c) from `request-scope.test.ts` provided its own test asserts the wrapper is used (one `getDb` reject → 503-or-500 test). Hand-rolled readers owe their own (c) test." This stops R4 double-charging 15 feed endpoints while still catching `chain.ts`/`history.ts`.
4. **Add (d) empty-during-market-hours and (e) non-JSON 2xx.** "(d) For any cron gated on market hours: an upstream `[]` during RTH must produce a `captureMessage`/`logger.warn` or an explicit `skipped` *reason* — assert it. (e) For any fetch wrapper: `res.json()` rejecting on a 2xx must resolve to the wrapper's error contract, not escape as `SyntaxError`." Both are the dominant *real* failure signature here (frozen UW cache, HTML maintenance pages) and neither is in R4 today.
5. **Name the codifying anti-pattern.** "A test that triggers the failure and then asserts the swallowed outcome (`200`, `success:true`, `stored:0`, `null`, `[]`) is a *violation*, not coverage — it locks the defect in. Reviewers should require the assertion to be on the surfacing side or on a documented `metrics`/`captureException` call for deliberate soft-degrades (e.g. `snapshot.ts`)."
6. **Mock hygiene clause.** "Tests asserting `captureException` must `vi.mock('../_lib/sentry.js')` (not rely on the real module) and `mockReset()` in `beforeEach`; a test file with zero `captureException` assertions but a mocked Sentry is a smell (`fetch-greek-exposure.test.ts`)."
7. **Python parity.** "For `uw-stream/` and `sidecar/`: the handler flush path and the DB retry path each need one test asserting `sentry_sdk.capture_exception` (or `log.error` with `exc_info`) on a raised write, and one partial-batch test."
