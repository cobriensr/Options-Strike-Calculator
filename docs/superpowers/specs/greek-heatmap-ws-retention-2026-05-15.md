# `ws_gex_strike_expiry` retention + 0DTE-only ingest — 2026-05-15

## Goal

Bound `ws_gex_strike_expiry` so the Greek Heatmap section loads in
<2 s instead of the ~20 s observed today. The table is meant to hold
"today's trading day, per-minute, no duplicates" but instead holds
~931k rows for a single (ticker, expiry) because UW pushes for the
expiry days before it is the 0DTE, and we never delete the
pre-trading-day rows.

## Verified scale (today, SPY 2026-05-15)

EXPLAIN ANALYZE results from `docs/tmp/greek-heatmap-probe-2026-05-15.mjs`:

| Query                                     | Wall   | Rows scanned           | Root cause                                            |
| ----------------------------------------- | ------ | ---------------------- | ----------------------------------------------------- |
| Snapshot `DISTINCT ON (strike)`           | 17.9 s | 931k → 267             | External merge sort + lossy bitmap recheck            |
| `intradayRange` MIN/MAX/COUNT DISTINCT    | 1.85 s | 908k                   | Slice size — index already fine                       |
| `getGreekHeatmapNetFlow` (separate table) | 6.4 s  | 1.45 M filtered to 24k | `date(ts)` non-sargable predicate (out of scope here) |

Net effect: ~20 s cold load.

## Decision (confirmed with user)

1. **Daemon filter** — drop any WS payload with `expiry != today_ET`. The
   only consumers (Greek Heatmap, Strike Battle Map) are 0DTE-only.
2. **Retention cron** — daily pre-market, delete rows where
   `ts_minute < today_ET`. Future-expiry rows that landed today are
   kept until they age out (defense-in-depth against any payload that
   slipped the daemon filter).
3. **Backfill cleanup (one-shot, now)** — DELETE rows where
   `date(ts_minute AT TIME ZONE 'America/New_York') < '2026-05-15'`.
   Friday's session stays intact for weekend inspection.

## Phases

### Phase 1 — Spec + verification ✅

This doc. Probe script captured in `docs/tmp/greek-heatmap-probe-2026-05-15.mjs`.

### Phase 2 — Daemon filter

- `uw-stream/src/handlers/gex_strike_expiry.py::_transform`: after
  `_to_date(payload.get("expiry"))`, reject if `expiry !=
today_et()`. Use `zoneinfo.ZoneInfo("America/New_York")` so the
  comparison anchors to the trading day, not the daemon's local TZ.
- Rate-limited warn log on rejection with `kind="expiry_not_today"`.
- Tests:
  - Today's expiry passes through.
  - Future expiry is rejected and the warn fires.
  - Past expiry is rejected (defensive — UW shouldn't, but we should
    not write).
  - DST boundary: 23:00 UTC on a day when ET is one day behind, the
    daemon must use the ET date, not the UTC date.

### Phase 3 — Retention cron

- New file: `api/cron/cleanup-ws-gex-strike-expiry.ts`.
- Pattern: `cronGuard` + `Sentry.setTag('cron.job', …)` per repo
  conventions. No market-hours gate — this is pre-market.
- Behavior: **two-pass DELETE** for index-friendly access — the
  initial single-predicate version wrapped `ts_minute` in `(… AT
  TIME ZONE 'America/New_York')::date < $today`, which is
  non-sargable and forced a per-batch seq scan (caught in the
  Phase 3 code review).
  1. `expiry < $today::date` — every past expiry's rows. Uses the
     `(ticker, expiry, …)` UNIQUE index via skip-scan / BitmapOr.
  2. `expiry >= $today::date AND ts_minute < ($today::date AT TIME
ZONE 'America/New_York')` — today's and future expiries with
     pre-today minutes. The TZ conversion is on the constant side,
     so the column comparison stays bare and the same index serves.
- Batched at 50k rows per statement, with a 295 s wall budget so a
  giant catch-up run exits cleanly with `stopReason: 'wall_budget'`
  instead of being killed mid-DELETE.
- Schedule: `0 12 * * 1-5` (12:00 UTC = 7-8am ET, ahead of all
  market-hours fetches at 13-21 UTC).
- Vercel.json registration.
- Test in `api/__tests__/cleanup-ws-gex-strike-expiry.test.ts`:
  CRON_SECRET guard, both passes use sargable predicates, batched
  loop terminates when DELETE returns 0 affected rows, wall budget
  exits early with partial counts, Sentry tag set on success path
  (not only on catch), no-op when table is empty.

### Phase 4 — One-shot backfill DELETE

- Execute via `docs/tmp/greek-heatmap-cleanup-2026-05-15.mjs`.
- `DELETE FROM ws_gex_strike_expiry WHERE date(ts_minute AT TIME
ZONE 'America/New_York') < '2026-05-15' RETURNING 1` in a 50k-row
  batched loop. Surface row count per batch.
- Run AFTER daemon filter is deployed so we don't race with new
  writes that the filter would still admit.

### Phase 5 — Verification

- Re-run probe; expect snapshot query under 500 ms.
- `npm run review` (tsc + eslint + prettier + vitest).

## Files to create/modify

- `docs/superpowers/specs/greek-heatmap-ws-retention-2026-05-15.md` (this file)
- `uw-stream/src/handlers/gex_strike_expiry.py` — add `expiry_not_today` reject
- `uw-stream/tests/test_gex_strike_expiry.py` — 4 new tests
- `api/cron/cleanup-ws-gex-strike-expiry.ts` — new cron
- `api/__tests__/cleanup-ws-gex-strike-expiry.test.ts` — cron tests
- `vercel.json` — register schedule
- `docs/tmp/greek-heatmap-cleanup-2026-05-15.mjs` — one-shot DELETE

## Out of scope (next session, separate spec)

- Rewriting `getGreekHeatmapNetFlow`'s `date(ts) = $expiry::date` →
  range predicate. Drops 6.4 s → <100 ms but is independent.
- Parallelizing the two heavy queries inside `getGreekHeatmapSnapshot`.
  Marginal once rows are bounded, but worth a follow-up.
- Adding `(ticker, expiry, strike, ts_minute DESC)` index. Likely
  unnecessary once retention bounds the slice.

## Thresholds

- Retention boundary: `date(ts_minute AT TIME ZONE 'America/New_York') < today_ET`.
- Batch size: 50,000 rows per DELETE statement.
- Daemon TZ: `America/New_York` (ET).
- Cron schedule: `0 12 * * 1-5` UTC.
