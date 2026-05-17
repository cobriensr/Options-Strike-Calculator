#!/usr/bin/env python3
"""Validation runner for multileg_assembler.

Loads UW Full Tape parquets, runs ``classify_trades`` per ticker, and
compares results against the legacy ``mv_delta`` baseline (76% of $1M+
prints have ``mv_delta > 0`` — the prior whale-multileg finding).

Outputs:
    results.json    — per-day and aggregate stats, mv_delta confusion
    sample_50.tsv   — 50 random MATCHED groups for manual spot-check

The matcher runs per-ticker on ALL options-only rows for that ticker so
that a $1M+ trade can match against smaller-premium sibling legs (you
cannot find a vertical's partner if you only look at the $1M leg).

Scoping:
    * Latest 5 days from ``~/Desktop/Eod-Full-Tape-parquet/`` by default.
    * Tickers with zero $1M+ trades on a given day are still processed
      so we capture an unbiased structure distribution.

Run:
    ml/.venv/bin/python ml/experiments/multileg-assembler-validation/run.py \\
        [--days N] [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD] \\
        [--time-window START_HOUR-END_HOUR] [--out-dir PATH]
"""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path

import polars as pl

# Make ml/src importable.
_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "ml" / "src"))

from multileg_assembler import classify_trades  # noqa: E402

# ── Configuration ──────────────────────────────────────────────────────────

PARQUET_DIR = Path.home() / "Desktop" / "Eod-Full-Tape-parquet"
PARQUET_GLOB = "*-fulltape.parquet"

PREMIUM_THRESHOLD = 1_000_000.0

# Matcher params (defaults from multileg_assembler.classify_trades).
WINDOW_SECONDS = 90
STRIKE_TOLERANCE = 0.05
SIZE_TOLERANCE = 0.10

# Per-ticker row cap. The matcher is O(W²) per starting index in the
# rolling time window. Empirically on this hardware:
#   NOW (~67K rows / day) → ~420s
#   OKLO (~27K rows / day) → ~83s
#   SPXW (1.3M rows / day) extrapolates to many hours.
#
# Smoke-test strategy: combine a per-ticker row cap (excludes mega-cap
# tail) with an optional ``--time-window`` slice (cuts the day to e.g.
# 1 hour so big tickers fit under the cap and DO get classified). This
# yields a representative cross-section of all $1M+ prints rather than
# leaving 89% of them in the unclassified mega-ticker tail.
#
# 10K default chosen so a typical ticker classifies in <30s and the
# smoke test completes in a bounded wall-clock budget.
PER_TICKER_ROW_CAP = 10_000

SAMPLE_GROUP_COUNT = 50
SAMPLE_SEED = 20260516

# Columns the matcher needs (+ ones we carry for diagnostics/sample TSV).
_MATCHER_COLS = (
    "id",
    "underlying_symbol",
    "executed_at",
    "option_chain_id",
    "strike",
    "expiry",
    "option_type",
    "size",
    "price",
    "nbbo_bid",
    "nbbo_ask",
    "premium",
    "multi_vol",
    "delta",
    "tags",
)


# ── Result schemas ─────────────────────────────────────────────────────────


@dataclass
class DayStats:
    """Per-day stats written into results.json."""

    date: str
    parquet_path: str
    total_rows: int
    options_only_rows: int
    tickers_processed: int
    tickers_skipped_oversize: int
    skipped_tickers: list[str]
    skipped_rows: int
    skipped_premium_1m: int
    elapsed_seconds: float
    structure_counts: dict[str, int]
    structure_pct: dict[str, float]
    isolated_pct: float
    premium_1m_total: int
    premium_1m_reclassified: int
    premium_1m_reclassification_rate: float
    # 2x2 confusion: legacy mv_delta > 0 (rows) vs new matched (cols), $1M+ only.
    # keys: legacy_multi_new_matched, legacy_multi_new_isolated,
    #       legacy_iso_new_matched,   legacy_iso_new_isolated
    mv_delta_confusion_1m: dict[str, int]
    mv_delta_agreement_1m_pct: float


