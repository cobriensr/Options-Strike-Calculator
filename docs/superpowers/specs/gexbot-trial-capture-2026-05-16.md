# GEXBot Orderflow-Tier Trial Capture — 2026-05-16

## Goal

Capture **every API endpoint accessible at the Orderflow tier** (which
inherits Classic + State) once per minute during market hours for the full
Index + ETF watchlist, so that by end of trial (~30 days) we have enough
data to answer two questions:

1. **Do GEXBot's proprietary scalars (`zcvr`, `zgr`, `dexoflow`, `gexoflow`,
   `cvroflow`) carry signal that `periscope_snapshots` and `index_candles_1m`
   don't already capture?**
2. **Can we reverse-engineer the `convexity_ratio` / `gex_ratio` formulas
   from the captured data + our own per-strike tables, so we can compute
   them locally after the trial ends?**

If answer to (1) is no → cancel, no loss.
If answer to (1) is yes and (2) is yes → cancel + self-compute permanently.
If (1) is yes and (2) is no → keep subscribing.

## Context

User subscribed to the GEXBot Orderflow tier on 2026-05-16 to access the
charts UI; API access comes bundled. This spec captures the API data during
the trial so we can quantify value before renewal/cancel decision.

`GEXBOT_API_KEY` env var is already set in Vercel and added to
`.env.example:140`.

Field-by-field comparison vs existing stack lives in the conversation
transcript (parsed from `github.com/nfa-llc/gexbot-openapi`,
`latest/gexbot.spec3.yaml`, OAS 3.0.1, GEXBot v2.2.0). Auth is
`Authorization: Bearer gexbot_custom_<secret>`. Rate limit: 1 req/sec per
(ticker, metric). Refresh ≤ 1/sec. HTTP timeout ≤ 1s required.

## Decisions

| Decision                     | Choice                                                                                                           | Rationale                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Polling cadence              | **1/min via Vercel cron**                                                                                        | Fits existing patterns; sub-minute can come later if data warrants                                                                                                                           |
| Ticker coverage              | **16 tickers** (full Index + ETF watchlist from GEXBot UI)                                                       | One cron, ~16 calls/min total — well under rate limit                                                                                                                                        |
| Endpoint coverage            | **All tier-eligible endpoints** (orderflow + state-per-strike × 8 categories + classic-maxchange × 2 categories) | Maximize trial data — we won't know which fields matter until we look                                                                                                                        |
| Storage shape                | **Hybrid: scalar table + generic JSONB capture table**                                                           | Scalars for the orderflow endpoint we know we'll query hot; raw JSONB for everything else (extract later as patterns emerge)                                                                 |
| **Archive + retention**      | **Daily Parquet → Vercel Blob; DB keeps 2 days (today + yesterday)**                                             | Mirrors `ws_option_trades` retention pattern. GEXBot has no historical files, so we are the archive of record.                                                                               |
| **Archive tooling**          | **TypeScript Vercel cron + `@dsnp/parquetjs`**                                                                   | Single platform with the fetch + cleanup crons. Volume (~85k rows/day) fits comfortably in a 300s function. Can swap to Railway Python sidecar in one PR if the JS Parquet writer struggles. |
| **Cleanup tooling**          | **TypeScript Vercel cron**                                                                                       | Mirrors `cleanup-ws-option-trades.ts` exactly — same batching, wall budget; audit-gated for safety                                                                                           |
| Analysis correlation targets | `periscope_snapshots` + `index_candles_1m`                                                                       | Tests "does GEXBot beat Periscope" and "do scalars lead price"                                                                                                                               |

**Endpoints captured (per ticker per minute):**

