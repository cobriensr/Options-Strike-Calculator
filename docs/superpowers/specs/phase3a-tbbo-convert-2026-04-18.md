# Phase 3a — TBBO Daily DBN → Parquet Converter — 2026-04-18

Part of the max-leverage roadmap. Phase 3a ingests the 1-year TBBO
Databento download into a queryable Parquet archive, parallel to the
existing OHLCV-1m archive. Phase 3b+ (Blob upload, Railway seed, ML
features) are separate sub-phases.

## Goal

Convert a directory of daily TBBO DBN files (from a Databento bulk
request, split-by-day) into year-partitioned Parquet at
`ml/data/archive/tbbo/year=YYYY/part.parquet`. Produce a
`tbbo_convert_summary.json` manifest and reuse the shared
`symbology.parquet` from the OHLCV archive.

## Input

- **Source:** `/Users/charlesobrien/Downloads/GLBX-20260419-FKLLGNVWNP/`
  - 315 daily files: `glbx-mdp3-YYYYMMDD.tbbo.dbn.zst` (300KB-27MB each, ~5GB total)
  - One `condition.json` for degraded-day tracking
- **Schema:** `tbbo` (CME Globex, `GLBX.MDP3` dataset)
- **Symbols requested:** `ES.FUT` + `NQ.FUT` via `stype_in=parent`
- **Date range:** approximately 2025-04-20 → 2026-04-18 (rolling 1 year)

## Output

```
ml/data/archive/
  tbbo/
    year=2025/part.parquet
    year=2026/part.parquet
  symbology.parquet         ← shared with OHLCV; extended if new instruments
  tbbo_convert_summary.json ← new, Phase 3a specific
```

## Files

### New

- `ml/src/tbbo_convert.py` — converter module mirroring the structure
  of `ml/src/archive_convert.py`. Separate module (not an extension)
  because TBBO and OHLCV have divergent column shapes that make a
  unified function signature awkward.
- `ml/tests/test_tbbo_convert.py` — mirrors
  `ml/tests/test_archive_convert.py` pattern with synthetic DBN
  fixtures.

### Not modified

- `ml/src/archive_convert.py` — keep as-is. Sibling module, not shared helpers.
- `archive_seeder.py`, `archive_query.py` — Phase 3b will extend these
  to know about the tbbo subdir. Out of scope here.

## Converter requirements

1. **CLI entrypoint:**
   ```
   .venv/bin/python -m src.tbbo_convert \
       --dbn-dir ~/Downloads/GLBX-20260419-FKLLGNVWNP \
       --out data/archive \
       --condition ~/Downloads/GLBX-20260419-FKLLGNVWNP/condition.json
   ```

2. **Iterate daily files.** Read each `glbx-mdp3-*.tbbo.dbn.zst` in
   sorted order. Skip files that don't match the TBBO schema name
   pattern. Log progress every 10 files.

3. **Schema guard.** For each file, confirm `store.schema == 'tbbo'`.
   Refuse to run if any file is not TBBO (fail loud, don't silently
   skip).

4. **Symbol filter.** Keep only ES* and NQ* **futures** symbols. Skip
   anything with a space in the resolved symbol (that's options format
   like `ES <date> C<strike>`). Symbol filter happens after symbology
   resolution, not on raw instrument_id.

5. **Batched Parquet writes.** Do NOT load all 315 files into one
   DataFrame. Process each file → resolve symbols → filter →
   append rows keyed by year. Use `pyarrow.parquet.ParquetWriter` in
   append mode per year-partition, or accumulate per-year row batches
   and write at the end. Either works; pick whichever keeps peak
   memory under ~2 GB.

