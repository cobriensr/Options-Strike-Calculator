---
status: Plan
date: 2026-10-23
---

# Unusual Whales API + websocket alignment

**Date:** 2026-10-23 (audit run 2026-10-02, findings re-verified against prod 2026-10-23)
**Status:** Plan. Two implementation plans:
- REST fixes: `docs/superpowers/plans/2026-10-23-uw-rest-fixes.md` (branch `fix/2026-10-02-uw-rest`)
- Schema + websocket capture: `docs/superpowers/plans/2026-10-23-uw-ws-capture.md` (branch `fix/2026-10-23-uw-ws`)

## Goal

Fix the live data bugs that UW's more explicit 2026-09/10 docs exposed, and start capturing the new websocket channels. The most important new channel is `periscope:SPX`: UW's only market-maker exposure feed, with no REST, no history and no backfill.

## Audit summary (2026-10-02, re-verified 2026-10-23)

**UW's REST contract barely changed since 2026-09-07.**
- No path we call was removed, renamed or deprecated.
- The docs moved: `/docs/operations/<id>.md` now 301s to `/docs/api/<tag>/<slug>.md`, and the websocket docs now live at `/docs/websocket/<channel>.md`.
- UW now documents behaviour we had been guessing at: 500-row page caps, ascending strikes, newest-first candles, and how realized-vol rows are dated.

**Websocket changes were additive:** new channels and new fields. Nothing we consume broke.

### Confirmed defects (prod 2026-10-23 unless noted)

| # | Defect | Evidence |
|---|---|---|
| D1 | `fetch-strike-all.ts` reads one 500-row page of `spot-exposures/strike` (strikes ascending), so every strike above about spot+10 is dropped. | Since 2026-09-25, `strike_exposures` (expiry `1970-01-01`) holds only strikes below spot. On 10-22: 45 strikes, top 7660, spot 7661. On 09-24 it was 86 strikes up to spot+200. |
| D2 | `vol_realized.rv_30d` is NULL on every row. The cron reads the newest row, whose 21-day RV window has not finished. `backfill-vol-surface.mjs` matches `date == D`, which stores the NEXT 21 days' RV (look-ahead). | NULL every day through 10-22. UW doc: "A row's `date` is the implied volatility observation date. `unshifted_rv_date` is the date when the realized volatility window ends." |
| D3 | Per-expiry gamma is never stored. `/greek-exposure/expiry` returns `call_gex`/`put_gex`; the code reads `call_gamma`/`put_gamma`. | 0 of ~4,500 rows per day non-NULL. |
| D4 | `build-features-phase2.ts` sends `date=` to `/stock/SPX/options-volume`, which has no `date` param, so it returns the latest days. | A probe for 2026-09-25 returned 10-01, 09-30 and 09-29. |
| D5 | `spx-candles.ts` `previousClose` is the open of `prCandles[0]`. Candles arrive newest first, so that is the LAST premarket bar, not a prior close. | Doc: "intraday candles are newest first". |
| D6 | `monitor-flow-ratio.ts` stores the index-only tide's `underlying_price`, which is SPY-scale, as `spx_price`. | 764 instead of 7665. |
| D7 | SPX spot is taken from `rows[0].price` of strike-ascending responses. The `?limit=1` preflights return the strike-200 row, and UW says a strike's `price`/`time` "can differ … possibly by hours". | `fetch-gex-0dte.ts:95-109`, `fetch-gex-strike-expiry-etfs.ts:120-140`, `fetch-strike-exposure.ts:150,230`, `fetch-strike-all.ts:89`. |
| D8 | `uw-stock-candles.ts` swallows errors to `[]`. Index OHLC (SPXW/NDXP/RUTW) returns 422, so `range_pos` is NULL for every index lottery fire, with no Sentry event. | 422: "The CBOE index OHLC dataset requires provisioned access". |
| D9 | `withRetry` ignores `Retry-After`. UW documents 503 + `Retry-After` on `spot-exposures/strike` and `/expiry-strike`. | `uw-fetch.ts:56-106`, `:260`. |
| D10 | `fetch-spx-candles-1m.ts` requests `limit=500`, newest first. Re-running a past day loses the open. | 500 rows covered 23:59Z..14:09Z on a full day. |
| D11 | The code reads `expiry-breakdown`'s `expires`, which live data sends, but UW's doc says `expiry`. | `fetch-greek-flow-etf.ts:181`, `reconcile-greek-flow-etf.ts:80`. |
| D12 | `fetch-flow-alerts.ts` leaves `rule_id`, `bid`, `ask`, `iv_start`/`iv_end`, `start_time`/`end_time` NULL, saying the list endpoint lacks them. The list endpoint returns all of them, plus size-weighted greeks since 2026-09-23. | Live probe. |
| D13 | `uw-stream` `flow_alerts.py` uses `executed_at` as `created_at`. UW sends `executed_at: 0` on some alerts (doc: "Same as `end_time` (kept for backwards compatibility)"). | 298 `ws_flow_alerts` rows dated 1970. |
| D14 | The `ws_option_trades` retention sweep doesn't delete. Commit 878f2683 (2026-10-02) landed, but the oldest row is still 2026-06-18. | ~67M rows, 85 GB heap + 23 GB indexes. |
| D15 | The `uw-stream` handshake sends no `User-Agent` (UW doc: "Send a real `User-Agent` on the handshake"). UW error frames (bare `{"error": …}`) are dropped as `malformed_envelope`. | `connector.py:233-238`, `router.py:79-86`. |
| D16 | `off_lit_trades.py` does not drop `average_price_trade` / `derivative_price_trade` prints, which breaks the repo's dark-pool filter rule. | 486 of 25,368 rows on 10-01. |
| D17 | `gex_strike_expiry_lottery` joins 86 tickers, but the handler's 0DTE filter discards everything except tickers with an expiry today. | Only SPX/IWM/SMH WS rows on 10-01. |
| D18 | `fetchAllDarkPoolTrades` (`darkpool.ts:158`) has no production caller. | grep. |

