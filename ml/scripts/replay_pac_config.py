"""Replay a single PAC StrategyParams config on a fresh year window.

Phase 3 of the regime-gated plan: take the BEST per-fold config from
a `full_cpcv_optuna_sweep` result JSON, run it as a single backtest
on a different year window, and report whether the same config holds
up out-of-sample.

Distinct from `pine_match_2026_window.py`: that one hardcodes a
BOS_BREAKOUT Config B; this one extracts whichever config Optuna
selected as the highest-Sharpe fold winner.

Usage:
    python ml/scripts/replay_pac_config.py \\
        --config-from ml/experiments/pac_a2/5m_2022_t150.json \\
        --start 2023-01-01 --end 2023-12-31 \\
        --timeframe 5m \\
        --out ml/experiments/pac_replay/5m_2022cfg_on_2023.json

The chosen "best" config is the one with the highest OOS Sharpe across
all 15 CPCV folds in the source result.
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

sys.path.insert(0, "ml/src")
sys.path.insert(0, "/app/ml-src")

from pac.archive_loader import load_bars  # noqa: E402
from pac.engine import PACEngine  # noqa: E402
from pac_backtest.loop import run_backtest  # noqa: E402
from pac_backtest.params import (  # noqa: E402
    EntryTrigger,
    EntryVsOb,
    ExitTrigger,
    OnOppositeSignal,
    SessionBucket,
    SessionFilter,
    StopPlacement,
    StrategyParams,
)
from pac_backtest.trades import trades_to_dataframe  # noqa: E402


def _load_best_config(result_path: Path) -> tuple[StrategyParams, dict]:
    """Read a CPCV+Optuna result file and return the highest-OOS-Sharpe fold's params."""
    data = json.loads(result_path.read_text())
    folds = data["per_market"]["NQ"]["fold_results"]
    best = max(
        folds,
        key=lambda f: (f.get("oos_metrics") or {}).get("sharpe_annualized", -1e9),
    )
    raw = best["best_params"]

    params = StrategyParams(
        entry_trigger=EntryTrigger(raw["entry_trigger"]),
        exit_trigger=ExitTrigger(raw["exit_trigger"]),
        stop_placement=StopPlacement(raw["stop_placement"]),
        stop_atr_multiple=float(raw["stop_atr_multiple"]),
        target_atr_multiple=float(raw["target_atr_multiple"]),
        session=SessionFilter(raw["session"]),
        iv_tercile_filter=raw.get("iv_tercile_filter"),
        event_day_filter=raw.get("event_day_filter"),
        session_bucket=SessionBucket(raw["session_bucket"]),
        min_ob_volume_z=raw.get("min_ob_volume_z"),
        min_ob_pct_atr=raw.get("min_ob_pct_atr"),
        entry_vs_ob=EntryVsOb(raw["entry_vs_ob"]),
        min_z_entry_vwap=raw.get("min_z_entry_vwap"),
        min_adx_14=raw.get("min_adx_14"),
        on_opposite_signal=OnOppositeSignal(raw["on_opposite_signal"]),
        exit_after_n_bos=raw.get("exit_after_n_bos"),
    )
    meta = {
        "source_result": str(result_path),
        "source_timeframe": data.get("timeframe"),
        "source_window": data.get("window"),
        "source_fold_index": best.get("fold_index"),
        "source_oos_sharpe": (best.get("oos_metrics") or {}).get("sharpe_annualized"),
        "source_oos_pnl": (best.get("oos_metrics") or {}).get("total_pnl_dollars"),
        "source_oos_wr": (best.get("oos_metrics") or {}).get("win_rate"),
        "source_oos_trade_count": (best.get("oos_metrics") or {}).get("trade_count"),
    }
    return params, meta


def _resample_ohlcv(bars: pd.DataFrame, rule: str) -> pd.DataFrame:
    """1m → 5m via pandas resample. Same convention as pine_match_2026_window.py."""
    bars = bars.copy()
    bars = bars.set_index("ts_event")
    out = bars.resample(rule, label="left", closed="left").agg(
        {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
        }
    )
    out = out.dropna(subset=["open", "close"])
    out = out.reset_index()
    if "symbol" in bars.columns:
        out["symbol"] = bars["symbol"].iloc[0]
    return out


