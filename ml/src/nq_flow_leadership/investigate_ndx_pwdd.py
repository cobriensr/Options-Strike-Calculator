"""Skeptical investigation of the NDX pwdd_30m_all PM-bucket finding.

Headline result from Phase 3:
  NDX pwdd_30m_all -> NQ fwd_60m, PM bucket: rho = -0.47, concentration 2.0x.

Open questions before treating as a real edge:
  Q1: Effective sample size after NaN drops (NDX is thin)
  Q2: Day-by-day persistence (one outlier day vs 13/15 consistent)
  Q3: Sub-bucket: does it concentrate further within PM?
  Q4: Does NDXP / QQQ pwdd_30m show the same PM contrarian pattern?
  Q5: 0dte vs all expiry: do they agree?
  Q6: Driver minutes: what flow patterns / forward returns dominate the rho?

Output: console report + JSON to ml/experiments/nq-flow-leadership/ndx_pwdd_investigation.json
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

DATA_DIR = Path(__file__).resolve().parents[3] / "ml" / "data" / "nq-flow-leadership"
EXP_DIR = (
    Path(__file__).resolve().parents[3] / "ml" / "experiments" / "nq-flow-leadership"
)

PM_START_MIN = 13 * 60  # 13:00 CT
PM_END_MIN = 14 * 60 + 30  # 14:30 CT


def spearman_safe(x: pd.Series, y: pd.Series) -> tuple[float, float, int]:
    pair_mask = x.notna() & y.notna()
    x = x[pair_mask]
    y = y[pair_mask]
    if len(x) < 10 or x.nunique() < 5:
        return float("nan"), float("nan"), int(len(x))
    res = stats.spearmanr(x, y)
    return float(res.statistic), float(res.pvalue), int(len(x))


def main() -> int:
    features = pd.read_parquet(DATA_DIR / "features_minute.parquet")
    returns = pd.read_parquet(DATA_DIR / "nq_forward_returns.parquet")
    merged = features.merge(returns, on="minute_ts", how="inner")

    ts_ct = merged["minute_ts"].dt.tz_convert("America/Chicago")
    mod = ts_ct.dt.hour * 60 + ts_ct.dt.minute
    merged["date_ct"] = ts_ct.dt.date
    merged["hour_min_ct"] = mod
    merged["pm_mask"] = (mod >= PM_START_MIN) & (mod < PM_END_MIN)

    target = "NDX_pwdd_30m_all"
    target_0dte = "NDX_pwdd_30m_0dte"
    target_ndxp = "NDXP_pwdd_30m_all"
    target_qqq = "QQQ_pwdd_30m_all"
    ret_col = "fwd_ret_60m"

    pm = merged[merged["pm_mask"]].copy()

    print("=" * 75)
    print("NDX pwdd_30m_all PM-bucket investigation")
    print("=" * 75)

    # Q1: sample size
    pm_total = len(pm)
    pm_target_valid = int(pm[target].notna().sum())
    pm_paired = int((pm[target].notna() & pm[ret_col].notna()).sum())
    print("\nQ1. Sample size in PM bucket")
    print(f"  PM minutes total: {pm_total} (90 min/day x 15 days = 1,350 max)")
    print(f"  with valid {target}: {pm_target_valid}")
    print(f"  with valid (target AND fwd_ret_60m): {pm_paired}")

    # Q2: per-day rho
    print("\nQ2. Day-by-day rho (PM bucket, NDX_pwdd_30m_all -> fwd_ret_60m)")
    per_day = []
    for d, sub in pm.groupby("date_ct"):
        rho, p, n = spearman_safe(sub[target], sub[ret_col])
        per_day.append({"date": str(d), "n": n, "rho": rho, "p": p})
        print(
            f"  {d}: n={n:>3}  rho={rho:+.3f}  p={p:.3f}"
            if not np.isnan(rho)
            else f"  {d}: n={n:>3}  insufficient data"
        )

    valid_days = [d for d in per_day if not np.isnan(d["rho"])]
    if valid_days:
        n_neg = sum(1 for d in valid_days if d["rho"] < 0)
        n_pos = sum(1 for d in valid_days if d["rho"] > 0)
        median_rho = float(np.median([d["rho"] for d in valid_days]))
        print(
            f"  -> Days with neg rho: {n_neg}/{len(valid_days)},  pos: {n_pos}/{len(valid_days)},  median: {median_rho:+.3f}"
        )

    # Q3: sub-bucket within PM
    print("\nQ3. Sub-localization within PM (split into 30-min sub-windows)")
    sub_buckets = {
        "13:00-13:30": (13 * 60, 13 * 60 + 30),
        "13:30-14:00": (13 * 60 + 30, 14 * 60),
        "14:00-14:30": (14 * 60, 14 * 60 + 30),
    }
    for name, (lo, hi) in sub_buckets.items():
        sub = merged[(merged["hour_min_ct"] >= lo) & (merged["hour_min_ct"] < hi)]
        rho, p, n = spearman_safe(sub[target], sub[ret_col])
        print(
            f"  {name}: n={n:>4}  rho={rho:+.3f}  p={p:.2e}"
            if not np.isnan(rho)
            else f"  {name}: n={n:>4}  insufficient"
        )

    # Q4: peer tickers (NDXP and QQQ pwdd_30m) in PM
    print("\nQ4. Peer tickers in PM bucket (does pattern generalize?)")
    for col, label in ((target, "NDX"), (target_ndxp, "NDXP"), (target_qqq, "QQQ")):
        if col not in pm.columns:
            print(f"  {label} pwdd_30m_all: column missing")
            continue
        rho, p, n = spearman_safe(pm[col], pm[ret_col])
        print(f"  {label:<5} pwdd_30m_all: n={n:>4}  rho={rho:+.3f}  p={p:.2e}")

    # Q5: 0dte vs all
    print("\nQ5. 0dte vs all expiry (PM bucket)")
    for col, label in ((target, "all"), (target_0dte, "0dte")):
        if col not in pm.columns:
            print(f"  {label}: missing")
            continue
        rho, p, n = spearman_safe(pm[col], pm[ret_col])
        print(f"  NDX pwdd_30m_{label:<4}: n={n:>4}  rho={rho:+.3f}  p={p:.2e}")

    # Q6: Driver minutes — top 10 by |target| in PM, with their fwd return
    print("\nQ6. Top 10 PM minutes by |NDX_pwdd_30m_all|")
    pm_clean = pm[pm[target].notna() & pm[ret_col].notna()].copy()
    pm_clean["abs_target"] = pm_clean[target].abs()
    top10 = pm_clean.nlargest(10, "abs_target")[
        ["date_ct", "hour_min_ct", target, ret_col]
    ]
    print("  date         time(CT)   NDX_pwdd_30m  fwd_ret_60m")
    for _, r in top10.iterrows():
        h, m = divmod(int(r["hour_min_ct"]), 60)
        sign_match = ((r[target] < 0) and (r[ret_col] > 0)) or (
            (r[target] > 0) and (r[ret_col] < 0)
        )
        marker = "   <-- contrarian fired" if sign_match else ""
        print(
            f"  {r['date_ct']}  {h:02d}:{m:02d}      {r[target]:+.3f}        {r[ret_col]:+.5f}{marker}"
        )

    # Distribution check: how many of the top |target| events fired contrarian?
    contrarian_hits = ((top10[target] < 0) & (top10[ret_col] > 0)) | (
        (top10[target] > 0) & (top10[ret_col] < 0)
    )
    print(
        f"  -> Contrarian fired: {int(contrarian_hits.sum())}/{len(top10)} of top-10 extreme PM PWDD minutes"
    )

    # Save JSON for posterity
    out = {
        "q1_sample_size": {
            "pm_minutes_total": pm_total,
            "with_valid_target": pm_target_valid,
            "with_valid_pair": pm_paired,
            "max_possible_pm": 1350,
        },
        "q2_per_day": per_day,
        "q3_sub_localization": {
            name: dict(
                zip(
                    ["rho", "p", "n"],
                    spearman_safe(
                        merged[
                            (merged["hour_min_ct"] >= lo) & (merged["hour_min_ct"] < hi)
                        ][target],
                        merged[
                            (merged["hour_min_ct"] >= lo) & (merged["hour_min_ct"] < hi)
                        ][ret_col],
                    ),
                )
            )
            for name, (lo, hi) in sub_buckets.items()
        },
        "q4_peers": {
            label: dict(zip(["rho", "p", "n"], spearman_safe(pm[col], pm[ret_col])))
            for col, label in (
                (target, "NDX"),
                (target_ndxp, "NDXP"),
                (target_qqq, "QQQ"),
            )
            if col in pm.columns
        },
        "q5_expiry": {
            label: dict(zip(["rho", "p", "n"], spearman_safe(pm[col], pm[ret_col])))
            for col, label in ((target, "all"), (target_0dte, "0dte"))
            if col in pm.columns
        },
        "q6_top10_drivers": top10.assign(date_ct=top10["date_ct"].astype(str)).to_dict(
            orient="records"
        ),
    }
    out_path = EXP_DIR / "ndx_pwdd_investigation.json"
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\nSaved {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
