# io-efficiency audit — 2026-09-08

Rule R5: stream or batch all I/O; never load-everything-then-loop. Read-only audit of the
`llm-antipattern-audit` worktree (clean checkout of origin/main). No source files modified.

## Method — what you grepped, what you read, counts

**TypeScript (api/, scripts/)**

- `grep` for `node:fs` / `@vercel/blob` importers (7 files), `readFileSync|readFile(|.arrayBuffer()|.text()|split('\n')` (16 sites, all read).
- Two brace-depth scanners (perl, in scratchpad) over every non-test `api/**/*.ts`:
  1. `await sql`/`db`/`withDbRetry(` inside `for`/`while` bodies → 48 sites in 27 files.
  2. `await <helper>(` inside loop bodies (catches `await insertFire(...)`, `await enrichRow(...)`) → 35 sites.
  Every flagged site was read with surrounding context and its rows-per-run derived from the cron cadence
  in `vercel.json` and the data sizes given (86-ticker universe, ~874 SB alerts/day, ~52 lottery fires/day,
  390 bars/session).
- Same scanners over `scripts/*.{mjs,ts,mts}` → 40 files with loop-awaited SQL; the two highest-count and the
  candle backfills read in full; the rest sampled for batching (`BATCH_SIZE`, `unnest`, `VALUES ${...}`).
- `Promise.all(...map(sql))` fan-outs: 14 sites, all bounded (2–7 parallel queries), none per-row.
- `SELECT *` in endpoints: 1 (silent-boom-export, date-bounded). All 12 `ws_option_trades` readers checked for
  time/ticker bounds.

**Python**

- `read_parquet(|pq.read_table(|ParquetFile(|ds.dataset(` across `ml/src`, `scripts`, `sidecar/src`,
  `uw-stream/src` → 136 sites; every `ml/src` site classified (DuckDB/hive pushdown, `columns=`, or bare).
- `.iterrows()|apply(axis=1)` in `ml/src` → 44 sites; the nightly-pipeline ones (`takeit/build_training_set.py`,
  `lottery_scoring.py`) read — all are O(N) deque/window loops over ≤60k-row frames, not I/O.
- Read in full: `uw-stream/src/db.py`, `handlers/base.py`, `handlers/option_trades.py`, `config.py` defaults;
  `sidecar/src/{archive_seeder,batched_writer,bar_writer,stat_writer}.py`; grepped `db.py`, `archive_query.py`,
  `databento_client.py`, `theta_fetcher.py`, all other uw-stream handlers.

**Counts:** ~250 candidate sites examined → 5 verified P1/P2 findings, 6 P3, 30+ batched/streamed patterns
confirmed good. The five IN-FLIGHT files (`uw-rate-limit.ts`, `uw-fetch.ts`, `sentry.ts`, two tests) were
scanned: no R5 findings (`uw-fetch.ts` loops are retry/worker-pool loops over HTTP, not DB; `.text()` is on
error bodies only).

## Findings

### IO-1: fetch-etf-candles-1m re-inserts the whole session per-row every minute  [P1] [confidence: high] [effort: S]

- Where: `api/cron/fetch-etf-candles-1m.ts:62-98` (`storeCandles`), `:122-127` (fetch), schedule `* 13-21 * * 1-5` (`vercel.json:78`)
- What: Each minute the cron fetches `/stock/{SPY,QQQ}/ohlc/1m?date=${today}` — the entire session to date —
  and `storeCandles` does `for (const candle of candles) { await withDbRetry(() => sql\`INSERT ... ON CONFLICT
  (ticker, timestamp) DO NOTHING RETURNING id\`) }`. There is no high-water-mark filter; every already-stored
  candle is re-sent as a no-op INSERT. The two tickers run concurrently (`Promise.allSettled`), so wall time is
  one ticker's sequential chain.
- Failure scenario: at 14:30 CT the response holds ≥390 RTH candles per ticker (more if UW includes
  pre-market). That is ≥780 Neon HTTP round trips per run, ~779 of them no-ops; at 30–50 ms each the run takes
  12–20 s of every 60 s cadence. Summed over the session, `2 × Σ(1..390)` ≈ 152,000 Neon queries/day to land
  780 new rows (0.5 % useful). Any Neon slowdown to 150 ms/query pushes a late-session run past 60 s and it
  overlaps the next tick. The sibling cron `fetch-spx-candles-1m.ts:280` already does this correctly.
