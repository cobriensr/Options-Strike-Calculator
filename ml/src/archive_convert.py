"""Convert Databento DBN OHLCV-1m files into year-partitioned Parquet.

One-shot utility for bootstrapping the local archive from a Databento batch
download (e.g. ``GLBX-20260418-J3LNNQVJQW/glbx-mdp3-...ohlcv-1m.dbn.zst``).

The DBN file we're targeting has:

* dataset ``GLBX.MDP3`` (CME Globex)
* schema ``ohlcv-1m`` (minute bars only — no ticks or MBP)
* ``stype_in=parent`` with parents ``ES.FUT``, ``NQ.FUT``, ``ES.OPT`` — so the
  content is every ES/NQ futures contract PLUS every ES options contract that
  traded across the full 16-year range
* ``stype_out=instrument_id`` with ``map_symbols=False`` — each record uses a
  CME numeric instrument_id that the Databento SDK can resolve back to a raw
  symbol string via its embedded symbology mappings when we call
  ``to_df(map_symbols=True)``

The converter emits::

    out_dir/
      ohlcv_1m/
        year=2010/part.parquet
        year=2011/part.parquet
        ...
      symbology.parquet      — instrument_id → symbol lookup with date range
      convert_summary.json   — row counts, date range, degraded-day count

CLI::

    cd ml
    .venv/bin/python -m src.archive_convert \\
        --dbn ~/GLBX-20260418-J3LNNQVJQW/glbx-mdp3-20100606-20260417.ohlcv-1m.dbn.zst \\
        --out data/archive \\
        --condition ~/GLBX-20260418-J3LNNQVJQW/condition.json

Loads the full DataFrame into memory (~2–5 GB for this file) which is fine
for a MacBook with 16 GB+ RAM and keeps the code simple. For truly large
inputs, iterate ``store.to_ndarray()`` in chunks instead.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import databento as db
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

log = logging.getLogger("archive_convert")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Expected schema. Guard rail — refuse to run on anything other than
# ohlcv-1m since column shapes and row counts differ wildly for ticks/MBP.
EXPECTED_SCHEMA = "ohlcv-1m"

# Parquet output settings. zstd level 3 is a sweet spot: ~4–5x compression
# vs uncompressed Arrow with minimal CPU cost vs level 1. DuckDB reads it
# at full speed.
PARQUET_COMPRESSION = "zstd"
PARQUET_COMPRESSION_LEVEL = 3

# Minimum columns we expect in the materialized DataFrame. If the Databento
# SDK upstream renames these we fail loud rather than writing a broken
# archive that surfaces as mysterious NaNs in backtests months later.
REQUIRED_COLUMNS = {
    "ts_event",
    "instrument_id",
    "open",
    "high",
    "low",
    "close",
    "volume",
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ConvertResult:
    """Summary of a single DBN → Parquet conversion run."""

    source_file: Path
    out_dir: Path
    schema: str
    total_rows: int
    distinct_instruments: int
    start_date: str  # ISO-8601
    end_date: str  # ISO-8601
    years: list[int]
    rows_per_year: dict[int, int]
    degraded_days: int  # 0 when no condition.json was supplied


def convert_dbn_to_parquet(
    dbn_path: Path,
    out_dir: Path,
    *,
    condition_path: Path | None = None,
    limit: int | None = None,
) -> ConvertResult:
    """Convert an ohlcv-1m DBN file into year-partitioned Parquet.

    Args:
        dbn_path: path to the ``.dbn.zst`` input file.
        out_dir:  destination root. Will contain ``ohlcv_1m/year=*/``
                  subdirs plus ``symbology.parquet`` and
                  ``convert_summary.json``.
        condition_path: optional companion ``condition.json`` from the
                  Databento batch. Copied into ``out_dir/`` verbatim so
                  downstream backtests can join against it for
                  gap/degraded-day awareness.
        limit: optional row cap for quick dev runs. ``None`` = all rows.

    Returns:
        ``ConvertResult`` with per-year row counts and the observed
        date range.

    Raises:
        FileNotFoundError: if ``dbn_path`` does not exist.
        ValueError: if the DBN's schema is anything other than ohlcv-1m.
        RuntimeError: if the materialized DataFrame is missing expected
            columns (guards against silent upstream SDK shape changes).
    """
    dbn_path = dbn_path.expanduser().resolve()
    out_dir = out_dir.expanduser().resolve()

    if not dbn_path.exists():
        raise FileNotFoundError(f"DBN file not found: {dbn_path}")

    ohlcv_dir = out_dir / "ohlcv_1m"
    ohlcv_dir.mkdir(parents=True, exist_ok=True)

    log.info("Opening DBN: %s", dbn_path)
    store = db.DBNStore.from_file(dbn_path)

    schema = str(store.schema)
    if schema != EXPECTED_SCHEMA:
        raise ValueError(
            f"Expected schema {EXPECTED_SCHEMA!r}, got {schema!r}. "
            "This converter is specific to minute-bar OHLCV."
        )

    log.info("Materializing bars (may take 20+ min for a full 16yr ES.OPT file)…")
    df = _materialize_dataframe(store)

    # Databento's to_df() returns a DatetimeIndex named 'ts_event' by
    # default. Promote it to a regular column so the rest of this
    # converter (groupby year, write Parquet, etc.) can treat it
    # uniformly with the other columns.
    if "ts_event" not in df.columns and df.index.name == "ts_event":
        df = df.reset_index()

    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise RuntimeError(
            f"DBN DataFrame missing expected columns: {sorted(missing)}. "
            f"Got: {sorted(df.columns)}. Databento SDK may have "
            "changed shapes; update REQUIRED_COLUMNS if this is expected."
        )

    # Older SDKs called it 'raw_symbol'; normalize.
    if "symbol" not in df.columns and "raw_symbol" in df.columns:
        df = df.rename(columns={"raw_symbol": "symbol"})

    # Absence of a symbol column isn't fatal — instrument_id is still
    # queryable — but it degrades the archive's usefulness significantly,
    # so log loudly.
    if "symbol" not in df.columns:
        log.warning(
            "No symbol column materialized — archive will only have "
            "instrument_id. Re-fetch with map_symbols=True to fix."
        )
        df["symbol"] = pd.NA

    if limit is not None:
        log.info("Applying dev --limit of %s rows", f"{limit:,}")
        df = df.head(limit)

    log.info(
        "Loaded %s rows across %s distinct instruments",
        f"{len(df):,}",
        f"{df['instrument_id'].nunique():,}",
    )

    # -- Partition by year ------------------------------------------------
    df["year"] = df["ts_event"].dt.year
    rows_per_year = _write_year_partitions(df, ohlcv_dir)

    # -- Symbology lookup -------------------------------------------------
    _write_symbology(df, out_dir / "symbology.parquet")

    # -- Optional condition.json copy ------------------------------------
    degraded_days = _copy_condition(condition_path, out_dir)

    # -- Summary manifest -------------------------------------------------
    result = ConvertResult(
        source_file=dbn_path,
        out_dir=out_dir,
        schema=schema,
        total_rows=int(len(df)),
        distinct_instruments=int(df["instrument_id"].nunique()),
        start_date=df["ts_event"].min().isoformat(),
        end_date=df["ts_event"].max().isoformat(),
        years=sorted(rows_per_year.keys()),
        rows_per_year=rows_per_year,
        degraded_days=degraded_days,
    )
    (out_dir / "convert_summary.json").write_text(
        json.dumps(_result_to_json(result), indent=2)
    )
    log.info("Summary manifest -> convert_summary.json")

    return result


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _materialize_dataframe(store: db.DBNStore) -> pd.DataFrame:
    """Call store.to_df(...) with arguments that are stable across SDK versions.

    The ``price_type`` kwarg was introduced in databento>=0.50; older
    releases used ``pretty_px``. We try the new spelling first and fall
    back so this script survives a minor SDK downgrade in a different
    venv.
    """
    try:
        return store.to_df(
            price_type="float",
            pretty_ts=True,
            map_symbols=True,
        )
    except TypeError:
        log.debug("price_type kwarg not supported; falling back to pretty_px")
        return store.to_df(
            pretty_px=True,
            pretty_ts=True,
            map_symbols=True,
        )


def _write_year_partitions(
    df: pd.DataFrame,
    ohlcv_dir: Path,
) -> dict[int, int]:
    """Write one Parquet file per year. Returns row counts per year."""
    rows_per_year: dict[int, int] = {}
    for year, grp in df.groupby("year", sort=True):
        year_dir = ohlcv_dir / f"year={int(year)}"
        year_dir.mkdir(parents=True, exist_ok=True)
        part_path = year_dir / "part.parquet"

        # Drop the year column before writing — it's already encoded in
        # the directory partition, and DuckDB/PyArrow will synthesize
        # it back automatically on read. Saves ~1% disk.
        part_df = grp.drop(columns=["year"])

        table = pa.Table.from_pandas(part_df, preserve_index=False)
        pq.write_table(
            table,
            part_path,
            compression=PARQUET_COMPRESSION,
            compression_level=PARQUET_COMPRESSION_LEVEL,
        )

        rows = len(part_df)
        size_mb = part_path.stat().st_size / 1_000_000
        rows_per_year[int(year)] = rows
        log.info("  year=%d -> %s rows, %.1f MB", year, f"{rows:,}", size_mb)

    return rows_per_year


def _write_symbology(df: pd.DataFrame, out_path: Path) -> None:
    """Build and persist the instrument_id → symbol lookup table.

    Aggregates by (instrument_id, symbol) to get the earliest and latest
    ts_event each mapping was observed. For most instruments this is a
    1-to-1 mapping; when Databento rotates a continuous parent symbol
    onto a new front-month contract the same symbol can span multiple
    instrument_ids, which is why we group by both.
    """
    if "symbol" not in df.columns or df["symbol"].isna().all():
        log.warning("Skipping symbology.parquet — no resolved symbols in input")
        return

    sym = (
        df[["instrument_id", "symbol", "ts_event"]]
        .dropna(subset=["symbol"])
        .groupby(["instrument_id", "symbol"], as_index=False)
        .agg(first_seen=("ts_event", "min"), last_seen=("ts_event", "max"))
        .sort_values("instrument_id")
    )
    table = pa.Table.from_pandas(sym, preserve_index=False)
    pq.write_table(table, out_path, compression=PARQUET_COMPRESSION)
    log.info(
        "Symbology: %s distinct (instrument_id, symbol) pairs -> %s",
        f"{len(sym):,}",
        out_path.name,
    )


def _copy_condition(condition_path: Path | None, out_dir: Path) -> int:
    """Copy a Databento condition.json into out_dir, return degraded-day count."""
    if condition_path is None:
        return 0
    condition_path = condition_path.expanduser().resolve()
    if not condition_path.exists():
        log.warning("condition.json not found at %s", condition_path)
        return 0

    dest = out_dir / "condition.json"
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
        1 for d in cond_days
        if isinstance(d, dict) and d.get("condition") == "degraded"
    )
    log.info(
        "Copied condition.json (%d degraded days of %d total)",
        degraded,
        len(cond_days),
    )
    return degraded


def _result_to_json(r: ConvertResult) -> dict[str, Any]:
    return {
        "source_file": str(r.source_file),
        "out_dir": str(r.out_dir),
        "schema": r.schema,
        "total_rows": r.total_rows,
        "distinct_instruments": r.distinct_instruments,
        "start_date": r.start_date,
        "end_date": r.end_date,
        "years": r.years,
        "rows_per_year": {str(k): v for k, v in r.rows_per_year.items()},
        "degraded_days": r.degraded_days,
        "generated_at": datetime.now(UTC).isoformat(),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Convert a Databento OHLCV-1m DBN file to year-partitioned "
            "Parquet suitable for DuckDB-over-Parquet backtesting."
        ),
    )
    parser.add_argument(
        "--dbn",
        required=True,
        type=Path,
        help="Path to the .dbn.zst input file.",
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
        help="Process only the first N rows — for dev runs.",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
    )

    try:
        result = convert_dbn_to_parquet(
            dbn_path=args.dbn,
            out_dir=args.out,
            condition_path=args.condition,
            limit=args.limit,
        )
    except Exception as exc:
        log.error("Conversion failed: %s", exc, exc_info=args.verbose)
        return 1

    print()
    print(
        f"✓ Converted {result.total_rows:,} bars across "
        f"{result.distinct_instruments:,} instruments"
    )
    print(f"  Range:  {result.start_date} → {result.end_date}")
    print(
        f"  Years:  {len(result.years)} "
        f"({min(result.years)}–{max(result.years)})"
    )
    if result.degraded_days:
        print(
            f"  Note:   {result.degraded_days} degraded trading days — "
            "join condition.json in backtests."
        )
    print(f"  Output: {result.out_dir}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
