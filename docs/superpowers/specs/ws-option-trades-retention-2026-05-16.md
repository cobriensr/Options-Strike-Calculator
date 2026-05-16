# `ws_option_trades` 2-day retention — 2026-05-16

## Goal

Bound `ws_option_trades` so the DB stops growing at ~5.4 GB/day. The
table is the input feed for live features (Lottery Finder, Silent
Boom, opening-flow-signal, etc.) — but the user already has
end-of-day full-tape + flow archives stored locally and backed up to
Cloudflare R2, so the DB doesn't need to be the historical archive.

## Verified current state (2026-05-16)

```
total : 81 GB     (76% of the 107 GB live DB)
heap  : 68 GB     (84% of which is the inline `raw_payload` jsonb)
idx   : 13 GB     (5 indexes)
toast : 19 MB     (raw_payload is just under the 2 KB threshold and stores inline)
rows  : 66,960,759    (~5.4 GB/day × ~15 days since May 1)
```

Index breakdown:
| Index | Size |
|---|---:|
| `(option_chain, executed_at DESC)` | 4.7 GB |
| `(ticker, executed_at DESC)` | 2.9 GB |
| `(ws_trade_id) UNIQUE` | 2.5 GB |
| `(executed_at)` | 1.5 GB |
| `(id) PK` | 1.4 GB |

## Read horizon audit

Every consumer of `ws_option_trades` reads only same-day or shorter
windows:

| Reader                                    | Window                                                    |
| ----------------------------------------- | --------------------------------------------------------- |
| `api/cron/detect-lottery-fires.ts`        | `executed_at >= NOW() - SCAN_WINDOW_MIN minutes`          |
| `api/cron/detect-silent-boom.ts`          | same, minute window                                       |
| `api/cron/enrich-lottery-outcomes.ts`     | `executed_at >= fire.entryTimeCt` (today's fires forward) |
| `api/cron/enrich-silent-boom-outcomes.ts` | `executed_at >= alert.bucketCt` (today's alerts forward)  |
| `api/cron/evaluate-round-trip.ts`         | `fire_time .. fire_time + WINDOW_MIN minutes`             |
| `api/lottery-contract-tape.ts`            | UI-supplied `[fromTs, toTs]` for a specific fire          |
| `api/opening-flow-signal.ts`              | opening 5-minute slice                                    |

Longest reach: same-day end-of-day enrichment. 2-day retention (today

- yesterday) gives a full session of margin and handles any
  late-arriving outcome-enrichment run after midnight ET.

## Decision (confirmed with user)

- **Retention window: 2 days (today + yesterday in ET).**
- Daily cron deletes `executed_at < today_et - 2 days`.
- One-time backfill DELETE via psql for the existing 49M+ rows that
  fall outside the window.
- VACUUM FULL is **deferred** to a separate decision after the user
  has watched their Neon Storage dashboard drop naturally as
  autovacuum reclaims dead tuples. The greek-heatmap cleanup just
  proved a VACUUM FULL is the only way to get the heap file to
  shrink, but the user already ran one today and may want a break.

## Phases

### Phase 1 — Spec + read-horizon audit ✅

This doc.

### Phase 2 — Retention cron

- New file: `api/cron/cleanup-ws-option-trades.ts`.
- Pattern: identical to
  `api/cron/cleanup-ws-gex-strike-expiry.ts` — `cronGuard` with
  `marketHours: false`, `requireApiKey: false`. Sentry tag on the
  success path.
- Predicate (sargable, hits the `(executed_at)` B-tree directly):
  ```sql
  WITH batch AS (
    SELECT id FROM ws_option_trades
    WHERE executed_at < ($today::date - INTERVAL '2 days') AT TIME ZONE 'America/New_York'
    LIMIT 50000
  )
  DELETE FROM ws_option_trades
  WHERE id IN (SELECT id FROM batch)
  RETURNING id
  ```
  The TZ conversion is on the constant side, so the column comparison
  stays bare and the B-tree on `executed_at` is index-driven.
- Batched at 50k rows per statement, 295 s wall budget. Steady-state
  load is ~6M rows/day so the cron drains in 2-3 minutes after the
  first run; the loop exists for the one-time post-deploy catch-up
  (handled by the psql script below, but cron must be able to
  follow up if the script doesn't finish cleanly).
- Schedule: `5 12 * * 1-5` (12:05 UTC, 5 min after the existing
  `cleanup-ws-gex-strike-expiry` so they don't fight for the 1 CU).

### Phase 3 — Tests

`api/__tests__/cleanup-ws-option-trades.test.ts` — mirror of the
greek-heatmap cron test:

- 405 on non-GET
- 401 on missing/wrong CRON_SECRET
- No-op when table holds no pre-cutoff rows
- Drains across multiple batches
- Predicate references `executed_at` and the ET TZ on the constant
  side (not on `executed_at`)
- Wall-budget exit emits `stopReason: 'wall_budget'`
- Sentry tag set on success path, not only catch

### Phase 4 — vercel.json registration

Add the schedule entry.

### Phase 5 — One-time backfill DELETE

- `docs/tmp/ws-option-trades-cleanup-psql-2026-05-16.sh`
- Same shape as `greek-heatmap-cleanup-psql-2026-05-15.sh` but on
  `ws_option_trades`.
- ~49M rows to delete (everything older than today minus 2 days).
- At ~100k rows / 10 s (observed rate on the gex_strike cleanup),
  estimated ~80 minutes wall time. Saturday evening, UW WS quiet,
  ~zero contention expected.

### Phase 6 — Verification

- Re-probe `pg_total_relation_size('ws_option_trades')` and row count
- `npm run review` (tsc + eslint + prettier + vitest)
- Code-reviewer subagent

## Files to create/modify

- `docs/superpowers/specs/ws-option-trades-retention-2026-05-16.md` (this file)
- `api/cron/cleanup-ws-option-trades.ts` (new)
- `api/__tests__/cleanup-ws-option-trades.test.ts` (new)
- `vercel.json` (add cron entry)
- `docs/tmp/ws-option-trades-cleanup-psql-2026-05-16.sh` (one-shot ops)

## Expected outcome

|              |      Before |              After phase 5 | After natural autovacuum |
| ------------ | ----------: | -------------------------: | -----------------------: |
| Rows         |      66.9 M |                      ~12 M |                    ~12 M |
| Heap size    |       68 GB |                      68 GB |                   ~15 GB |
| Total table  |       81 GB |                      81 GB |                   ~17 GB |
| Daily growth | +5.4 GB/day | net-zero (delete = insert) |                 net-zero |

Heap doesn't shrink immediately; autovacuum reclaims dead tuples for
reuse within the file. A future VACUUM FULL (or letting writes refill
over weeks) takes the file size down. Neon's billed storage starts
dropping as soon as the 6-hour history window rolls past the bulk
DELETE.

## Out of scope (next spec, if pursued)

- Extract `trade_code` to typed column, drop `raw_payload` — would
  shave another ~10 GB off steady state.
- Swap `(executed_at)` B-tree for BRIN — saves ~1.4 GB of index space
  on a monotonically-increasing column.
- Audit `(option_chain, executed_at DESC)` — biggest single index at
  4.7 GB; confirm it's still hot before deciding whether to drop.

## Thresholds

- Retention window: **2 days** (today + yesterday in ET).
- Cron schedule: `5 12 * * 1-5` UTC (pre-market).
- Batch size: 50,000 rows per DELETE statement.
- Wall budget: 295 s (5 s headroom under the 300 s function limit).
