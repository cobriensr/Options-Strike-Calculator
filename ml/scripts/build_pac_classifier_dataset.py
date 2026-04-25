"""Materialize the per-event feature+label dataset for the PAC event classifier.

For each calendar year in the requested range, load NQ 1m bars from
the local archive, resample to the requested timeframe (5m default),
run PAC engine over the year, and write a parquet of the joined
events × labels × features dataframe.

Output layout:
    ml/data/pac_classifier/<timeframe>_<symbol>_<year>.parquet

Phase 2 of the event classifier roadmap. Phase 1 shipped the events,
labels, features, and dataset assembler — this script is the driver
that calls them with real archive data.

Invocation:

    ml/.venv/bin/python ml/scripts/build_pac_classifier_dataset.py \\
        --symbol NQ \\
        --timeframe 5m \\
        --years 2022,2023,2024 \\
        --out-dir ml/data/pac_classifier

Re-running is idempotent — each call overwrites the year's parquet.
Skips empty years silently with a warning to stderr.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

# Ensure ml/src/ is importable when run directly (not via pytest's conftest)
_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT / "ml" / "src"))

from pac.archive_loader import load_bars  # noqa: E402
from pac.engine import PACEngine  # noqa: E402
from pac_classifier.dataset import build_dataset, write_dataset  # noqa: E402


def _resample_ohlcv(bars: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Resample 1m bars to `rule` (e.g. '5min'). Mirrors the helper in
    `ml/scripts/full_cpcv_optuna_sweep.py` — duplicated here per the
    `ml/scripts/` convention of self-contained entry points."""
    if bars.empty:
        return bars
    df = bars.copy().set_index("ts_event")
    agg = df.resample(rule, label="left", closed="left").agg(
        {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
            "symbol": "first",
        }
    )
    return agg.dropna(subset=["open"]).reset_index()


def _timeframe_to_pandas_rule(timeframe: str) -> str | None:
    """Map CLI timeframe to a pandas resample rule. None = no resample."""
    if timeframe == "1m":
        return None
    if timeframe == "5m":
        return "5min"
    raise ValueError(f"unsupported timeframe: {timeframe!r} (expected 1m or 5m)")


def build_year(
    symbol: str,
    year: int,
    timeframe: str,
    out_dir: Path,
) -> Path | None:
    """Build the dataset parquet for one calendar year. Returns the
    output path, or None if no data was available for the year."""
    start = f"{year}-01-01"
    end = f"{year + 1}-01-01"
    print(f"[build] {symbol} {year} ({timeframe}): loading 1m bars {start} → {end}", flush=True)
    bars_1m = load_bars(symbol, start, end)
    if len(bars_1m) == 0:
        print(f"[build]   WARN: no bars for {symbol} {year}, skipping", file=sys.stderr)
        return None

    rule = _timeframe_to_pandas_rule(timeframe)
    if rule is None:
        bars = bars_1m
    else:
        print(f"[build]   resampling {len(bars_1m):,} 1m → {rule}", flush=True)
        bars = _resample_ohlcv(bars_1m, rule)

    print(f"[build]   running PAC engine on {len(bars):,} bars", flush=True)
    enriched = PACEngine().batch_state(bars)

    print("[build]   building event dataset", flush=True)
    dataset = build_dataset(enriched, timeframe=timeframe)

    out_path = out_dir / f"{timeframe}_{symbol}_{year}.parquet"
    write_dataset(dataset, out_path)
    print(
        f"[build]   wrote {out_path.name}: {len(dataset):,} events "
        f"({int(dataset['label_a'].notna().sum()):,} resolved, "
        f"{int(dataset['label_a'].isna().sum()):,} timeout)",
        flush=True,
    )
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Materialize the PAC event classifier dataset (per year, parquet)."
    )
    parser.add_argument("--symbol", default="NQ", help="Root symbol (default: NQ)")
    parser.add_argument(
        "--timeframe",
        default="5m",
        choices=("1m", "5m"),
        help="Bar timeframe; 5m resamples the 1m archive in-process",
    )
    parser.add_argument(
        "--years",
        default="2022,2023,2024",
        help="Comma-separated calendar years (default: 2022,2023,2024)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("ml/data/pac_classifier"),
        help="Directory to write per-year parquets",
    )
    args = parser.parse_args()

    years = [int(y.strip()) for y in args.years.split(",") if y.strip()]
    args.out_dir.mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    for year in years:
        out = build_year(args.symbol, year, args.timeframe, args.out_dir)
        if out is not None:
            written.append(out)

    if not written:
        print("[build] no parquets written — all years empty?", file=sys.stderr)
        return 1
    print(f"[build] done: wrote {len(written)} parquets to {args.out_dir}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
