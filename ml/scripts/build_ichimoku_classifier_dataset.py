"""Materialize the per-event feature+label dataset for the Ichimoku classifier.

Mirrors `build_pac_classifier_dataset.py` but uses `IchimokuEngine`
for signal extraction. The labeler is configurable via `--strategy`:

  pac_baseline       — Original PAC-style fixed ±1.5R bracket
                       (kept for back-compatibility; matches the
                       earlier null result in
                       ichimoku-classifier-2026-04-25.md).
  kijun_stop_2r      — Stop = Kijun line at entry, target = 2R.
  cloud_stop_2r      — Stop = far cloud edge at entry, target = 2R.
  tk_reversal_exit   — Stop = Kijun, no fixed target; exit on
                       opposite TK cross or close re-crossing Kijun.

Output layout (strategy-aware):
    ml/data/ichimoku_classifier/<strategy>/<timeframe>_<symbol>_<year>.parquet

Invocation:

    ml/.venv/bin/python ml/scripts/build_ichimoku_classifier_dataset.py \\
        --symbol NQ \\
        --timeframe 5m \\
        --years 2022,2023,2024 \\
        --strategy kijun_stop_2r \\
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
from ichimoku_classifier.dataset import (  # noqa: E402
    build_ichimoku_dataset,
)
from ichimoku_classifier.dataset import (
    write_dataset as write_ichimoku_dataset,
)
from ichimoku_classifier.labels import PRESET_STRATEGIES  # noqa: E402
from pac.archive_loader import load_bars  # noqa: E402
from pac_classifier.dataset import build_dataset, write_dataset  # noqa: E402

_STRATEGY_CHOICES = ("pac_baseline", *PRESET_STRATEGIES.keys())


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


def build_year(
    symbol: str, year: int, timeframe: str, strategy: str, out_dir: Path
) -> Path | None:
    start = f"{year}-01-01"
    end = f"{year + 1}-01-01"
    print(
        f"[ichimoku-build] {symbol} {year} ({timeframe}, {strategy}): loading 1m bars {start} → {end}",
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

    print(f"[ichimoku-build]   building event dataset (strategy={strategy})", flush=True)
    if strategy == "pac_baseline":
        dataset = build_dataset(enriched, timeframe=timeframe)
        writer = write_dataset
    else:
        spec = PRESET_STRATEGIES[strategy]
        dataset = build_ichimoku_dataset(enriched, spec, timeframe=timeframe)
        writer = write_ichimoku_dataset

    out_path = out_dir / f"{timeframe}_{symbol}_{year}.parquet"
    writer(dataset, out_path)
    no_data_count = int((dataset["exit_reason"] == "no_data").sum()) if len(dataset) > 0 else 0
    print(
        f"[ichimoku-build]   wrote {out_path.name}: {len(dataset):,} events "
        f"({int(dataset['label_a'].notna().sum()):,} resolved, "
        f"{int(dataset['label_a'].isna().sum()):,} unresolved, "
        f"{no_data_count:,} no_data)",
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
        "--strategy",
        default="kijun_stop_2r",
        choices=_STRATEGY_CHOICES,
        help="Labeling strategy: PAC-style baseline or one of the Ichimoku-native presets",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("ml/data/ichimoku_classifier"),
        help="Per-strategy parquets land in <out-dir>/<strategy>/",
    )
    args = parser.parse_args()

    years = [int(y.strip()) for y in args.years.split(",") if y.strip()]
    strategy_dir = args.out_dir / args.strategy
    strategy_dir.mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    for year in years:
        out = build_year(args.symbol, year, args.timeframe, args.strategy, strategy_dir)
        if out is not None:
            written.append(out)

    if not written:
        print("[ichimoku-build] no parquets written", file=sys.stderr)
        return 1
    print(f"[ichimoku-build] done: wrote {len(written)} parquets to {strategy_dir}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