- Fix: `SELECT max(timestamp) FROM etf_candles_1m WHERE ticker=$1 AND timestamp >= $today` → keep only
  candles after it → one `INSERT ... SELECT FROM unnest($1::text[], $2::timestamptz[], ...)` (template:
  `api/_lib/gexbot-store.ts:42-54`) or `sql.transaction(candles.map(...))` as `fetch-spx-candles-1m.ts:280`.

### IO-2: backup-tables buffers whole tables in memory with OFFSET paging; strike_exposures can no longer fit  [P1] [confidence: high] [effort: M]

- Where: `api/cron/backup-tables.ts:52` (`EXPORT_CHUNK_ROWS = 50_000`), `:77-106` (`exportTable`), `:150-184`
  (per-table loop + single `put()`), `maxDuration: 300`, no memory override in `vercel.json`
- What: `exportTable` pages with `ORDER BY 1 LIMIT 50000 OFFSET n`, pushes a `Buffer` per row into `chunks[]`,
  then `Buffer.concat(chunks)` (2× peak) and uploads the whole body with one non-multipart `put()`. The file's
  own comment records that on 2026-05-17 a table's JSONL exceeded V8's max string (~512 MiB) — the Buffer
  switch raised the ceiling, it did not remove the load-everything design. There is no `DELETE`/retention on
  `strike_exposures`, `flow_data`, `spot_exposures`, `greek_exposure` anywhere in `api/`.
- Failure scenario: `rollup-ws-gex-strike-expiry` (22:30 UTC daily since 2026-05-18,
  `api/_lib/rollup-ws-gex-strike-expiry.ts:40`) writes ~500k rows/day into `strike_exposures` per its spec
  (`docs/superpowers/specs/ws-gex-strike-expiry-rollup-2026-05-17.md:119`, "~125M rows/year"), on top of the
  REST rows (SPX×2 expiries + SPY + QQQ every 5 min). ~80 trading days later that is ≈40M rows; at ~350 B/row
  JSONL (22 numeric-string columns) ≈ 14 GB. Exporting it means ~280 pages with OFFSET up to 40M (each page
  re-scans the `ORDER BY 1` prefix), a `Buffer.concat` above `Buffer` max (4 GiB) and far above the ~2 GB
  function memory, inside a 300 s budget. The function is killed mid-`strike_exposures` (table 10 of 16), so
  `training_features`, `day_labels`, `economic_events`, `es_bars`, `es_overnight_summaries`,
  `schema_migrations` are never exported, `pruneOldBackups` never runs, and `reportCronRun` never fires —
  the weekly backup is silently partial. The 2026-05-17 RangeError shows this crossed 512 MiB before the rollup
  even started.
- Fix: keyset pagination (`WHERE id > $last ORDER BY id LIMIT 50000`); stream pages straight to Blob with
  `put(path, readableStream, { multipart: true })` (template: `scripts/upload-archive-to-blob.mjs:132-150`) or
  write `backups/{date}/{table}.part-{n}.jsonl` per page; bound the tape tables by date (last N days) or drop
  them from the weekly JSONL and rely on the Parquet archive.

### IO-3: wave2-confirmation issues 1–2 queries per open candidate every 5 min  [P2] [confidence: high] [effort: S]

- Where: `api/cron/wave2-confirmation.ts:174-290` (loop), `:59` (`LOOKBACK_MIN = 70`), schedule `*/5 13-21`
- What: Candidates = every lottery fire / SB alert with `wave2_status IS NULL` in `[now−70 min, now−60 s]`.
  For each: one `SELECT ... LIMIT 1` follow-up lookup, then one `UPDATE ... WHERE id = $1` when resolved.
  Unresolved candidates stay in the set for up to 60 min and are re-queried every tick.
- Failure scenario: at ~874 SB alerts/day the steady-state window holds ≈ 874 × 70/390 ≈ 157 SB candidates
  plus ~10 lottery → ~165 SELECTs + up to 165 UPDATEs = 170–330 sequential round trips ≈ 8–16 s per tick at
  50 ms. SB volume is front-loaded at the open (see memory `lottery-tod-and-firecount-studies`), so open ticks
  carry 300–500 candidates → 15–50 s per 5-min tick, growing linearly with alert volume.