| #   | Endpoint                      | Why                                      |
| --- | ----------------------------- | ---------------------------------------- |
| 1   | `/orderflow/orderflow`        | Orderflow scalars + basic per-strike GEX |
| 2   | `/state/gamma_zero`           | Per-strike 0DTE gamma                    |
| 3   | `/state/delta_zero`           | Per-strike 0DTE delta                    |
| 4   | `/state/vanna_zero`           | Per-strike 0DTE vanna                    |
| 5   | `/state/charm_zero`           | Per-strike 0DTE charm                    |
| 6   | `/state/gamma_one`            | Per-strike 1DTE+ gamma                   |
| 7   | `/state/delta_one`            | Per-strike 1DTE+ delta                   |
| 8   | `/state/vanna_one`            | Per-strike 1DTE+ vanna                   |
| 9   | `/state/charm_one`            | Per-strike 1DTE+ charm                   |
| 10  | `/classic/gex_zero/maxchange` | 0DTE GEX strike-change (6 windows)       |
| 11  | `/classic/gex_one/maxchange`  | 1DTE+ GEX strike-change                  |
| 12  | `/classic/gex_full/maxchange` | Full-DTE GEX strike-change               |
| 13  | `/state/gamma_zero/maxchange` | 0DTE gamma strike-change (per-window)    |
| 14  | `/state/delta_zero/maxchange` | 0DTE delta strike-change                 |
| 15  | `/state/vanna_zero/maxchange` | 0DTE vanna strike-change                 |
| 16  | `/state/charm_zero/maxchange` | 0DTE charm strike-change                 |
| 17  | `/state/gamma_one/maxchange`  | 1DTE+ gamma strike-change                |
| 18  | `/state/delta_one/maxchange`  | 1DTE+ delta strike-change                |
| 19  | `/state/vanna_one/maxchange`  | 1DTE+ vanna strike-change                |
| 20  | `/state/charm_one/maxchange`  | 1DTE+ charm strike-change                |

**Total: 20 endpoints × 16 tickers = 320 calls/min** ≈ 5.3/sec.
Well under GEXBot's 1/sec per (ticker, metric) — each (ticker, endpoint)
pair is polled 1/min, not 1/sec.

**Cron split:**

- **`fetch-gexbot-fast`** (192/min): orderflow + 3 classic-maxchange + 8
  state-maxchange. All small-payload responses.
- **`fetch-gexbot-strikes`** (128/min): 8 state per-strike endpoints
  (~30 KB JSONB per row). Isolated so its wall-time budget doesn't
  share a function with the small-payload calls.

**Deliberately skipped:**

- **`/{*}/majors`** — `zero_gamma`, `major_pos_*`, `major_neg_*` already
  in the orderflow + state `/{category}` responses (field-for-field
  redundant)
