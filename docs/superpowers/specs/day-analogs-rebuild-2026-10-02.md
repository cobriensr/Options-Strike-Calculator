# Day-analog rebuild from `futures_bars` — 2026-10-02

## Goal

Rebuild the inputs behind the analyze endpoint's "similar days" and
"analog range forecast" blocks so that both work on live analyze calls,
compare like with like, and never see the outcome they predict. Today's
query vector and the historical corpus will both come from the first N
minutes of the ES cash session. The sidecar's DuckDB archive will be
retired as a runtime dependency.

## Status

| Item                                  | State                                                     |
| ------------------------------------- | --------------------------------------------------------- |
| P0 parity (archive vs `futures_bars`) | Done in this branch. Results are in "Phase 0 results".    |
| Window-independent correctness fixes  | Done in this branch (`fix(analogs): …`).                  |
| P1 – P3                               | Not started. P1 waits on the owner confirming the window. |

## Findings (verified read-only, 2026-10-02)

### How the corpus is built today

- **Builder.** `sidecar/src/archive_query.py` builds both the text summary
  and the 60-dim vector (`feature_set = first_hour_pct_change_v1`):
  - **Front month.** The front month is the top-volume `ES%` symbology
    symbol for the day. Calendar spreads are **not** excluded. As a
    result, 15 `day_features` rows and 17 `day_embeddings` rows describe a
    spread instead of ES, one on every quarterly roll Monday since 2019.
    For example, `2026-03-16 ESH6-ESM6 | open 49.45 | 1h range 0.30`.
  - **Day bucket.** The bucket is the **UTC calendar day**. On weekdays the
    "first hour" therefore starts at 00:00 UTC, which is 7–8 PM ET the
    evening before. Sunday rows (771 in `day_embeddings`, 662 in
    `day_features`) are the Sunday Globex open.
  - **Vector.** The vector is the close at minutes 1..60 after the day's
    first bar, carried forward, divided by the first bar's open, minus 1.
    Days with fewer than 10 bars in that hour are rejected.
  - **Batch endpoints.** On 2026-05-28 (`ff03c1e1`) the batch endpoints
    moved to the CME session date. The corpus was built on 2026-04-19/20,
    before that change, so re-running the backfill today would **not**
    reproduce the stored rows. The single-date endpoints still bucket by
    UTC day.
- **The stored corpus matches this description exactly.** The P0 script's
  UTC replica reproduces all 4,754 overlapping `day_features` rows to
  1.5e-9 or better, with 0 front-symbol mismatches.

### Stored tables (prod)

| Table            | Rows  | Dates                   | Contents                                                                                                                                                              |
| ---------------- | ----- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `day_embeddings` | 4,948 | 2010-06-07 → 2026-09-21 | 4,696 ES first-hour summaries (→ 2026-04-17), 182 ES full-day summaries, 70 SPX full-day summaries (2026-04-27 → 09-21, from the `embed-yesterday` Postgres fallback) |
| `day_features`   | 4,755 | 2010-06-07 → 2026-04-17 | Built 2026-04-19/20. **No writer since**: no cron writes this table                                                                                                   |

- **`vix_bucket`** is NULL on 967 rows: 889 ES first-hour rows, 8 ES
  full-day rows and all 70 SPX rows. Nothing has set it since the one-off
  backfill.
- **`range_pt` labels are not cash-session ranges.**
  - On ES rows they hold the front month's UTC-calendar-day range.
    `up_exc` and `down_exc` are measured from the ~7 PM ET overnight open.
    For example, on 2026-04-14 the stored range is 93.5 pt, while the cash
    session's was about 70.5 pt.
  - On SPX rows they are SPX cash-session values.
  - `formatRangeForecast` prints them as "distances from open", which a
    0DTE reader will take to mean the cash open.

### Analyze-time path