@dataclass
class AggregateStats:
    """Combined across all processed days."""

    days: int
    total_rows: int
    options_only_rows: int
    tickers_skipped_oversize_total: int
    skipped_rows_total: int
    skipped_premium_1m_total: int
    structure_counts: dict[str, int]
    structure_pct: dict[str, float]
    isolated_pct: float
    premium_1m_total: int
    premium_1m_reclassified: int
    premium_1m_reclassification_rate: float
    mv_delta_confusion_1m: dict[str, int]
    mv_delta_agreement_1m_pct: float


@dataclass
class RunResult:
    """Top-level results.json shape."""

    generated_at: str
    matcher_git_sha: str
    params: dict[str, float]
    days: list[DayStats] = field(default_factory=list)
    aggregate: AggregateStats | None = None


# ── Parquet selection ──────────────────────────────────────────────────────


def _list_available_dates() -> list[date]:
    """Return all dates with a parquet available, sorted ascending."""
    dates: list[date] = []
    for path in sorted(PARQUET_DIR.glob(PARQUET_GLOB)):
        # Filename: YYYY-MM-DD-fulltape.parquet
        stem = path.stem  # 2026-05-15-fulltape
        date_str = stem.rsplit("-fulltape", 1)[0]
        try:
            dates.append(date.fromisoformat(date_str))
        except ValueError:
            continue
    return sorted(set(dates))


def _select_dates(
    available: list[date],
    *,
    days: int | None,
    start_date: date | None,
    end_date: date | None,
) -> list[date]:
    """Choose which dates to process based on CLI args."""
    if start_date is not None or end_date is not None:
        lo = start_date or available[0]
        hi = end_date or available[-1]
        return [d for d in available if lo <= d <= hi]
    n = days if days is not None else 5
    return available[-n:]


def _parquet_path_for(d: date) -> Path:
    return PARQUET_DIR / f"{d.isoformat()}-fulltape.parquet"


# ── Per-day processing ─────────────────────────────────────────────────────


def _load_day_options(
    parquet_path: Path,
    time_window: tuple[int, int] | None = None,
) -> tuple[pl.DataFrame, int]:
    """Load options-only rows + compute legacy ``mv_delta``.

    Returns (options_df, total_row_count_before_filter).

    ``time_window``: (start_hour_utc, end_hour_utc) inclusive-exclusive,
    e.g. (16, 17) restricts to 16:00-17:00 UTC (11am-12pm CT). When set,
    we still compute mv_delta on the FULL day (so per-contract cumulative
    multi_vol is correct) then filter to the window before returning.
    """
    lf = pl.scan_parquet(str(parquet_path))
    total_rows = int(lf.select(pl.len()).collect().item())

    # Options only — schema in this archive always has 'call'/'put' so this
    # is a no-op safety net, not a data-driven filter.
    options = lf.filter(pl.col("option_type").is_in(["call", "put"]))

    # Compute legacy mv_delta per option_chain_id ON THE FULL DAY. This is
    # the prior baseline "is this a multi-leg leg" signal we're comparing
    # against; it must see the full intra-day sequence per contract.
    options = options.sort(["option_chain_id", "executed_at"]).with_columns(
        (
            pl.col("multi_vol")
            - pl.col("multi_vol").shift(1).over("option_chain_id")
        )
        .fill_null(pl.col("multi_vol"))
        .alias("mv_delta")
    )

    # Apply time window AFTER mv_delta calc so cumulative semantics are
    # preserved.
    if time_window is not None:
        start_h, end_h = time_window
        options = options.filter(
            (pl.col("executed_at").dt.hour() >= start_h)
            & (pl.col("executed_at").dt.hour() < end_h)
        )

    # Project to the columns we need + mv_delta. Keep tags for diagnostics.
    keep_cols = list(_MATCHER_COLS) + ["mv_delta"]
    options_df = options.select(keep_cols).collect()
    return options_df, total_rows


@dataclass
class _SkipInfo:
    """What we skipped during per-ticker classification."""

    tickers: list[str] = field(default_factory=list)
    rows: int = 0
    premium_1m: int = 0


