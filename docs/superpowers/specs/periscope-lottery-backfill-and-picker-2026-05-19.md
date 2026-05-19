# Periscope Lottery — Historical Backfill + Date Picker (Phases 6–7)

**Status**: in progress
**Created**: 2026-05-19
**Spec for**: Phases 6 and 7 of the parent feature documented in
`periscope-lottery-alerts-2026-05-19.md`. Phases 1–5 are merged.

## Goal

Make the Periscope Lottery panel **backtestable** by

1. populating `periscope_lottery_fires` with every event the v3 strict
   filter would have fired on for the dates already in
   `periscope_snapshots` (~Apr 13 – May 18, 26+ trading days), and
2. exposing a date picker on the UI so the user can scroll through any
   day and see the fires + realized outcomes.

## Phases

### Phase 6 — Historical backfill (this commit batch)

**6a. Refactor detection for "all-events-of-the-day" mode.**

Files:
- `api/_lib/periscope-lottery-finder.ts`

Today `fetchCandidates(panel, expiry)` returns events from the
*latest* slice pair only — fine for the 5-min cron, useless for
backfill. Add a second mode: `fetchAllCandidatesForExpiry(panel,
expiry)` that uses `LAG` over `captured_at` to compute deltas across
*every* consecutive slice pair in the day, and `PARTITION BY
captured_at` for `lvl_rank` / `chg_rank` so per-slot rankings are
preserved.

Add two new exports — `detectCallLotteryAllForDate(expiry)` and
`detectPutLotteryAllForDate(expiry)` — that call the new fetch + run
the same downstream augmentation loop (`fetchGexTarget`,
`fetchQqqNetPremBalance30m`, `fetchEntryPx`, `fetchLatestVix`,
strike/dist/rank/gex filters). The existing `detectCallLottery` /
`detectPutLottery` are unchanged so the live cron isn't affected.

The `fetchEntryPx` and `fetchQqqNetPremBalance30m` lookups will return
`null` for dates outside the `ws_option_trades` /
`net_flow_per_ticker_history` retention windows. That's acceptable —
the panel already renders nulls gracefully. The Python outcomes
script (Phase 6c) backfills `entry_px` from parquet for any null
rows.

**6b. Node backfill script for detection.**

Files:
- `scripts/backfill-periscope-lottery-fires.mjs`

Walks distinct `expiry` values in `periscope_snapshots` (constrained
to `--start` / `--end` if supplied). For each expiry:

1. Run `detectCallLotteryAllForDate(expiry)` → upsert via the same
   `ON CONFLICT (fire_type, fire_time, event_strike) DO NOTHING` shape
   the live cron uses, so re-running is idempotent.
2. Run `detectPutLotteryAllForDate(expiry)` → same upsert.

Logging: per-date row count + total. Pass `--dry-run` to skip the
INSERTs.

**6c. Python outcomes backfill from parquet.**

Files:
- `scripts/backfill_periscope_lottery_outcomes.py`

For every row in `periscope_lottery_fires` with `outcome_locked =
FALSE`, find the matching parquet at
`~/Desktop/Bot-Eod-parquet/{expiry}-trades.parquet`. Filter to
`(expiry, trade_strike, side)` where side is derived from `fire_type`
(`call_lottery` → `C`). Compute:

- `entry_px` — first non-canceled trade within +60s of `fire_time` if
  `entry_px` is null
- hold-window peak (`peak_px`, `peak_pct`, `peak_time`) — max price
  within `fire_time + [0, HOLD_MINUTES]` where `HOLD_MINUTES` is 120
  for calls, 180 for puts (matches the live enrich cron)
- `eod_close_px` — last trade of the day for the contract
- `realized_r_peak` = `(peak_px - entry_px) / entry_px`,
  `realized_r_eod` = `(eod - entry_px) / entry_px`
- Lock with `outcome_locked = TRUE` even if no trades found
  (`realized_r = -1`), matching the live enrich semantics.

Bulk-update via psycopg2; ~500 fires expected → fast.

**6d. Run + verify.**

Run the Node detection backfill, then the Python outcomes backfill.
Sanity-check the row counts against the in-sample / OOS numbers from
the research scripts. Spot-check one known fire (5/18 7430C, peak
$25, EOD $0.05).

### Phase 7 — Date picker

**7a. Add date picker to panel header.**

Files:
- `src/components/PeriscopeLottery/PeriscopeLotteryPanel.tsx`

Replace the today-only `useMemo(() => getETDateStr(new Date()), [])`
with `useState<string>` initialised to today. Add an
`<input type="date">` (or a small inline picker) in the panel header.
Clamp `max` to today (ET).

**7b. Thread `date` + `historical` through the hook.**

The hook already accepts both — panel just passes them. `historical
= selectedDate < todayET` so polling skips on past days.

**7c. Tests.**

New tests:
- Date picker changes the `date` param to the hook
- Past dates skip polling (assert no interval fires)
- Today is the default initial value
- `aria-label` on the date input

### Out of scope (deferred)

- Filter chips (V4-only, hide losers, sort by R) — the panel renders
  all fires unfiltered for now.
- Export to CSV — can copy from the DB if needed.
- Pre-filling fires from before periscope_snapshots existed.

## Open questions

None — all picked-up from prior conversation:

- 1 contract / configurable: covered by Phase 5 outcome semantics
- Both panels: Phase 5
- Separate panels per side: Phase 5
