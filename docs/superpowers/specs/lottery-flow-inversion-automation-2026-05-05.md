# Lottery Flow-Inversion Automation — 2026-05-05

## Goal

Make `lottery_finder_fires.realized_flow_inversion_pct` populate
automatically every market day so the Lottery Finder UI's flow-inversion
column stops being empty for recent fires, while preserving fidelity
with the EDA results (NBBO-mid pricing).

## Why

Today, `realized_flow_inversion_pct` is filled only by a one-shot
manual run of `ml/experiments/lottery-net-flow-eda/exit_simulation.py`
with `WRITE_DB=1`. That script:

- Reads NBBO bid/ask from local parquet files at
  `/Users/charlesobrien/Desktop/Bot-Eod-parquet/`.
- Reads per-minute net flow from `net_flow_per_ticker_history`.
- Writes back via `UPDATE … FROM unnest(...)`.

Neither the parquet ingest nor the per-minute REST flow ingest is
running on a schedule, so today's, yesterday's, and any future fires
land with `NULL` in that column. The cron
`api/cron/enrich-lottery-outcomes.ts` only computes `trail30_10`,
`hard30m`, `tier50`, and `eod` policies.

## Phases

### Phase 1 — Manual backfill (~30 min, ship today)

One-off catch-up so the column isn't blank in the UI right now.

Files touched: none (re-runs existing scripts).

Steps:

1. `node scripts/backfill-net-prem-ticks.mjs DAYS=10` to top up
   `net_flow_per_ticker_history` through 2026-05-04. The script is
   idempotent (`ON CONFLICT (ticker, ts, source) DO NOTHING`) so this
   is safe to re-run.
2. `WRITE_DB=1 ml/.venv/bin/python ml/experiments/lottery-net-flow-eda/exit_simulation.py`
   with the date window in the script extended to 2026-05-04. The
   parquet for 2026-05-04 already exists locally; older dates inside
   the existing window are no-ops because the UPDATE only changes
   rows whose `inversion_pct` it just computed.
3. Confirm via `SELECT COUNT(*) FROM lottery_finder_fires WHERE date >= '2026-05-02' AND realized_flow_inversion_pct IS NULL` that backfill succeeded.

Skipped if the script's hardcoded `WHERE date <= '2026-05-01'` filter
needs widening — that's a one-line edit, not worth a separate phase.

### Phase 2 — REST-driven flow-inversion cron (~1–2 days)

**REVISED 2026-05-05** after confirming UW does **not** publish an
`option_quotes` WebSocket channel (verified via
`https://api.unusualwhales.com/api/socket`). UW does expose
`/api/option-contract/{id}/intraday`, which returns per-minute NBBO
bid/ask and per-side volume for any option chain. Phase 2 now runs
entirely server-side post-close — no daemon, no new WS subscriptions,
no Railway redeploy.

Files to create:

- `api/_lib/db-migrations.ts` migration #125 — `option_intraday_nbbo`
  cache table (per-minute NBBO bid/ask per option chain).
- `api/_lib/option-intraday.ts` — UW REST helper:
  `fetchAndCacheOptionIntraday(chainId, dateCt)` calls
  `/option-contract/{chainId}/intraday?date=YYYY-MM-DD` via the
  existing `uwFetch`, parses minute rows, upserts into the cache,
  returns the minute time-series `[{minute, bid, ask, mid}]`.
- `api/_lib/flow-inversion.ts` — pure-function TS port of
  `simulate_flow_inversion` (peak detect + 5-min slope + 3-min persist).
- `api/cron/fetch-net-flow-history.ts` — daily 16:30 CT cron that
  populates `net_flow_per_ticker_history` for today (so the enrichment
  cron has flow data to read). Idempotent on `(ticker, ts, source)`.
- `api/__tests__/option-intraday.test.ts` — UW response parse + cache
  upsert.
- `api/__tests__/flow-inversion.test.ts` — synthetic flow + price
  series covering `inversion`, `eod_no_inversion_window`,
  `flat_flow_no_peak`, `no_post_trigger_prices`,
  `insufficient_flow_data` branches.
- `api/__tests__/fetch-net-flow-history.test.ts` — cron test using
  the standard `vi.mocked(getDb)` + `mockResolvedValueOnce` pattern.

Files to modify:

- `api/cron/enrich-lottery-outcomes.ts` — for each fire:
  1. `fetchAndCacheOptionIntraday(option_chain_id, date)` →
     per-minute mids.
  2. Load post-trigger flow from `net_flow_per_ticker_history` for
     `(ticker, date)`.
  3. `simulateFlowInversion(...)` → `realized_flow_inversion_pct`.
  4. Batch-update `lottery_finder_fires`.
- `api/__tests__/enrich-lottery-outcomes.test.ts` — extend mock SQL
  sequence + assert the new UPDATE call.
- `api/__tests__/db.test.ts` — register migration #125 in the
  applied-migrations mock + expected output + bump SQL call count.