- **Backend switch.** `fetchSimilarDaysContext` picks its backend from
  `DAY_ANALOG_BACKEND`. `'features'` selects `day_features`; anything else,
  including unset, selects the text embeddings. The **code default is
  `'text'`**; the prod value is unknown. `.env.example` describes the
  variable as `'pgvector' (default) | 'in_memory'`, which is stale. It is
  not edited here because CLAUDE.md forbids editing `.env*`.
- **Query text.** The query text comes from `/archive/day-summary`, which
  returns the **full-day** format, including the day's range and close.
  That does not match the first-hour corpus (4,696 of 4,948 rows), and in
  a backtest it leaks the outcome. `getRangeForecast` documents that it
  expects the first-hour summary.
- **Neighbour filter.** `findSimilarDays` and `findSimilarDaysByFeatures`
  filtered with `date <> d`, so backtests could retrieve _future_ days.
  `getRangeForecast` already used `date < d`. **Fixed in this branch.**
- **Live calls never get either block.**
  - `analysisDate` is today (ET).
  - The sidecar returns 404 for today or later (SIDE-017).
  - `current_day_snapshot` has 0 rows.

  Only a backtest with `selectedDate` ≤ 2026-04-17 can get the blocks.
  There are 10 `analyses` rows since 2026-04-20, the last on 2026-07-24.
  Analyses #260 (2026-04-29) and #261 (2026-06-15) note that the blocks
  were missing.

### Nightly crons

- **`embed-yesterday`** runs at 07:00 UTC, Tuesday to Saturday.
  - It asks the sidecar first. The archive is frozen, so new dates always
    return 404. It then builds the SPX full-day summary from
    `index_candles_1m`.
  - It stopped at 09-21 because SPX candles are missing for 2026-07-23 →
    09-07 and 09-22 → 09-30.
  - It **wrote partial days as complete**: 07-22 has 82 of 390 bars and
    09-21 has 169.
  - A DB error in the fallback was swallowed into a `no_summary` skip
    (R4).

  **Fixed in this branch.**

- **`fetch-day-ohlc`** ran at 23:00 UTC, Monday to Friday, and targeted
  "yesterday ET". Monday's run therefore targeted Sunday and did nothing,
  and Friday's row was never targeted. `range_pt` is NULL on 12 of 12 SPX
  Fridays. **Fixed in this branch.**

### `futures_bars` ES provenance

`futures_bars` ES has had several writers. This corrects the earlier
scoping note, which assumed all of 2025-04 → 2026-09 came from the
merging writer.

| Span (UTC)              | Writer                                                                       | Front-month rule                                                 | Notes                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2025-04-06 → 2026-04-05 | `scripts/backfill-futures.ts` (Databento `ES.c.0`, `ON CONFLICT DO NOTHING`) | Calendar roll: holds the expiring contract through expiry Friday | During roll week the expiring contract is still used while volume has already moved to the next one. On expiry Friday there are no bars from 08:30 CT. |
| 2026-04-05 → ~06-15     | Live Databento sidecar writer (`_resolve_symbol`)                            | Every outright month is mapped to `'ES'` and merged              | `ON CONFLICT` keeps **open = first write**, high = GREATEST, low = LEAST and close = last write, so back-month carry contaminates open and high.       |
| ~06-16 → 09-03          | Same live writer                                                             | Same                                                             | The proxy flags are quiet. This span cannot be checked against the archive.                                                                            |
| 09-04 → 09-29           | None                                                                         | —                                                                | Gap left by the Databento cancellation.                                                                                                                |
| 09-30 →                 | uw-stream `futures_trades` plus the `backfill-futures-gaps` cron             | Cumulative UTC-day volume, outrights only                        | Not independently verified.                                                                                                                            |

## Window decision

**Default pick: the 08:30 CT cash open.** A 0DTE tool wants the first N
minutes of the cash session, with N no greater than the minutes elapsed at
analyze time. The proposed vector, for minutes 0..N−1:

- uses the bars stamped 08:30 … 08:30+N−1 CT (America/Chicago, so DST is
  handled);
- takes each bar's close, carried forward over gaps;
- divides by the **open of the 08:30 bar** and subtracts 1.

The front month is the top-volume **outright** for the day; spreads and
options are excluded. P0 measured this window as `cash`.

**Open question for the owner.** Confirm the 08:30 CT window. The current
window is the overnight UTC-day first hour.

## Phases

### P0 — Parity (done)

`ml/src/day_analog_parity.py` compares the archive with `futures_bars` for
ES over 2025-04-06 → 2026-04-17, for both windows. It reports:

- per-day vector parity;
- top-15 cosine neighbour overlap;
- minute-level back-month contamination;
- an archive-free contamination proxy for the months after the archive
  ends.

It is read-only and runs in about 15 s.

### Window-independent correctness fixes (done)

- **Strictly earlier neighbours.** Neighbour selection is `date < d` in both
  backends. The range forecast already used it.
- **`fetch-day-ohlc` covers Fridays.** It now runs Tuesday to Saturday and
  targets the prior **trading** day, holiday-aware via
  `src/data/marketHours.ts`. `vercel.json` and `cron-schedules.ts` are kept
  in sync.
- **`embed-yesterday` completeness guard.**
  - It never writes a day with fewer cash-session bars than expected: 390,
    or 210 on a half day.
  - It skips non-trading days before doing any work.
  - A skip surfaces as a warning: `logger.warn`, a metric and a Sentry
    warning.
- **`fetch-day-ohlc` uses the same guard**, so a partial day can no longer
  become a `range_pt` label. It also reports `skipped` instead of
  `success` when no `day_embeddings` row matched (`updated = 0`), closing
  the 2026-06-11 codebase-audit item.
- **`fetchDayOhlcFromPostgres` keeps its fail-soft contract** (null on a DB
  error) for the regime-0DTE scorecard. The analog crons use the new
  throwing `readDayOhlcFromPostgres`.
- **DB errors surface.** The cron fallbacks now raise DB rejects, so the
  cron reports an error instead of "no summary".
- **`vix_bucket` is set in `embed-yesterday`** from `outcomes.vix_close`,
  using the same `vixBucketOf` cut-points as the forecast.

### P1 — Build the query and nightly rows from `futures_bars` (ships dark)

P1 is split to respect the five-files-per-phase rule.

- **P1a — builder and schema.**
  - A new `api/_lib/day-analog-builder.ts` reads `futures_bars` ES for a CT
    date.
  - It returns the cash-window vectors for N ∈ {15, 30, 60} and a v2
    **prediction-only** summary: open, N-minute delta, N-minute
    high/low/range and N-minute volume. Nothing after minute N is
    included.
  - It **refuses** a window that carries a contamination flag (open gap or
    reverting spike over 15 pt) or has fewer than `MIN_BARS` bars.
  - A new table (migration) holds `(date, feature_set, n_minutes)` →
    `vector(N)`, the v2 summary, source, symbol, VIX bucket and
    cash-session labels. It is keyed so v1 and v2 can coexist through the
    cut-over.
- **P1b — wiring.**
  - The analyze fetchers query v2 with the largest N that is no greater
    than the minutes elapsed since 08:30 CT. There is no block before
    08:45 CT.
  - `embed-yesterday` writes the v2 row for the prior trading day from
    `futures_bars`, keeping the completeness guard.
  - The block stays empty until P2 fills the corpus. That is acceptable
    because live calls get nothing today.
- **Basis sanity check.** Add a daily check of the ES − SPX basis at 08:30
  CT. The UW-era front month cannot be verified against the archive, and a
  roll-week mismatch shows up as a jump in the basis.

### P2 — Re-baseline and re-embed (~4.9K rows; owner-run production writes)