- **`/state/{gamma,delta,vanna,charm}` (no `_zero`/`_one` suffix)** —
  all-DTE per-strike Greeks; nearly derivable from `_zero` + `_one`
  rows (misses 2DTE+ but that's marginal for a 0DTE-primary trader)
- **`/{*}/{*}/majors` for state** — same key-levels redundancy as above
- **`/tickers`** — static; one-off fetch only if needed (not crons)
- **`/{ticker}/classic/{category}` (base, no sub-route)** — the
  orderflow response carries the same `basic_response` superset
  (spot/zero_gamma/strikes/sum_gex/etc.)

**Tickers (from user's GEXBot UI screenshots):**

- **Indexes (6):** `SPX`, `ES_SPX`, `NDX`, `NQ_NDX`, `RUT`, `VIX`
- **ETFs (10):** `SPY`, `QQQ`, `IWM`, `TLT`, `GLD`, `USO`, `TQQQ`, `UVXY`,
  `HYG`, `SLV`

Both `SPX⇒ES` and `NDX⇒NQ` map to GEXBot's variant slugs `ES_SPX` and
`NQ_NDX` per `latest/gexbot.spec3.yaml` `ticker_variant` enum.

## Phases

### Phase 1 — Migration #156 + DB scaffolding

Files to modify:

- `api/_lib/db-migrations.ts` — add migration #156 creating
  `gexbot_snapshots` (orderflow scalars) + `gexbot_api_capture` (generic
  raw JSONB) tables
- `api/__tests__/db.test.ts` — append `{id: 156}` to applied-migrations
  mock + expected output + SQL call count (note: migration emits 2 CREATE
  TABLE + 4 CREATE INDEX + 1 INSERT INTO schema_migrations)

**Table 1 — `gexbot_snapshots`** (orderflow scalars, hot-query path):

```sql
CREATE TABLE gexbot_snapshots (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ticker TEXT NOT NULL,
  source_timestamp BIGINT,            -- GEXBot's own "timestamp" field
  spot NUMERIC,
  zero_gamma NUMERIC,
  -- 0DTE block (z_ prefix)
  z_mlgamma NUMERIC, z_msgamma NUMERIC,
  zero_mcall NUMERIC, zero_mput NUMERIC,
  zcvr NUMERIC, zgr NUMERIC,
  zvanna NUMERIC, zcharm NUMERIC,
  -- 1DTE+ block (o_ prefix)
  o_mlgamma NUMERIC, o_msgamma NUMERIC,
  one_mcall NUMERIC, one_mput NUMERIC,
  ocvr NUMERIC, ogr NUMERIC,
  ovanna NUMERIC, ocharm NUMERIC,
  -- aggregate DEX
  agg_dex NUMERIC, one_agg_dex NUMERIC,
  agg_call_dex NUMERIC, one_agg_call_dex NUMERIC,
  agg_put_dex NUMERIC, one_agg_put_dex NUMERIC,
  -- net DEX
  net_dex NUMERIC, one_net_dex NUMERIC,
  net_call_dex NUMERIC, one_net_call_dex NUMERIC,
  net_put_dex NUMERIC, one_net_put_dex NUMERIC,
  -- orderflow rates
  dexoflow NUMERIC, gexoflow NUMERIC, cvroflow NUMERIC,
  one_dexoflow NUMERIC, one_gexoflow NUMERIC, one_cvroflow NUMERIC,
  -- inherited from basic_response
  sum_gex_vol NUMERIC, sum_gex_oi NUMERIC,
  major_pos_vol NUMERIC, major_pos_oi NUMERIC,
  major_neg_vol NUMERIC, major_neg_oi NUMERIC,
  delta_risk_reversal NUMERIC,
  min_dte INT, sec_min_dte INT,
  raw_response JSONB NOT NULL
);

CREATE INDEX gexbot_snapshots_ticker_time_idx
  ON gexbot_snapshots (ticker, captured_at DESC);
CREATE INDEX gexbot_snapshots_captured_at_idx
  ON gexbot_snapshots (captured_at DESC);
```

**Table 2 — `gexbot_api_capture`** (generic raw-response store for all
non-orderflow endpoints — state-per-strike + maxchange):

```sql
CREATE TABLE gexbot_api_capture (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ticker TEXT NOT NULL,
  endpoint TEXT NOT NULL,             -- e.g. 'state', 'classic'
  category TEXT NOT NULL,             -- e.g. 'gamma_zero', 'gex_zero/maxchange'
  source_timestamp BIGINT,            -- response.timestamp if present
  raw_response JSONB NOT NULL
);

CREATE INDEX gexbot_api_capture_ticker_time_idx
  ON gexbot_api_capture (ticker, endpoint, category, captured_at DESC);
CREATE INDEX gexbot_api_capture_captured_at_idx
  ON gexbot_api_capture (captured_at DESC);
```

**Table 3 — `gexbot_archive_audit`** (record of every successful
Parquet → Blob export; gates the cleanup cron):

```sql
CREATE TABLE gexbot_archive_audit (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,           -- 'gexbot_snapshots' | 'gexbot_api_capture'
  archive_date DATE NOT NULL,         -- ET trading date being archived
  row_count BIGINT NOT NULL,
  blob_url TEXT NOT NULL,             -- public-or-private blob URL of the parquet
  blob_size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (table_name, archive_date)
);

CREATE INDEX gexbot_archive_audit_date_idx
  ON gexbot_archive_audit (archive_date DESC);
```

Rationale for hybrid: we know exactly what we want to query on the
orderflow response (the proprietary scalars — `zcvr`/`zgr`/`dexoflow`/etc.).
For the state per-strike and maxchange data, we don't yet know which
fields will matter — store raw, extract later via SQL views or follow-up
migrations once patterns emerge.

`strikes[]` and `max_priors` arrays in the orderflow response stay inside
`raw_response` (not extracted). Per-strike data is for ad-hoc queries.

The audit table is the **safety gate**: cleanup cron will only delete rows
for a (table, date) pair that has a verified audit row. Failed archive →
no cleanup → data preserved for retry. Idempotent re-archives just
update the existing audit row via `ON CONFLICT (table_name, archive_date)
DO UPDATE`.

### Phase 2 — `api/_lib/gexbot-client.ts`

Files to create:

- `api/_lib/gexbot-client.ts` — typed wrapper with:
  - `fetchOrderflow(ticker: string): Promise<OrderflowResponse>`
  - `fetchStatePerStrike(ticker: string, category: StateCategory): Promise<BasicResponse>`
  - `fetchMaxchange(ticker: string, category: 'gex_zero' | 'gex_full'): Promise<MaxchangeResponse>`
  - Zod schemas validating each response shape (per
    `latest/gexbot.spec3.yaml`)
  - 1s HTTP timeout per call via `AbortController`
  - `Authorization: Bearer gexbot_custom_<GEXBOT_API_KEY>` header
  - `User-Agent: strike-calculator/1.0` + `Accept: application/json`
  - Throws on non-2xx; caller decides Sentry strategy
  - Exports `GEXBOT_TICKERS` const (16 tickers) and `STATE_CATEGORIES`
    const (8 entries: `gamma_zero`, `delta_zero`, `vanna_zero`,
    `charm_zero`, `gamma_one`, `delta_one`, `vanna_one`, `charm_one`)

Pattern mirrors `api/_lib/uw-fetch.ts` but simpler (no rate limiter — Vercel
cron cadence keeps us well under GEXBot's 1/sec/ticker limit).

### Phase 3 — Cron handlers (two crons)

To keep each cron's wall time and failure blast radius small, split into
**two crons that both fire every minute**:

**Cron A: `api/cron/fetch-gexbot-fast.ts`** (192 calls/min)

- 16 × `/orderflow/orderflow` → `gexbot_snapshots` (extract scalars +
  store raw)
- 16 × `/classic/gex_zero/maxchange` → `gexbot_api_capture` (raw only)
- 16 × `/classic/gex_full/maxchange` → `gexbot_api_capture` (raw only)

**Cron B: `api/cron/fetch-gexbot-strikes.ts`** (128 calls/min)

- 16 tickers × 8 state categories (`{gamma,delta,vanna,charm}_{zero,one}`)
  → `gexbot_api_capture` (raw only)

Both handlers:

- `cronGuard(req)` (CRON_SECRET check)
- `if (!isMarketHours()) return res.status(200).json({skipped:true})`
- `Promise.allSettled(...)` across all calls
- Batched `INSERT` per target table (one query per table per cron)
- Sentry.captureException per (ticker, endpoint) on fetch/parse failure
  (tagged with both)
- Returns `{stored: N, failed: M}`

Files to create:

- `api/cron/fetch-gexbot-fast.ts`
- `api/cron/fetch-gexbot-strikes.ts`
- `api/__tests__/fetch-gexbot-fast.test.ts` — tests:
  1. Rejects without CRON_SECRET → 401
  2. Skips outside market hours
  3. Happy path: 192 successful fetches → 16 orderflow rows + 176
     batched capture rows (48 classic-maxchange + 128 state-maxchange)
  4. Partial failure: one ticker errors on orderflow → 15 orderflow rows,
     full 176 captures, Sentry called once
- `api/__tests__/fetch-gexbot-strikes.test.ts` — tests:
  1. Rejects without CRON_SECRET → 401
  2. Skips outside market hours
  3. Happy path: 128 successful fetches → 128 capture rows
  4. Partial failure: one (ticker, category) errors → 127 rows, Sentry once

Files to modify:

- `vercel.json` — add two cron entries:

  ```json
  {"path": "/api/cron/fetch-gexbot-fast",    "schedule": "* 13-21 * * 1-5"},
  {"path": "/api/cron/fetch-gexbot-strikes", "schedule": "* 13-21 * * 1-5"}
  ```

  (every minute, 9am-5pm ET, Mon-Fri — same pattern as `fetch-spot-gex.ts`)

### Phase 4a — Archive (TypeScript Vercel cron + `@dsnp/parquetjs`)

Files to create:

- `api/_lib/gexbot-parquet.ts` — Parquet writer helper:
  - `writeParquet<T>(rows: AsyncIterable<T>, schema: ParquetSchema): Promise<Buffer>`
  - Uses `@dsnp/parquetjs` `ParquetWriter` streaming into a `WritableStreamBuffer`
  - Snappy compression, row-group size 50k
  - Computes SHA-256 of the final buffer alongside the bytes

- `api/cron/archive-gexbot.ts` — TS cron handler:
  1. `cronGuard(req, res, { marketHours: false, requireApiKey: false })`
  2. Compute `archiveDate` = yesterday (ET) — today is still being
     written to by the 1-min fetch crons
  3. For each target table (`gexbot_snapshots`, `gexbot_api_capture`): - Build per-table `ParquetSchema` (typed columns for
     `gexbot_snapshots`; `{ captured_at, ticker, endpoint, category,
source_timestamp, raw_response_json: UTF8 }` for `api_capture`
     where `raw_response_json` is the JSONB serialized as a string —
     Parquet doesn't have a native JSONB type) - Stream rows via `db.unsafe(SELECT ...)` with a chunked cursor
     pattern (the Neon serverless driver supports
     `cursor.read(batchSize)`); accumulate ~10k rows per chunk - Pipe through `writeParquet()` → Buffer - `put(...)` to Vercel Blob at
     `gexbot/{table}/{yyyy-mm-dd}.parquet` via `@vercel/blob`
     (`access: 'public' | 'private'` matching the store config —
     check existing `scripts/upload-archive-to-blob.mjs`) - HEAD via `head(url)` from `@vercel/blob`; verify `size === buffer.length` - `INSERT INTO gexbot_archive_audit ... ON CONFLICT (table_name,
archive_date) DO UPDATE` so re-runs are idempotent
  4. Sentry tag `cron.job: 'archive-gexbot'`
  5. Returns per-table `{ table, archiveDate, rowCount, blobUrl,
bytes, sha256, archived }`
  6. `export const config = { maxDuration: 300 }`

- `api/__tests__/archive-gexbot.test.ts` — tests:
  1. Rejects without CRON_SECRET → 401
  2. Empty table for archive date → records audit row with `row_count: 0`
     and a 0-byte (or schema-only) Parquet
  3. Happy path: 100 mock rows per table → Parquet round-trip parses, audit
     rows written, Blob `put()` + `head()` called per table
  4. Blob HEAD size mismatch → throw + Sentry capture + no audit row
  5. Idempotent re-run for same `archive_date` updates the audit row
     (verified via `ON CONFLICT DO UPDATE`)

Files to modify:

- `package.json` — add `@dsnp/parquetjs` and ensure `@vercel/blob` is
  in dependencies (already used by `scripts/upload-archive-to-blob.mjs`
  so likely present)
- `vercel.json` — add one cron entry:

  ```json
  { "path": "/api/cron/archive-gexbot", "schedule": "30 21 * * 1-5" }
  ```

  (21:30 UTC, Mon–Fri — same days the fetch crons ran; archive runs
  AFTER the 21:00 UTC fetch-stop boundary, so today's complete dataset
  is in DB before we snapshot yesterday's. Mon's run archives Fri's
  data since no fetches happened over the weekend.)

**Wait — schedule correction:** since fetch crons run Mon–Fri 13–21 UTC,
data lands in DB on those days only. Yesterday-ET on Monday is Sunday
(no data). The schedule should be **Tue–Sat at 21:30 UTC**, not Mon–Fri.
But Vercel cron uses standard cron and the weekday field convention
matches (Tue–Sat = `2-6`). Final schedule:

```json
{ "path": "/api/cron/archive-gexbot", "schedule": "30 21 * * 2-6" }
```

This archives the prior weekday's data Tue–Sat (covering Mon–Fri
trading sessions).

### Phase 4b — Cleanup (TypeScript Vercel cron, audit-gated)

Files to create:

- `api/cron/cleanup-gexbot.ts` — TS cron handler, mirrors
  `api/cron/cleanup-ws-option-trades.ts` pattern:
  - `cronGuard(req)` with `marketHours: false, requireApiKey: false`
  - For each target table: - Look up max archived date in `gexbot_archive_audit` for that table - Compute `safe_cutoff = LEAST(today_et - INTERVAL '1 day',
max_archived_date)` — only delete what's confirmed-archived - 50k-row batched `DELETE` loop with 295s wall budget - Track totals, return `{table, deleted, batches, durationMs}` per
    table
  - Sentry tag: `cron.job: 'cleanup-gexbot'`
  - `export const config = { maxDuration: 300 }`

- `api/__tests__/cleanup-gexbot.test.ts` — tests:
  1. Rejects without CRON_SECRET → 401
  2. No audit rows → deletes nothing (safety)
  3. Audit row for yesterday + today's data → only yesterday's rows
     deleted from each table
  4. Wall budget exhaustion returns `stopReason: 'wall_budget'` and
     remaining rows stay
  5. Cleanup runs both tables in sequence (no early bail-out if one
     errors)

Files to modify:

- `vercel.json` — add one cron entry:

  ```json
  { "path": "/api/cron/cleanup-gexbot", "schedule": "15 12 * * 1-5" }
  ```

  (12:15 UTC, pre-market, **10 min after** `cleanup-ws-option-trades`
  at 12:05 UTC — avoids autoscale ceiling contention per the
  ws-option-trades retention spec's stagger note)

### Phase 5 — Verify

- `npm run review` (tsc + eslint + prettier + vitest --coverage) — must pass
- After first deploy: manually trigger
  `GET /api/cron/archive-gexbot` (with `CRON_SECRET`) once after a
  trading day to smoke-test the Parquet writer + Blob upload + audit
  row insertion, BEFORE relying on the scheduled cron for cleanup.

### Phase 6 — Code review subagent

- Run `code-reviewer` agent on `git diff` — verdict pass/continue/refactor

### Phase 7 — Commit + push

- Direct to `main` (per [[feedback_direct_to_main]] memory)
- Commit message: `feat(gexbot): Phase 1 — trial-capture cron + migration #156`

---

## Out of scope (later phases — separate specs)

- **Week-1 spot check** — run a SQL distribution check after first 5 trading
  days. Confirm data is flowing for all 16 tickers, no nulls in scalar
  columns, JSONB blobs parse round-trip.
- **Week-2 analysis** — correlation matrix: GEXBot scalars vs
  `periscope_snapshots` deltas vs `index_candles_1m` 1-min realized range.
  Output → `ml/findings/gexbot-trial-week2-2026-XX-XX/`.
- **End-of-trial decision doc** — keep/cancel/self-compute, with the
  evidence cited.

## Open questions

- **`strikes[]` capture later?** — if the per-strike `[strike, value_1,
value_2, [5 priors]]` array turns out to matter, we add a child table
  `gexbot_strike_snapshots` in a follow-up migration. Not now.
- **Schwab `delta_risk_reversal` comparison** — GEXBot ships RR; we don't
  store it. If we want to validate their definition, add a Schwab-chain
  derived RR computation. Out of scope here.
- **Sub-minute upgrade** — if 1/min is too slow once data lands, build a
  Railway sidecar service polling at 5–10s. Defer until we know the data
  is worth the granularity.

## Thresholds / constants

| Constant            | Value                                                        | Location                                       |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| Fetch cadence       | every minute, 13–21 UTC, Mon–Fri                             | `vercel.json` cron schedule (×2 fetch crons)   |
| Archive cadence     | 21:30 UTC, Tue–Sat (archives prior Mon–Fri)                  | `vercel.json` → `api/cron/archive-gexbot.ts`   |
| Cleanup cadence     | 12:15 UTC, Mon–Fri (10 min after `cleanup-ws-option-trades`) | `vercel.json`                                  |
| Retention window    | 2 days (today + yesterday)                                   | `cleanup-gexbot.ts`, audit-gated               |
| HTTP timeout        | 1000 ms per call                                             | `gexbot-client.ts` AbortController             |
| Auth prefix         | literal `gexbot_custom_`                                     | hard-coded in client                           |
| Ticker list         | 16 (above)                                                   | exported const `GEXBOT_TICKERS` in client      |
| State categories    | 8 (`{gamma,delta,vanna,charm}_{zero,one}`)                   | exported const `STATE_CATEGORIES`              |
| Classic maxchange   | 3 (`gex_zero`, `gex_one`, `gex_full`)                        | exported const `MAXCHANGE_CATEGORIES`          |
| State maxchange     | 8 (same as `STATE_CATEGORIES`)                               | exported alias `STATE_MAXCHANGE_CATEGORIES`    |
| Fan-out concurrency | 32 per cron tick                                             | `FETCH_CONCURRENCY` in `fetch-gexbot-fast.ts`  |
| Sentry error cap    | 10 captures + 1 summary message per tick                     | `SENTRY_CAPTURE_CAP` in `fetch-gexbot-fast.ts` |
| Total calls/min     | 320 (192 fast + 128 strikes)                                 | —                                              |
| Migration id        | 156                                                          | next available after #155                      |
| Parquet compression | Snappy, 50k-row row groups                                   | `archive_gexbot_daily.py`                      |
| Blob key format     | `gexbot/{table}/{yyyy-mm-dd}.parquet`                        | `archive_gexbot_daily.py`                      |

## Risk notes

- **320 calls/min across two fetch crons** — GEXBot rate limit is per
  (ticker, metric), not global. `Promise.allSettled` across distinct
  (ticker, endpoint) pairs is compliant: each pair is polled 1/min, well
  under the 1/sec/(ticker, metric) cap.
- **Vercel function wall time** — `fetch-gexbot-strikes` fires 128 parallel
  HTTP calls with 1s individual timeout. Wall time should land in 2–4s;
  Hobby plan cron function timeout is 10s. Production timeout is 300s.
  Fits both.
- **GEXBot outage** — `Promise.allSettled` means one (ticker, endpoint)
  failing doesn't cascade. Sentry tags `(ticker, endpoint, statusCode)`
  so we can distinguish GEXBot-wide outage from a single-symbol issue.
- **DB growth — bounded by archive + cleanup** — At steady state, DB
  holds **today + yesterday** = ~2 days of fetched data:
  - `gexbot_snapshots`: 16 × 60 × 8h × 2d = 15k rows
  - `gexbot_api_capture` (maxchange): 32 × 60 × 8h × 2d = 30k rows
  - `gexbot_api_capture` (state per-strike): 128 × 60 × 8h × 2d = 123k
    rows, ~30 KB JSONB each ≈ **3.5 GB live**
  - Total live DB footprint: ~**3.5 GB peak** (vs 28–41 GB/month
    without retention).
- **Blob growth** — Parquet w/ Snappy compresses raw JSONB ~5–10×.
  Daily Parquet size estimates:
  - `gexbot_snapshots`: ~5 MB/day
  - `gexbot_api_capture`: ~150–250 MB/day (state per-strike dominates)
  - **Total: ~3.5–5 GB on Blob over the 22-trading-day trial month** ≈
    $0.05–$0.10/month at Blob pricing.
- **Cleanup safety** — cleanup is audit-gated: if `archive-gexbot.yml`
  workflow fails one night, that date's audit row never appears, so
  cleanup skips it. Next successful archive run restores the audit row;
  cleanup catches up the following day. No data loss possible from a
  single archive failure.
- **Archive failure visibility** — GitHub Actions surfaces failed runs
  as red X in the repo's Actions tab. Set up workflow failure
  notification (email or Slack) before depending on the data.
- **`raw_response` redundancy on `gexbot_snapshots`** — orderflow scalars
  are stored both as flat columns AND inside the JSONB blob. Intentional:
  scalar columns for fast filtering, blob for future-extracted fields we
  didn't anticipate (e.g. if we later care about `strikes[]` or
  `max_priors`).
