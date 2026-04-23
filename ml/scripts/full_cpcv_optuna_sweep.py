"""Full CPCV + Optuna sweep across markets — ml-sweep's heavy-lift entry point.

Wraps the existing `pac_backtest.cross_market.run_market_sweep` orchestrator
with two additions that ml-sweep's runner.py needs:

  1. `--timeframe {1m,5m}`  — resamples the 1m archive in-process for 5m
                              runs (same helper as pine_match_2026_window.py).
  2. `--out <path>`         — writes a single consolidated JSON result
                              that runner.py uploads to Vercel Blob.

Intended invocation from ml-sweep's `/run` endpoint:

    python /app/ml-scripts/full_cpcv_optuna_sweep.py \\
        --timeframe 1m \\
        --markets NQ \\
        --start 2022-01-01 --end 2024-12-31 \\
        --n-trials 50 \\
        --out /data/jobs/<job_id>/result.json

Also works on the developer laptop for smoke tests. A default 3-year NQ
1m sweep takes ~90 min on the laptop; budget ~2 hours on Railway's
standard tier. 5m is ~5x faster (~20-30 min).

Output JSON shape is a superset of the per-market `fold_results.json`
existing sweeps produce — one top-level record with:
  - schema_version, script, timeframe, window, markets
  - run_tag, git_head_sha, acceptance_version
  - gate_result (cross-market promotion summary)
  - markets: {NQ: MarketResult-dict, ES: MarketResult-dict, ...}
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

# Support both PYTHONPATHs: laptop (ml/src) and container (/app/ml-src).
sys.path.insert(0, "ml/src")
sys.path.insert(0, "/app/ml-src")

# Silence smartmoneyconcepts credit print before the PAC imports.
os.environ.setdefault("SMC_CREDIT", "0")

from pac.archive_loader import load_bars  # noqa: E402
from pac.engine import PACEngine  # noqa: E402
from pac_backtest.acceptance import _ACCEPTANCE_PATH, load_acceptance  # noqa: E402
from pac_backtest.cross_market import (  # noqa: E402
    MarketResult,
    apply_cross_market_gate,
    run_market_sweep,
)
from pac_backtest.sweep import fold_result_to_dict  # noqa: E402


def _resample_ohlcv(bars: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Resample 1m bars to `rule` (e.g. '5min'). Mirror of the helper in
    pine_match_2026_window.py — duplicated here to avoid cross-script
    imports (keeps ml/scripts/ entries self-contained)."""
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


def _git_head_sha() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def _serialize_market_result(mr: MarketResult) -> dict[str, Any]:
    return {
        "symbol": mr.symbol,
        "n_folds": mr.n_folds,
        "n_unique_configs": len(mr.config_keys),
        "fold_results": [fold_result_to_dict(fr) for fr in mr.fold_results],
        "config_scenario_matrix": mr.config_scenario_matrix.tolist(),
        "config_keys": [list(k) for k in mr.config_keys],
    }