- Fix: one set-based statement per table: `UPDATE silent_boom_alerts c SET wave2_status = ..., wave2_detected_at
  = f.t FROM LATERAL (SELECT bucket_ct t FROM silent_boom_alerts f WHERE f.underlying_symbol = c.underlying_symbol
  AND f.option_type = c.option_type AND f.id <> c.id AND f.bucket_ct > c.bucket_ct AND f.bucket_ct <= c.bucket_ct
  + interval '60 min' ORDER BY f.bucket_ct LIMIT 1) f WHERE c.wave2_status IS NULL AND ...`, plus one
  `UPDATE ... SET wave2_status='fizzled'` for the aged-out remainder. 2–4 round trips total.

### IO-4: detect-silent-boom / detect-lottery-fires run a 3–4 round-trip chain per fire inside a 60 s function  [P2] [confidence: high] [effort: M]

- Where: `api/cron/detect-silent-boom.ts:860` (loop), `:932` (`classifyAlertMultileg`), `:1041`
  (`getLatestGexbotSnapshotAt`), `:1058` (per-fire `INSERT ... RETURNING id`);
  `api/cron/detect-lottery-fires.ts:641`, `:705`, `:841`, `:858`;
  `api/_lib/multileg-classify-batch.ts:231-260` (per-call ws_option_trades window read, `HALF_WINDOW_SEC = 30`,
  `MAX_WINDOW_TRADES = 10000`); `vercel.json:347-348` (`maxDuration: 60`)
- What: Per fire, sequentially: `classifyAlertMultileg` → one `ws_option_trades` read of the whole ticker's
  ±30 s window (up to 10k rows) + one sidecar POST; `getLatestGexbotSnapshotAt` → one query; then a per-row
  INSERT. The multileg cache key is (ticker, chain, minute) so distinct fires almost never share it; the ticker
  flow series is cached (good). Pre-trade counts and co-fire sets are already batched (good).
- Failure scenario: SB runs every 5 min with a 60 s cap. ~874 alerts/day front-loaded at the open → 50–100+
  fires in an open tick. 100 fires × (DB 50 ms + sidecar 100–300 ms + gexbot 30 ms + INSERT 30 ms ≈ 250–400 ms)
  = 25–40 s. A slow classifier (memory `classifier-service-unreachable-triage`: it OOMs at the open) pushes past
  60 s and the function is killed mid-loop; the remaining fires re-detect next tick (35-min scan window +
  `ON CONFLICT DO NOTHING`), so the cost is 5–10 min alert latency and duplicate sidecar load rather than data
  loss. Lottery is the same shape at 1-min cadence but ~52 fires/day, so it only bites on burst days.
- Fix: batch per tick — one `ws_option_trades` read per distinct (ticker, minute) window (or one query over
  `unnest(tickers, starts, ends)`), one sidecar POST for all anchors (`classifyMultilegBatch` already takes a
  trade list, `multileg-classify-batch.ts:311`), one `SELECT DISTINCT ON (ticker) ... FROM gexbot_snapshots
  WHERE ticker = ANY($1)` for all fires, and one multi-row `INSERT ... SELECT FROM unnest(...) RETURNING id`.

### IO-5: archive-gexbot pages by row count with no byte budget, then loads the Parquet file into a Buffer  [P2] [confidence: medium] [effort: S]

- Where: `api/cron/archive-gexbot.ts:43` (`PAGE_SIZE = 5_000`), `:89-116` (page query), `:183-200`
  (`put(result.buffer)`); `api/_lib/gexbot-parquet.ts:68` (`readFile(tmpPath)`); `cleanup-gexbot.ts` audit gate
- What: `gexbot_api_capture` receives 16 tickers × 8 categories = 128 rows/min × ~506 min ≈ 65k rows/day, and
  both `api/_lib/gexbot-store.ts:8` and the spec (`gexbot-trial-capture-2026-05-16.md:88,489`) put
  `raw_response` at ~30 KB JSONB per row. The archive reads `SELECT *` in 5,000-row pages, so one page is
  5,000 × 30 KB ≈ 150 MB of JSON in a single Neon HTTP response. `backup-tables.ts:47-51` documents the Neon
  driver's 64 MiB response cap (HTTP 507, SENTRY-EMERALD-DESERT-6V). After paging, the whole Parquet file
  (spec: 150–250 MB/day) is `readFile`d into a Buffer, hashed, and uploaded with a single non-multipart `put()`;
  Vercel `/tmp` is 500 MB.