- **Vector backfill.** Write v2 vectors for N ∈ {15, 30, 60}:
  - **≤ 2026-04-17:** from the local archive, using P0's `outright`
    front-month rule and the cash window. **Do not** use `futures_bars`
    for this span: its roll weeks follow `ES.c.0`, and it has no cash
    bars on expiry Fridays.
  - **2026-04-18 → present:** from `futures_bars`. **Exclude** days the
    proxy flags, which is the live-writer span 2026-04-20 → ~06-15. The
    Sept gap stays a hole.
- **Labels.** Re-label every row with the **cash-session** range, up
  excursion and down excursion measured from the 08:30 CT open, half-day
  aware. Use ES points throughout; the default is ES, see the open
  questions.
- **Text summaries.** Re-embed the v2 text summaries (~4.9K OpenAI calls,
  about $0.05) if the text backend is kept.
- **VIX bucket.** Backfill `vix_bucket` on every row from
  `public/vix-data.json` and `outcomes.vix_close`.
- **Validate before cut-over.** Re-run the `compare-analog-backends`
  calibration (cohort p90 hit rate against a target of 80%) on v2 with
  cash labels and strictly earlier neighbours. Then switch the reads to v2
  and drop v1.

### P3 — Retire the sidecar archive

- **Remove from the sidecar:**
  - the `/archive/*` routes and `POST /admin/seed-archive` (`health.py`,
    `main.py`);
  - `archive_query.py`, `front_month.py` and `archive_seeder.py`;
  - the `ARCHIVE_*` env vars and the Railway `/data` volume.
- **Remove from Vercel:**
  - `api/_lib/archive-sidecar.ts`;
  - the sidecar branches in `embed-yesterday` and `fetch-day-ohlc`.
- **Remove or port the scripts** `backfill-day-{embeddings,features,ohlc}.mjs`
  and `compare-analog-backends.mjs`.
- **Keep** the SHAP/takeit routes, the multileg routes and Theta.
- **Keep the Blob archive and its manifest for ml-sweep**, which reads
  `ARCHIVE_ROOT` and `ARCHIVE_MANIFEST_URL`
  (`ml/src/setups_backtest/data_loaders.py`).

## Files

| Phase | Files                                                                                                                                                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | `ml/src/day_analog_parity.py` (new), `ml/tests/test_day_analog_parity.py` (new), this spec                                                                                                                                                                                                                                                                          |
| Fixes | `api/_lib/day-embeddings.ts`, `api/_lib/day-features.ts`, `api/_lib/postgres-day-summary.ts`, `api/cron/embed-yesterday.ts`, `api/cron/fetch-day-ohlc.ts`, `src/data/marketHours.ts`, `vercel.json`, `api/_lib/cron-schedules.ts`, plus their tests                                                                                                                 |
| P1a   | `api/_lib/day-analog-builder.ts` (new), `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`, `api/__tests__/day-analog-builder.test.ts` (new)                                                                                                                                                                                                                   |
| P1b   | `api/_lib/analyze-context-fetchers.ts`, `api/_lib/analog-range-forecast.ts`, `api/_lib/day-features.ts`, `api/cron/embed-yesterday.ts`, plus tests                                                                                                                                                                                                                  |
| P2    | `ml/src/day_analog_backfill.py` (new; reuses the P0 loaders), `scripts/backfill-day-vix-bucket.mjs`, `scripts/compare-analog-backends.mjs` (v2 + cash labels), then a cleanup migration dropping v1                                                                                                                                                                 |
| P3    | `sidecar/src/{health,main,archive_query,front_month,archive_seeder}.py`, `sidecar/tests/test_{archive_query,front_month,archive_seeder,archive_concurrency,health,main}.py`, `api/_lib/archive-sidecar.ts`, `api/__tests__/archive-sidecar.test.ts`, the crons above, `docs/{ARCHITECTURE,FEATURES,ONBOARDING}.md`, the CLAUDE.md env table, `sidecar/railway.toml` |

