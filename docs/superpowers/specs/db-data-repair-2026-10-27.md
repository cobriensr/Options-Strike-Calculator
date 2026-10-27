# Database data repair (owner request, 2026-10-27)

## Goal

Go through the database and correct, or fill in, what is missing or wrong, re-fetching from the upstream APIs (Schwab, Unusual Whales, GEXBot) wherever they can still serve the data. Where no API can re-serve it, repair rows from data we already store, or delete them if they can't be repaired.

## Status

Not started. This is a stub. Phase 0 (the inventory) comes first, and every prod write needs the owner's approval of a dry run.

## Known issues to include

These were collected 2026-10-26/27. Revalidate each one before acting on it.

| Table(s) | Problem | Repair source | Tracked in |
|---|---|---|---|
| `etf_candles_1m` (SPY, QQQ) | Frozen partial bars: rows inserted while the bar was still forming. About 100% of regular-session bars since April are frozen; ranges are understated by about 8–19%. | UW 1-min OHLC, as far back as its lookback goes | Review remediation Q26 / D1c |
| `index_candles_1m` (SPX, NDX) | Same frozen-bar bug (99% of the last 30 days). Some rows use a static ratio (SPX ×10, NDX ×48) instead of the day's ratio. | ETF bars × the per-day ratio from Schwab daily closes | Q26 / D1h; `rr-repair` worktree |
| `vega_spike_events`, `ws_gamma_setup_fires` (returns), `day_embeddings` | Values derived from the frozen candles. Pre-fix `fwd_return_eod` holds a return at about t+30–40 min instead of the close. | Recompute after the candle repair | Q26 downstream; D1e |
| `market_snapshots` | 220 live rows filed under the wrong date (weekend-tab and past-date saves). 51 rows have SPX outside the date's range, including a constant ≈5,720 on 03-23..03-30. `is_backtest` is probably inverted for today's saves. | Not re-fetchable (the calculator wrote them): delete or relabel | `past-date-replay-integrity-2026-10-27.md` phase 5 |
| `futures_bars` | One back-month CL bar at 2026-09-30 02:36 UTC (89.41 → 87.24 → 89.39). Gaps are already repaired by the `backfill-futures-gaps` cron. | UW REST futures candles | Remediation Q12 / 3.13 |
| `cone_levels` | Stored as K−P / K+C; the owner chose K ± (C+P). | Recompute from the stored premiums | Remediation Q8 / 3.11 |
| UW-fed tables | Confirmed unfixed bugs from the 2026-10-02 UW audit: SPX strike truncation since 09-25, `rv_30d` NULL, and others. | UW REST re-fetch where the window allows | Memory `uw-audit-2026-10-02` |

## Approach

0. **Inventory (read-only).** For every live table, record:
   - its writer (cron, WS or client) and its source API;
   - how far back that API can re-serve data;
   - checks for gaps, NULL-rate drift, duplicates, out-of-range values and partial bars;
   - whether a repair is possible.

   Output: a table-by-table report in `docs/tmp/`, ranked by impact (what feeds Claude's analysis, the ML features and the trading panels).
1. **Per table, in impact order:**
   - a repair or backfill script with `--dry-run` first;
   - a JSONL backup of every row it would change;
   - an idempotent upsert keyed on the source key;
   - batched writes (R5/R6);
   - verification queries afterwards.

   The owner approves each dry run before anything is written.
2. **Recompute derived tables** after their inputs are repaired.
3. **Prevent recurrence.** Each root cause gets a code fix and a test in its own stream, e.g. the forming-bar filter (shipped 10-26) and the past-date save guard (integrity spec phase 1).

## Constraints

- `.env.local` `DATABASE_URL` points at **production** Neon. Every read is a read-only transaction. A Neon branch snapshot comes before any bulk write.
- Respect the UW rate limit (`UW_CONCURRENCY_CAP=3`). Probe each endpoint's history depth with a single request before planning a backfill.
- Railway services are untouched unless a root-cause fix needs them, and those push only after 15:00 CT.
