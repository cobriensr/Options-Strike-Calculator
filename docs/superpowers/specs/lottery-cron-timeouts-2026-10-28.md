---
status: Plan
date: 2026-10-28
---

# Lottery fire detector: stop the timeouts, recover the lost fires

## Goal

Stop `detect-lottery-fires` from timing out (it drops fires and blanks Take-It), then recover the fires and Take-It scores the timeouts lost. Owner rules that apply: fix now, and always backfill and correct where a source exists (2026-10-28).

## What we know (investigation 2026-10-28, verified in Sentry and Neon)

- Since **2026-10-16** the cron times out on 19–35% of runs (Sentry: 356 runs in 24 h, p50 44.6 s, p90 60.0 s; timeouts per day ≤37 before 10-16, then 135, 105, 205, 139). No deploy explains the onset.
- **Fires are lost.** A replay of the unmodified detector over the saved tape:

  | Day   | Timeouts | Replay fires | Missing    |
  | ----- | -------- | ------------ | ---------- |
  | 10-26 | 30       | 3,722        | 254 (6.8%) |
  | 10-27 | 116      | 5,026        | 344 (6.8%) |
  | 10-28 | 139      | 6,334        | 525 (8.3%) |

  Missing fires sit in the timed-out hours; the method's noise floor is 0.5%. The 7-minute window does not reliably re-detect a missed fire: `cumVol` and `spotAtFirst` are relative to the window start, so a later run finds the trigger at a later tick with different features, or not at all. Drifted near-duplicates reached 9.7% of fires on 10-16.

- **Take-It goes blank.** When the setup prefetch times out, every fire in the run is stored with `takeit_prob` NULL and the run still reports `success`: 47–69% of fires on bad days, ~16K rows since 10-16, 0% before.
- **Where the time goes.** The setup phase, not the per-fire work:
  - win-rate prefetch (`fetchPriorSessionWinRateByTicker`): a 1.5 GB parallel seq scan every minute (4.9 s idle) whose answer only changes daily; 446 of 742 `db attempt timeout` errors in 7 d;
  - `fetchRecentSameType`: no date bound, walks the whole `(date, trigger_time_ct)` index (4.8 s idle); 267 errors; the same query runs in `detect-silent-boom.ts`;
  - tick scan: 3 hash batches each read the full 7-min window (~99K rows), 2.75 s per batch;
  - `fetchTickerFlowSeries` and the tick scan have no try/catch, so one timeout fails the whole run.
  - `withDbRetry` races a timer but does not cancel the query, so each retry adds a concurrent copy on Neon.
  - Runs can keep executing past the 60 s response (seen finishing at t+83 s), so runs already overlap.
- **Neon load leads (cause of the 10-16 onset not proven):** `lottery_finder_fires` has 195K dead tuples and was last autovacuumed 10-14; `/api/greek-heatmap` (polled every 30 s) filters `date(ts)` on `ws_net_flow_per_ticker`, a non-sargable scan of ~2.5M blocks taking 49.5 s per call (`api/_lib/db-greek-heatmap.ts:347`).

Raw data: `docs/tmp/lottery-tapes/` (gitignored): tapes for 10-26 and 10-28 (10-27 being exported before Neon prunes it ~04:05 UTC 10-30), replay results, `replay-day.ts`.

## Phases

### A. Stop the setup timeouts (tonight; small)

Files: `api/cron/detect-lottery-fires.ts`, `api/cron/detect-silent-boom.ts`, their tests, and the shared query module if the win-rate/recent-fires queries live there.