## Data dependencies

- **Prod reads:**
  - `futures_bars` (symbol `'ES'`);
  - `index_candles_1m` (SPX, `market_time = 'r'`);
  - `outcomes.vix_close`;
  - `day_embeddings` and `day_features`.
- **Local data:** the frozen archive at `ml/data/archive` (475 MB OHLCV-1m,
  2010-06-06 → 2026-04-17), which is the only source for the 16-year
  history.
- **New:**
  - one migration for the v2 table (P1a) and one cleanup migration (P2);
  - no new env vars.
- **External:** OpenAI `text-embedding-3-large` at 2000 dims, used only for
  the P2 re-embed.

## Risks

1. **Contaminated `futures_bars`, 2026-04-05 → ~06-15.**
   - **Open:** the first write wins, so a back-month bar written first moves
     the 08:30 anchor about 50 pt.
   - **High:** GREATEST keeps the back month's premium.
   - **Rule:** never embed or label from this span without the flag check,
     and never take high/low from it.
2. **Neighbour sensitivity.** One contaminated minute replaces most of a
   day's 15 neighbours, and roll-week basis drift (about 2e-4) replaces 1–2
   of them. The builder must refuse flagged windows, not repair them.
3. **Holes.** `futures_bars` has no data for 2026-09-04 → 09-29, and SPX
   candles have none for 07-23 → 09-07. UW REST 1-minute candles only reach
   about 3.5 trading days back, so these holes stay.
4. **UW-era front month is unverified** against an independent source. The
   P1 basis check is the guard.
5. **`src/data/marketHours.ts` only lists 2025–2026 holidays.**
   - In 2027 an unknown holiday reads as a trading day. That costs only a
     wasted no-bars run.
   - An unknown 2027 half day is held to 390 bars and skipped.
   - Update the calendar every year.
6. **Spread-front rows** (15 + 17) stay in the v1 corpus until P2. They
   surface only on roll Mondays, and only in backtests.
7. **ES vs SPX.** Corpus vectors and the P2 labels are in ES points. The
   intraday ES–SPX basis is flat, so ranges agree to within about 1–2%.

## Open questions (default picks noted)

1. **Window.** Default: the 08:30 CT cash open. The owner's lead, not yet
   explicitly confirmed.
2. **N policy.** Default: store N ∈ {15, 30, 60}. The query uses the
   largest N that is no greater than the minutes elapsed. There is no block
   before 08:45 CT.
3. **Labels.** Default: the ES cash-session range. SPX cash data in
   `index_candles_1m` only starts on 2026-02-26.
4. **Text backend.** Default: keep it and re-embed in P2, then decide from
   the v2 calibration whether the deterministic features backend makes it
   redundant.
5. **`DAY_ANALOG_BACKEND`.** The prod value is unknown and the code default
   is `'text'`. The owner should check Vercel and fix the stale
   `.env.example` comment.
6. **Contaminated span.** Default: exclude it. There is no clean minute
   source for 2026-04-20 → 06-15.

## Thresholds / constants

| Constant                  | Value                                        | Where                                  |
| ------------------------- | -------------------------------------------- | -------------------------------------- |
| Vector length             | 60                                           | `VEC_DIM`; `DAY_FEATURES_DIM`          |
| Minimum bars per window   | 10                                           | `MIN_BARS` (same floor as the sidecar) |
| Cohort size               | 15                                           | `TOP_K`; `COHORT_SIZE`                 |
| Parity tolerance          | 1e-4 per-day max abs diff                    | `PARITY_TOL`                           |
| Contamination threshold   | 2 ticks = 0.50 pt                            | `CONTAM_PTS`                           |
| Proxy flag                | open gap or reverting close spike over 15 pt | `PROXY_JUMP_PTS`                       |
| Wide-bar flag             | over 20 pt; informational only               | `PROXY_WIDE_PTS`                       |
| Cash open                 | 08:30 CT (America/Chicago)                   | `CASH_OPEN_MIN_CT`                     |
| Full cash session         | 390 one-minute bars                          | `cashSessionMinutes()`                 |
| Half-day session          | 210 one-minute bars                          | `cashSessionMinutes()`                 |
| Live merge writer start   | 2026-04-05 21:00 UTC                         | `LIVE_WRITER_START`                    |
| `fetch-day-ohlc` schedule | `0 23 * * 2-6`                               | `vercel.json`; `cron-schedules.ts`     |