def _serialize_gate_result(gate) -> dict[str, Any]:  # noqa: ANN001
    return {
        "cross_market_pass_count": len(gate.cross_market_pass),
        "nq_only_count": len(gate.nq_only),
        "es_only_count": len(gate.es_only),
        "non_promoted_count": len(gate.non_promoted),
        "cross_market_pass": gate.cross_market_pass,
        "nq_only": gate.nq_only,
        "es_only": gate.es_only,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--timeframe",
        choices=("1m", "5m"),
        default="1m",
        help="Bar timeframe. 5m resamples the 1m archive in-process.",
    )
    parser.add_argument("--start", default="2022-01-01", help="ISO date inclusive")
    parser.add_argument("--end", default="2024-12-31", help="ISO date exclusive")
    parser.add_argument(
        "--markets",
        default="NQ,ES",
        help="Comma-separated market symbols (default: NQ,ES)",
    )
    parser.add_argument(
        "--n-trials",
        type=int,
        default=None,
        help="Override acceptance.yml optuna_trials_per_fold (for smoke tests)",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Path to write the consolidated result JSON (uploaded to blob by runner).",
    )
    parser.add_argument(
        "--snapshot-dir",
        type=Path,
        default=None,
        help="Optional directory to write per-market fold JSONs + acceptance snapshot "
        "(auditable trail). Defaults to out.parent / snapshot.",
    )
    args = parser.parse_args()

    acceptance = load_acceptance()
    print(
        f"[sweep] acceptance v{acceptance.version}, committed {acceptance.committed_ts}",
        flush=True,
    )
    print(f"[sweep] timeframe={args.timeframe} markets={args.markets}", flush=True)
    print(
        f"[sweep] cpcv {acceptance.sweep.cpcv_n_groups}×{acceptance.sweep.cpcv_k_test_groups}, "
        f"embargo {acceptance.sweep.embargo_bars}, "
        f"trials/fold {args.n_trials or acceptance.sweep.optuna_trials_per_fold}",
        flush=True,
    )

    # Snapshot directory — written alongside the consolidated JSON for audit
    snapshot_dir = args.snapshot_dir or (args.out.parent / "snapshot")
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(_ACCEPTANCE_PATH, snapshot_dir / "acceptance_snapshot.yml")

    run_tag = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    markets_to_run = [m.strip() for m in args.markets.split(",") if m.strip()]
    per_market: dict[str, MarketResult] = {}

    for symbol in markets_to_run:
        print(f"[sweep] loading {symbol} 1m bars {args.start} → {args.end}", flush=True)
        bars_1m = load_bars(symbol, args.start, args.end)
        if len(bars_1m) == 0:
            print(f"[sweep]  WARN: no bars for {symbol}, skipping", flush=True)
            continue

        if args.timeframe == "5m":
            print(f"[sweep]  resampling {len(bars_1m):,} 1m → 5m bars", flush=True)
            bars = _resample_ohlcv(bars_1m, "5min")
            print(f"[sweep]  {len(bars):,} 5m bars", flush=True)
        else:
            bars = bars_1m
            print(f"[sweep]  {len(bars):,} bars (1m, no resample)", flush=True)

        print(f"[sweep]  running PAC engine on {symbol}...", flush=True)
        enriched = PACEngine().batch_state(bars)
        print(f"[sweep]  CPCV + Optuna on {symbol} ({len(enriched):,} bars)", flush=True)
        mr = run_market_sweep(
            symbol,
            enriched,
            acceptance,
            n_trials_per_fold=args.n_trials,
            seed=args.seed,
        )
        per_market[symbol] = mr

        # Mid-run per-market snapshot so we can inspect even if the run aborts
        with (snapshot_dir / f"{symbol}_fold_results.json").open("w") as f:
            json.dump(_serialize_market_result(mr), f, indent=2)
        print(
            f"[sweep]  {symbol}: {mr.n_folds} folds, "
            f"{len(mr.config_keys)} unique best-per-fold configs",
            flush=True,
        )

    if not per_market:
        result = {
            "schema_version": 1,
            "script": "full_cpcv_optuna_sweep",
            "timeframe": args.timeframe,
            "window": {"start": args.start, "end": args.end},
            "markets": [],
            "error": "No markets produced results",
        }
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2))
        print("[sweep] no markets produced results — wrote empty result + exiting 1", flush=True)
        return 1

    gate = apply_cross_market_gate(per_market, acceptance)

    result = {
        "schema_version": 1,
        "script": "full_cpcv_optuna_sweep",
        "timeframe": args.timeframe,
        "window": {"start": args.start, "end": args.end},
        "markets": list(per_market.keys()),
        "run_tag": run_tag,
        "git_head_sha": _git_head_sha(),
        "acceptance_version": acceptance.version,
        "n_trials_override": args.n_trials,
        "seed": args.seed,
        "gate_result": _serialize_gate_result(gate),
        "per_market": {
            symbol: _serialize_market_result(mr) for symbol, mr in per_market.items()
        },
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, default=str))

    print()
    print(f"[sweep] === GATE RESULT === (acceptance v{acceptance.version})", flush=True)
    print(f"[sweep]   cross_market_pass: {len(gate.cross_market_pass)}", flush=True)
    print(f"[sweep]   nq_only:           {len(gate.nq_only)}", flush=True)
    print(f"[sweep]   es_only:           {len(gate.es_only)}", flush=True)
    print(f"[sweep]   non_promoted:      {len(gate.non_promoted)}", flush=True)
    print(f"[sweep] wrote {args.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
