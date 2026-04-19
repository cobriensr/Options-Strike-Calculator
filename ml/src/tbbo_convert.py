"""Convert a directory of Databento TBBO daily DBN files into year-partitioned Parquet.

Sibling of :mod:`archive_convert` — separate module (not a shared helper) because
TBBO and OHLCV have divergent column shapes and this converter takes a *directory*
of daily files rather than one monolithic file.

Input layout (from a Databento split-by-day batch download)::

    <dbn_dir>/
      glbx-mdp3-YYYYMMDD.tbbo.dbn.zst   (one per trading day)
      condition.json

Each file has:

* dataset ``GLBX.MDP3`` (CME Globex)
* schema ``tbbo`` — quote-stamped trades with pre-trade top-of-book
* ``stype_in=parent`` with parents ``ES.FUT`` + ``NQ.FUT``
* ``stype_out=instrument_id`` with ``map_symbols=True`` so ``to_df()`` resolves
  the CME numeric instrument_id back to a raw symbol string

Output layout::

    <out_dir>/
      tbbo/
        year=2025/part.parquet
        year=2026/part.parquet
      symbology.parquet            ← merged with any existing OHLCV mappings
      tbbo_condition.json          ← copy of input condition.json, namespaced
      tbbo_convert_summary.json    ← per-year / per-symbol row counts manifest

Verified TBBO DBN schema (databento SDK, 2026-04-18 REPL probe on
``glbx-mdp3-20250421.tbbo.dbn.zst``)::

    SCHEMA: tbbo
    INDEX:  ts_recv (datetime64[ns, UTC])
    COLUMNS (19):
      ts_event       datetime64[ns, UTC]   ← exchange timestamp of the trade
      rtype          uint8
      publisher_id   uint16
      instrument_id  uint32
      action         str   (observed: only 'T' — trades)
      side           str   (observed: 'A' ask-aggressor / 'B' bid-aggressor / 'N' none)
      depth          uint8
      price          float64
      size           uint32
      flags          uint8
      ts_in_delta    int32
      sequence       uint32
      bid_px_00      float64   ← pre-trade best bid price (level 0)
      ask_px_00      float64   ← pre-trade best ask price (level 0)
      bid_sz_00      uint32
      ask_sz_00      uint32
      bid_ct_00      uint32
      ask_ct_00      uint32
      symbol         str       ← resolved from instrument_id via map_symbols=True

Observed symbols in one day (2025-04-21): outright futures (ESM5, ESU5, ESZ5,
ESH6, NQM5, NQU5) + leg spreads (ESM5-ESU5, ESM5-ESZ5, ESU5-ESZ5, NQM5-NQU5).
Spreads have hyphens; options (absent here — the subscription is futures-only)
would have spaces (``ES 250620 C5800`` format). The symbol filter excludes both.

CLI::

    cd ml
    .venv/bin/python -m src.tbbo_convert \\
        --dbn-dir ~/Downloads/GLBX-20260419-FKLLGNVWNP \\
        --out data/archive \\
        --condition ~/Downloads/GLBX-20260419-FKLLGNVWNP/condition.json

Memory discipline: processes one daily file at a time, buffers filtered rows
keyed by year, and flushes to Parquet via ``pyarrow.parquet.ParquetWriter``
append mode whenever any per-year buffer exceeds ``FLUSH_ROW_THRESHOLD``.
Peak memory stays well under 2 GB for the full 315-file / 5 GB input.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import shutil
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import databento as db
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

log = logging.getLogger("tbbo_convert")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Expected schema. Guard rail — refuse to ingest non-TBBO data through this path
# because the row shape is materially different from OHLCV/MBP/trades.
EXPECTED_SCHEMA = "tbbo"

# Parquet output settings. zstd level 3: same sweet spot used by archive_convert.py.
PARQUET_COMPRESSION = "zstd"
PARQUET_COMPRESSION_LEVEL = 3

# File-name glob for daily TBBO files in the source directory.
DBN_GLOB = "glbx-mdp3-*.tbbo.dbn.zst"

# Accept outright ES*/NQ* futures contracts only. Excludes:
#   - spread symbols (hyphenated, e.g. ESM5-ESU5)
#   - options (space-separated, e.g. "ES 250620 C5800")
#   - non-ES/NQ products (CL, GC, etc. — shouldn't appear but defensive)
SYMBOL_FILTER_RE = re.compile(r"^(ES|NQ)[A-Z0-9]+$")

# Columns that MUST be present on each file. Fail loud if databento ever renames
# one — a silently-dropped column surfaces as mysterious NaNs in backtests months
# later.
REQUIRED_COLUMNS = frozenset(
    {
        "ts_event",
        "ts_recv",
        "instrument_id",
        "action",
        "side",
        "price",
        "size",
        "bid_px_00",
        "ask_px_00",
        "bid_sz_00",
        "ask_sz_00",
        "symbol",
    }
)

# Flush per-year row buffers to disk whenever one exceeds this count. 500K rows
# of TBBO is ~40-60 MB in-memory which keeps peak RSS comfortably under 2 GB.
FLUSH_ROW_THRESHOLD = 500_000

# Log progress every N files through the main loop.
LOG_EVERY_N_FILES = 10


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@dataclass
class ConvertResult:
    """Summary of a TBBO-directory → Parquet conversion run."""

    source_dir: Path
    out_dir: Path
    schema: str
    total_rows: int
    distinct_instruments: int
    start_date: str  # ISO-8601
    end_date: str  # ISO-8601
    years: list[int]
    rows_per_year: dict[int, int]
    rows_per_symbol: dict[str, int]
    degraded_days: int
    files_processed: int
    files_skipped: int
    skipped_files: list[str] = field(default_factory=list)


def convert_tbbo_dir_to_parquet(
    dbn_dir: Path,
    out_dir: Path,
    *,
    condition_path: Path | None = None,
    limit: int | None = None,
) -> ConvertResult:
    """Convert a directory of daily TBBO DBN files into year-partitioned Parquet.

    Args:
        dbn_dir: directory containing ``glbx-mdp3-YYYYMMDD.tbbo.dbn.zst`` files.
        out_dir: destination root. Will contain ``tbbo/year=*/`` subdirs plus a
                 merged ``symbology.parquet`` and ``tbbo_convert_summary.json``.
        condition_path: optional companion ``condition.json`` from the Databento
                 batch. Copied into ``out_dir/tbbo_condition.json`` verbatim.
        limit: optional cap on total rows written — for dev runs.

    Returns:
        ``ConvertResult`` with per-year / per-symbol row counts.

    Raises:
        FileNotFoundError: if ``dbn_dir`` does not exist or contains no TBBO files.
        ValueError: if any file's schema is not ``tbbo`` (fail loud — this is a
            guard rail, not a silent-skip).
    """
    dbn_dir = dbn_dir.expanduser().resolve()
    out_dir = out_dir.expanduser().resolve()

    if not dbn_dir.exists() or not dbn_dir.is_dir():
        raise FileNotFoundError(f"TBBO directory not found: {dbn_dir}")

    files = sorted(dbn_dir.glob(DBN_GLOB))
    if not files:
        raise FileNotFoundError(f"No TBBO files matching {DBN_GLOB!r} in {dbn_dir}")

    tbbo_dir = out_dir / "tbbo"
    tbbo_dir.mkdir(parents=True, exist_ok=True)

    log.info("Found %d TBBO files in %s", len(files), dbn_dir)

    # State accumulated across all files.
    # Per-year row buffers (list[pa.Table]) flushed to disk on threshold.
    year_buffers: dict[int, list[pa.Table]] = defaultdict(list)
    year_buffer_rows: dict[int, int] = defaultdict(int)
    # Per-year ParquetWriter — opened lazily on first flush, closed at end.
    year_writers: dict[int, pq.ParquetWriter] = {}
    # Per-year canonical schema — locked in on first flush to keep all writes
    # for one year in lock-step (new files can't silently add / drop columns).
    year_schemas: dict[int, pa.Schema] = {}

    rows_per_year: dict[int, int] = defaultdict(int)
    rows_per_symbol: dict[str, int] = defaultdict(int)
    # Track (instrument_id, symbol) → (first_seen, last_seen) for the symbology
    # sidecar. This replaces the DataFrame groupby used in archive_convert.py,
    # which doesn't scale to streaming directory input.
    symbology: dict[tuple[int, str], tuple[pd.Timestamp, pd.Timestamp]] = {}

    total_rows = 0
    files_processed = 0
    files_skipped = 0
    skipped_files: list[str] = []
    global_min_ts: pd.Timestamp | None = None
    global_max_ts: pd.Timestamp | None = None

    try:
        for idx, file in enumerate(files, start=1):
            if limit is not None and total_rows >= limit:
                log.info(
                    "Row limit reached (%s) — stopping early after %d files",
                    f"{limit:,}",
                    idx - 1,
                )
                break

            try:
                df = _load_and_filter_file(file)
            except ValueError:
                # Schema guard failures MUST propagate — spec requires fail-loud.
                raise
            except RuntimeError as exc:
                # RuntimeError is reserved for the REQUIRED_COLUMNS check — i.e.
                # the SDK materialized a DataFrame shape we don't recognize.
                # Flag it distinctly from generic per-file errors (corrupt DBN,
                # filesystem EIO, etc.) so the operator knows to update
                # REQUIRED_COLUMNS rather than re-downloading the file.
                if "missing required columns" in str(exc).lower():
                    log.error(
                        "Skipping %s: SDK schema drift — %s "
                        "(update REQUIRED_COLUMNS if this is expected)",
                        file.name,
                        exc,
                    )
                else:
                    log.error("Skipping %s: %s", file.name, exc)
                files_skipped += 1
                skipped_files.append(file.name)
                continue
            except Exception as exc:  # noqa: BLE001
                log.error("Skipping %s: %s", file.name, exc)
                files_skipped += 1
                skipped_files.append(file.name)
                continue

            files_processed += 1

            if df.empty:
                log.debug("%s had no futures rows after filter", file.name)
            else:
                # Honor limit mid-file.
                if limit is not None and total_rows + len(df) > limit:
                    df = df.head(limit - total_rows)

                total_rows += len(df)

                # Global timestamp bounds for the manifest.
                file_min = df["ts_event"].min()
                file_max = df["ts_event"].max()
                if global_min_ts is None or file_min < global_min_ts:
                    global_min_ts = file_min
                if global_max_ts is None or file_max > global_max_ts:
                    global_max_ts = file_max

                # Symbol counts roll up across the whole run.
                for sym, cnt in df["symbol"].value_counts().items():
                    rows_per_symbol[str(sym)] += int(cnt)

                # Update symbology accumulator. Using groupby keeps this O(rows)
                # per file rather than O(rows²).
                sym_grp = (
                    df[["instrument_id", "symbol", "ts_event"]]
                    .groupby(["instrument_id", "symbol"], as_index=False)
                    .agg(first_seen=("ts_event", "min"), last_seen=("ts_event", "max"))
                )
                for row in sym_grp.itertuples(index=False):
                    key = (int(row.instrument_id), str(row.symbol))
                    existing = symbology.get(key)
                    if existing is None:
                        symbology[key] = (row.first_seen, row.last_seen)
                    else:
                        first_seen = min(existing[0], row.first_seen)
                        last_seen = max(existing[1], row.last_seen)
                        symbology[key] = (first_seen, last_seen)

                # Partition by year-of-ts_event. Append to the per-year buffer;
                # flush if we've crossed the threshold.
                df["year"] = df["ts_event"].dt.year
                for year, grp in df.groupby("year", sort=False):
                    year_int = int(year)
                    part_df = grp.drop(columns=["year"])
                    table = pa.Table.from_pandas(part_df, preserve_index=False)
                    year_buffers[year_int].append(table)
                    year_buffer_rows[year_int] += len(part_df)
                    rows_per_year[year_int] += len(part_df)

                    if year_buffer_rows[year_int] >= FLUSH_ROW_THRESHOLD:
                        _flush_year_buffer(
                            year_int,
                            year_buffers,
                            year_buffer_rows,
                            year_writers,
                            year_schemas,
                            tbbo_dir,
                        )

            if idx % LOG_EVERY_N_FILES == 0 or idx == len(files):
                log.info(
                    "Progress: %d/%d files (processed=%d skipped=%d rows=%s)",
                    idx,
                    len(files),
                    files_processed,
                    files_skipped,
                    f"{total_rows:,}",
                )

        # Final flush of any remaining per-year buffers.
        for year_int in list(year_buffers.keys()):
            if year_buffer_rows[year_int] > 0:
                _flush_year_buffer(
                    year_int,
                    year_buffers,
                    year_buffer_rows,
                    year_writers,
                    year_schemas,
                    tbbo_dir,
                )
    finally:
        # Always close writers so partial runs still produce readable Parquet.
        for writer in year_writers.values():
            writer.close()

    if total_rows == 0:
        log.warning(
            "No rows written — either every file was skipped or the symbol "
            "filter excluded all rows."
        )

    # Merge (instrument_id, symbol) mappings into the shared symbology parquet.
    _merge_symbology(out_dir / "symbology.parquet", symbology)

    # Copy condition.json verbatim (namespaced to avoid colliding with OHLCV).
    degraded_days = _copy_condition(condition_path, out_dir)

    # Write summary manifest.
    distinct_instruments = len({key[0] for key in symbology})
    result = ConvertResult(
        source_dir=dbn_dir,
        out_dir=out_dir,
        schema=EXPECTED_SCHEMA,
        total_rows=total_rows,
        distinct_instruments=distinct_instruments,
        start_date=global_min_ts.isoformat() if global_min_ts is not None else "",
        end_date=global_max_ts.isoformat() if global_max_ts is not None else "",
        years=sorted(rows_per_year.keys()),
        rows_per_year=dict(rows_per_year),
        rows_per_symbol=dict(rows_per_symbol),
        degraded_days=degraded_days,
        files_processed=files_processed,
        files_skipped=files_skipped,
        skipped_files=skipped_files,
    )
    (out_dir / "tbbo_convert_summary.json").write_text(
        json.dumps(_result_to_json(result), indent=2)
    )
    log.info("Summary manifest -> tbbo_convert_summary.json")

    return result


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _load_and_filter_file(file: Path) -> pd.DataFrame:
    """Open one TBBO DBN file, validate schema, resolve symbols, filter to futures.

    Raises:
        ValueError: non-TBBO schema (must propagate — caller re-raises).
        RuntimeError: materialized DataFrame missing required columns.
    """
    store = db.DBNStore.from_file(file)

    schema = str(store.schema)
    if schema != EXPECTED_SCHEMA:
        raise ValueError(
            f"Expected schema {EXPECTED_SCHEMA!r} in {file.name}, got {schema!r}. "
            "This converter is TBBO-specific — refusing to ingest mixed schemas."
        )

    df = store.to_df(map_symbols=True)

    # Databento's to_df(schema=tbbo) uses ts_recv as the DatetimeIndex; ts_event
    # is a regular column. Reset so both timestamps are addressable by name.
    if df.index.name == "ts_recv" and "ts_recv" not in df.columns:
        df = df.reset_index()

    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise RuntimeError(
            f"TBBO DataFrame in {file.name} missing required columns: "
            f"{sorted(missing)}. Got: {sorted(df.columns)}. The databento SDK "
            "may have changed shapes; update REQUIRED_COLUMNS if this is expected."
        )

    # Filter AFTER symbology resolution: symbol is what we want to match against,
    # not the raw numeric instrument_id.
    mask = df["symbol"].fillna("").map(lambda s: bool(SYMBOL_FILTER_RE.match(s)))
    filtered = df.loc[mask].copy()

    # Normalize the str/ArrowString dtype to Python str for downstream pyarrow
    # writes — Arrow-backed string arrays round-trip fine but mixing them with
    # pd.NA in value_counts() can surprise. Cast explicitly.
    if not filtered.empty:
        filtered["symbol"] = filtered["symbol"].astype(str)

    return filtered


def _flush_year_buffer(
    year: int,
    buffers: dict[int, list[pa.Table]],
    buffer_rows: dict[int, int],
    writers: dict[int, pq.ParquetWriter],
    schemas: dict[int, pa.Schema],
    tbbo_dir: Path,
) -> None:
    """Concat the year's buffered tables and append to its ParquetWriter.

    Opens the writer on first call for this year. The first table's schema is
    locked in as the canonical per-year schema — subsequent appends must match
    (pyarrow will raise if they don't, which is the desired fail-loud behavior).
    """
    tables = buffers[year]
    if not tables:
        return

    combined = pa.concat_tables(tables, promote_options="default")

    if year not in writers:
        year_dir = tbbo_dir / f"year={year}"
        year_dir.mkdir(parents=True, exist_ok=True)
        part_path = year_dir / "part.parquet"
        schemas[year] = combined.schema
        writers[year] = pq.ParquetWriter(
            part_path,
            combined.schema,
            compression=PARQUET_COMPRESSION,
            compression_level=PARQUET_COMPRESSION_LEVEL,
        )
        log.debug("Opened writer for year=%d at %s", year, part_path)
    else:
        # Align schema to the canonical one in case column dtypes vary
        # marginally across files (e.g. int32 vs int64 for sequence when a file
        # is empty-ish). cast() raises on incompatible casts — good, fail loud.
        if combined.schema != schemas[year]:
            combined = combined.cast(schemas[year])

    writers[year].write_table(combined)
    log.debug(
        "Flushed year=%d: %s rows buffered -> disk",
        year,
        f"{buffer_rows[year]:,}",
    )

    buffers[year] = []
    buffer_rows[year] = 0


def _merge_symbology(
    path: Path,
    new_mappings: dict[tuple[int, str], tuple[pd.Timestamp, pd.Timestamp]],
) -> None:
    """Merge new (instrument_id, symbol) mappings into path, preserving existing rows.

    Behavior:
      - If ``path`` does not exist, write new_mappings as-is.
      - If it exists (e.g. from a prior OHLCV archive_convert run), union with
        the existing rows. On duplicate (instrument_id, symbol) keys, take the
        min(first_seen) and max(last_seen) so the date range always widens.
    """
    if not new_mappings:
        log.warning("Skipping symbology merge — no mappings collected from TBBO run")
        return

    new_df = pd.DataFrame(
        [
            {
                "instrument_id": key[0],
                "symbol": key[1],
                "first_seen": val[0],
                "last_seen": val[1],
            }
            for key, val in new_mappings.items()
        ]
    )

    if path.exists():
        existing = pq.read_table(path).to_pandas()
        log.info("Merging with existing symbology (%d rows)", len(existing))
        combined = pd.concat([existing, new_df], ignore_index=True)
        # Normalize timestamps to UTC pandas datetimes so min/max work cleanly
        # across pyarrow-backed and pandas-backed dtypes.
        combined["first_seen"] = pd.to_datetime(combined["first_seen"], utc=True)
        combined["last_seen"] = pd.to_datetime(combined["last_seen"], utc=True)
        merged = (
            combined.groupby(["instrument_id", "symbol"], as_index=False)
            .agg(first_seen=("first_seen", "min"), last_seen=("last_seen", "max"))
            .sort_values("instrument_id")
        )
    else:
        merged = new_df.sort_values("instrument_id")

    table = pa.Table.from_pandas(merged, preserve_index=False)
    pq.write_table(table, path, compression=PARQUET_COMPRESSION)
    log.info(
        "Symbology: %s rows written to %s",
        f"{len(merged):,}",
        path.name,
    )


def _copy_condition(condition_path: Path | None, out_dir: Path) -> int:
    """Copy a Databento condition.json into out_dir (namespaced), return degraded count."""
    if condition_path is None:
        return 0
    condition_path = condition_path.expanduser().resolve()
    if not condition_path.exists():
        log.warning("condition.json not found at %s", condition_path)
        return 0

    dest = out_dir / "tbbo_condition.json"
    shutil.copy2(condition_path, dest)

    try:
        cond_days = json.loads(dest.read_text())
    except json.JSONDecodeError as exc:
        log.warning("condition.json is not valid JSON: %s", exc)
        return 0

    if not isinstance(cond_days, list):
        log.warning("condition.json is not a list; skipping degraded-day count")
        return 0

    degraded = sum(
        1 for d in cond_days if isinstance(d, dict) and d.get("condition") == "degraded"
    )
    log.info(
        "Copied condition.json → tbbo_condition.json (%d degraded days of %d total)",
        degraded,
        len(cond_days),
    )
    return degraded


def _result_to_json(r: ConvertResult) -> dict[str, Any]:
    return {
        "source_dir": str(r.source_dir),
        "out_dir": str(r.out_dir),
        "schema": r.schema,
        "total_rows": r.total_rows,
        "distinct_instruments": r.distinct_instruments,
        "start_date": r.start_date,
        "end_date": r.end_date,
        "years": r.years,
        "rows_per_year": {str(k): v for k, v in r.rows_per_year.items()},
        "rows_per_symbol": dict(
            sorted(r.rows_per_symbol.items(), key=lambda kv: -kv[1])
        ),
        "degraded_days": r.degraded_days,
        "files_processed": r.files_processed,
        "files_skipped": r.files_skipped,
        "skipped_files": r.skipped_files,
        "generated_at": datetime.now(UTC).isoformat(),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Convert a directory of daily Databento TBBO DBN files into "
            "year-partitioned Parquet suitable for DuckDB-over-Parquet analysis."
        ),
    )
    parser.add_argument(
        "--dbn-dir",
        required=True,
        type=Path,
        help="Directory containing glbx-mdp3-*.tbbo.dbn.zst files.",
    )
    parser.add_argument(
        "--out",
        required=True,
        type=Path,
        help="Output directory root (created if missing).",
    )
    parser.add_argument(
        "--condition",
        type=Path,
        default=None,
        help="Optional companion condition.json from the Databento batch.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Process only the first N rows total — for dev runs.",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
    )

    try:
        result = convert_tbbo_dir_to_parquet(
            dbn_dir=args.dbn_dir,
            out_dir=args.out,
            condition_path=args.condition,
            limit=args.limit,
        )
    except Exception as exc:
        log.error("Conversion failed: %s", exc, exc_info=args.verbose)
        return 1

    print()
    print(
        f"Converted {result.total_rows:,} TBBO rows across "
        f"{result.distinct_instruments:,} instruments "
        f"({result.files_processed} files processed, "
        f"{result.files_skipped} skipped)"
    )
    if result.start_date and result.end_date:
        print(f"  Range:  {result.start_date} -> {result.end_date}")
    if result.years:
        print(
            f"  Years:  {len(result.years)} ({min(result.years)}-{max(result.years)})"
        )
    if result.degraded_days:
        print(
            f"  Note:   {result.degraded_days} degraded trading days — "
            "join tbbo_condition.json in backtests."
        )
    print(f"  Output: {result.out_dir}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