def _summarize(trades: list, tick_value: float) -> dict[str, Any]:
    """Reproduce the metrics shape the result JSON uses."""
    if not trades:
        return {
            "trade_count": 0,
            "win_rate": 0.0,
            "total_pnl_dollars": 0.0,
            "sharpe_annualized": 0.0,
            "profit_factor": 0.0,
        }
    df = trades_to_dataframe(trades)
    pnls = df["pnl_dollars"].to_numpy(dtype=float)
    wins = (pnls > 0).sum()
    losses = (pnls < 0).sum()
    gross_win = pnls[pnls > 0].sum()
    gross_loss = abs(pnls[pnls < 0].sum())
    pf = gross_win / gross_loss if gross_loss > 0 else float("inf") if gross_win > 0 else 0.0
    # Annualized Sharpe — same convention as fold metrics: per-trade returns,
    # scaled by sqrt(252) using daily-aggregate proxy. For this validator we
    # report the simpler trade-level Sharpe; the fold metric is calibrated for
    # CPCV folds so a direct comparison would need replicating that calc.
    if len(pnls) > 1 and pnls.std() > 0:
        sharpe_per_trade = pnls.mean() / pnls.std()
    else:
        sharpe_per_trade = 0.0
    return {
        "trade_count": int(len(pnls)),
        "win_rate": float(wins) / len(pnls),
        "total_pnl_dollars": float(pnls.sum()),
        "sharpe_per_trade": float(sharpe_per_trade),
        "profit_factor": float(pf) if np.isfinite(pf) else None,
        "avg_pnl_dollars": float(pnls.mean()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-from", type=Path, required=True,
                        help="Path to a sweep result JSON; best fold's config is loaded.")
    parser.add_argument("--start", required=True, help="ISO date inclusive.")
    parser.add_argument("--end", required=True, help="ISO date exclusive.")
    parser.add_argument("--timeframe", choices=("1m", "5m"), default="5m")
    parser.add_argument("--symbol", default="NQ")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    params, meta = _load_best_config(args.config_from)
    print(f"Loaded best config from fold {meta['source_fold_index']} "
          f"(source OOS Sharpe={meta['source_oos_sharpe']:.2f})", flush=True)
    print(f"  entry={params.entry_trigger.value}  exit={params.exit_trigger.value}  "
          f"stop={params.stop_placement.value}  bucket={params.session_bucket.value}", flush=True)

    print(f"Loading {args.symbol} 1m bars {args.start} → {args.end}...", flush=True)
    bars_1m = load_bars(args.symbol, args.start, args.end)
    print(f"  {len(bars_1m):,} 1m bars", flush=True)

    if args.timeframe == "5m":
        bars = _resample_ohlcv(bars_1m, "5min")
        print(f"  → {len(bars):,} 5m bars", flush=True)
    else:
        bars = bars_1m

    os.environ.setdefault("SMC_CREDIT", "0")
    print("Running PAC engine...", flush=True)
    enriched = PACEngine().batch_state(bars)

    print("Running backtest with replayed config...", flush=True)
    trades = run_backtest(enriched, params)
    print(f"Trades: {len(trades)}", flush=True)

    metrics = _summarize(trades, params.tick_value_dollars)
    print(f"  total_pnl=${metrics['total_pnl_dollars']:,.2f}  "
          f"WR={metrics['win_rate']:.1%}  PF={metrics['profit_factor']}", flush=True)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "type": "pac_config_replay",
                "source_meta": meta,
                "replay_window": {"start": args.start, "end": args.end},
                "replay_timeframe": args.timeframe,
                "replay_symbol": args.symbol,
                "params": {
                    k: v.value if hasattr(v, "value") else v
                    for k, v in params.__dict__.items()
                },
                "metrics": metrics,
                "n_trades": len(trades),
                "side_distribution": dict(
                    Counter(getattr(t, "side", "?") for t in trades)
                ) if trades else {},
            },
            indent=2,
            default=str,
        )
    )
    print(f"Wrote {args.out}", flush=True)


if __name__ == "__main__":
    main()