def _classify_per_ticker(
    options_df: pl.DataFrame,
) -> tuple[pl.DataFrame, int, _SkipInfo]:
    """Run matcher per ticker (skipping oversize ones), concatenate.

    Returns (classified_df, processed_ticker_count, skip_info).

    Tickers with row count > ``PER_TICKER_ROW_CAP`` are recorded but not
    classified — the matcher is O(W²) per starting index in the rolling
    window and stalls on the mega-tickers (SPXW, SPY, QQQ, TSLA, NVDA on
    most days). The skip is surfaced honestly in the per-day stats and
    the final report so the reader sees what scope the gate was measured
    against.
    """
    pieces: list[pl.DataFrame] = []
    skip = _SkipInfo()
    processed_count = 0
    tickers = options_df.get_column("underlying_symbol").unique().to_list()
    for ticker in tickers:
        chunk = options_df.filter(pl.col("underlying_symbol") == ticker)
        if chunk.height == 0:
            continue
        if chunk.height > PER_TICKER_ROW_CAP:
            high_prem = chunk.filter(
                pl.col("premium") >= PREMIUM_THRESHOLD
            ).height
            skip.tickers.append(str(ticker))
            skip.rows += chunk.height
            skip.premium_1m += high_prem
            print(
                f"    SKIP {ticker}: {chunk.height:,} rows "
                f"(> cap {PER_TICKER_ROW_CAP:,}); "
                f"{high_prem} $1M+ prints excluded",
                flush=True,
            )
            continue
        t0 = time.time()
        classified = classify_trades(
            chunk,
            window_seconds=WINDOW_SECONDS,
            strike_tolerance=STRIKE_TOLERANCE,
            size_tolerance=SIZE_TOLERANCE,
        )
        elapsed = time.time() - t0
        if elapsed > 30:
            print(
                f"    {ticker}: {chunk.height:,} rows in {elapsed:.1f}s",
                flush=True,
            )
        pieces.append(classified)
        processed_count += 1
    if not pieces:
        return options_df.clear(), 0, skip
    return pl.concat(pieces, how="vertical_relaxed"), processed_count, skip


def _structure_counts(df: pl.DataFrame) -> dict[str, int]:
    """Return {structure_name: count} for ``inferred_structure``."""
    grouped = (
        df.group_by("inferred_structure")
        .agg(pl.len().alias("n"))
        .sort("inferred_structure")
    )
    return {
        str(row["inferred_structure"]): int(row["n"])
        for row in grouped.iter_rows(named=True)
    }


def _pct_of(counts: dict[str, int], total: int) -> dict[str, float]:
    if total == 0:
        return dict.fromkeys(counts, 0.0)
    return {k: round(100.0 * v / total, 4) for k, v in counts.items()}


def _mv_delta_confusion(df: pl.DataFrame) -> dict[str, int]:
    """2x2 confusion: legacy mv_delta>0 vs new matched, $1M+ trades only."""
    high_prem = df.filter(pl.col("premium") >= PREMIUM_THRESHOLD)
    if high_prem.height == 0:
        return {
            "legacy_multi_new_matched": 0,
            "legacy_multi_new_isolated": 0,
            "legacy_iso_new_matched": 0,
            "legacy_iso_new_isolated": 0,
        }
    legacy_multi = pl.col("mv_delta") > 0
    new_matched = ~pl.col("is_isolated_leg")
    cm = high_prem.select(
        (legacy_multi & new_matched).sum().alias("legacy_multi_new_matched"),
        (legacy_multi & ~new_matched)
        .sum()
        .alias("legacy_multi_new_isolated"),
        (~legacy_multi & new_matched).sum().alias("legacy_iso_new_matched"),
        (~legacy_multi & ~new_matched)
        .sum()
        .alias("legacy_iso_new_isolated"),
    ).row(0, named=True)
    return {k: int(v) for k, v in cm.items()}


def _agreement_pct(confusion: dict[str, int]) -> float:
    total = sum(confusion.values())
    if total == 0:
        return 0.0
    agree = (
        confusion["legacy_multi_new_matched"]
        + confusion["legacy_iso_new_isolated"]
    )
    return round(100.0 * agree / total, 4)