- `vercel.json` — add the new `fetch-net-flow-history` cron schedule
  (`30 21 * * 1-5` UTC = 16:30 CT, post-close).

#### Schema (option_intraday_nbbo cache)

```sql
CREATE TABLE option_intraday_nbbo (
  option_chain      TEXT          NOT NULL,
  ts                TIMESTAMPTZ   NOT NULL,         -- minute bucket, UTC
  nbbo_bid          NUMERIC(12,4),
  nbbo_ask          NUMERIC(12,4),
  volume_ask_side   INTEGER,
  volume_bid_side   INTEGER,
  volume_mid_side   INTEGER,
  ingested_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (option_chain, ts)
);

CREATE INDEX option_intraday_nbbo_chain_ts_idx
  ON option_intraday_nbbo (option_chain, ts DESC);
```

No retention cron yet — table size estimate is ~263 chains × ~390
minutes/day × 252 trading days = ~26M rows/year, well within Neon's
default storage.

#### Volume + cost

REST cost per close: ~263 unique chains/day × 1 call each = 263
calls. UW Advanced rate limit is 120 req/min; with `p-limit(2)`
concurrency the post-close fan-out finishes in ~2.5 min. Idempotent
re-runs are free (cache short-circuits the REST call).

#### Algorithm (1:1 port of `exit_simulation.py:simulate_flow_inversion`)

1. Load post-trigger flow rows from `net_flow_per_ticker_history`
   (`source = 'rest'`) for `(ticker, date)`.
2. Load post-trigger NBBO from `option_intraday_nbbo` for
   `(option_chain, date)`; minute mid = `(bid + ask) / 2`.
3. Detect cumulative-flow peak via local-max-with-prominence >=
   `PEAK_PROMINENCE_RATIO` (5%) of cumulative range. TS port of
   `scipy.signal.find_peaks` prominence — minimal ~40-line
   implementation (Open question 3).
4. From peak, compute 5-min slope = `(cum[i] - cum[i-5]) / 5`; walk
   forward and exit on the first index where 3 consecutive slopes are
   negative. Fallback to EOD (15:00 CT) if no inversion found.
5. Skip cost-netting in the cron — the EDA wrote the gross
   `inversion_pct` to `realized_flow_inversion_pct`, so the port does
   the same for parity.

#### Out of scope for this phase

- Re-running the 47,658 historic rows (mid-from-parquet path) against
  the new mid-from-UW path. Open question 5 default: keep historic.
- A daemon-based per-tick NBBO stream. The current cost/effort math
  doesn't justify it — `/intraday` minute bars are sufficient for
  flow-inversion fidelity.

## Data dependencies

- New table: `option_intraday_nbbo` (Phase 2 cache).
- New cron: `fetch-net-flow-history` (Phase 2).
- New env vars: none. Existing `UW_API_KEY`, `DATABASE_URL`,
  `CRON_SECRET` cover all phases.
- No changes to `lottery_finder_fires` schema — column already exists
  from migration #124.

## Open questions

| # | Question | Resolution |
| - | -------- | ---------- |
| 1 | ~~Filter strategy for option_quotes volume?~~ | OBSOLETE — REST per-fire approach has no firehose problem. |
| 2 | ~~Does UW expose `option_quotes:<TICKER>`?~~ | RESOLVED — no, confirmed via UW socket channels endpoint. Pivoted to REST `/option-contract/{id}/intraday`. |
| 3 | Peak detection without scipy? | Minimal prominence port, ~40 lines. |
| 4 | Run Phase 1 against the existing parquet window edit, or extend the script's date filter? | RESOLVED — edited the date filter. |
| 5 | Should `realized_flow_inversion_pct` historic values (47,658 rows from EDA parquet path) be re-run with the new REST-NBBO path? | No — keep historic, only forward-fill. |
| 6 | Should the cron skip a fire when intraday NBBO is unavailable (e.g. UW returns 404 / empty)? | Yes — log + skip + leave column NULL. Matches EDA's `no_post_trigger_prices` behavior. |

## Thresholds / constants

(Frozen from `exit_simulation.py`, do not re-tune in the port.)

- `PEAK_PROMINENCE_RATIO = 0.05`
- `INVERSION_SLOPE_WINDOW_MIN = 5`
- `INVERSION_NEG_PERSIST_MIN = 3`
- `EOD_CT = 15:00`

(Cost-netting constants `COMMISSION_USD_PER_CONTRACT_RT` and
`SLIPPAGE_PCT_OF_SPREAD` are out of scope — the column stores the
gross %, matching what the EDA WRITE_DB path persists.)

## Sequencing

1. ✅ Phase 1 — done 2026-05-05. `realized_flow_inversion_pct` filled
   for all fires through 2026-05-04 with finite algorithm output.
2. Phase 2 — single feature branch, all files together. Order within:
   migration → intraday helper → flow-inversion helper →
   fetch-net-flow-history cron → enrich-lottery-outcomes wiring →
   tests → review → commit → PR.