**Not a defect, deliberately left alone:**
- **`ws_option_trades.canceled` is always FALSE.** UW sends no such field, but ~30 readers filter `canceled = FALSE`, so the column stays.
- **`net_flow` docs say "cumulative", but the wire carries per-tick deltas.** Session sums match REST within ~1%, so keep the delta logic. SPXW is the exception (see Phase W9).

## Decisions (user, 2026-10-02)

1. **Periscope storage:** compact arrays in Neon, recorded around the clock: one row per snapshot × expiry, all-zero strikes dropped. Budget ~40–55 GB/yr. Byte-identical consecutive snapshots store a header row only (see thresholds).
2. **Periscope tickers:** SPX only.
3. **New websocket channels:** all three, i.e. `market_tide`, `greek_flow_expiry:SPX`, `iv_term_structure:SPX`. **Ruling (controller):** `market_tide` starts as a SHADOW writer into its own table. UW does not document whether its values are cumulative or per-update, and `flow_data` has ~10 readers. Swap the writer only after one RTH session shows the shadow matches REST (Phase W10).
4. **rv_30d:** fix the cron AND rewrite history with trailing RV. This is a methodology change to an ML input, flagged to the user and approved.

## Phases

### REST plan (`fix/2026-10-02-uw-rest`)

| Phase | Scope | Files |
|---|---|---|
| R1 | Shared UW spot helper; walk/limit strike pages in strike-all; fix the backfill; backfill 2026-09-25 → yesterday | `api/_lib/uw-spot.ts` (new), `api/__tests__/uw-spot.test.ts` (new), `api/cron/fetch-strike-all.ts`, `api/__tests__/fetch-strike-all.test.ts`, `scripts/backfill-strike-all.mjs` |
| R2 | Trailing rv_30d in the cron + backfill; rewrite vol_realized history | `api/cron/fetch-vol-surface.ts`, `api/__tests__/fetch-vol-surface.test.ts`, `scripts/backfill-vol-surface.mjs` |
| R3 | Per-expiry gamma from `call_gex`/`put_gex` | `api/cron/fetch-greek-exposure.ts`, `api/__tests__/fetch-greek-exposure.test.ts`, `scripts/backfill-greek-exposure.mjs` |
| R4 | Adopt the spot helper in the remaining preflights (D7) | `api/cron/fetch-gex-0dte.ts`, `api/cron/fetch-gex-strike-expiry-etfs.ts`, `api/cron/fetch-strike-exposure.ts` + their tests |
| R5 | options-volume picks the row whose `date` matches | `api/_lib/build-features-phase2.ts` + test |
| R6 | monitor-flow-ratio stores a real SPX price | `api/cron/monitor-flow-ratio.ts` + test |
| R7 | Real previous close in spx-candles (UW and DB paths) | `api/_lib/spx-candles.ts` + test |
| R8 | Index candles via ETF proxy; surface fetch errors | `api/_lib/uw-stock-candles.ts`, `api/cron/detect-lottery-fires.ts` + tests |
| R9 | Honour `Retry-After` on 503/429; full-day 1m candle fetch | `api/_lib/uw-fetch.ts`, `api/__tests__/api-helpers.test.ts`, `api/cron/fetch-spx-candles-1m.ts` + test |
| R10 | `expires ?? expiry` defensive read | `api/cron/fetch-greek-flow-etf.ts`, `api/cron/reconcile-greek-flow-etf.ts`, `scripts/backfill-greek-flow-etf-0dte.mjs` + test |
| R11 | Diagnose and fix the ws_option_trades retention sweep (D14) | `api/cron/cleanup-ws-option-trades.ts` + test (+ whatever the diagnosis shows) |
| R12 | Delete `fetchAllDarkPoolTrades`; correct the flow-per-strike-intraday comment | `api/_lib/darkpool.ts`, `api/__tests__/darkpool.test.ts`, `api/_lib/uw-fetch-paged.ts` (comment), `api/cron/fetch-strike-trade-volume.ts` (comment) |
| R13 | Flow-alert list fields + greeks into `flow_alerts`. **Needs W1 on main first** (rebase). | `api/cron/fetch-flow-alerts.ts`, `api/_lib/flow-alert-derive.ts`, test |
| R14 | Resync the `unusual-whales-api` skill | `.claude/skills/unusual-whales-api/SKILL.md` |

