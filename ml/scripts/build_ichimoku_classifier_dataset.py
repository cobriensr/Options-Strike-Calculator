"""Materialize the per-event feature+label dataset for the Ichimoku classifier.

Mirrors `build_pac_classifier_dataset.py` but uses `IchimokuEngine`
instead of `PACEngine`. The downstream pipeline (events → labels →
features → dataset) is unchanged because IchimokuEngine emits the
same column schema (BOS/CHOCH/CHOCHPlus mapped from TK-cross /
cloud-break / strong-confluence events).

Output layout:
    ml/data/ichimoku_classifier/<timeframe>_<symbol>_<year>.parquet

Invocation:

    ml/.venv/bin/python ml/scripts/build_ichimoku_classifier_dataset.py \\
        --symbol NQ \\
        --timeframe 5m \\
        --years 2022,2023,2024 \\
        --out-dir ml/data/ichimoku_classifier
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT / "ml" / "src"))

from ichimoku.engine import IchimokuEngine  # noqa: E402
from pac.archive_loader import load_bars  # noqa: E402
from pac_classifier.dataset import build_dataset, write_dataset  # noqa: E402


def _resample_ohlcv(bars: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Resample 1m bars to `rule` (e.g. '5min'). Same convention as
    `build_pac_classifier_dataset.py`."""
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
    if timeframe == "1m":
        return None
    if timeframe == "5m":
        return "5min"
    raise ValueError(f"unsupported timeframe: {timeframe!r} (expected 1m or 5m)")


def build_year(symbol: str, year: int, timeframe: str, out_dir: Path) -> Path | None:
    start = f"{year}-01-01"
    end = f"{year + 1}-01-01"
    print(
        f"[ichimoku-build] {symbol} {year} ({timeframe}): loading 1m bars {start} → {end}",
        flush=True,
    )
    bars_1m = load_bars(symbol, start, end)
    if len(bars_1m) == 0:
        print(
            f"[ichimoku-build]   WARN: no bars for {symbol} {year}, skipping",
            file=sys.stderr,
        )
        return None

    rule = _timeframe_to_pandas_rule(timeframe)
    bars = bars_1m if rule is None else _resample_ohlcv(bars_1m, rule)
    if rule is not None:
        print(f"[ichimoku-build]   resampled {len(bars_1m):,} 1m → {len(bars):,} {timeframe}", flush=True)

    print(f"[ichimoku-build]   running Ichimoku engine on {len(bars):,} bars", flush=True)
    enriched = IchimokuEngine().batch_state(bars)

    print("[ichimoku-build]   building event dataset", flush=True)
    dataset = build_dataset(enriched, timeframe=timeframe)

    out_path = out_dir / f"{timeframe}_{symbol}_{year}.parquet"
    write_dataset(dataset, out_path)
    print(
        f"[ichimoku-build]   wrote {out_path.name}: {len(dataset):,} events "
        f"({int(dataset['label_a'].notna().sum()):,} resolved, "
        f"{int(dataset['label_a'].isna().sum()):,} timeout)",
        flush=True,
    )
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Materialize the Ichimoku event classifier dataset (per year, parquet)."
    )
    parser.add_argument("--symbol", default="NQ")
    parser.add_argument("--timeframe", default="5m", choices=("1m", "5m"))
    parser.add_argument("--years", default="2022,2023,2024")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("ml/data/ichimoku_classifier"),
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
        print("[ichimoku-build] no parquets written", file=sys.stderr)
        return 1
    print(f"[ichimoku-build] done: wrote {len(written)} parquets to {args.out_dir}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
