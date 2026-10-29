---
status: Plan
date: 2026-10-28
---

# Lottery `range_pos_at_trigger`: pass the UW key, surface failures, backfill

## Goal

Restore `lottery_finder_fires.range_pos_at_trigger` (the session-range position behind the "NEW HIGH" badge) on live fires and backfill every empty row a source can fill. Owner chose fix "A" (pass the real key) and the standing rule "always backfill and correct where we can" (2026-10-28).

## What's broken (verified 2026-10-28)

- `api/cron/detect-lottery-fires.ts` is wrapped with `{ requireApiKey: false }` (~line 1086), so `cronGuard` sets `apiKey = ''` (`api/_lib/cron-helpers.ts` ~287). The candle call (~line 686, `fetchStockCandles1m(ctx.apiKey, …)`) sends `Bearer ` with no key.
- `api/_lib/uw-stock-candles.ts` (~39) catches every error and returns `[]`, so `computeRangePos` returns null and nothing alerts.
- Result: 0 of ~150K fires since 2026-09-15 have the value; last populated 2026-05-18. In total 417,295 fires (3,632 ticker-days, 2026-01-02 → 2026-10-28) are NULL.
- Index tickers can't be fixed by the key: UW returns 422 "The CBOE index OHLC dataset requires provisioned access" for SPXW/NDXP/RUTW (spec `uw-api-ws-alignment-2026-10-23.md`, D8). 22,499 fires / 189 ticker-days.
- UW serves historical 1-min stock candles by `date` (probe 2026-10-28: AAPL 2026-01-05 → 637 rows, 2026-05-12 → 757 rows, newest first, extended hours included).

## Phases

1. **Fix (live path).** Files: `api/cron/detect-lottery-fires.ts`, `api/_lib/uw-stock-candles.ts`, their tests.
   - Drop `{ requireApiKey: false }` so `cronGuard` supplies `UW_API_KEY` (the repo norm for every UW cron).
   - Skip the candle call for index roots UW refuses (422), leaving `range_pos` null for them by design, with a comment citing D8. Reuse an existing index-ticker list if one exists; otherwise one domain constant.
   - Stop the silent swallow: failures are counted per run, logged once per run with the first error, put in the cron's Axiom `meta` (never a new top-level key — CLAUDE.md Axiom rule), and sent to Sentry once per run when non-zero.
   - Tests (R4): key reaches the fetch; UW non-2xx and malformed payload are surfaced by name; index ticker makes no request; happy path writes the value.
2. **Backfill (history).** Extend the existing `scripts/backfill-range-pos.mjs` (it already groups by ticker-day, batches a JSONB-pivot UPDATE per group and has `--limit`/`--dry-run`; found in review 2026-10-28) rather than writing a new script.
   - Source: one UW `/stock/{t}/ohlc/1m?date=` call per non-index ticker-day with NULL rows (~3,440 calls), through the repo's UW fetch/limiter (concurrency ≤ 3).
   - Compute with the same `computeRangePos` the cron uses, per fire (its trigger time and spot).
   - Write: batched `UPDATE … FROM unnest(...)` in ~500-row chunks, `WHERE range_pos_at_trigger IS NULL` (idempotent, resumable).
   - Flags: `--dry-run`, `--limit`, date range. 50-row timing probe first, then the full run. Progress log per ticker-day batch.
   - Report before/after NULL counts by month, plus ticker-days with no candles.
   - Tests for the pure parts (grouping, row mapping, chunking).
   - As built:
     - The pure parts live in `scripts/_lib/range-pos-backfill.mjs` (tests beside it). Plain `node` can't import the TypeScript `uwFetch` or `computeRangePos` (their `./x.js` imports need a bundler, and `uwFetch` brings the prod Redis limiter the crons share), so the script calls UW with its own `fetch` (explicit User-Agent, 15 s timeout, 3 in flight, one retry on 5xx/429/network/timeout) and runs a copy of `computeRangePos` and `CASH_INDEX_ROOTS`, each pinned to its source by a test. Positions are written as `numeric` text, matching the cron's bind.
     - It refuses to start 08:15–15:30 CT on weekdays unless `--allow-market-hours` is passed: its UW calls skip the shared semaphore, and a 429 there would open the live cron's candle breaker. Every Neon call has a 30 s per-attempt deadline that counts as transient for the retry.
     - Two differences from the live cron's value are inherent. (1) `spot_at_first` is `NUMERIC(12,4)`, so the backfill uses the 4-dp spot where the cron used the tick's full price: an error of at most 0.00005 ÷ the session range, under 1e-4 for any range of $0.50 or more. (2) The backfill sees the trigger minute's finished candle, where the live cron saw it still forming (or not yet opened). If price set a new session high or low later in that same minute, the backfill's range is wider by that move. That's usually tiny, but it isn't bounded in general.
     - After a full run, `VACUUM (ANALYZE) lottery_finder_fires` (about 395K rows rewritten); owner approval pending.
     - 2026-10-28 was still in session when the run was prepared, so it needs a second pass after midnight CT: `--from 2026-10-28 --to 2026-10-28`.

## Data dependencies

- Prod Neon (`.env.local` points at production). UW REST, ~3.4K calls. No new tables, columns, env vars or migrations.

## Open questions

- Index fires (SPXW/NDXP): a proxy from `index_candles_1m` (SPX/NDX rebuilt from SPY/QQQ × the Schwab ratio) would fill 22.5K rows, but it changes the method. Owner decision pending; default: leave NULL. RUTW has no source.
- Ticker-days where UW returns no candles stay NULL and are listed in the report.