### Websocket plan (`fix/2026-10-23-uw-ws`)

| Phase | Scope | Files |
|---|---|---|
| W1 | Migrations 191+: greek columns on `flow_alerts` + `ws_flow_alerts`; `ws_periscope_snapshots`, `ws_periscope_expiries`, `ws_greek_flow_expiry`, `ws_iv_term_structure`, `ws_market_tide`. Apply to prod via `scripts/run-pending-migrations.mts` and insert `schema_migrations` rows. | `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts` |
| W2 | flow_alerts: `created_at` from `end_time`; store greeks | `uw-stream/src/handlers/flow_alerts.py` + test |
| W3 | Handshake User-Agent; explicit error-frame handling | `uw-stream/src/connector.py`, `uw-stream/src/router.py` + tests |
| W4 | Off-lit synthetic-price filter; `gex_strike_expiry_0dte` shorthand (lottery token kept as alias) | `uw-stream/src/handlers/off_lit_trades.py`, `uw-stream/src/config.py`, `uw-stream/src/channel_registry.py` + tests |
| W5 | Periscope capture handler | `uw-stream/src/handlers/periscope.py` (new), `uw-stream/src/channel_registry.py`, test (new) |
| W6 | greek_flow_expiry + iv_term_structure handlers | 2 new handlers, registry, 2 new tests |
| W7 | market_tide shadow handler | new handler, registry, new test |
| W8 | Deploy + `WS_CHANNELS` (outside 09:00–15:00 CT; handler live BEFORE the var changes); repair the 1970 `ws_flow_alerts` rows | ops only |
| W9 | Investigate the SPXW net_flow WS-vs-REST divergence (read-only report) | `docs/tmp/` report |
| W10 | After one RTH session: validate `ws_market_tide` against `flow_data` REST rows, then swap the writer | `api/cron/fetch-flow.ts`, the market_tide handler + tests |
| W11 | Resync the `unusual-whales-websocket` skill | `.claude/skills/unusual-whales-websocket/SKILL.md` |

## Data dependencies