def _process_day(
    parquet_path: Path,
    time_window: tuple[int, int] | None = None,
) -> tuple[DayStats, pl.DataFrame]:
    """Run the full per-day pipeline. Return stats + classified DataFrame."""
    start = time.time()
    options_df, total_rows = _load_day_options(parquet_path, time_window)
    classified, ticker_count, skip = _classify_per_ticker(options_df)
    elapsed = time.time() - start

    structure_counts = _structure_counts(classified)
    structure_pct = _pct_of(structure_counts, classified.height)
    isolated_pct = structure_pct.get("isolated_leg", 0.0)

    high_prem = classified.filter(pl.col("premium") >= PREMIUM_THRESHOLD)
    premium_1m_total = high_prem.height
    premium_1m_reclassified = int(
        high_prem.select((~pl.col("is_isolated_leg")).sum()).item()
        if premium_1m_total
        else 0
    )
    reclass_rate = (
        round(100.0 * premium_1m_reclassified / premium_1m_total, 4)
        if premium_1m_total
        else 0.0
    )

    confusion = _mv_delta_confusion(classified)
    agreement = _agreement_pct(confusion)

    # Date string from filename stem
    date_str = parquet_path.stem.rsplit("-fulltape", 1)[0]

    stats = DayStats(
        date=date_str,
        parquet_path=str(parquet_path),
        total_rows=total_rows,
        options_only_rows=classified.height,
        tickers_processed=ticker_count,
        tickers_skipped_oversize=len(skip.tickers),
        skipped_tickers=skip.tickers,
        skipped_rows=skip.rows,
        skipped_premium_1m=skip.premium_1m,
        elapsed_seconds=round(elapsed, 2),
        structure_counts=structure_counts,
        structure_pct=structure_pct,
        isolated_pct=isolated_pct,
        premium_1m_total=premium_1m_total,
        premium_1m_reclassified=premium_1m_reclassified,
        premium_1m_reclassification_rate=reclass_rate,
        mv_delta_confusion_1m=confusion,
        mv_delta_agreement_1m_pct=agreement,
    )
    return stats, classified


# ── Aggregation + sampling ────────────────────────────────────────────────


def _aggregate(
    day_stats: list[DayStats], all_classified: list[pl.DataFrame]
) -> AggregateStats:
    """Combine per-day stats by re-deriving from the concatenated frame."""
    skipped_tickers = sum(d.tickers_skipped_oversize for d in day_stats)
    skipped_rows = sum(d.skipped_rows for d in day_stats)
    skipped_prem = sum(d.skipped_premium_1m for d in day_stats)
    if not all_classified:
        return AggregateStats(
            days=0,
            total_rows=0,
            options_only_rows=0,
            tickers_skipped_oversize_total=skipped_tickers,
            skipped_rows_total=skipped_rows,
            skipped_premium_1m_total=skipped_prem,
            structure_counts={},
            structure_pct={},
            isolated_pct=0.0,
            premium_1m_total=0,
            premium_1m_reclassified=0,
            premium_1m_reclassification_rate=0.0,
            mv_delta_confusion_1m={
                "legacy_multi_new_matched": 0,
                "legacy_multi_new_isolated": 0,
                "legacy_iso_new_matched": 0,
                "legacy_iso_new_isolated": 0,
            },
            mv_delta_agreement_1m_pct=0.0,
        )

    combined = pl.concat(all_classified, how="vertical_relaxed")
    structure_counts = _structure_counts(combined)
    structure_pct = _pct_of(structure_counts, combined.height)
    isolated_pct = structure_pct.get("isolated_leg", 0.0)

    high_prem = combined.filter(pl.col("premium") >= PREMIUM_THRESHOLD)
    premium_1m_total = high_prem.height
    premium_1m_reclassified = (
        int(high_prem.select((~pl.col("is_isolated_leg")).sum()).item())
        if premium_1m_total
        else 0
    )
    reclass_rate = (
        round(100.0 * premium_1m_reclassified / premium_1m_total, 4)
        if premium_1m_total
        else 0.0
    )
    confusion = _mv_delta_confusion(combined)
    agreement = _agreement_pct(confusion)

    return AggregateStats(
        days=len(day_stats),
        total_rows=sum(d.total_rows for d in day_stats),
        options_only_rows=combined.height,
        tickers_skipped_oversize_total=skipped_tickers,
        skipped_rows_total=skipped_rows,
        skipped_premium_1m_total=skipped_prem,
        structure_counts=structure_counts,
        structure_pct=structure_pct,
        isolated_pct=isolated_pct,
        premium_1m_total=premium_1m_total,
        premium_1m_reclassified=premium_1m_reclassified,
        premium_1m_reclassification_rate=reclass_rate,
        mv_delta_confusion_1m=confusion,
        mv_delta_agreement_1m_pct=agreement,
    )