- Failure scenario: if the mean `raw_response` is ≥ ~13 KB, the first page of `gexbot_api_capture` exceeds
  64 MiB and 507s every day → `archiveOneTable` throws → no `gexbot_archive_audit` row → `cleanup-gexbot`'s
  audit gate stalls → the table is never trimmed (~65k rows × 30 KB ≈ 1.9 GB/day raw). If the mean is smaller
  and it succeeds, the run still pulls ~1.9 GB of JSON through `JSON.parse` + `JSON.stringify` + JS Parquet
  encoding inside 300 s and holds a 150–250 MB Buffer for the upload. Confidence is medium because the per-row
  size comes from the authors' comments, not a measurement in this audit. Verify with
  `SELECT count(*), avg(pg_column_size(raw_response)) FROM gexbot_api_capture WHERE captured_at::date =
  current_date - 1` and `SELECT archive_date, row_count, blob_size_bytes FROM gexbot_archive_audit ORDER BY 1
  DESC LIMIT 10`.
- Fix: page by a byte budget (`LIMIT 500`, or stop a page when `sum(pg_column_size(raw_response)) OVER (ORDER
  BY id)` passes 32 MB); keep the streaming Parquet writer but upload with
  `put(path, createReadStream(tmpPath), { multipart: true })` and hash while streaming (template:
  `scripts/upload-archive-to-blob.mjs:117-150`).

### IO-6: takeit-fill-shap per-row UPDATE, up to 200 per 2-min run  [P3] [confidence: high] [effort: S]

- Where: `api/cron/takeit-fill-shap.ts:39` (`BATCH_SIZE = 100`), `:187-210`
- What: After one batched sidecar POST, the results are written back one `UPDATE ... WHERE id = $1` at a time,
  per alert type. Steady state is a handful of rows; after a sidecar outage the backlog is drained 100 + 100
  per run → 200 round trips ≈ 6–10 s per 2-min tick until caught up. Bounded, so P3 not P2.
- Fix: `UPDATE lottery_finder_fires f SET takeit_top_features = u.feat FROM unnest($1::int[], $2::jsonb[]) AS
  u(id, feat) WHERE f.id = u.id` — one round trip.

### IO-7: enrich-lottery-outcomes / enrich-silent-boom-outcomes write back one UPDATE per fire  [P3] [confidence: high] [effort: S]

- Where: `api/cron/enrich-lottery-outcomes.ts:211` (`LIMIT 300`), `:285` (loop), `:380` (per-fire UPDATE);
  `api/cron/enrich-silent-boom-outcomes.ts:116`, `:184`, `:258`
- What: The tick fetch is already one LATERAL query for all 300 fires (good), but each enriched fire gets its
  own `UPDATE ... WHERE id = $1`. Nightly, ≤300 round trips ≈ 10–15 s in a 300 s budget; the no-tick path
  already uses `WHERE id = ANY($1::int[])`. Hygiene only.
- Fix: collect outcomes and issue one `UPDATE ... FROM unnest(ids, peak_pct, ...)` per table.

### IO-8: candle backfill scripts insert one row per round trip  [P3] [confidence: high] [effort: S]

- Where: `scripts/backfill-etf-candles-1m.mjs:104-120`, `scripts/backfill-spx-candles-1m.mjs:207-230`
- What: Same per-candle `INSERT ... ON CONFLICT DO NOTHING RETURNING id` loop as IO-1, over every day of the
  backfill. A 60-day, 2-ticker run is 2 × 60 × 390 = 46,800 round trips ≈ 25–40 min; chunked at 500 rows it
  is ~94 queries (<1 min). One-shot scripts, so P3, but the repo's own rule (`feedback_batched_inserts`) is
  violated and `scripts/backfill-lottery-fires.mjs:373-400` / `backfill-dark-pool-prints.mjs:208-275` show the
  right shape.
