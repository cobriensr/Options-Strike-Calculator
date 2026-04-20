# Phase 4b — Distribute TBBO Archive to Railway + Runtime Queries — 2026-04-19

Part of the max-leverage roadmap. Phase 4b was paused during initial
execution so that the parallel day-embeddings work could settle. Now
unblocked: Phase 5a + 5b shipped and the parallel session's archive
infrastructure (OHLCV archive + DuckDB query layer + `/archive/*`
endpoints) is stable. Phase 4b mirrors that pattern for the TBBO
archive.

## Goal

1. Push the local TBBO Parquet archive (`ml/data/archive/tbbo/year=*/part.parquet`,
   3.9 GB) to Vercel Blob so the Railway sidecar can seed it.
2. Extend `sidecar/src/archive_query.py` with two TBBO-aware queries.
3. Expose both as new `/archive/*` endpoints.
4. Wire one (1-year OFI percentile) into the analyze context so
   Claude sees "today's NQ 1h OFI is in the Nth percentile of the
   last year" — the historical-context augmentation of the Phase 5a
   live signal.

## Why two queries, not one

The minimum viable deliverable is a **percentile ranker** so Claude
knows whether today's OFI value is unusual. But the TBBO archive also
enables a **per-day summary** endpoint that computes the same
microstructure features Phase 4c builds locally, but against the
sidecar's DuckDB on any arbitrary date in the 1-year window — which
future analog-matching / regime-classifier work will need. Shipping
both at once avoids a round trip when the next signal-exploration
question lands.

## Scope breakdown

### 1. Upload extension (laptop-side)

**File:** `scripts/upload-archive-to-blob.mjs`

Extend the existing OHLCV uploader to include the `tbbo/` subtree
under the same manifest. The uploader already walks a directory and
computes per-file SHA-256; just extend the directory roots list to
include TBBO.

Manifest shape stays the same (one entry per file, path relative to
`ml/data/archive/`), so the seeder doesn't need to change.

### 2. Seeder verification (sidecar)

**File:** `sidecar/src/archive_seeder.py`

The seeder reads the manifest and downloads every entry. It's already
generic — if the manifest includes `tbbo/year=2025/part.parquet`, the
seeder downloads it to `/data/archive/tbbo/year=2025/part.parquet`
without code changes. **Verify this** by reading the seeder and
confirming it doesn't hard-code paths for `ohlcv_1m`. Add tests if
needed.

### 3. Query layer (sidecar)

**File:** `sidecar/src/archive_query.py`

Add two new functions alongside `es_day_summary` and `analog_days`:

#### `tbbo_day_microstructure(date_iso, symbol)`

Computes the per-day microstructure features for `(date, symbol)`
over the TBBO Parquet archive. Mirror the SQL approach used in
`ml/src/features/microstructure.py` but adapted for DuckDB over
volume-mounted Parquet. Return the same 23-feature dict shape so a
Vercel caller can reuse the type.

#### `tbbo_ofi_percentile(symbol, current_value, horizon_days=252)`

Given today's OFI value, rank it against the last `horizon_days` of
computed OFI for the same symbol + window. Returns `{percentile,
mean, std, count}`. DuckDB one-pass.

For the rolling computation to be cheap, derive daily OFI values via
the same SQL used by `tbbo_day_microstructure` but aggregated across
all dates in the window, computed on first call and cached in module
state (DuckDB handles this naturally via prepared statements). Initial
call may take 10-20s; subsequent calls microseconds.

### 4. Sidecar endpoints

**File:** `sidecar/src/health.py`

Add two unauthenticated read endpoints (matching the existing
`/archive/*` pattern — public market data, no secrets):

- `GET /archive/tbbo-day-microstructure?date=YYYY-MM-DD&symbol=ES|NQ`
  → 200 with JSON feature dict; 404 if date has no bars.
- `GET /archive/tbbo-ofi-percentile?symbol=ES|NQ&value=<float>&window=<1h|15m|5m>`
  → 200 with `{percentile, mean, std, count}`.

Input validation: `date` matches `YYYY-MM-DD`, `symbol in {ES, NQ}`,
`value` finite float, `window in {5m, 15m, 1h}`. Return 400 on
malformed input with a clear error message.

### 5. Vercel-side wiring

**File:** `api/_lib/archive-sidecar.ts`

This module already has `fetchDaySummary` from the parallel
day-embeddings work. Add:

- `fetchTbboDayMicrostructure(date, symbol)`
- `fetchTbboOfiPercentile(symbol, value, window)`

Both follow the existing null-on-error pattern with 2s timeout.

### 6. Analyze context integration

**File:** `api/_lib/analyze-context-fetchers.ts`

In the existing `fetchMicrostructureBlock` (or the orchestrator that
calls it — verify during implementation), after the per-symbol live
OFI values are computed by Phase 5a's `computeAllSymbolSignals`, make
a call to `fetchTbboOfiPercentile` for each symbol's 1h OFI and
inject the percentile rank into the formatter output.

**Example rendered block:**

```
NQ (latest front-month NQM6):
  OFI 1h: +0.38 → AGGRESSIVE_BUY
  Historical rank: 92nd percentile of the last 252 days
  Spread widening: 1 events
  TOB pressure: 1.18 → BALANCED
```

