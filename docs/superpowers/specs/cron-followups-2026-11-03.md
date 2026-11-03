---
status: Done
date: 2026-11-03
---

# Cron follow-ups: a batch of queued cron bugs (2026-11-03)

## Goal

Close eleven queued cron findings in one worktree (`fix/2026-11-03-cron-batch`, off `origin/main` `6b4b75de`): stop two crons from clobbering or mis-gating data, make failed writes report as failures (R4), plug two missing Axiom error events, fix a DST-sensitive fallback, and evaluate late-day wave-2 fires. Owner approved the whole batch on 2026-11-03. Nothing is pushed; the owner reviews and pushes.

Every claim below was re-checked against current code on `origin/main` before it was written down. None of the eleven was already fixed upstream.

## Items

### 1. auto-prefill-premarket overwrites hand-saved data

- **Where:** `api/cron/auto-prefill-premarket.ts:156-165`. The UPDATE has no guard, and in EDT the schedule `30 13,14 * * 1-5` runs it again at 14:30 UTC (10:30 ET), after the owner may have saved by hand.
- **Discriminator check (done first):** the manual path is `POST /api/pre-market` (`api/pre-market.ts:90-96`), which builds its JSON from named fields only (`globexHigh`, `globexLow`, `globexClose`, `globexVwap`, `savedAt`). `preMarketBodySchema` (`api/_lib/validation/snapshot.ts:87`) is a plain `z.object`, which strips unknown keys, so a client cannot send `autoFilled` either. The UPDATE replaces the whole JSON, so a manual save also erases a prior `autoFilled: true`. The frontend reads `autoFilled === true` (`src/components/PreMarketInput.tsx:81`) to show the "Auto-filled" badge. So `autoFilled: true` is set only by the cron, and `pre_market_data->>'autoFilled' = 'true'` is a sound discriminator.
- **Fix:** the UPDATE becomes `... WHERE id = $id AND (pre_market_data IS NULL OR pre_market_data->>'autoFilled' = 'true') RETURNING id`; zero rows returned means a hand-saved row, and the run reports `skipped` with reason `manual_pre_market_data`. `->>` compared to the text `'true'` is used instead of the suggested `::boolean` cast so a malformed value can never throw.
- **One addition beyond the suggested guard:** `market_snapshots` can hold several rows for a date, and the cron picks "latest row". If the owner saved by hand on an older row and an analysis snapshot later created a newer row with a NULL `pre_market_data`, the guard alone would pass on the newer row, write auto data there, and `GET /api/pre-market` (latest row with a non-null `pre_market_data`) would then return the auto data and hide the hand-saved values. So the target row is chosen the way the reader chooses it: `ORDER BY (pre_market_data IS NOT NULL) DESC, created_at DESC LIMIT 1`.
- **Tests:** `auto-prefill-premarket.test.ts` (mocked SQL: the sequence is now bars, target row, UPDATE ... RETURNING; empty RETURNING gives `skipped`), plus a pglite test that runs the real statements against a `market_snapshots` table: manual row untouched, auto row refreshed, NULL row filled, missing row inserted, and the older-manual-plus-newer-empty case left alone.

### 2. auto-prefill-premarket has no holiday gate

