"""Phase 3 — Spearman rank correlation: flow features vs forward NQ returns.

Joins ml/data/nq-flow-leadership/{features_minute,nq_forward_returns}.parquet
on minute_ts, then for each (ticker, feature, window, expiry_filter, horizon,
time_of_day_bucket) computes Spearman rho + p-value + n. Writes:

  - ml/experiments/nq-flow-leadership/correlations.parquet  (full grid)
  - ml/experiments/nq-flow-leadership/top_correlations.json (top 30)

Time-of-day stratification serves a leakage check: per
feedback_uniform_lift_is_leakage.md, a real edge concentrates in 1-2
buckets. Uniform rho across all 5 buckets is a leakage fingerprint.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

DATA_DIR = Path(__file__).resolve().parents[3] / "ml" / "data" / "nq-flow-leadership"
EXP_DIR = (
    Path(__file__).resolve().parents[3] / "ml" / "experiments" / "nq-flow-leadership"
)

FEATURES_PATH = DATA_DIR / "features_minute.parquet"
RETURNS_PATH = DATA_DIR / "nq_forward_returns.parquet"
CORRELATIONS_PATH = EXP_DIR / "correlations.parquet"
TOP_PATH = EXP_DIR / "top_correlations.json"

HORIZONS = (5, 15, 30, 60)

# CT minute-of-day boundaries.
SESSION_BUCKETS = {
    "open": (8 * 60 + 30, 9 * 60 + 30),
    "morning": (9 * 60 + 30, 11 * 60),
    "lunch": (11 * 60, 13 * 60),
    "pm": (13 * 60, 14 * 60 + 30),
    "power": (14 * 60 + 30, 15 * 60),
}

# Feature column name pattern: {TICKER}_{feature}_{window}m_{expiry_filter}
FEATURE_COL_RE = re.compile(
    r"^(?P<ticker>[A-Z]+)_(?P<feature>[a-z_]+?)_(?P<window>\d+)m_(?P<expiry>0dte|all)$"
)


def parse_feature_col(name: str) -> dict | None:
    m = FEATURE_COL_RE.match(name)
    if not m:
        return None
    d = m.groupdict()
    d["window"] = int(d["window"])
    return d


def assign_bucket(minute_of_day_ct: pd.Series) -> pd.Series:
    """Map CT minute-of-day to bucket name (or 'outside' if pre-open/post-close)."""
    bucket = pd.Series(
        ["outside"] * len(minute_of_day_ct), index=minute_of_day_ct.index
    )
    for name, (lo, hi) in SESSION_BUCKETS.items():
        mask = (minute_of_day_ct >= lo) & (minute_of_day_ct < hi)
        bucket[mask] = name
    return bucket


def main() -> int:
    EXP_DIR.mkdir(parents=True, exist_ok=True)

    features = pd.read_parquet(FEATURES_PATH)
    returns = pd.read_parquet(RETURNS_PATH)

    # Inner-join on minute_ts. Both are tz-aware UTC.
    merged = features.merge(returns, on="minute_ts", how="inner")
    print(f"Joined {len(merged):,} minute rows")

    # Add bucket column based on CT minute-of-day.
    ts_ct = merged["minute_ts"].dt.tz_convert("America/Chicago")
    minute_of_day = ts_ct.dt.hour * 60 + ts_ct.dt.minute
    merged["bucket"] = assign_bucket(minute_of_day)

    # Identify feature columns.
    feature_cols = [c for c in features.columns if parse_feature_col(c) is not None]
    print(f"Found {len(feature_cols):,} feature columns")

    # Compute correlations: per feature_col, per horizon, per bucket (incl 'overall').
    rows = []
    bucket_names = ["overall"] + list(SESSION_BUCKETS.keys())
    for fcol in feature_cols:
        meta = parse_feature_col(fcol)
        if meta is None:
            continue
        feature_values_full = merged[fcol]
        for h in HORIZONS:
            ret_col = f"fwd_ret_{h}m"
            for bname in bucket_names:
                if bname == "overall":
                    mask = pd.Series(True, index=merged.index)
                else:
                    mask = merged["bucket"] == bname
                fv = feature_values_full[mask]
                rv = merged[ret_col][mask]
                # Align: drop pairs where either is NaN.
                pair_mask = fv.notna() & rv.notna()
                fv = fv[pair_mask]
                rv = rv[pair_mask]
                # Drop pairs where the feature is constant 0 (no flow that minute) — these
                # add noise to ranks. This is a generous filter; a stricter version would
                # drop a feature entirely if too few non-zero rows.
                if len(fv) < 30 or fv.nunique() < 5:
                    rho, pval = np.nan, np.nan
                else:
                    res = stats.spearmanr(fv, rv)
                    rho = float(res.statistic)  # scipy >=1.11 attribute name
                    pval = float(res.pvalue)
                rows.append(
                    {
                        "ticker": meta["ticker"],
                        "feature": meta["feature"],
                        "window_min": meta["window"],
                        "expiry_filter": meta["expiry"],
                        "horizon_min": h,
                        "bucket": bname,
                        "n": int(len(fv)),
                        "rho": rho,
                        "p_value": pval,
                    }
                )

    out = pd.DataFrame(rows)
    # Bonferroni correction within (ticker, expiry_filter, bucket) family
    # = (feature x window x horizon) = 6 * 4 * 4 = 96 tests max per family.
    family_size = (
        out.dropna(subset=["p_value"])
        .groupby(["ticker", "expiry_filter", "bucket"])["p_value"]
        .transform("size")
    )
    out["p_bonf"] = (out["p_value"] * family_size).clip(upper=1.0)

    out.to_parquet(CORRELATIONS_PATH, compression="zstd")
    print(f"Wrote {CORRELATIONS_PATH} ({len(out):,} rows)")

    # Top 30 by |rho|, restricted to 'overall' bucket and significant uncorrected p.
    overall = out[(out["bucket"] == "overall") & (out["p_value"] < 0.05)].copy()
    overall["abs_rho"] = overall["rho"].abs()
    top = overall.sort_values("abs_rho", ascending=False).head(30)

    # For each top row, attach concentration diagnostic: max |rho| across non-overall buckets,
    # and which bucket dominates.
    diag = []
    for _, row in top.iterrows():
        peers = out[
            (out["ticker"] == row["ticker"])
            & (out["feature"] == row["feature"])
            & (out["window_min"] == row["window_min"])
            & (out["expiry_filter"] == row["expiry_filter"])
            & (out["horizon_min"] == row["horizon_min"])
            & (out["bucket"] != "overall")
            & out["rho"].notna()
        ]
        if not peers.empty:
            peers = peers.assign(abs_rho=peers["rho"].abs())
            best = peers.loc[peers["abs_rho"].idxmax()]
            # Concentration: max |rho| / mean |rho| across the 5 buckets.
            # Higher = more concentrated. ~1.0 = uniform = leakage suspect.
            concentration = (
                float(peers["abs_rho"].max() / peers["abs_rho"].mean())
                if peers["abs_rho"].mean() > 0
                else float("nan")
            )
            diag.append(
                {
                    "ticker": row["ticker"],
                    "feature": row["feature"],
                    "window_min": int(row["window_min"]),
                    "expiry_filter": row["expiry_filter"],
                    "horizon_min": int(row["horizon_min"]),
                    "overall_rho": float(row["rho"]),
                    "overall_p": float(row["p_value"]),
                    "overall_p_bonf": float(row["p_bonf"]),
                    "overall_n": int(row["n"]),
                    "best_bucket": str(best["bucket"]),
                    "best_bucket_rho": float(best["rho"]),
                    "best_bucket_n": int(best["n"]),
                    "concentration_ratio": concentration,
                }
            )

    with open(TOP_PATH, "w") as f:
        json.dump(diag, f, indent=2)
    print(f"Wrote {TOP_PATH} (top {len(diag)} correlations)")

    # Console preview.
    print("\n=== Top 15 correlations (overall, |rho|, p<0.05 uncorrected) ===")
    for d in diag[:15]:
        sig = (
            "***"
            if d["overall_p_bonf"] < 0.05
            else (" **" if d["overall_p"] < 0.01 else "  *")
        )
        print(
            f"  {sig}  {d['ticker']:<5} {d['feature']:<14} "
            f"win={d['window_min']:>2}m exp={d['expiry_filter']:<4} "
            f"h={d['horizon_min']:>2}m   "
            f"rho={d['overall_rho']:+.3f}  p={d['overall_p']:.1e}  "
            f"n={d['overall_n']:>4}  "
            f"best=[{d['best_bucket']}:{d['best_bucket_rho']:+.2f}]  "
            f"conc={d['concentration_ratio']:.2f}"
        )
    print("\nLegend: *** = Bonferroni-corrected p<0.05 (strong)")
    print("         ** = uncorrected p<0.01")
    print(
        "          * = uncorrected p<0.05 only (weak; could be multiple-comparison artifact)"
    )
    print(" conc = max|rho|/mean|rho| across 5 time-of-day buckets")
    print("        ~1.0 = uniform across day = leakage suspect")
    print("        >2.0 = concentrated in 1-2 buckets = more credible edge")

    return 0


if __name__ == "__main__":
    sys.exit(main())
