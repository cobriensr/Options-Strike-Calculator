"""Python backtest on the matched Pine Strategy Tester window.

Runs PAC BOS Config B over 2026-03-29 to 2026-04-18 (18 trading days)
and compares trade-by-trade to the Pine Strategy Tester output.

Invoked by the ml-sweep Railway service — accepts these CLI flags so the
service can parameterize it:

    --timeframe {1m,5m}   # 1m = raw archive; 5m = resample via pandas
    --out <path>          # write the result JSON here (required by runner)

Also usable from the developer laptop as a one-shot validator:
    python ml/scripts/pine_match_2026_window.py --timeframe 5m --out /tmp/r.json

The output JSON has the shape ml-sweep's /status endpoint expects to
upload to blob. Full-field schema below in `_build_result()`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

# Support two import roots: the developer laptop uses ml/src/ as PYTHONPATH;
# the Railway container uses /app/ml-src/ (injected via PYTHONPATH env).
sys.path.insert(0, "ml/src")
sys.path.insert(0, "/app/ml-src")

from pac.archive_loader import load_bars  # noqa: E402
from pac.engine import PACEngine  # noqa: E402
from pac_backtest.loop import run_backtest  # noqa: E402
from pac_backtest.params import (  # noqa: E402
    EntryTrigger,
    ExitTrigger,
    OnOppositeSignal,
    SessionFilter,
    StopPlacement,
    StrategyParams,
)
from pac_backtest.trades import trades_to_dataframe  # noqa: E402


def _resample_ohlcv(bars: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Resample 1m OHLCV bars to a coarser timeframe (e.g. '5min').

    Uses standard OHLCV aggregation: open = first, high = max, low = min,
    close = last, volume = sum. Groups by left-closed UTC buckets so a
    09:30-09:35 bar appears with ts_event = 09:30 UTC (matches pandas
    default resample semantics).

    Empty 5-min windows (e.g. during exchange halts) are dropped.
    """
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
    # Drop buckets with no trading activity — an NA open means no bars
    # fell in that window (e.g. globex maintenance gap).
    agg = agg.dropna(subset=["open"])
    return agg.reset_index()


def _build_result(
    *,
    timeframe: str,
    symbol: str,
    start: str,
    end: str,
    bars_in: int,
    bars_out: int,
    params: StrategyParams,
    trades: list,
) -> dict[str, Any]:
    """Collapse trades + metadata into the JSON shape blob-uploaded by the runner."""
    if trades:
        pnls = np.array([t.pnl_dollars for t in trades])
        wins = int((pnls > 0).sum())
        losses = int((pnls < 0).sum())

        df = pd.DataFrame({"exit_ts": [t.exit_ts for t in trades], "pnl": pnls})
        df = df.sort_values("exit_ts").reset_index(drop=True)
        df["equity"] = 10_000 + df["pnl"].cumsum()
        df["peak"] = df["equity"].cummax()
        df["dd_dollars"] = df["peak"] - df["equity"]
        summary = {
            "trades": len(trades),
            "wins": wins,
            "losses": losses,
            "win_rate": round(wins / len(trades), 4),
            "total_pnl_dollars": float(pnls.sum()),
            "avg_pnl_dollars": float(pnls.mean()),
            "median_pnl_dollars": float(np.median(pnls)),
            "best_pnl_dollars": float(pnls.max()),
            "worst_pnl_dollars": float(pnls.min()),
            "max_drawdown_dollars": float(df.dd_dollars.max()),
            "exit_reasons": dict(Counter(t.exit_reason for t in trades)),
        }
        trades_df = trades_to_dataframe(trades)
        # Drop feature columns from the per-trade records — they're huge
        # (one row × 40 cols of ef_*). Callers can regenerate them locally.
        core_cols = [c for c in trades_df.columns if not c.startswith("ef_")]
        trade_records = trades_df[core_cols].to_dict(orient="records")
    else:
        summary = {"trades": 0, "note": "no trades fired"}
        trade_records = []

    # Convert StrategyParams dataclass → dict of primitive types for JSON.
    params_dict = {
        k: (str(v) if hasattr(v, "value") else v)
        for k, v in params.__dict__.items()
    }

    return {
        "schema_version": 1,
        "script": "pine_match_2026_window",
        "timeframe": timeframe,
        "symbol": symbol,
        "window": {"start": start, "end": end},
        "bars_loaded": bars_in,
        "bars_after_resample": bars_out,
        "params": params_dict,
        "summary": summary,
        "trades": trade_records,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--timeframe",
        choices=("1m", "5m"),
        default="1m",
        help="Bar timeframe. 5m resamples the 1m archive in-process.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Path to write the result JSON.",
    )
    parser.add_argument(
        "--start",
        default="2026-03-29",
        help="ISO date (inclusive) to start loading bars.",
    )
    parser.add_argument(
        "--end",
        default="2026-04-18",
        help="ISO date (exclusive) to stop loading bars.",
    )
    parser.add_argument(
        "--symbol",
        default="NQ",
        help="Root futures symbol (NQ, ES, etc.).",
    )
    args = parser.parse_args()

    print(f"Loading {args.symbol} 1m bars {args.start} to {args.end}...", flush=True)
    bars_1m = load_bars(args.symbol, args.start, args.end)
    print(f"  {len(bars_1m):,} 1m bars", flush=True)

    if args.timeframe == "5m":
        print("Resampling 1m → 5m...", flush=True)
        bars = _resample_ohlcv(bars_1m, "5min")
        print(f"  {len(bars):,} 5m bars", flush=True)
    else:
        bars = bars_1m

    if bars.empty:
        print("No bars for the window — aborting early", flush=True)
        result = _build_result(
            timeframe=args.timeframe,
            symbol=args.symbol,
            start=args.start,
            end=args.end,
            bars_in=len(bars_1m),
            bars_out=len(bars),
            params=StrategyParams(),
            trades=[],
        )
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2, default=str))
        return

    # Disable smc's 'please star us' print on import
    os.environ.setdefault("SMC_CREDIT", "0")

    print("Running PAC engine...", flush=True)
    enriched = PACEngine().batch_state(bars)
    print(f"  {len(enriched):,} enriched rows", flush=True)

    # Match Pine's Config B on NQ ($5/tick).
    params = StrategyParams(
        entry_trigger=EntryTrigger.BOS_BREAKOUT,
        exit_trigger=ExitTrigger.OPPOSITE_CHOCH,
        stop_placement=StopPlacement.SWING_EXTREME,
        session=SessionFilter.RTH,
        stop_atr_multiple=2.25,
        target_atr_multiple=2.0,
        event_day_filter="skip_events",
        min_z_entry_vwap=1.0,
        on_opposite_signal=OnOppositeSignal.EXIT_ONLY,
        exit_after_n_bos=2,
        slippage_ticks=1.0,
        commission_per_rt=3.00,
        tick_value_dollars=5.00,
    )
    print(f"Params: {params}", flush=True)

    print("Running backtest...", flush=True)
    trades = run_backtest(enriched, params)
    print(f"Trades: {len(trades)}", flush=True)

    result = _build_result(
        timeframe=args.timeframe,
        symbol=args.symbol,
        start=args.start,
        end=args.end,
        bars_in=len(bars_1m),
        bars_out=len(bars),
        params=params,
        trades=trades,
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, default=str))
    print(f"Wrote result to {args.out}", flush=True)


if __name__ == "__main__":
    main()