def _write_sample_tsv(
    all_classified: list[pl.DataFrame], out_path: Path
) -> int:
    """Pick SAMPLE_GROUP_COUNT random MATCHED groups, write full groups.

    Returns the number of groups actually written (may be < SAMPLE_GROUP_COUNT
    if fewer matched groups exist).
    """
    if not all_classified:
        out_path.write_text("")
        return 0
    combined = pl.concat(all_classified, how="vertical_relaxed")
    matched = combined.filter(~pl.col("is_isolated_leg"))
    if matched.height == 0:
        out_path.write_text("")
        return 0

    group_ids = matched.get_column("pattern_group_id").unique().to_list()
    rng = random.Random(SAMPLE_SEED)
    rng.shuffle(group_ids)
    chosen = group_ids[:SAMPLE_GROUP_COUNT]
    sample = matched.filter(
        pl.col("pattern_group_id").is_in(chosen)
    ).sort(["pattern_group_id", "executed_at"])

    cols_for_review = [
        "pattern_group_id",
        "inferred_structure",
        "match_confidence",
        "underlying_symbol",
        "executed_at",
        "expiry",
        "option_type",
        "strike",
        "size",
        "price",
        "nbbo_bid",
        "nbbo_ask",
        "premium",
        "delta",
        "multi_vol",
        "mv_delta",
        "tags",
        "id",
        "option_chain_id",
    ]
    available = [c for c in cols_for_review if c in sample.columns]
    sample = sample.select(available)
    sample.write_csv(str(out_path), separator="\t")
    return len(chosen)


# ── Git SHA helper ─────────────────────────────────────────────────────────


def _matcher_git_sha() -> str:
    """SHA of the multileg_assembler.py at HEAD; mark dirty if modified."""
    target = _REPO_ROOT / "ml" / "src" / "multileg_assembler.py"
    try:
        sha = subprocess.check_output(
            ["git", "log", "-n", "1", "--format=%H", "--", str(target)],
            cwd=str(_REPO_ROOT),
            text=True,
        ).strip()
    except subprocess.CalledProcessError:
        return "unknown"
    if not sha:
        return "uncommitted"
    # Dirty check
    try:
        dirty = subprocess.check_output(
            ["git", "status", "--porcelain", "--", str(target)],
            cwd=str(_REPO_ROOT),
            text=True,
        ).strip()
    except subprocess.CalledProcessError:
        dirty = ""
    return f"{sha[:12]}{'-dirty' if dirty else ''}"


# ── CLI ────────────────────────────────────────────────────────────────────


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--days", type=int, default=None, help="latest N days")
    p.add_argument(
        "--start-date",
        type=date.fromisoformat,
        default=None,
        help="inclusive YYYY-MM-DD",
    )
    p.add_argument(
        "--end-date",
        type=date.fromisoformat,
        default=None,
        help="inclusive YYYY-MM-DD",
    )
    p.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="results.json + sample_50.tsv destination",
    )
    p.add_argument(
        "--time-window",
        type=str,
        default=None,
        help=(
            "Restrict to intra-day window (UTC hours, half-open) — "
            "format START-END e.g. 16-17 for 16:00-17:00 UTC (11am-12pm CT). "
            "mv_delta is still computed on the full day."
        ),
    )
    return p.parse_args()


def _parse_time_window(spec: str | None) -> tuple[int, int] | None:
    if spec is None:
        return None
    try:
        lo_str, hi_str = spec.split("-", 1)
        lo, hi = int(lo_str), int(hi_str)
    except ValueError as exc:
        raise SystemExit(
            f"--time-window must be START-END (int hours UTC), got {spec!r}"
        ) from exc
    if not (0 <= lo < hi <= 24):
        raise SystemExit(
            f"--time-window hours must satisfy 0 <= start < end <= 24, "
            f"got {lo}-{hi}"
        )
    return (lo, hi)