- **New tables (W1), all with source-derived or bucketed keys, never `NOW()`:**
  - `ws_periscope_snapshots` PK `(ticker, snapshot_ts)`
  - `ws_periscope_expiries` PK `(ticker, snapshot_ts, expiry)`
  - `ws_greek_flow_expiry` PK `(ticker, ts_minute, expiry)`
  - `ws_iv_term_structure` PK `(ticker, expiry, ts_minute)`
  - `ws_market_tide` PK `(ts)`
- **New columns:** `iv`, `delta`, `gamma`, `theta`, `vega`, `rho`, `theo` (float8, nullable) on `flow_alerts` and `ws_flow_alerts`.
- **Migrations:** code and DB are both at id 190 on 2026-10-23, so new ids start at 191. Apply via psql/`run-pending-migrations.mts`, because `OWNER_SECRET` is empty in prod.
- **Railway `WS_CHANNELS`:** append `periscope:SPX,greek_flow_expiry:SPX,iv_term_structure:SPX,market_tide`. Replace `gex_strike_expiry_lottery` with `gex_strike_expiry_0dte`. Read the current value back first; never retype it.
- **No new env vars.**

## Thresholds / constants

- **Strike window:** `ATM_RANGE = 200` points (unchanged). UW page size 500; a page with exactly 500 rows means fetch the next page. Page cap 10.
- **rv_30d:** UW `days=21` (trading days) trailing window ending ON day D. `iv_30d` = `implied_volatility` of the row whose `date` = D.
- **Periscope snapshot assembly:**
  - Finalize when the `has_more=false` frame arrives; `complete` = Σrows == `total_rows`.
  - A new `timestamp` for the same ticker closes the prior snapshot as incomplete.
  - Reap stale in-flight snapshots after 180 s.
  - At most 2 in-flight snapshots per ticker.
  - Dedupe `(expiry, strike)` within a snapshot.
  - Values: accept JSON numbers or decimal strings.
  - Arrays stored as `real[]`.
  - `content_hash` = sha256 of the sorted non-zero rows. When it equals the previous stored snapshot's hash for the ticker, write the header only, with `duplicate_of` = that snapshot's `snapshot_ts`.
- **greek_flow_expiry:**
  - Messages are PARTIAL sums. Accumulate in memory per `(ticker, timestamp, expiry)` and upsert the full running total (replace, not add).
  - Hold a minute bucket 180 s past the minute's end, then evict.
  - Discard buckets whose minute had already started when the handler started (partial view).
  - Join `greek_flow_expiry:SPX`, not `:SPXW`; UW folds SPXW into SPX.
- **iv_term_structure:** there is no message timestamp. Bucket by receive minute (`ts_minute` = floor(receive time, 1 min)); last value in the minute wins (replace upsert).
- **market_tide shadow:** key on the payload `timestamp` (ISO); store all 6 values.
- **`gex_strike_expiry_0dte` tickers:** the daily-expiry set, derived from `ws_gex_strike_expiry` + UW expiry calendars at implementation time and documented in `config.py`.
- **Deploy window for `uw-stream`:** before 08:30 CT or after 15:00 CT only.

## Review focus

1. **A UW page with exactly 500 rows** must trigger the next page. A short final page ends the walk with no error.
2. **A periscope snapshot whose last frame never arrives** (socket drop) must be written as `complete=false` by the reaper, not lost and not left in memory.
3. **greek_flow_expiry partial sums** arriving after the bucket was first written must raise the stored total, not overwrite it with the partial.
4. **Spot helper returns null** (UW error or empty): crons must fail loudly (Sentry + non-2xx/`partial`), never fall back silently to the strike-200 price.
5. **Backfills write prod.** Each must be idempotent on re-run, print per-date counts, and stop on the first error.

## Open questions (defaults chosen)

- **Periscope session hours:** UW's moderator said cash session; UW's example measured snapshots at 1 am ET. Default: no time gate (user chose around the clock), with byte-identical dedupe keeping overnight cost low.
- **vol_realized gap (no rows 07-22 → 09-07):** default is to fill it in R2's backfill if UW history allows.
- **`ws_option_trades` space:** fixing the sweep frees space inside the file but doesn't shrink it. A `VACUUM FULL`/`pg_repack` is disruptive and is the user's call. Not in scope.
