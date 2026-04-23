#!/usr/bin/env python3
"""Cross-chunk summary for the PAC A2 sweep campaign.

A2 chain = 3 years × 2 timeframes × NQ = 6 independent result files at
`ml/experiments/pac_a2/{1m,5m}_{2022,2023,2024}.json`. Each was produced
by `full_cpcv_optuna_sweep.py` on Railway ml-sweep (6-fold CPCV, 30
Optuna trials per fold).

This script reads all 6 (or however many exist), extracts per-fold OOS
metrics + gate verdicts, and emits a markdown comparison table suitable
for pasting into a spec or commit body.

Run:
    ml/.venv/bin/python ml/scripts/compare_pac_a2.py
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

EXP_DIR = Path(__file__).resolve().parent.parent / "experiments" / "pac_a2"
CHUNKS = [
    ("1m", "2022"),
    ("1m", "2023"),
    ("1m", "2024"),
    ("5m", "2022"),
    ("5m", "2023"),
    ("5m", "2024"),
]


def summarize_one(path: Path) -> dict[str, float | int | str | None]:
    """Extract headline numbers from one chunk's result JSON.

    Returns NaN-friendly zeros when no folds are present — happens for
    chunks that failed gates aggressively enough that no config survived.
    """
    data = json.loads(path.read_text())
    gate = data.get("gate_result", {}) or {}
    markets = data.get("per_market", {}) or {}
    # A2 fires NQ only, but handle defensively.
    nq = markets.get("NQ", {}) or {}
    folds = nq.get("fold_results") or []

    def medians(key: str) -> float:
        vals = [
            (f.get("oos_metrics") or {}).get(key)
            for f in folds
            if (f.get("oos_metrics") or {}).get(key) is not None
        ]
        return statistics.median(vals) if vals else 0.0

    def total(key: str) -> float:
        vals = [
            (f.get("oos_metrics") or {}).get(key)
            for f in folds
            if (f.get("oos_metrics") or {}).get(key) is not None
        ]
        return sum(vals) if vals else 0.0

    return {
        "n_folds": len(folds),
        "n_unique_configs": nq.get("n_unique_configs", 0),
        "cross_market_pass": int(gate.get("cross_market_pass_count", 0)),
        "nq_only": int(gate.get("nq_only_count", 0)),
        "non_promoted": int(gate.get("non_promoted_count", 0)),
        "median_sharpe": medians("sharpe_annualized"),
        "median_wr": medians("win_rate"),
        "median_pf": medians("profit_factor"),
        "median_trades": medians("trade_count"),
        "total_pnl": total("total_pnl_dollars"),
        "train_bars_sample": (
            folds[0].get("n_train_bars") if folds else 0
        ),
        "test_bars_sample": (
            folds[0].get("n_test_bars") if folds else 0
        ),
    }


def fmt_row(label: str, s: dict) -> str:
    return (
        f"| {label} | {s['n_folds']} | {s['n_unique_configs']} "
        f"| {s['cross_market_pass']} | {s['nq_only']} | {s['non_promoted']} "
        f"| {s['median_sharpe']:+.2f} | {s['median_wr']:.1%} "
        f"| {s['median_pf']:.2f} | {s['median_trades']:.0f} "
        f"| ${s['total_pnl']:,.0f} "
        f"| {s['train_bars_sample']:,}/{s['test_bars_sample']:,} |"
    )


def main() -> int:
    header = (
        "| Chunk | Folds | Configs | XMkt | NQ-only | Rejected "
        "| Med Sharpe | Med WR | Med PF | Med Trades | Total P&L | Train/Test Bars |\n"
        "| ----- | -----:| -------:| ----:| -------:| --------:"
        "| ---------:| ------:| ------:| ----------:| ---------:| ---------------:|"
    )
    rows = []
    print(header)
    for tf, yr in CHUNKS:
        p = EXP_DIR / f"{tf}_{yr}.json"
        if not p.is_file():
            label = f"{tf}_{yr}"
            print(f"| {label} | — | — | — | — | — | — | — | — | — | — | MISSING |")
            continue
        s = summarize_one(p)
        rows.append((f"{tf}_{yr}", s))
        print(fmt_row(f"{tf}_{yr}", s))

    if len(rows) == 6:
        # Timeframe roll-ups
        print()
        print("**By timeframe (sums/medians across 3 years):**")
        print()
        print(header)
        for tf in ("1m", "5m"):
            subs = [s for label, s in rows if label.startswith(tf)]
            if not subs:
                continue
            rolled = {
                "n_folds": sum(s["n_folds"] for s in subs),
                "n_unique_configs": sum(s["n_unique_configs"] for s in subs),
                "cross_market_pass": sum(s["cross_market_pass"] for s in subs),
                "nq_only": sum(s["nq_only"] for s in subs),
                "non_promoted": sum(s["non_promoted"] for s in subs),
                "median_sharpe": statistics.median([s["median_sharpe"] for s in subs]),
                "median_wr": statistics.median([s["median_wr"] for s in subs]),
                "median_pf": statistics.median([s["median_pf"] for s in subs]),
                "median_trades": statistics.median([s["median_trades"] for s in subs]),
                "total_pnl": sum(s["total_pnl"] for s in subs),
                "train_bars_sample": subs[0]["train_bars_sample"],
                "test_bars_sample": subs[0]["test_bars_sample"],
            }
            print(fmt_row(f"**{tf} (3y sum)**", rolled))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
