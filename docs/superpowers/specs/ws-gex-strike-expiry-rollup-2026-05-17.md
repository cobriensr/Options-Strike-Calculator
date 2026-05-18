---
status: Building
date: 2026-05-17
---

# `ws_gex_strike_expiry` → `strike_exposures` daily rollup + rescue

## Goal

Preserve per-minute per-strike WS Greek captures past their daily
retention deadline so the Greek Heatmap's HISTORICAL view shows the
LIVE scrubber for every lottery ticker, not just SPY/QQQ/NDX.

Today the WS daemon writes ~70-400 distinct ts_minute rows per
(ticker, 0DTE expiry) to `ws_gex_strike_expiry`, but the retention
cron (`cleanup-ws-gex-strike-expiry`) deletes everything pre-today
every weekday pre-market. The Greek Heatmap's historical query path
reads `strike_exposures`, which gets a single EOD snapshot per
(ticker, date) from the one-shot REST backfill. Net effect: META on
Friday 5/15 shows "EOD snapshot · 2:00 PM CT" even though the WS
captured 87 distinct minutes that day in `ws_gex_strike_expiry`.

## Approach

Add a daily EOD cron that copies today's `ws_gex_strike_expiry` rows
into `strike_exposures` with `ts_minute` preserved, runs AFTER the
WS finishes pushing for the day but BEFORE the next-day retention
sweep. The historical query path then renders the LIVE scrubber for
every ticker that the WS captured.

Schema mapping (WS → strike_exposures):
- `ts_minute` → `timestamp`
- `date(ts_minute AT TIME ZONE 'America/New_York')` → `date`
- `call_gamma_ask_vol` → `call_gamma_ask` (and the 7 sibling vol →
  no-vol renames for charm/vanna ask/bid)
- All OI columns 1:1
- `call_delta_oi` / `put_delta_oi` → NULL (WS payload doesn't carry
  delta; the REST backfill does, so backfilled rows keep delta).

Idempotent via the existing `(date, timestamp, ticker, strike,
expiry)` UNIQUE constraint on `strike_exposures`. Re-running on any
date is a no-op for already-present rows.

## Time-sensitive: 5/15 rescue

5/15's WS data is currently still in `ws_gex_strike_expiry` (80
tickers × ~398 minutes × ~150 strikes = 490k 0DTE rows + 7M non-0DTE
rows for future expiries — but only 0DTE rows matter for the
heatmap). **Monday 5/18 12:00 UTC (7am EDT) the retention cron will
DELETE Friday's data.** UW REST cannot retroactively serve per-minute
historical data, so the rescue must run before Monday morning or
Friday's intraday is lost forever.

## Phases

### Phase 1 — Helper + cron + test (ships as one commit)

**Files:**
- `api/_lib/rollup-ws-gex-strike-expiry.ts` — exports
  `rollupWsGexToStrikeExposures(db, date): Promise<{inserted, durationMs}>`.
  Iterates the lottery universe (read from
  `src/constants/greekHeatmapUniverse.ts`); per-ticker `INSERT INTO
  strike_exposures … SELECT … FROM ws_gex_strike_expiry WHERE ticker =
  $1 AND expiry = $2::date AND date(ts_minute AT TIME ZONE
  'America/New_York') = $2::date ON CONFLICT (...) DO NOTHING`.
- `api/cron/rollup-ws-gex-strike-expiry.ts` — Vercel cron handler;
  `cronGuard({ marketHours: false, requireApiKey: false })`; calls the
  helper with `today`; reports inserted count.
- `api/__tests__/rollup-ws-gex-strike-expiry.test.ts` — cron auth
  guard, success path, error path, Sentry tag.
- `vercel.json` — register cron at `30 22 * * 1-5` (22:30 UTC = 6:30
  PM EDT / 5:30 PM EST, after market close + restatement reconciles
  at 22:00, well before next-day 12:00 UTC retention). `maxDuration:
  120`.

**Rescue script:**
- `scripts/rescue-rollup-ws-gex-strike-expiry.mjs` — standalone .mjs;
  takes a YYYY-MM-DD arg; runs the same per-ticker INSERT...SELECT
  pattern against prod DB. Used to capture 5/15 before Monday.

### Phase 2 — Run the 5/15 rescue (manual, immediately after commit)

`node --env-file=.env.local scripts/rescue-rollup-ws-gex-strike-expiry.mjs 2026-05-15`

Re-probe to confirm `strike_exposures` for META 5/15 now has ~87
distinct timestamps (matching WS ts_minute count) instead of 1.

### Phase 3 — Monitor first auto-run on Monday

Confirm the cron fires at 22:30 UTC Monday 5/18, writes Monday's
rows to `strike_exposures`, and the heatmap on Tuesday for any
lottery ticker on 5/18 renders the LIVE scrubber.

## Files to create/modify

- create `docs/superpowers/specs/ws-gex-strike-expiry-rollup-2026-05-17.md` (this file)
- create `api/_lib/rollup-ws-gex-strike-expiry.ts`
- create `api/cron/rollup-ws-gex-strike-expiry.ts`
- create `api/__tests__/rollup-ws-gex-strike-expiry.test.ts`
- create `scripts/rescue-rollup-ws-gex-strike-expiry.mjs`
- edit `vercel.json` — register the cron + maxDuration

## Open questions — resolved during scoping

- **Delta columns**: WS payload doesn't include `call_delta_oi` /
  `put_delta_oi`. Rolled-up rows have NULL delta; existing REST
  backfill rows retain delta. The heatmap doesn't read delta, so no
  user-visible impact.
- **`expiry` filter**: rollup only copies rows where `expiry =
  date(ts_minute AT TIME ZONE 'America/New_York')` — 0DTE only.
  Future-expiry rows still in `ws_gex_strike_expiry` (the daemon's
  0DTE filter from the retention spec hasn't fully purged them) are
  not rolled up. The heatmap is 0DTE-only by spec, so non-0DTE rows
  are noise.
- **Storage growth**: ~500k rows/day for 80 tickers × 252 trading
  days = ~125M rows/year. `strike_exposures` already has indexes on
  (date, ticker), expiry, timestamp. Acceptable for the next 12
  months; revisit partitioning when the table crosses ~200M rows.

## Acceptance criteria

- [ ] Cron registered in vercel.json with `30 22 * * 1-5` schedule
- [ ] Rollup helper writes `INSERT...SELECT...ON CONFLICT DO NOTHING`
- [ ] Test passes for cron auth + success + error + Sentry tag
- [ ] Rescue script imports cleanly and runs against `.env.local`
- [ ] After manual rescue run: META 5/15 in `strike_exposures` has
  >50 distinct timestamps (was 1)
- [ ] `npm run review` passes (tsc + eslint + prettier + vitest)
- [ ] Code-reviewer subagent verdict: pass