- Win-rate prefetch: compute once per ET trading day (bounded one-entry module cache keyed on the ET date — R1: one entry, replaced on date change) instead of every minute.
- `fetchRecentSameType`: add `date >= <today ET> - 1 day` (or the window it actually needs) in both crons; confirm with EXPLAIN that it uses the index range.
- Take-It prefetch: best-effort, one attempt with a short deadline (~5 s); on failure keep going and report the run `partial` with a counter in Axiom `meta`, plus one Sentry warning per run.
- `fetchTickerFlowSeries` failure: non-fatal per ticker (that ticker's fires skip the flow features, counted and reported), not a whole-run failure.
- `maxDuration` stays 60 s.
- Tests (R4): each degraded path asserts its surfacing by name; the win-rate cache refreshes on a new ET date.

### B. Make the run cheap (spec'd here, built after A; medium)

- Tick scan in time slices, each row read once.
- Pass 1 flow series in one query (`ticker = ANY`).
- Prefetch per run: `flow_data`, `spot_exposures`, `strike_exposures`, `gexbot_snapshots` → in-memory lookups.
- Insert fires first, one multi-row `unnest` `INSERT … ON CONFLICT DO NOTHING` (R5), then enrich.
- Property-test new lookups against the old per-fire queries on the saved tapes.

### C. Classifier off the insert path (medium)

Take-It does not read multileg today (the cron's `takeitRow` never sets those fields). Move classification to a fill pass/cron. Coordinate with the 2026-10-28 classifier replacement spec (exchange multi-leg flag); if that lands first, C reduces to removing the call.

### D. Overlap guard (small)

Single-run Redis lease (`SET NX PX`, holder-fenced release, skip if held; existing `nx/ex` claim pattern in schwab-reauth-reminder). Only with the lease consider `maxDuration` 120 s. Setup-phase timings into Axiom `meta`.

### E. Recover lost fires and Take-It (after B; owner rule "always backfill")

- Build the replay from the live code path (B makes it callable as a library). Existing replay scripts are stale (no V2 score, cluster bonus, cum_ncp/npp, takeit, multileg, gex, direction_gated).
- Seed cooldown from live in-universe rows plus the replay's own fires (the 05-04/05-20 corruption came from a missing seed).
- Insert only fires with no live fire on the same chain within ±5 min; mark them recovered.
- Days: 10-26/10-27/10-28 from the saved tapes (`docs/tmp/lottery-tapes/`, all three exported 2026-10-28); 10-16 → 10-23 from the UW Full Tape, which still serves them (probe 2026-10-28: 10-16 → 302 to a 2.35 GB zip; memory says back to 2025-12-10). The "last 3 trading days" comment in `scripts/download-fulltape.sh` is stale — fix it with this phase.
- Then outcomes for recovered rows (full-tape outcome path for days past retention) and the Take-It backfill for the ~16K NULL rows (`scripts/backfill-takeit-scores.mjs`, checked against the current bundle first).
- Re-score pass (review 2026-10-29, N4): after Phase A, a ticker-day whose flow series failed or was skipped by the breaker keeps `cum_ncp_at_fire` / `cum_npp_at_fire` and the V2 `score` NULL for good (the score is frozen at detect time; the feed sorts `score NULLS LAST`). Axiom `meta` (`flowSeriesFailures`, `flowSeriesSkippedBreaker`) identifies those runs; recompute flow features and score for them from `flow_data`/the tape.
- The same recovery applies to the 2026-07-23 → 2026-09-07 gap (no lottery or silent-boom fires at all) if the owner confirms it was not intentional; the UW Full Tape reaches back to 2025-12-10.

### F. Neon load (after A; small–medium)

- `/api/greek-heatmap`: make the `ws_net_flow_per_ticker` filter sargable (`ts >= $start AND ts < $end` instead of `date(ts)`), verify with EXPLAIN.
- `lottery_finder_fires` autovacuum: check settings, consider a table-level autovacuum scale factor; ~8 updates per insert is the bloat source.

## Data dependencies

Prod Neon (read for diagnosis; writes only via the cron and recovery scripts). UW Full Tape for older days. No new tables in A; E may add a `recovered` marker column (migration) — decide in E.

## Open questions (defaults)

- Recovery tagging: a boolean `recovered_at` column vs a `source` text column. Default: `recovered_at timestamptz NULL`.
- Drifted near-duplicates already in the table (what the owner saw live): leave them. Default: leave, but exclude from ML training if they skew counts.
- Classifier: C vs waiting for the replacement spec. Default: follow the replacement spec if it ships this week.
- The 10-16 trigger: not proven; F's fixes plus autovacuum check first.

## Thresholds / constants

- Win-rate cache: one entry, keyed on ET date.
- Recent-fires bound: today ET minus 1 day (confirm against what the score needs).
- Take-It prefetch: 1 attempt, ~5 s deadline.
- `maxDuration` 60 s until D's lease exists.
