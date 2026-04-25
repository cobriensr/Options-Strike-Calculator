"""IV-anomaly Phase D2 — signal magnitude × regime.

Phase C bucketed by signal *count* (1 vs 2 reasons fired). It found
multi-signal isn't better than single-signal on average. But that
treated a 5σ z-score the same as a 2σ z-score. D2 buckets by
*magnitude* per signal, sliced by regime × side.

Plus a **composite intensity score**: z-score-standardize each signal
ONLY across alerts where it fired (avoids penalizing alerts with
missing signals), sum, and bin by quartile.

Outputs:
- ml/findings/iv-anomaly-signal-magnitude-2026-04-25.json
- ml/reports/iv-anomaly-signal-magnitude-2026-04-25.md
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(REPO_ROOT / "ml"))

from iv_anomaly_utils import (  # noqa: E402
    aggregate_pnl,
    apply_best_strategy,
    attach_regime,
    load_session_regime_labels,
    pick_best_strategy_per_ticker_regime,
    silence_pandas_psycopg2_warning,
    to_jsonable,
)

silence_pandas_psycopg2_warning()
BACKTEST_PATH = REPO_ROOT / "ml" / "data" / "iv-anomaly-backtest-2026-04-25.parquet"
OUT_FINDINGS = REPO_ROOT / "ml" / "findings" / "iv-anomaly-signal-magnitude-2026-04-25.json"
OUT_REPORT = REPO_ROOT / "ml" / "reports" / "iv-anomaly-signal-magnitude-2026-04-25.md"

NON_ORACLE = ["pnl_itm_touch", "pnl_eod"]


def load_and_label() -> pd.DataFrame:
    df = pd.read_parquet(BACKTEST_PATH)
    df = attach_regime(df, load_session_regime_labels())
    return df


def apply_best(df: pd.DataFrame, best_map: dict) -> pd.DataFrame:
    """Local thin wrapper — delegates to shared apply_best_strategy."""
    return apply_best_strategy(df, best_map)


def bucket_z_score(z: float) -> str:
    if pd.isna(z):
        return "missing"
    a = abs(z)
    if a < 2.0:
        return "z_lt_2"
    if a < 3.0:
        return "z_2to3"
    if a < 5.0:
        return "z_3to5"
    return "z_5plus"


def bucket_skew_delta(s: float) -> str:
    if pd.isna(s):
        return "missing"
    a = abs(s)
    if a < 0.01:
        return "skew_lt_001"
    if a < 0.025:
        return "skew_01to025"
    if a < 0.05:
        return "skew_025to05"
    return "skew_05plus"


def bucket_ask_mid_div(a: float) -> str:
    if pd.isna(a):
        return "missing"
    a = abs(a)
    if a < 0.3:
        return "amd_lt_03"
    if a < 0.5:
        return "amd_03to05"
    if a < 0.7:
        return "amd_05to07"
    return "amd_07plus"


def bucket_vol_oi(v: float) -> str:
    if pd.isna(v):
        return "missing"
    if v < 10:
        return "vo_5to10"
    if v < 50:
        return "vo_10to50"
    if v < 200:
        return "vo_50to200"
    return "vo_200plus"


def bucket_side_skew(s: float) -> str:
    if pd.isna(s):
        return "missing"
    if s < 0.80:
        return "ss_065to080"
    if s < 0.95:
        return "ss_080to095"
    return "ss_095plus"


def aggregate_by_signal_bucket(df: pd.DataFrame, signal_name: str, bucket_col: str) -> pd.DataFrame:
    """Aggregate win rate / mean PnL by (regime, side, signal_bucket)."""
    sub = df.dropna(subset=["best_pnl_pct"])
    g = sub.groupby(["regime", "side", bucket_col]).agg(
        n=("anomaly_id", "count"),
        win_pct=("best_pnl_pct", lambda x: float((x > 0).mean() * 100)),
        mean_pct=("best_pnl_pct", "mean"),
        mean_dollar=("best_dollar", "mean"),
        median_dollar=("best_dollar", "median"),
    )
    return g.round(2)


def composite_intensity(df: pd.DataFrame) -> pd.Series:
    """Z-score-standardize each signal magnitude across alerts where it fired, sum the standardized values."""
    abs_sigs = pd.DataFrame({
        "z_score": df["z_score"].abs(),
        "skew_delta": df["skew_delta"].abs(),
        "ask_mid_div": df["ask_mid_div"].abs(),
        "vol_oi_ratio": df["vol_oi_ratio"],
    })
    standardized = abs_sigs.copy()
    for col in standardized.columns:
        present = standardized[col].dropna()
        if len(present) > 1 and present.std() > 0:
            standardized[col] = (standardized[col] - present.mean()) / present.std()
    # Sum where present (NaN treated as 0 contribution)
    intensity = standardized.fillna(0).sum(axis=1)
    return intensity


def main() -> None:
    df = load_and_label()
    best = pick_best_strategy_per_ticker_regime(df)
    df = apply_best(df, best)

    # Apply buckets
    df["bucket_z"] = df["z_score"].apply(bucket_z_score)
    df["bucket_skew"] = df["skew_delta"].apply(bucket_skew_delta)
    df["bucket_amd"] = df["ask_mid_div"].apply(bucket_ask_mid_div)
    df["bucket_vo"] = df["vol_oi_ratio"].apply(bucket_vol_oi)
    df["bucket_ss"] = df["side_skew"].apply(bucket_side_skew)
    df["intensity"] = composite_intensity(df)
    df["bucket_intensity"] = pd.qcut(df["intensity"], 4, labels=["q1_low", "q2", "q3", "q4_high"], duplicates="drop")

    # Aggregations
    by_z = aggregate_by_signal_bucket(df, "z_score", "bucket_z")
    by_skew = aggregate_by_signal_bucket(df, "skew_delta", "bucket_skew")
    by_amd = aggregate_by_signal_bucket(df, "ask_mid_div", "bucket_amd")
    by_vo = aggregate_by_signal_bucket(df, "vol_oi_ratio", "bucket_vo")
    by_ss = aggregate_by_signal_bucket(df, "side_skew", "bucket_ss")
    by_intensity = aggregate_by_signal_bucket(df, "intensity", "bucket_intensity")

    # ──────── JSON findings ────────
    findings = {
        "n_total": int(len(df)),
        "by_z_score": by_z.reset_index().to_dict(orient="records"),
        "by_skew_delta": by_skew.reset_index().to_dict(orient="records"),
        "by_ask_mid_div": by_amd.reset_index().to_dict(orient="records"),
        "by_vol_oi_ratio": by_vo.reset_index().to_dict(orient="records"),
        "by_side_skew": by_ss.reset_index().to_dict(orient="records"),
        "by_composite_intensity": by_intensity.reset_index().to_dict(orient="records"),
    }
    OUT_FINDINGS.parent.mkdir(parents=True, exist_ok=True)
    OUT_FINDINGS.write_text(json.dumps(findings, indent=2, default=to_jsonable))
    print(f"Wrote {OUT_FINDINGS}")

    # ──────── Markdown ────────
    OUT_REPORT.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# IV-Anomaly Signal Magnitude (Phase D2) — 2026-04-25")
    lines.append(f"**Sample:** {len(df):,} alerts, sliced by regime × side × signal-magnitude bucket.")
    lines.append("")
    lines.append("**Key question:** does signal *strength* (e.g. 5σ z-score) predict better outcomes than signal "
                 "*presence* alone? Phase C answered the count question (no). This answers magnitude.")
    lines.append("")

    def _emit(title: str, table: pd.DataFrame, bucket_label: str) -> None:
        lines.append(f"## {title}")
        lines.append("")
        lines.append(f"| regime | side | {bucket_label} | n | win% | mean% | mean $ | median $ |")
        lines.append("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |")
        for (regime, side, bucket), row in table.iterrows():
            n = int(row["n"])
            if n < 30:
                continue
            lines.append(
                f"| {regime} | {side} | {bucket} | {n:,} | {row['win_pct']:.1f}% | "
                f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} | ${row['median_dollar']:,.0f} |"
            )
        lines.append("")

    _emit("Z-score magnitude × regime × side", by_z, "z_bucket")
    _emit("Skew-delta magnitude × regime × side", by_skew, "skew_bucket")
    _emit("Ask-mid divergence × regime × side", by_amd, "amd_bucket")
    _emit("Vol/OI ratio × regime × side", by_vo, "vo_bucket")
    _emit("Side-skew × regime × side", by_ss, "ss_bucket")
    _emit("Composite intensity quartile × regime × side", by_intensity, "intensity_q")

    OUT_REPORT.write_text("\n".join(lines))
    print(f"Wrote {OUT_REPORT}")


if __name__ == "__main__":
    main()
