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

## Data dependencies

- Prod Neon (`.env.local` points at production). UW REST, ~3.4K calls. No new tables, columns, env vars or migrations.

## Open questions

- Index fires (SPXW/NDXP): a proxy from `index_candles_1m` (SPX/NDX rebuilt from SPY/QQQ × the Schwab ratio) would fill 22.5K rows, but it changes the method. Owner decision pending; default: leave NULL. RUTW has no source.
- Ticker-days where UW returns no candles stay NULL and are listed in the report.
