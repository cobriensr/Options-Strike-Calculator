"""CLI entry point for the PAC backtest sweep.

Usage:
    python -m pac_backtest.run_sweep \\
        --start 2022-01-01 --end 2024-12-31 \\
        --markets NQ,ES \\
        --output-dir ml/experiments/sweeps

Output is a timestamped directory under `--output-dir` containing:
    summary.json       : top-level gate result + per-market aggregate stats
    NQ_fold_results.json, ES_fold_results.json : per-fold Optuna outputs
    acceptance_snapshot.yml : copy of the locked acceptance.yml used

The acceptance_snapshot + summary.json + commit hash give full audit
traceability — you can reproduce any sweep result from git history alone.
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

# Silence the upstream smartmoneyconcepts credit print before imports
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


def _git_head_sha() -> str | None:
    """Return current git HEAD short SHA, or None if not in a git repo."""
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
    """JSON-friendly flattening of MarketResult (numpy array → list)."""
    return {
        "symbol": mr.symbol,
        "n_folds": mr.n_folds,
        "n_unique_configs": len(mr.config_keys),
        "fold_results": [fold_result_to_dict(fr) for fr in mr.fold_results],
        "config_scenario_matrix": mr.config_scenario_matrix.tolist(),
        "config_keys": [list(k) for k in mr.config_keys],
    }


def _serialize_gate_result(gate) -> dict[str, Any]:
    """JSON-friendly top-level gate summary. Drops full fold results — those
    live in per-market files."""
    return {
        "cross_market_pass_count": len(gate.cross_market_pass),
        "nq_only_count": len(gate.nq_only),
        "es_only_count": len(gate.es_only),
        "non_promoted_count": len(gate.non_promoted),
        "cross_market_pass": gate.cross_market_pass,
        "nq_only": gate.nq_only,
        "es_only": gate.es_only,
        # non_promoted is large — write only a count by default
    }


def _run_pac_engine(bars: pd.DataFrame) -> pd.DataFrame:
    """Helper: enrich raw bars via PAC engine with default params."""
    return PACEngine().batch_state(bars)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the PAC CPCV + Optuna sweep across markets."
    )
    parser.add_argument(
        "--start", required=True, help="Start date (YYYY-MM-DD UTC)"
    )
    parser.add_argument(
        "--end", required=True, help="End date (YYYY-MM-DD UTC, exclusive)"
    )
    parser.add_argument(
        "--markets",
        default="NQ,ES",
        help="Comma-separated market symbols (default: NQ,ES)",
    )
    parser.add_argument(
        "--output-dir",
        default="ml/experiments/sweeps",
        help="Directory where timestamped run output is written",
    )
    parser.add_argument(
        "--n-trials",
        type=int,
        default=None,
        help="Override acceptance.yml optuna_trials_per_fold (for smoke tests)",
    )
    parser.add_argument(
        "--seed", type=int, default=42, help="RNG seed for reproducibility"
    )
    args = parser.parse_args(argv)

    acceptance = load_acceptance()
    print(
        f"[sweep] acceptance.yml v{acceptance.version}, "
        f"committed {acceptance.committed_ts}"
    )
    print(f"[sweep] markets: {acceptance.markets}")
    print(
        f"[sweep] cpcv {acceptance.sweep.cpcv_n_groups}×{acceptance.sweep.cpcv_k_test_groups}, "
        f"embargo {acceptance.sweep.embargo_bars}, "
        f"trials/fold {args.n_trials or acceptance.sweep.optuna_trials_per_fold}"
    )

    # Prepare output directory
    run_tag = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    out_dir = Path(args.output_dir) / run_tag
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[sweep] output → {out_dir}")

    # Snapshot acceptance.yml alongside results
    shutil.copy2(_ACCEPTANCE_PATH, out_dir / "acceptance_snapshot.yml")

    # Load bars + run PAC engine per market, then run the sweep
    markets_to_run = [m.strip() for m in args.markets.split(",") if m.strip()]
    per_market: dict[str, MarketResult] = {}
    for symbol in markets_to_run:
        print(f"[sweep] loading {symbol} bars {args.start} → {args.end}")
        bars = load_bars(symbol, args.start, args.end)
        if len(bars) == 0:
            print(f"[sweep]  WARN: no bars for {symbol}, skipping")
            continue
        print(f"[sweep]  {len(bars):,} bars; running PAC engine")
        enriched = _run_pac_engine(bars)
        print(f"[sweep]  CPCV sweep on {symbol} ({len(enriched):,} bars)")
        mr = run_market_sweep(
            symbol,
            enriched,
            acceptance,
            n_trials_per_fold=args.n_trials,
            seed=args.seed,
        )
        per_market[symbol] = mr
        # Write per-market detail immediately so you can inspect mid-run
        with (out_dir / f"{symbol}_fold_results.json").open("w") as f:
            json.dump(_serialize_market_result(mr), f, indent=2)
        print(
            f"[sweep]  {symbol}: {mr.n_folds} folds, "
            f"{len(mr.config_keys)} unique best-per-fold configs"
        )

    if not per_market:
        print("[sweep] no markets produced results — aborting gate")
        return 1

    gate = apply_cross_market_gate(per_market, acceptance)

    # Write top-level summary
    summary = {
        "run_tag": run_tag,
        "git_head_sha": _git_head_sha(),
        "acceptance_version": acceptance.version,
        "acceptance_commit_snapshot": str(_ACCEPTANCE_PATH),
        "start": args.start,
        "end": args.end,
        "markets_run": list(per_market.keys()),
        "gate_result": _serialize_gate_result(gate),
    }
    with (out_dir / "summary.json").open("w") as f:
        json.dump(summary, f, indent=2)

    print()
    print(f"[sweep] === GATE RESULT === (acceptance v{acceptance.version})")
    print(f"[sweep]   cross_market_pass: {len(gate.cross_market_pass)}")
    print(f"[sweep]   nq_only:           {len(gate.nq_only)}")
    print(f"[sweep]   es_only:           {len(gate.es_only)}")
    print(f"[sweep]   non_promoted:      {len(gate.non_promoted)}")
    print(f"[sweep] output: {out_dir}/summary.json")

    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