6. **TBBO record columns.** The canonical TBBO record shape from
   Databento (verified via SDK before coding):
   - `ts_event` (nanosecond timestamp of the trade)
   - `ts_recv` (nanosecond timestamp of receipt; optional)
   - `instrument_id`
   - `price` (trade price, scaled int or Decimal — match DBN convention)
   - `size` (trade size)
   - `action` (char, expected 'T' for trades)
   - `side` (char, aggressor side from Databento's classification if provided; else we derive downstream)
   - `flags`
   - `bid_px_00`, `ask_px_00`, `bid_sz_00`, `ask_sz_00` — pre-trade top-of-book
   - Possibly `sequence`, `ts_in_delta`, etc.

   **Before coding:** verify actual column names by running
   `db.DBNStore.from_file(<any_file>).to_df().columns` in the REPL.
   The converter should assert REQUIRED_COLUMNS at load time.

7. **Shared symbology.** After processing all files, extract the
   (instrument_id → symbol) mapping and **merge** into
   `ml/data/archive/symbology.parquet` if it exists. Don't overwrite —
   preserve instruments already mapped from the OHLCV archive. Use a
   UNION on instrument_id. If a new instrument_id appears with a
   different symbol than the existing mapping, prefer the most recent
   observation (TBBO data is newer).

8. **Summary manifest.** Write
   `ml/data/archive/tbbo_convert_summary.json`:
   ```json
   {
     "source_dir": "...",
     "out_dir": "...",
     "schema": "tbbo",
     "total_rows": 12345678,
     "distinct_instruments": 50,
     "start_date": "2025-04-20T...",
     "end_date": "2026-04-18T...",
     "years": [2025, 2026],
     "rows_per_year": {"2025": ..., "2026": ...},
     "rows_per_symbol": {"ESM5": ..., "ESU5": ..., "NQM5": ...},
     "degraded_days": 0,
     "files_processed": 315,
     "files_skipped": 0,
     "generated_at": "2026-04-19T..."
   }
   ```

9. **Condition.json pass-through.** Copy the source condition.json
   verbatim to `ml/data/archive/tbbo_condition.json` (namespaced so
   it doesn't collide with the OHLCV condition.json).

10. **Compression.** Zstd level 3 for Parquet, same as OHLCV archive.

11. **Error handling.** On any per-file failure, log the file path and
    continue to next file. Track failures in the summary's `files_skipped`
    count. Do NOT fail the whole run on a single bad file.

## Tests

Follow the `test_archive_convert.py` pattern. Use `databento_dbn` to
write tiny synthetic TBBO DBN files to a tmpdir fixture, then run the
converter against the fixture directory.

Required cases:

- Happy path: 2-3 synthetic day files → correct year-partitioned output
- Symbol filter: file with mixed ES futures + ES options → options filtered out
- Non-TBBO schema: file with different schema → ValueError
- Single file failure: one bad file amongst good ones → logs error,
  continues, summary reports `files_skipped=1`
- Empty directory → meaningful error
- Shared symbology merge: pre-existing symbology.parquet from OHLCV run
  → TBBO converter preserves OHLCV entries AND adds TBBO entries
- Summary JSON shape matches spec

## Constraints

- **No new runtime dependencies** beyond what `archive_convert.py`
  uses (databento, pandas, pyarrow).
- **No touching `archive_convert.py`.** Sibling module only.
- **No Blob upload, no Railway seed.** Phase 3b.
- **No ML features, no analyze-context.** Phase 3c/3d.
- **Peak memory < 2 GB** during conversion.
- **Runtime target:** < 2 hours end-to-end for the 315-file / 5GB input.

## Done when

- `.venv/bin/python -m src.tbbo_convert --dbn-dir ... --out ... --condition ...`
  runs successfully against the real input at
  `/Users/charlesobrien/Downloads/GLBX-20260419-FKLLGNVWNP/`.
- `ml/data/archive/tbbo/year=2025/part.parquet` and `year=2026/part.parquet`
  exist and contain non-zero rows.
- `ml/data/archive/symbology.parquet` now contains entries for ES*
  and NQ* futures contracts (in addition to any existing OHLCV entries).
- `ml/data/archive/tbbo_convert_summary.json` written.
- All new tests pass via `.venv/bin/pytest tests/test_tbbo_convert.py`.
- Existing `archive_convert.py` and its tests still pass.

## Out of scope for Phase 3a

- Blob upload of the new tbbo subdirectory (Phase 3b).
- Extending `archive_seeder.py` to know about tbbo (Phase 3b).
- Extending `archive_query.py` with TBBO-aware queries (Phase 3b).
- ML feature engineering off the TBBO archive (Phase 3c).
- EDA / signal validation (Phase 3d).

## Open questions

- **Exact column names from the DBN SDK.** Verify via REPL before
  coding (`store.to_df().columns` on any TBBO file). The SDK's TBBO
  column naming has evolved; don't hardcode without confirming.
- **Aggressor side encoding.** Databento's `side` field may be 'A'/'B'/'N'
  or 'B'/'S'/'N' depending on schema. Check actual values on a real
  file before writing the type hint.