- **Where:** `api/cron/auto-prefill-premarket.ts:44-47`. `isAfterCashOpen` checks only `>= 9:30 ET`; it ignores weekends (the schedule covers those) and market holidays.
- **Fix:** drop the local predicate and gate with the shared `isPastCashOpen` (`api/_lib/cron-helpers.ts:77`), which reads the market calendar (`getMarketCloseHourET` from `src/data/marketHours.js`) and so skips holidays and gates at the cash open. Its extra upper bound (the day's close) cannot bite: the cron's slots are 13:30 and 14:30 UTC.
- **Tests:** a new `auto-prefill-premarket-gate.test.ts` runs the REAL `cronGuard` under fake time: Thanksgiving (2026-11-26) at the 14:30 UTC slot skips with no DB call; the CST 13:30 UTC slot (08:30 ET) skips; the CST 14:30 UTC slot and the EDT 13:30 UTC slot run. The old file's mocked `getETTime` was only feeding the removed predicate (the guard is mocked there), so it goes too.

### 3. Schwab error bodies leak (shared redaction)

- **Where:** `api/_lib/schwab-fetch.ts:151` builds `error: "[code] Schwab API error (status): ${body}"` from the raw response body. Every caller embeds `result.error` in logs, thrown Errors, Sentry `extra` or Axiom metadata. Only `compute-cone.ts:201` and `fetch-strike-iv.ts:355` redact today; `fetch-market-internals.ts:148` and `:311` do not (thrown Error and metadata).
- **Fix:** redact the BODY (not the whole string) in the helper with `redactUpstreamBody`, so every Schwab caller is covered and the `[code] Schwab API error (status):` prefix stays readable. Then remove the call-site `redactUpstreamBody` in `compute-cone.ts` and `fetch-strike-iv.ts`: a second pass would measure the already-capped string and report the capped length instead of the original ("... (212 chars)" instead of "... (4,031 chars)"). `fetch-market-internals.ts` needs no source change once the helper redacts, because both sites embed `result.error`; it gets an end-to-end test instead.
- **Tests:** `api-helpers.test.ts` (the shared helper masks a 24+ character token and appends the original length once); `cron-compute-cone.test.ts` and `cron-fetch-strike-iv.test.ts` (rewritten: they mock `schwabFetch`, so they now feed an already-redacted error and assert it reaches Sentry, the log line and the response unchanged, not re-capped); a new `fetch-market-internals-redaction.test.ts` drives the real `schwabFetch` with a stubbed `fetch` and asserts the thrown Error text and the response metadata carry no token.

### 4. R4: a failed write reports success

- **Where:** `fetch-etf-tide.ts:126-130`, `fetch-net-flow.ts:165-169`, `fetch-gex-strike-expiry-etfs.ts:384-389`. Each `storeAllCandles`/`storeStrikes` catches the DB error, captures it and returns `stored: 0`, so the per-ticker legs count as healthy and `deriveCronStatus(0, n)` gives `success`.
- **Fix:** let the write error propagate to the existing per-leg catch (etf-tide, net-flow) or to the `Promise.allSettled` loop (gex), where it already increments `failureCount`, captures to Sentry and logs. The inner capture goes (one capture per failure, not two). Lock-conflict retry in the gex store stays. In gex, `processTicker`'s `withRetry` now also re-runs a write error whose message looks transient (timeout, fetch failed, ...), up to 3 times; the UPSERT is idempotent and only the final failure is captured. Status follows the crons' existing rules: one failed leg is `partial`, all failed is `error`.
- **Tests (R4):** DB rejects for one ticker gives `partial`, for all gives `error`, each asserting the capture; the two gex tests that pinned `status: 'success'` after a failed batch insert are corrected.

### 5. Missing Axiom error events

- **Where:** `fetch-futures-snapshot.ts` (the "All symbols failed" 500 at :167 and the catch at :220) and `fetch-vol-surface.ts` (the catch at :325) respond 500 and capture to Sentry but never call `reportCronRun`.
- **Fix:** send `reportCronRun(job, { status: 'error', message, error, durationMs })` in each, the shape `withCronInstrumentation` uses for its own failures (`cron-instrumentation.ts:850`). Only allowlisted names go top-level; non-primitives (the `errors` array) fall into `meta`, so no new column is created.
- **Tests:** assert `reportCronRun` is called with `status: 'error'` for each path (futures-snapshot: both; vol-surface: the catch). `fetch-vol-surface.test.ts` gains the `axiom.js` mock it lacked.

### 6. Hardcoded `T21:00Z` in fetch-gex-strike-expiry-etfs

- **Where:** `fetch-gex-strike-expiry-etfs.ts:234`: `fallbackTsMinute = new Date(`${expiry}T21:00:00Z`)`. It is the `ts_minute` given to a row whose UW `time` does not parse. 21:00Z is the 4:00 PM ET close only in EST; in EDT the close is 20:00Z, so the fallback lands an hour after the close.
- **Fix:** `getETCloseUtcIso(expiry)` from `src/utils/timezone.js` (already `.js`-safe, DST-aware, returns null only for a malformed date, which then throws loudly as `auto-prefill` does).
- **Tests:** a row with an unparseable `time` in an EDT session (expiry 2026-05-06, expect `...T20:00:00.000Z`) and an EST session (expiry 2026-01-14, expect `...T21:00:00.000Z`).

### 7. wave2-confirmation never fizzles late-day fires

- **Confirmed by code AND data.** The cron runs `isMarketHours()` (09:25 ET to close + 5 min = 16:05 ET), a fire becomes eligible to fizzle at age 60 min, and `LOOKBACK_MIN = 70` drops it from the candidate query soon after. A fire after about 15:05 ET therefore hits 16:05 ET before age 60, and the next morning it is far outside the 70-minute lookback. It is never evaluated unless a follow-up exists (which is labelled in-day). Read-only check on prod Neon, `lottery_finder_fires`, fires since 2026-10-01 older than a day: 1,400 of 124,217 have `wave2_status IS NULL`; all of them fired between 15:06 and 16:05 ET (hour 15: 1,224 of 19,048 NULL; hour 16: 176 of 368), and none before 15:00 ET. So late-day "fizzled" fires sit at NULL, which biases the fizzle rate.
- **Fix (same as `evaluate-round-trip`, fixed 2026-10-02):** gate with `isMarketHours(POST_CLOSE_EVAL_MIN)` where `POST_CLOSE_EVAL_MIN = 75`. The detectors' last alert fires by close + 5:59; it reaches age 60 at close + 65:59, so the close + 70 tick is the first to see it and the close + 75 tick is one retry (age 69:01, still inside the 70-minute lookback). Per-tick load is unchanged because the lookback is unchanged. `vercel.json` and `SCHEDULE_MAP` go from `*/5 13-21` to `*/5 13-22` so the close + 70 and + 75 ticks exist in EST (17:10 and 17:15 ET are 22:10 and 22:15 UTC); in EDT they are 21:10 and 21:15 and already served.
- **Rejected alternative:** a lookback that spans the overnight. The first 09:25 ET tick would then walk the whole prior late-day backlog (about 450 candidates on a Friday evening, two sequential queries each) inside the 60-second function budget (R5).
- **Tests:** at 17:10 ET the handler runs and fizzles a 16:05 ET fire; at 17:20 ET it skips; the same in EST with 22:15 / 22:20 UTC; a half-day (close 13:00 ET) ends at 14:15 ET; `cron-schedules.test.ts` gains the post-close tick check for wave2 in both regimes.
- **Not done here:** backfilling the historical NULL late-day rows. That is a production write; see Open questions. Dry-run counts (read-only SELECT on prod Neon, rows older than 2 days, since 2026-05-18, late means fired at or after 15:05 ET; the verdict is what the cron's own rules would assign): lottery 5,963 late-day NULL rows (4,805 fizzled, 1,152 confirmed, 6 lagging), silent boom 1,915 (1,771 fizzled, 125 confirmed, 19 lagging). The early-day NULLs in the same range (lottery 13,392 rows on 4 days between 2026-05-18 and 2026-06-10, silent boom 817) have another cause (cron gaps in that period) and are not part of this fix.

### 8. fetch-futures-session-stats in CST

- **What it reads:** UW `/futures/{contract}/stats` (no date parameter) for the front two contracts of six roots: `settlement`, `settlement_date`, `session_volume` and `open_interest`. `fetched_at` records the run that last CHANGED a row.
- **Evidence from prod (read-only):** the endpoint's `settlement_date` is still the PRIOR session at 21:30 UTC in both regimes: the Mon 2026-11-02 21:30 UTC run (15:30 CST) and the Fri 2026-10-30 21:30 UTC run (16:30 CDT) both rewrote rows of the previous session (10-30 and 10-29), and the first run ever, Thu 10-29 22:39 UTC (17:39 CDT), still returned 10-28. The date rolls overnight and the 12:30 UTC run is what first records a session. What the 21:30 UTC run adds is the open-interest revision that lands during the next business day: the 12:30 UTC run on 2026-11-03 wrote 12 new rows (11-02 session) and UW's current ESZ6 open interest (1,963,799 at 21:11 UTC) already differs from the stored 12:30 value (1,966,499).
- **Verdict: no change.** The 21:30 UTC slot is not too early in CST.
  - The evening run never captures the same-day session in either regime, because `settlement_date` rolls overnight. So the one-hour DST shift cannot make it miss a settlement; what the run adds is the previous session's open-interest revision.
  - Two CST data points. Mon 2026-11-02 21:30 UTC (15:30 CST): the Vercel log reads `rows: 12, unchanged: 0`, so that run inserted or changed all 12 rows of the 10-30 session. Tue 2026-11-03 21:30:26 UTC (15:30 CST): ESZ6, CLZ6, CLF7 and NQZ6 now carry the revised open interest (ESZ6 1,966,499 at 12:30 UTC, 1,963,799 after the run).
  - Sampling UW's stats endpoint every 2 to 10 minutes from 21:11 to 22:36 UTC (15:11 to 16:36 CT) showed open interest and settlement date constant (ESZ6 1,963,799, CLZ6 236,239). The revision had landed at least 19 minutes before the CST run, and nothing changed after it.
  - Not established: the minute the revision lands between 12:30 and 21:11 UTC, so the CST margin is at least 19 minutes on one day. If a later check finds stored open interest that differs from what UW serves hours afterwards, move the slot; the DST-safe form is `30 21,22 * * 1-5` with a 16:30 CT window gate, as compute-cone does. No schedule, gate or `NAMED_GATES` change is made.

### 9. capture-opening-flow-signal comment

- **Where:** `api/cron/capture-opening-flow-signal.ts:142-145`, the comment on the guard options. It says that in CST 14:50 UTC "is 08:50 CT (BEFORE 09:30 CT open)". The cash open is 08:30 CT (09:30 ET), not 09:30 CT, so 08:50 CT is 20 minutes AFTER the open, and the default `isMarketHours()` window (09:25 ET on) admits 14:50 UTC in both regimes. The header comment (lines 9-16) and the `SCHEDULE_MAP` entry have correct CT/ET clock times and are left alone.
- **Fix:** comment only, no behavior change, no test.

### 10. refresh-tracker-contracts: REST vs websocket (report only)

Findings and the recommendation are in the final report. Summary: the two UW REST reads (`stock-state` for spot, `option-contracts` for per-contract last/bid/ask/volume/OI) have matching channels (`price`, `contract_screener`), but the tracker holds one active contract (8 rows ever, per prod Neon), so a uw-stream migration is not worth its cost today. Nothing is migrated.

### 11. Nits

- `curate-periscope-lessons.ts` `RunReport.ok` JSDoc: say "False on an error run".
- `fetch-strike-iv.ts` `TickerResult.code`: type it `SchwabErrorCode` (re-exported through `api-helpers`).
- `db.test.ts:980`: rename "passes on the real MIGRATIONS array (ids 1..189, no dups)" so it no longer hard-codes an id range (highest id is 200).

## Commit grouping (at most 5 files each; `npm run review` on each commit's final content)

| #   | Commit                                                                                   | Items    | Files                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `docs(spec): Plan the 2026-11-03 cron follow-up batch`                                   | plan     | this doc                                                                                                                                          |
| 1   | `fix(auto-prefill): Protect hand-saved pre-market data and skip holidays`                | 1, 2     | cron, `auto-prefill-premarket.test.ts`, new pglite test, new gate test                                                                            |
| 2   | `fix(schwab): Redact upstream error bodies in the shared fetch helper`                   | 3        | `schwab-fetch.ts`, `api-helpers.test.ts`, new `fetch-market-internals-redaction.test.ts`                                                          |
| 3   | `refactor(cron): Drop call-site Schwab body redaction`                                   | 3, 11    | `compute-cone.ts`, `fetch-strike-iv.ts` (+ `code` type), their two tests                                                                          |
| 4   | `fix(cron): Report a rejected flow write as a failed run`                                | 4        | `fetch-etf-tide.ts`, `fetch-net-flow.ts`, their two tests                                                                                         |
| 5   | `fix(gex-etf): Fail the run on a rejected write and anchor the fallback to the ET close` | 4, 6     | `fetch-gex-strike-expiry-etfs.ts`, its test                                                                                                       |
| 6   | `fix(cron): Send an Axiom error event from futures-snapshot and vol-surface`             | 5        | the two crons, their two tests                                                                                                                    |
| 7   | `fix(wave2): Evaluate late-day fires after the close`                                    | 7        | `wave2-confirmation.ts`, `vercel.json`, `cron-schedules.ts`, `cron-wave2-confirmation.test.ts`, `cron-schedules.test.ts`                          |
| 8   | `fix(cron): Apply review notes to the R4 and redaction commits`                          | review   | `auto-prefill-premarket.ts`, `fetch-gex-strike-expiry-etfs.ts` and its test, `fetch-net-flow.test.ts`, `fetch-market-internals-redaction.test.ts` |
| 9   | `docs(cron): Fix a comment and two stale labels, record the outcome`                     | 8, 9, 11 | `capture-opening-flow-signal.ts`, `curate-periscope-lessons.ts`, `db.test.ts`, this doc (item 8 needed no change)                                 |

## Data dependencies

No new tables, migrations or env vars. Item 7 changes one `vercel.json` cron schedule (and its `SCHEDULE_MAP` mirror). Item 8 changed nothing.

## Open questions

1. **Item 7 backfill (needs the owner).** Historical late-day `wave2_status IS NULL` rows (about 1,400 lottery rows since 2026-10-01, more before) stay NULL after this fix, which only covers new fires. Backfilling them is a production write, and the Neon connection available here is read-only. Proposed: a one-off set-based UPDATE to `fizzled` where no same-ticker, same-type follow-up exists within 60 minutes, `confirmed` or `lagging` with `wave2_detected_at` where one does. A dry-run SELECT count by verdict is in the final report.
2. **Item 8**: resolved, no schedule change (see its verdict). Re-check only if open-interest rows are ever seen to differ from what UW serves later in the day.
3. **Item 10** whether to migrate: recommendation in the final report (default: no).

## Thresholds and constants

- `POST_CLOSE_EVAL_MIN = 75` (wave2): close + 5:59 (last fire) + 60 (fizzle age) puts the first evaluable tick at close + 70; + 75 is the one retry inside the 70-minute lookback.
- `LOOKBACK_MIN = 70`, `GRACE_SECONDS = 60`, `CONFIRMED_WINDOW_MIN = 30`, `LAGGING_WINDOW_MIN = 60` (wave2): unchanged.
