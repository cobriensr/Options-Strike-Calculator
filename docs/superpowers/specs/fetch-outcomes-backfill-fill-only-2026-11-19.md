# fetch-outcomes backfill fills gaps only

Status: implemented 2026-11-19 (`fix(outcomes)`), on the owner's request.

## Goal

Make `GET /api/cron/fetch-outcomes?backfill=true` fill only the days that have no `outcomes` row, and stop it blanking `vix1d_close`.

## The bug

`handleBackfill` called `saveOutcome` for every completed daily SPX candle of the last ~62 days. `saveOutcome` is `ON CONFLICT (date) DO UPDATE` over every column, and the backfill passed `vix1dClose: undefined` (Schwab's daily history has no VIX1D). So one run would overwrite all 29 days stored in that window with the daily bar's values and set `vix1d_close = NULL` on each. `ml/` and `api/ml/export.ts` read that column.

What was actually missing in production is a set of gaps: 09-21..09-30, 10-08..10-15 and 11-18 (a Schwab logout, which loses the day for the main run).

## Design

- `insertOutcomeIfMissing(input)` in `api/_lib/db-analyses.ts`, same input type as `saveOutcome`. It runs `INSERT … ON CONFLICT (date) DO NOTHING RETURNING date` and returns true when it inserted a row, false when the date already had one. A database error rejects. The derived columns (range pts, range pct, close vs open) come from one private helper that `saveOutcome` also uses. The key is the trading date, so a re-run or a retry is idempotent.
- The backfill calls it instead of `saveOutcome`. Each missing day takes OHLC and settlement (the daily bar's close) from the Schwab daily SPX bars, `vix_close` from the daily VIX bars, and `vix1d_close` from the CBOE map in Redis (`vix1d:daily-map`, written by `refresh-vix1d`), read once per run.
- The VIX1D map is optional. If it is missing or empty, or the Redis read throws, the backfill logs a warning that names the cause, saves NULL `vix1d_close` and carries on.
- Response: `{ backfill: true, status, saved, present, skipped, insertedDates, vix1dMissingDates }`. `saved` is days inserted, `present` is days that already had a row, `skipped` is days whose insert failed. `status` still comes from failures only (`deriveCronStatus(skipped, total)`), so an all-present run is a success. The run is triggered by hand, so the response is what the operator reads. The inserted dates are logged too.
- `vix1dMissingDates` is the inserted days stored with a NULL `vix1d_close`: the map had no close for the date, or there was no map. It does not list present or failed days. Because the insert is DO NOTHING, a re-run cannot fill those days once the map catches up, so the run names them, with one warning that lists the dates (in addition to the whole-map warnings above). Repairing them is a separate step.

## Unchanged

- `saveOutcome` and the main end-of-day run (it legitimately re-saves today, from 5-minute candles and the VIX/VIX1D quotes).
- The auth guard, the 502 on a Schwab SPX failure, the throw on an empty candle set, the 62-day window, the one Sentry event per run for failed days.
- No new env var or flag. The endpoint is still triggered by hand.

## Limits

An existing row is never repaired: a stored day with a NULL `vix1d_close` stays NULL, including a day this backfill itself inserted without a close (see `vix1dMissingDates`). Filling those is a separate, deliberate repair, not part of a backfill.

## Tests

`api/__tests__/outcomes-fill-only-pglite.test.ts` runs the real SQL on pglite (an existing row keeps every column, the handler end to end, no `DO UPDATE` sent). `api/__tests__/fetch-outcomes.test.ts` covers the counts, the map lookup and its failure modes, and the Sentry event.