- Fix: chunk 500 → one `INSERT ... SELECT FROM unnest(...)` per chunk.

### IO-9: ml/src/enrich_lottery_outcomes.py rescans the entire Parquet archive once per fire  [P3] [confidence: high] [effort: M]

- Where: `ml/src/enrich_lottery_outcomes.py:99-126` (`load_option_trades`), `:204-206` (per-fire loop, batch
  1,000)
- What: For every fire it opens a fresh in-memory DuckDB connection and runs
  `read_parquet('{archive}/*.parquet', union_by_name=true) WHERE option_chain_id = ? AND executed_at >= ?`.
  DuckDB pushes the predicates down, but each call re-opens every daily file in the 100+-day archive and reads
  its footer/row-group stats; nothing partitions by date. A 1,000-fire batch is 1,000 full-glob scans. Not on
  the nightly path (`ml/Makefile all`, `ml-pipeline.yml`); imported by research scripts
  (`scripts/feature_audit.py`, `flow_inversion_timing.py`, `recompute_peak_from_parquet.py`). The cron
  equivalent (`api/cron/enrich-lottery-outcomes.ts`) is batched.
- Fix: one connection; register the fire list as a DuckDB table and do a single join (`... FROM read_parquet(glob)
  t JOIN fires f ON t.option_chain_id = f.chain AND t.executed_at >= f.entry`), or hive-partition the archive
  by `date=` and add the date predicate so only that day's file is opened.

### IO-10: ml/src/whale_plots.py concatenates every by-day chain Parquet without column projection  [P3] [confidence: medium] [effort: S]

- Where: `ml/src/whale_plots.py:29`, `:62` (`pl.concat([pl.read_parquet(f) for f in files])`)
- What: Eager `read_parquet` of every `*-chains.parquet` under `scripts/eod-flow-analysis/output/by-day` with
  all columns, then derives ~6 columns. Plotting script, run manually; size grows one file per trading day.
- Fix: `pl.scan_parquet(files).select([...needed])` or `pl.read_parquet(f, columns=[...])`.

## Already good — batched/streamed patterns worth protecting (path:line)

**Neon multi-row writers (templates for the fixes above)**

- `api/_lib/bulk-upsert.ts:43` — 500-row chunked multi-VALUES upsert; multi-chunk runs wrapped in one
  `sql.transaction`.
- `api/_lib/gexbot-store.ts:42-54`, `api/_lib/greek-flow-etf-store.ts:95`, `api/cron/fetch-net-flow-history.ts:151`,
  `api/cron/populate-periscope-from-gexbot.ts:124-136`, `api/cron/refresh-tracker-contracts.ts:349-380`
  (`TICK_INSERT_BATCH_SIZE = 500`) — single `unnest(...)` INSERTs.
- `api/cron/fetch-gex-0dte.ts:181-239`, `api/cron/fetch-gex-strike-expiry-etfs.ts:330-370`,
  `api/cron/backfill-futures-gaps.ts:251-284` (100-row VALUES) — built multi-VALUES via `sql.query`.
- `sql.transaction(rows.map(txn\`INSERT...\`))` = ONE Neon HTTP round trip (N statements server-side):
  `fetch-spx-candles-1m.ts:280`, `fetch-strike-exposure.ts:167`, `fetch-oi-per-strike.ts:53`,
  `fetch-strike-all.ts:121`, `fetch-greek-exposure-strike.ts:89`, `fetch-flow-alerts.ts:112`,
  `fetch-vol-surface.ts:100`, `fetch-strike-iv.ts:497`, `fetch-strike-trade-volume.ts:178`,
  `fetch-oi-change.ts:80`, `fetch-zero-dte-flow.ts:121`, `fetch-greek-flow.ts:98`, `fetch-net-flow.ts:142`,
  `fetch-etf-tide.ts:110`, `curate-lessons.ts:446`, `db.ts:425` (migrations).
