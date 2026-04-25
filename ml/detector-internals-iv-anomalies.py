"""IV-anomaly Phase D4 — detector internals × regime.

Asks: does an alert's *firing pattern* (duration, persistence,
time-to-first-firing) predict outcome? Are flash alerts (fire once
and disappear) different from persistent alerts (fire 30+ times)?

Outputs:
- ml/findings/iv-anomaly-detector-internals-2026-04-25.json
- ml/reports/iv-anomaly-detector-internals-2026-04-25.md
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
OUT_FINDINGS = REPO_ROOT / "ml" / "findings" / "iv-anomaly-detector-internals-2026-04-25.json"
OUT_REPORT = REPO_ROOT / "ml" / "reports" / "iv-anomaly-detector-internals-2026-04-25.md"

NON_ORACLE = ["pnl_itm_touch", "pnl_eod"]


def load_label_and_pick() -> pd.DataFrame:
    df = pd.read_parquet(BACKTEST_PATH)
    df = attach_regime(df, load_session_regime_labels())
    best = pick_best_strategy_per_ticker_regime(df)
    df = apply_best_strategy(df, best)

    df["compound_key"] = df["ticker"] + "|" + df["strike"].astype(str) + "|" + df["side"] + "|" + df["expiry"].astype(str)
    return df


def derive_per_key_features(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate per (compound_key, date) for duration / count / time-to-first."""
    df = df.sort_values("alert_ct")
    sess_open = df["alert_ct"].dt.normalize() + pd.Timedelta(hours=8, minutes=30)
    sess_open = sess_open.dt.tz_convert("UTC")
    df["mins_since_open"] = (df["alert_ct"].dt.tz_convert("UTC") - sess_open).dt.total_seconds() / 60.0

    g = df.groupby(["compound_key", "date"]).agg(
        ticker=("ticker", "first"),
        regime=("regime", "first"),
        side=("side", "first"),
        first_seen_ct=("alert_ct", "min"),
        last_seen_ct=("alert_ct", "max"),
        firing_count=("anomaly_id", "count"),
        time_to_first_min=("mins_since_open", "min"),
    ).reset_index()
    g["duration_min"] = (g["last_seen_ct"] - g["first_seen_ct"]).dt.total_seconds() / 60.0

    # Categorize
    def categorize(r):
        if r["duration_min"] < 5 and r["firing_count"] < 3:
            return "flash"
        if r["duration_min"] >= 60 or r["firing_count"] >= 20:
            return "persistent"
        return "medium"
    g["pattern"] = g.apply(categorize, axis=1)

    return g[["compound_key", "date", "ticker", "regime", "side", "firing_count", "duration_min", "time_to_first_min", "pattern"]]


def aggregate_by(df: pd.DataFrame, group_cols: list[str]) -> pd.DataFrame:
    sub = df.dropna(subset=["best_pnl_pct"])
    g = sub.groupby(group_cols).agg(
        n=("anomaly_id", "count"),
        win_pct=("best_pnl_pct", lambda x: float((x > 0).mean() * 100)),
        mean_pct=("best_pnl_pct", "mean"),
        mean_dollar=("best_dollar", "mean"),
    )
    return g.round(2)


def main() -> None:
    df = load_label_and_pick()
    keys = derive_per_key_features(df)

    # Join key-level features back to alerts (one alert -> one key+date row)
    df = df.merge(keys[["compound_key", "date", "duration_min", "firing_count", "time_to_first_min", "pattern"]],
                  on=["compound_key", "date"], how="left")

    # Buckets
    df["fc_bucket"] = pd.cut(df["firing_count"], bins=[0, 1, 5, 20, np.inf], labels=["fc_1", "fc_2to5", "fc_6to20", "fc_21plus"])
    df["dur_bucket"] = pd.cut(df["duration_min"], bins=[-1, 5, 60, np.inf], labels=["dur_under5min", "dur_5to60min", "dur_over1hr"])
    df["ttf_bucket"] = pd.cut(df["time_to_first_min"], bins=[-1, 30, 120, 300, np.inf], labels=["first_30min", "first_2hr", "midday", "afternoon"])

    findings = {
        "n_total": int(len(df)),
        "by_pattern": aggregate_by(df, ["pattern", "side"]).reset_index().to_dict(orient="records"),
        "by_pattern_regime": aggregate_by(df, ["regime", "pattern", "side"]).reset_index().to_dict(orient="records"),
        "by_firing_count": aggregate_by(df, ["fc_bucket", "side"]).reset_index().to_dict(orient="records"),
        "by_duration": aggregate_by(df, ["dur_bucket", "side"]).reset_index().to_dict(orient="records"),
        "by_time_to_first": aggregate_by(df, ["ttf_bucket", "side"]).reset_index().to_dict(orient="records"),
        "by_time_to_first_regime": aggregate_by(df, ["regime", "ttf_bucket", "side"]).reset_index().to_dict(orient="records"),
    }
    OUT_FINDINGS.parent.mkdir(parents=True, exist_ok=True)
    OUT_FINDINGS.write_text(json.dumps(findings, indent=2, default=to_jsonable))
    print(f"Wrote {OUT_FINDINGS}")

    # ──────── Markdown ────────
    lines: list[str] = []
    lines.append("# IV-Anomaly Detector Internals (Phase D4) — 2026-04-25")
    lines.append(f"**Sample:** {len(df):,} alerts.")
    lines.append("")
    lines.append("**Pattern definitions:**")
    lines.append("")
    lines.append("- `flash` — duration <5 min AND firing_count <3")
    lines.append("- `persistent` — duration ≥60 min OR firing_count ≥20")
    lines.append("- `medium` — everything else")
    lines.append("")
    lines.append("**Time-to-first-firing buckets:** time from session open (08:30 CT) to first firing of that "
                 "(compound_key, date).")
    lines.append("")

    def _emit(title: str, table: pd.DataFrame, bucket_label: str = "") -> None:
        lines.append(f"## {title}")
        lines.append("")
        cols = list(table.index.names)
        header = "| " + " | ".join(cols + ["n", "win%", "mean%", "mean $"]) + " |"
        sep = "| " + " | ".join(["---"] * len(cols) + ["---:"] * 4) + " |"
        lines.append(header)
        lines.append(sep)
        for idx, row in table.iterrows():
            n = int(row["n"])
            if n < 30:
                continue
            ix = idx if isinstance(idx, tuple) else (idx,)
            vals = " | ".join(str(v) for v in ix)
            lines.append(
                f"| {vals} | {n:,} | {row['win_pct']:.1f}% | "
                f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
            )
        lines.append("")

    _emit("Pattern (flash / medium / persistent) × side", aggregate_by(df, ["pattern", "side"]))
    _emit("Firing-count bucket × side", aggregate_by(df, ["fc_bucket", "side"]))
    _emit("Duration bucket × side", aggregate_by(df, ["dur_bucket", "side"]))
    _emit("Time-to-first-firing × side", aggregate_by(df, ["ttf_bucket", "side"]))
    _emit("Pattern × regime × side", aggregate_by(df, ["regime", "pattern", "side"]))
    _emit("Time-to-first × regime × side", aggregate_by(df, ["regime", "ttf_bucket", "side"]))

    OUT_REPORT.write_text("\n".join(lines))
    print(f"Wrote {OUT_REPORT}")


if __name__ == "__main__":
    main()
