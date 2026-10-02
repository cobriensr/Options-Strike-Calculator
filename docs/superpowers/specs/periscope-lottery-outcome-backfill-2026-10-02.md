# Periscope lottery outcome backfill from UW minute bars — 2026-10-02

## Goal

Fill the outcome columns of the ~4,800 `periscope_lottery_fires` rows the
enrich cron can never reach: their trades aged out of the 2-day
`ws_option_trades` retention. The values come from UW per-contract 1-minute
bars and must be exactly what the cron would have written, or the row stays
unlocked.

## Phases

1. **Done (this change).** Phase 1 has five parts:
   - `periscopeFireWindow` is shared by the cron and the backfill.
   - The pure bar → outcome mapping.
   - The UW bars client.
   - The dry-run-by-default script, with a parity gate and guarded writes.
   - The old parquet script is retired.
2. **Owner.** Review the dry run, then run `--apply` after the close.
3. **Open.** Add an `outcome_source` column (see Open questions), and decide
   what to do with the rows the old script mis-wrote.

## Files

- `api/_lib/periscope-lottery-outcome.ts` holds the window definitions and
  `outcomeFromMinuteBars`. Its header documents the bar ↔ tape mapping,
  `barTapeLive` and `barParityMismatches`.
- `api/_lib/uw-option-contract-bars.ts` is the
  `/option-contract/{id}/intraday` client and parser.
- `api/cron/enrich-periscope-lottery-outcomes.ts` now uses
  `periscopeFireWindow`, with no behavior change.
- `api/_lib/periscope-lottery-types.ts` gains
  `PERISCOPE_LOTTERY_ENTRY_WINDOW_MINUTES`, which the finder's
  `fetchEntryPx` now uses.
- `scripts/_lib/periscope-outcome-backfill.ts` holds the orchestration.
  `scripts/backfill-periscope-lottery-outcomes.ts` is the entry point.
- Tests: `api/__tests__/periscope-lottery-outcome.test.ts`,
  `api/__tests__/uw-option-contract-bars.test.ts` and
  `scripts/_lib/periscope-outcome-backfill.test.ts`.
- Deleted: `scripts/backfill_periscope_lottery_outcomes.py`.

## Data dependencies

- **UW.** `GET /api/option-contract/{id}/intraday?date=`, one call per
  contract-day.
  - Live shape (probed 2026-10-02): rows come newest first, with string
    OHLC, `trading_hours`, and no `option_symbol` echo.
  - The parser therefore checks that bars land on the requested ET day,
    start on a minute, and have consistent OHLC.
- **Env.** `DATABASE_URL` and `UW_API_KEY`, loaded from `.env.local`.
- **No migration.** The script reads and writes existing columns only.

## Thresholds and constants

| Name | Value | Why |
|---|---|---|
| `PRICE_EPS` | 5e-5 | half a NUMERIC(10,4) unit; prices sit on a $0.01 grid |
| parity tolerance | 5e-5 + 1e-9 | stored values are rounded to 4 dp |
| `PARITY_MIN_COMPARED` | 20 | fewer cannot establish parity |
| `WRITE_CHUNK` | 500 | R5 batch size |
| `TAPE_TAIL_MINUTES` | 10 | the cron's liveness tail |
| entry window | 5 min | `PERISCOPE_LOTTERY_ENTRY_WINDOW_MINUTES` |
| UW concurrency | 3 | `UW_CONCURRENCY_CAP` |

## Dry run against prod (read-only, 2026-10-02 ~05:00 UTC)

- **Parity.** 302 cron-locked fires (2026-09-30 and 10-01). 292 were
  compared and all 292 match. 10 abstain as `ambiguous_peak`.
  `peak_time` is NULL on 37 of the compared fires.
- **Backfill.**
  - 4,800 candidates over 43 days and 809 contract-days.
  - 4,540 would lock; 592 of them have a NULL `peak_time`.
  - 260 stay unlocked: 256 `ambiguous_peak` and 4 `tape_tail_dead`. The
    `tape_tail_dead` fires fired at 15:59:xx ET.
- **Gaps.** No contract-day returned zero bars, and no UW errors occurred.
- **Cost.** 852 UW calls, about 55 s.
- **Skipped.** 118 unlocked fires have no `entry_px` and are left
  untouched.

## Open questions

1. **`outcome_source` column.** No migration is in this change. Proposed:
   `ALTER TABLE periscope_lottery_fires ADD COLUMN IF NOT EXISTS
   outcome_source TEXT CHECK (outcome_source IN ('ws_tape',
   'uw_minute_bars'))`, with the cron writing `'ws_tape'`.
   Default: defer.
2. **Rows the retired script mis-wrote.**
   - 366 locked rows hold `peak_pct` ×100 (percent, not a ratio).
   - 6 rows (ids 1, 246, 466, 833, 834 and 958) are locked at R = -1 with
     no `entry_px`.
   - This backfill cannot touch locked rows. Default: a separate,
     reviewed fix.
3. **`ambiguous_peak`** (256 fires). These rows stay unlocked. Resolving
   them needs tick data for the fire minute; `/api/option-trades` serves
   only the latest day.

## Residual risk

Parity is measured only on the last two days of fires. The backfill reaches
back to June. Any historical change in how UW builds bars (for example,
whether canceled prints count) would not show up in parity. Two guards
limit the damage: the entry-bracket checks catch bars that disagree with
the tape a fire was entered on, and every UPDATE is guarded.