## Phase 0 results

Run on 2026-10-02 against `futures_bars` ES (492,286 rows, pulled
read-only) and the local archive. The comparison window is 2025-04-06 →
2026-04-17. The neighbour corpus is the full archive history from
2010-06-06.

```bash
ml/.venv/Scripts/python.exe ml/src/day_analog_parity.py \
  --archive ml/data/archive --fb-parquet <cache>/futures_bars_es.parquet \
  --stored-features <cache>/day_features.parquet --out <scratch>/parity.json
# add --pull to fetch futures_bars (READ ONLY, DATABASE_URL from env)
```

**How the overlap metrics are measured.** The "query swap" corpus is the
archive's own vectors. Each query day is answered twice, once with the
archive vector and once with the `futures_bars` vector, and only
strictly earlier days count as neighbours. "Corpus swap" builds both the
corpus and the query from each source, restricted to the common days.

**Replica check.** The UTC replica matches the stored `day_features`
rows:

| Metric                    | Value                           |
| ------------------------- | ------------------------------- |
| Common days               | 4,754                           |
| Per-day max abs diff, max | 1.5e-9                          |
| Share within 1e-4         | 1.000                           |
| Front-symbol mismatches   | 0                               |
| Days only in the replica  | 166 (2010–2013, mostly Sundays) |
| Days only stored          | 1 (2017-03-13)                  |

The stored backfill skipped the 166 replica-only days.

### Vector parity and neighbour overlap

| Metric                                          | UTC day (current)                                                               | 08:30 CT cash open                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Days compared                                   | 323                                                                             | 262                                                             |
| Only in archive / only in `futures_bars`        | 0 / 1                                                                           | 4 / 0 (the four expiry Fridays)                                 |
| Per-day max abs diff: median / p90 / max        | 0 / 0 / 0.0109                                                                  | 0 / 0 / 0.0085                                                  |
| Share of days within 1e-4                       | **0.935**                                                                       | **0.943**                                                       |
| Days over 1e-4 by cause                         | spread front 4, roll week 12, live writer 5, **other 0**                        | roll week 10, live writer 5, **other 0**                        |
| Share within 1e-4 on days with no known cause   | **1.000** (n = 291)                                                             | **1.000** (n = 236)                                             |
| Top-15 overlap, query swap: mean / median / p10 | 0.965 / 1.0 / 1.0                                                               | 0.977 / 1.0 / 1.0                                               |
| Top-15 overlap, query swap: share 15/15         | 0.938                                                                           | 0.935                                                           |
| Query-swap overlap mean by cause                | other 1.000 (291), roll week 0.846 (16), live writer 0.594 (12), spread 0.0 (4) | other 1.000 (236), roll week 0.933 (16), live writer 0.513 (10) |
| Top-15 overlap, corpus swap: mean / p10 / 15/15 | 0.954 / 0.933 / 0.583                                                           | 0.955 / 0.867 / 0.725                                           |

**Reading the table.**

- **Clean days match exactly.** Every day with no known cause matches
  exactly: per-day max diff 0 and 15/15 neighbours, in both windows.
- **Roll weeks.** `futures_bars` (`ES.c.0`) holds the expiring contract,
  while the archive's volume front has already rolled. The basis drift
  is small (about 2e-4 in the cash window) but still replaces 1–2 of the
  15 neighbours.