- Small bounded per-row loops that are fine as-is (≤16 rows/run): `fetch-gexbot-fast.ts:145` (16 snapshots/min,
  46 cols, justified in `gexbot-store.ts:10`), `fetch-spot-gex.ts:102` (HWM-filtered, ~1–5 rows/min),
  `fetch-futures-snapshot.ts:89` (7), `capture-opening-flow-signal.ts:87` (2), `audit-takeit-health.ts:168`
  (~8), `refresh-tracker-contracts.ts:305/502` (user's tracked contracts), `backfill-gamma-setup-outcomes.ts:139`
  (rare fires, daily), `fetch-outcomes.ts:413` (~40 daily candles).

**Bounded / pushed-down reads**

- `api/cron/detect-lottery-fires.ts:234-257` — 7-min window, narrow projection, split into 3 hash-bucketed
  parallel queries (~21 MB each at open-rate volume, under the 64 MiB cap).
- `api/cron/detect-silent-boom.ts:279-286` — 35-min window aggregated into 5-min buckets in SQL.
- `api/_lib/flow-regime-rows.ts:185-257` — full-day `ws_option_trades` reduced to per-slot sums in SQL.
- `api/cron/enrich-lottery-outcomes.ts:240-263`, `enrich-silent-boom-outcomes.ts:143-166`,
  `evaluate-round-trip.ts:167` — one LATERAL tick fetch for all fires, `LIMIT 300`.
- `api/_lib/opening-flow-evaluator.ts:159-215` — 2 tickers × 5-min slices.
- `api/silent-boom-export.ts:153` — `SELECT *` but date-bounded (~874 rows). `api/lottery-contract-tape.ts:105`
  — chain + time bounded, aggregated in SQL.
- `api/_lib/takeit-bundle-loader.ts:36` — 3.5 MB bundle cached 15 min per instance, manifest-gated refresh.
- `api/_lib/csv-parser/parse.ts:462` (positions CSV, bounded by the 4.5 MB body limit),
  `api/cron/refresh-vix1d.ts:55` (~1k-line CBOE CSV), `api/cron/backfill-futures-gaps.ts:127-132` (NDJSON, a
  few MB per gap) — `split('\n')` on small, bounded payloads.
- `api/cron/archive-gexbot.ts:83-137` — keyset-paginated async generator feeding a streaming Parquet writer
  (`gexbot-parquet.ts:54-66`, `rowGroupSize 50_000`). Keep this half; only the page byte budget and the final
  `readFile`/single `put` need changing (IO-5).

**uw-stream sink (Railway)**

- `uw-stream/src/db.py:130,186-209,289-339` — `_build_multi_row_insert` + `_chunked_rows` capped at
  `MAX_INSERT_PARAMS = 30000` (500 rows × 16 cols = 8,000 params per `ws_option_trades` flush; under both
  the 32,767 wire limit and Postgres' 65,535), one round trip per chunk, `ON CONFLICT DO NOTHING`, transient
  retry (3 attempts, 0.5/1.5 s), `command_timeout=30`, pool 2–10.
- `uw-stream/src/handlers/base.py:51-67,128-179` — bounded `asyncio.Queue(maxsize=50_000)`, flush at
  `ws_batch_size=500` OR `ws_batch_interval_ms=2000`, `drop_oldest` backpressure with a drop counter on
  `/metrics`; `block` policy capped at 50 ms so the WS receive task never stalls. Worst-case memory ≈ 50k ×
  ~2 KB payload ≈ 100 MB per handler; throughput ceiling 500 rows per Neon RTT (~10–25k rows/s) is above the
  open-burst rate, and a slow Neon degrades to bounded, counted drops rather than unbounded growth. All seven
  handlers (`flow_alerts`, `option_trades`, `interval_ba`, `gex_strike_expiry`, `net_flow`, `off_lit_trades`)
  flush through `bulk_insert_ignore_conflict` / `bulk_upsert_replace`.
- `handlers/base.py:184-306` — shutdown drain with a 5 s deadline and a double-flush race guard.

**Sidecar (Railway)**

- `sidecar/src/db.py:47,239-283` — `psycopg2.extras.execute_values(page_size=500)` for options trades,
  TBBO top-of-book, trade ticks, Theta EOD; `sidecar/src/theta_fetcher.py:63,354-360` (`BATCH_FLUSH_SIZE = 500`).
- `sidecar/src/batched_writer.py:80-238` — lock-swap-release-then-write buffer, size + time flush, bounded
  re-queue (`max_buffer_size = 10 × batch`) with counted drops; `trade_processor.py:39` (100/10 s),
  `quote_processor.py:55` (500).
- `sidecar/src/bar_writer.py:80-83`, `stat_writer.py:99-107` — per-row upserts, but ≤7 bars/5 s and ≤42 stat
  rows (21 strikes × 2, `symbol_manager.py:53`) per burst on a background thread; acceptable.
- `sidecar/src/archive_seeder.py:67,174-194,310-386` — 1 MiB streaming chunks, streaming SHA-256, `.tmp` +
  atomic rename, whole-file SHA skip on resume, 4 workers, per-file logging, HTTPS host allowlist. This is the
  reference streaming downloader.
- `sidecar/src/archive_query.py:131-169,237-238` — DuckDB over year-partitioned Parquet globs with predicates,
  thread-local connection, `temp_directory` set.

**Scripts / ML**

- `scripts/upload-archive-to-blob.mjs:117-150` — `createReadStream` → `put(..., { multipart: true })` with
  streaming SHA-256 and a concurrency-limited worker pool (documented as required for >2 GiB files).
- `scripts/backfill-lottery-fires.mjs:35,373-400`, `scripts/backfill-dark-pool-prints.mjs:208-275`,
  `scripts/reload-ws-option-trades-from-fulltape.py:357-376`, `scripts/enrich_lottery_outcomes.py:456-459,576-586`,
  `scripts/recompute_peak_from_parquet.py:755-766` — 500-row chunks / `execute_values(page_size=500)` /
  `columns=` + `filters=` pushdown, `flush=True` progress lines.
- `ml/src/utils/r2.py:82-91,118-129`, `ml/src/flow_archive.py:19`, `ml/src/nq_flow_leadership/load_options_trades.py:74-78`
  — `columns=` / `filters=` pushed into `read_parquet`; `ml/src/eod_flow_*.py`, `setups_backtest/data_loaders.py`,
  `features/microstructure.py` — DuckDB `read_parquet(glob, hive_partitioning=true)` with WHERE pushdown.
- `ml/src/takeit/build_training_set.py:383-530` — the `iterrows` loops are O(N) deque sliding windows, not
  per-row I/O.

## Rule tweaks — how to reword R5 if it would misfire on legitimate code here

1. **Count rows-per-run, not loop shape.** "No await on a single-row query inside a loop" flags 25+ sites here
   whose iteration count is a static constant ≤ 20 (tickers, panels, symbols, migrations, backup TABLES). Reword:
   "a per-row awaited query is a finding when the loop bound is data-driven (rows, candles, alerts, fires) and
   exceeds ~50 per run; static enumerations of ≤ 20 items are exempt."
2. **`sql.transaction(rows.map(...))` on the Neon HTTP driver is one round trip.** It ships N statements in a
   single HTTP request and executes them server-side; it is the repo's dominant batched form (16 crons). R5
   should list it as compliant, with a note that `unnest`/multi-VALUES is preferable above ~1k rows.
3. **"Files over ~10 MB must be streamed" needs a growth qualifier.** `readFile` of a bounded temp file that a
   streaming writer just produced (IO-5's Parquet) is only a problem when the size scales with data volume;
   the takeit bundle (3.5 MB, cached) and per-request PNGs are fine. Reword to "…when the object's size is
   unbounded by data growth, or > ~100 MB."
4. **Accept DuckDB / polars lazy scans as pushdown.** The `columns=`/`filters=` wording would flag every
   `read_parquet(glob) ... WHERE` in `ml/src`, which is correct pushdown. Add "DuckDB `read_parquet` with WHERE
   predicates and `pl.scan_parquet().select()` count as pushed-down"; flag instead *repeated* scans of the same
   glob per row (IO-9).
5. **Add the idempotent-re-store case.** IO-1 is R5's costliest instance but the waste is re-sending
   already-stored rows, not the loop per se. Add: "a job that fetches a cumulative payload (session-to-date
   candles, full-day tide) must diff against a high-water mark before writing."
6. **Add a byte budget to pagination.** Row-count paging (`LIMIT 5000`) is not a memory bound when rows carry
   JSONB; R5 should say "page by rows AND bytes (Neon HTTP responses cap at 64 MiB); JSONB/TEXT-heavy tables
   need a `pg_column_size` budget."