def main() -> None:
    args = _parse_args()
    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    time_window = _parse_time_window(args.time_window)

    available = _list_available_dates()
    if not available:
        sys.stderr.write(
            f"No parquets found in {PARQUET_DIR}/{PARQUET_GLOB}\n"
        )
        sys.exit(1)

    selected = _select_dates(
        available,
        days=args.days,
        start_date=args.start_date,
        end_date=args.end_date,
    )
    if not selected:
        sys.stderr.write("No dates matched the requested range\n")
        sys.exit(1)

    tw_str = (
        f"{time_window[0]:02d}:00-{time_window[1]:02d}:00 UTC"
        if time_window
        else "full session"
    )
    print(
        f"Processing {len(selected)} day(s): "
        f"{selected[0].isoformat()} -> {selected[-1].isoformat()} "
        f"({tw_str})",
        flush=True,
    )
    print(
        f"Params: window_seconds={WINDOW_SECONDS}, "
        f"strike_tolerance={STRIKE_TOLERANCE}, "
        f"size_tolerance={SIZE_TOLERANCE}, "
        f"per_ticker_row_cap={PER_TICKER_ROW_CAP}",
        flush=True,
    )

    result = RunResult(
        generated_at=datetime.now(UTC).isoformat(timespec="seconds"),
        matcher_git_sha=_matcher_git_sha(),
        params={
            "window_seconds": WINDOW_SECONDS,
            "strike_tolerance": STRIKE_TOLERANCE,
            "size_tolerance": SIZE_TOLERANCE,
            "per_ticker_row_cap": PER_TICKER_ROW_CAP,
        },
    )

    all_classified: list[pl.DataFrame] = []
    for d in selected:
        parquet_path = _parquet_path_for(d)
        if not parquet_path.exists():
            print(f"  SKIP {d.isoformat()}: parquet missing", flush=True)
            continue
        print(f"  {d.isoformat()} ... ", flush=True)
        stats, classified = _process_day(parquet_path, time_window)
        result.days.append(stats)
        all_classified.append(classified)
        print(
            f"  -> {stats.elapsed_seconds:.1f}s "
            f"({stats.options_only_rows:,} options rows classified, "
            f"{stats.tickers_processed} tickers, "
            f"{stats.tickers_skipped_oversize} skipped, "
            f"{stats.premium_1m_total} prints>=$1M, "
            f"reclass={stats.premium_1m_reclassification_rate:.1f}%)",
            flush=True,
        )

    result.aggregate = _aggregate(result.days, all_classified)

    # Write results.json
    results_path = out_dir / "results.json"
    payload: dict[str, object] = {
        "generated_at": result.generated_at,
        "matcher_git_sha": result.matcher_git_sha,
        "params": result.params,
        "time_window_utc": (
            list(time_window) if time_window is not None else None
        ),
        "days": [asdict(d) for d in result.days],
        "aggregate": asdict(result.aggregate) if result.aggregate else None,
    }
    results_path.write_text(json.dumps(payload, indent=2, default=str))

    # Write sample_50.tsv
    sample_path = out_dir / "sample_50.tsv"
    n_sampled = _write_sample_tsv(all_classified, sample_path)

    # Print summary
    agg = result.aggregate
    assert agg is not None  # always populated above
    print("\n── Summary ──", flush=True)
    print(
        f"Days processed:     {agg.days}\n"
        f"Total rows:         {agg.total_rows:,}\n"
        f"Options-only rows classified: {agg.options_only_rows:,}\n"
        f"Tickers skipped (oversize): {agg.tickers_skipped_oversize_total} "
        f"({agg.skipped_rows_total:,} rows, "
        f"{agg.skipped_premium_1m_total} $1M+ prints excluded)\n"
        f"$1M+ prints (classified): {agg.premium_1m_total}\n"
        f"  reclassified:     {agg.premium_1m_reclassified} "
        f"({agg.premium_1m_reclassification_rate:.2f}%)\n"
        f"Isolated overall:   {agg.isolated_pct:.2f}%\n"
        f"Structure mix:      {agg.structure_pct}\n"
        f"mv_delta confusion (1M+): {agg.mv_delta_confusion_1m}\n"
        f"mv_delta agreement (1M+): {agg.mv_delta_agreement_1m_pct:.2f}%",
        flush=True,
    )
    gate_low, gate_high = 65.0, 85.0
    rate = agg.premium_1m_reclassification_rate
    gate_pass = gate_low <= rate <= gate_high
    print(
        f"\nGate ($1M+ reclassification in {gate_low}-{gate_high}%): "
        f"{'PASS' if gate_pass else 'FAIL'} ({rate:.2f}%)",
        flush=True,
    )
    print(f"\nWrote: {results_path}", flush=True)
    print(f"Wrote: {sample_path} ({n_sampled} matched groups)", flush=True)


if __name__ == "__main__":
    main()