- **Live writer.** A merged back-month open moves the 08:30 anchor by
  about 50 pt (0.0078–0.0085). On those days the neighbour set is almost
  entirely replaced (about 0.03 overlap), which pulls the live-writer mean
  down to 0.51–0.59.
- **Spread days.** The UTC builder's spread-front days are unrelated to ES
  and share no neighbours.

### Back-month contamination (`futures_bars` vs the archive front month, > 2 ticks)

| Span                                 | Minutes | Bad close     | Bad open | Bad high | Bad low |
| ------------------------------------ | ------- | ------------- | -------- | -------- | ------- |
| Backfill (`ES.c.0`), not roll week   | 324,225 | **0**         | 0        | 0        | 0       |
| Backfill (`ES.c.0`), roll weeks      | 24,462  | 24,462 (100%) | 100%     | 100%     | 100%    |
| Live merge writer (04-05 → 04-17)    | 13,800  | 301 (2.2%)    | 9.1%     | 11.2%    | 0%      |
| Live merge writer, cash session only | 3,900   | 3 (0.08%)     | 19.1%    | 19.1%    | 0%      |

- **Coverage.** There are 362,487 matched minutes, against 364,953
  archive front-month minutes.
- **Roll weeks.** The roll-week span covers 20 days: Monday to Friday of
  each quarterly expiry week.
- **Attribution.** 24,760 of the 24,763 bad closes equal another
  outright's close at the same minute, so they are back-month or
  expiring-contract prints, not noise.
- **Shape of the merge.** The live writer's damage is concentrated in
  `open` and `high` (first write and GREATEST), which is exactly what its
  `ON CONFLICT` clause produces.

### After the archive (no ground truth): proxy

The proxy flags a minute when the open is more than 15 pt from the
previous close, or when the close spikes more than 15 pt and reverts.

**Calibration** on the 262 cash-window overlap days: 5 true positives,
2 false positives (real open gaps) and **0 false negatives**.

**Flagged bars per month:**

| Month             | Flagged bars                                 |
| ----------------- | -------------------------------------------- |
| 2025-04 – 2026-03 | 0–35 per month (35 was the April 2025 crash) |
| 2026-04           | 4,050                                        |
| 2026-05           | 8,173                                        |
| 2026-06           | 9,008                                        |
| 2026-07 →         | 0–2 per month                                |

Cash-window days after 2026-04-17 that a P2 backfill could use (a
window is usable when it has its anchor bar, at least 10 bars and no
flag):

| Month   | Days with anchor | Full 60/60 | Flagged | Usable |
| ------- | ---------------- | ---------- | ------- | ------ |
| 2026-04 | 9                | 9          | 9       | 0      |
| 2026-05 | 21               | 21         | 20      | 1      |
| 2026-06 | 21               | 21         | 9       | 12     |
| 2026-07 | 23               | 23         | 0       | 23     |
| 2026-08 | 15               | 15         | 0       | 15     |
| 2026-09 | 4                | 4          | 0       | 4      |
| 2026-10 | 1                | 1          | 0       | 1      |

### Recommendation for P1

**Go**, with three preconditions built into P1 and P2:

1. **Refuse flagged windows.** The builder rejects any window that has an
   open-gap or reverting-spike flag, or fewer than 10 bars, rather than
   embedding it. A single bad minute replaces most of a day's neighbours.
2. **Source the history from the archive.** Corpus rows up to 2026-04-17
   come from the archive, using the outright, UTC-day-volume front month
   and the cash window. Do not use `futures_bars` for that span: its roll
   weeks follow `ES.c.0`, and expiry Fridays have no cash bars.
3. **Exclude the contaminated span.** Drop the flagged 2026-04-20 →
   ~06-15 days, and take no high/low labels from them.

`futures_bars` is otherwise a faithful source. Outside roll weeks and the
merge writer it matches the archive minute-for-minute: 0 bad minutes in
324,225.
