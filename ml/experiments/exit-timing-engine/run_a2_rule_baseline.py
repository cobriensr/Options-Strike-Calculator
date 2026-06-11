# ml/experiments/exit-timing-engine/run_a2_rule_baseline.py
"""A2: parametric-rule baseline + same-basis (mid) on-path benchmark, MONTH-LEVEL
expanding walk-forward (matches A3). Memory-safe: reads ONE month-part at a time,
builds a per-fire realized-%-per-knob matrix, then for each test month picks the
knob with the best PRIOR-months mean and applies it OOS. On-path baselines
(trail-30/10, hard-30m, tier-50, hold-EOD) recomputed on the same mid paths.

Run: ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a2_rule_baseline.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.costs import apply_costs
from exit_engine.onpath_policies import onpath_baselines
from exit_engine.rule_family import decide_exit_index_vec, grid

A2_COLS = ["fire_id", "entry_price", "mid", "ret_from_entry_pct", "minutes_since_entry", "spread_pct"]


def _parts() -> list[Path]:
    ps = sorted(cfg.DATASET_DIR.glob("part-*.parquet"))
    if not ps:
        print("No dataset parts — run A1 first.", file=sys.stderr)
        sys.exit(1)
    return ps


def _stats(x) -> str:
    a = np.asarray(x, dtype="float64")
    return f"mean={a.mean():+6.1f}  median={np.median(a):+6.1f}  win%={(a > 0).mean() * 100:4.1f}"


def main() -> int:
    parts = _parts()
    if len(parts) < 2:
        print("Need >=2 month-parts for walk-forward.", file=sys.stderr)
        return 1
    print(f"parts: {[p.name for p in parts]}", flush=True)
    knobs = grid()

    # Per-part (one month at a time): per-fire realized-%-per-knob + on-path baselines.
    realized_rows: list[np.ndarray] = []   # each: (n_knobs,) realized % per knob
    month_idx: list[int] = []
    base = {"eod": [], "trail30_10": [], "hard30m": [], "tier50_holdeod": []}
    for mi, p in enumerate(parts):
        df = pd.read_parquet(p, columns=A2_COLS)
        for _fid, g in df.groupby("fire_id", sort=False):
            g = g.sort_values("minutes_since_entry")
            ret = g["ret_from_entry_pct"].to_numpy("float64")
            mse = g["minutes_since_entry"].to_numpy("float64")
            mid = g["mid"].to_numpy("float64")
            entry = float(g["entry_price"].iloc[0])
            sp = float(g["spread_pct"].iloc[0])
            rv = np.empty(len(knobs), dtype="float64")
            for j, kn in enumerate(knobs):
                idx = decide_exit_index_vec(ret, mse, kn["activate_pct"], kn["giveback_pct"], kn["hard_stop_min"])
                rv[j] = apply_costs((mid[idx] - entry) / entry * 100.0, entry, sp)
            realized_rows.append(rv)
            month_idx.append(mi)
            rows = pd.DataFrame({"mid": mid, "entry_price": entry, "spread_pct": sp,
                                 "ret_from_entry_pct": ret, "minutes_since_entry": mse})
            b = onpath_baselines(rows)
            for k in base:
                base[k].append(b[k])
        del df
        print(f"  scanned {p.name}: cum fires {len(realized_rows):,}", flush=True)

    realized = np.vstack(realized_rows)
    months = np.array(month_idx)
    base_month = np.array(month_idx)  # baselines are 1:1 with fires in the same order

    # Month walk-forward: for test month k (k>=1), best knob = argmax over months<k mean.
    engine = np.full(len(realized), np.nan)
    for k in range(1, len(parts)):
        train = months < k
        test = months == k
        if not train.any() or not test.any():
            continue
        tm = realized[train].mean(axis=0)
        best = int(np.argmax(tm))
        engine[test] = realized[test, best]
        print(f"WF test={parts[k].name[5:12]}: best={knobs[best]} train_mean={tm[best]:+.1f} n_test={int(test.sum())}", flush=True)

    oos_mask = (months >= 1) & ~np.isnan(engine)
    oos = engine[oos_mask]
    # Baselines restricted to the SAME OOS test months (k>=1) for an apples-to-apples table.
    base_oos = {k: np.asarray(v)[base_month >= 1] for k, v in base.items()}

    lines = ["# A2 — Rule Baseline vs On-Path Benchmark (month walk-forward, OOS, mid basis)", ""]
    lines.append(f"- OOS test fires (months >= 2nd): {len(oos):,}")
    lines.append("")
    lines.append("| policy | stats |")
    lines.append("| --- | --- |")
    lines.append(f"| **ENGINE-RULE (walk-forward OOS)** | {_stats(oos)} |")
    for k, v in base_oos.items():
        lines.append(f"| {k} | {_stats(v)} |")
    report = "\n".join(lines)
    print("\n" + report, flush=True)
    (Path(__file__).parent / "a2_rule_baseline.md").write_text(report + "\n")
    print(f"\nwrote {Path(__file__).parent / 'a2_rule_baseline.md'}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