The "Historical rank: 92nd percentile" line is the new bit. It makes
the absolute OFI value meaningful — +0.38 sounds big but whether
it's "top 5% buy day of the year" or "routine morning noise" needs
the distribution context.

### 7. Prompt interpretation rules

**File:** `api/_lib/analyze-prompts.ts`

Extend `<microstructure_signals_rules>` with guidance on how to
weight the historical rank:

```
Historical OFI percentile rank (Phase 4b): when today's OFI value is
in the top or bottom 10% of the last 252 days, the directional signal
is meaningfully unusual. Percentile between 25 and 75 is "typical for
this symbol" — weight the live classification less strongly. Percentile
> 95 or < 5 is a genuine outlier day; weight the classification more
strongly.
```

## Files modified / created

### Modified

- `scripts/upload-archive-to-blob.mjs` — extend roots list
- `sidecar/src/archive_query.py` — add two query functions
- `sidecar/src/health.py` — add two route handlers
- `sidecar/tests/test_archive_query.py` — tests for new queries
- `sidecar/tests/test_archive_seeder.py` — verify TBBO paths seed correctly
- `api/_lib/archive-sidecar.ts` — two new fetcher functions
- `api/_lib/analyze-context-fetchers.ts` — call the percentile fetcher, thread rank into the microstructure block
- `api/_lib/microstructure-signals.ts` — extend `formatMicrostructureDualSymbolForClaude` to accept optional percentile ranks and render them
- `api/_lib/analyze-prompts.ts` — extend rules with percentile guidance
- `api/__tests__/archive-sidecar.test.ts` — tests for new fetchers
- `api/__tests__/microstructure-signals.test.ts` — formatter test with percentile ranks
- `api/__tests__/analyze-context.test.ts` — integration test

### New

None. This phase widens existing modules.

## Verify against source

Before coding, confirm:

1. **Seeder transparency:** read `sidecar/src/archive_seeder.py`. Does
   it iterate manifest entries with no path-prefix hardcoding? If it
   special-cases `ohlcv_1m/`, the TBBO subtree needs parallel handling.

2. **Upload script walk:** read `scripts/upload-archive-to-blob.mjs`.
   Confirm the directory-walk is configurable (list of roots) or if
   it hardcodes `ohlcv_1m`.

3. **Archive query connection pattern:** read `archive_query.py` to
   see how `_ROOT`, DuckDB connection, and globs are set up. The
   parallel session landed thread-local + threaded-HTTP work at
   commit `a03a411` — build on top of that, don't regress it.

4. **Current Phase 5a formatter:** read
   `api/_lib/microstructure-signals.ts`'s
   `formatMicrostructureDualSymbolForClaude` to see how the block is
   currently rendered. The percentile rank extension should be
   backward-compatible (optional parameter).

## Constraints

- **No new DB migrations, no new crons.**
- **No new Python deps** in the sidecar (DuckDB already there).
- **Blob upload** is an operational action, not code — once Phase 4b
  is merged, the user runs the updated upload script once. Document in
  the commit message or a README snippet.
- **Seeder triggered manually** via `POST /admin/seed-archive` with
  the `ARCHIVE_SEED_TOKEN` (parallel session's existing endpoint).
- **Fallback:** if the sidecar percentile endpoint is unreachable,
  the analyze context renders without the "Historical rank" line.
  Don't block analyze on archive queries.
- **Cache boundary:** interpretation rules in cached `SYSTEM_PROMPT_PART1`;
  live values in dynamic context.

## Done when

- `npm run review` green.
- `cd sidecar && .venv/bin/pytest` green.
- Tests cover: seeder with TBBO paths, `tbbo_day_microstructure`
  happy path + 404, `tbbo_ofi_percentile` happy path + boundary
  values, Vercel fetcher null-on-error, formatter renders percentile
  line conditionally.
- Manual smoke test (user does after deploy):
  - Run `node scripts/upload-archive-to-blob.mjs` to push TBBO to Blob
  - Trigger `POST /admin/seed-archive` on Railway
  - `curl $SIDECAR/archive/tbbo-ofi-percentile?symbol=NQ&value=0.25&window=1h` → plausible JSON
  - Analyze call renders the Historical rank line in the microstructure block

## Out of scope

- Analog-day matching by microstructure feature vector — separate
  phase if the percentile-rank signal turns out to be insufficient.
- Live ML model inference — that's a far-downstream concern.
- Frontend UI surfacing of percentile ranks.
- Retention / archive rollover policy — the TBBO archive is a
  snapshot; re-runs replace it.

## Open questions

- **Horizon default:** spec picks 252 days (≈ 1 year of trading). If
  the archive window is shorter (Phase 4a pulled exactly 1 year),
  this is the full window. If the archive grows via future pulls,
  252 is the sensible rolling standard.
- **Caching of the historical distribution:** DuckDB's query-plan
  cache handles this transparently. If first-call latency is >10s,
  pre-warm on seeder completion. Phase 4b ships without pre-warm;
  add later if needed.
- **ES vs NQ distributions:** per Phase 4d, NQ has validated signal
  and ES doesn't. Compute percentiles for both symbols equally; let
  Claude weight them appropriately per the existing prompt rules.
