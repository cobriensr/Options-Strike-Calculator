"""IV-anomaly Phase E2 — dark-print proximity (SPXW only).

For each SPXW alert, computes how much dark-pool premium accumulated
at or near the alerted strike on that trading day. The dark_pool_levels
table is SPX-attributed only — SPY/QQQ/NDXP rows have null SPY price
columns in this dataset, so E2 is restricted to SPXW.

Per the project's three darkpool filter rules (already enforced upstream
in the cron that populates dark_pool_levels — sale_cond_codes filtering
and session-window restriction happen at ingest).

Hypothesis: SPXW call alerts that fire ON or NEAR strikes where major
dark prints landed earlier the same day have higher win rates than
alerts on strikes with no dark-print concentration.

Outputs:
- ml/findings/iv-anomaly-darkprint-2026-04-25.json
- ml/reports/iv-anomaly-darkprint-2026-04-25.md
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

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
ENV_LOCAL = REPO_ROOT / ".env.local"
BACKTEST_PATH = REPO_ROOT / "ml" / "data" / "iv-anomaly-backtest-2026-04-25.parquet"
OUT_FINDINGS = REPO_ROOT / "ml" / "findings" / "iv-anomaly-darkprint-2026-04-25.json"
OUT_REPORT = REPO_ROOT / "ml" / "reports" / "iv-anomaly-darkprint-2026-04-25.md"

NON_ORACLE = ["pnl_itm_touch", "pnl_eod"]
# At-strike band: alert strike is at-the-money for dark print purposes if a
# dp_level lands within ±5pts (SPX 5-pt strike grid).
AT_STRIKE_BAND = 5
# Wider band: ±25pts captures the broader "magnetic zone" — dealers will
# often hedge a cluster spanning 25pts with their nearest strike sell.
NEAR_STRIKE_BAND = 25


def load_env() -> None:
    if not ENV_LOCAL.exists():
        return
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k, v.strip().strip('"'))


def fetch_dp_levels(conn) -> pd.DataFrame:
    """Per-(date, spx_level) dark print premium aggregates."""
    sql = """
    SELECT date, spx_approx, total_premium, trade_count, total_shares,
           buyer_initiated, seller_initiated, neutral, latest_time
    FROM dark_pool_levels
    WHERE date >= '2026-04-13' AND date < '2026-04-25'
    ORDER BY date, spx_approx
    """
    print("[query] dark_pool_levels...", file=sys.stderr)
    df = pd.read_sql_query(sql, conn)
    df["total_premium"] = df["total_premium"].astype(float)
    df["spx_approx"] = df["spx_approx"].astype(int)
    return df


def compute_dp_features(alert_strike: float, alert_date, dp: pd.DataFrame) -> dict:
    """For a single SPXW alert, summarize nearby dark-print activity."""
    day_dp = dp[dp["date"] == alert_date]
    if len(day_dp) == 0:
        return {
            "dp_n_levels_at_strike": 0,
            "dp_prem_at_strike": 0.0,
            "dp_n_levels_near_strike": 0,
            "dp_prem_near_strike": 0.0,
            "dp_largest_near_premium": 0.0,
            "dp_buyer_pct_near_strike": np.nan,
            "dp_total_day_premium": 0.0,
            "dp_strike_share_of_day": np.nan,
        }

    diff = (day_dp["spx_approx"] - alert_strike).abs()
    at_band = day_dp[diff <= AT_STRIKE_BAND]
    near_band = day_dp[diff <= NEAR_STRIKE_BAND]

    total_day = float(day_dp["total_premium"].sum())
    near_prem = float(near_band["total_premium"].sum())
    near_buyer = float(near_band["buyer_initiated"].sum())
    near_seller = float(near_band["seller_initiated"].sum())
    near_neutral = float(near_band["neutral"].sum())
    near_total_count = near_buyer + near_seller + near_neutral

    return {
        "dp_n_levels_at_strike": int(len(at_band)),
        "dp_prem_at_strike": float(at_band["total_premium"].sum()),
        "dp_n_levels_near_strike": int(len(near_band)),
        "dp_prem_near_strike": near_prem,
        "dp_largest_near_premium": float(near_band["total_premium"].max()) if len(near_band) > 0 else 0.0,
        "dp_buyer_pct_near_strike": float(near_buyer / near_total_count * 100) if near_total_count > 0 else np.nan,
        "dp_total_day_premium": total_day,
        "dp_strike_share_of_day": float(near_prem / total_day * 100) if total_day > 0 else np.nan,
    }


def _attach_session_regime(df: pd.DataFrame) -> pd.DataFrame:
    """Use shared session-bounded regime labels (Phase A-E review fix)."""
    return attach_regime(df, load_session_regime_labels())




def aggregate(df: pd.DataFrame, group_cols: list[str]) -> pd.DataFrame:
    sub = df.dropna(subset=["best_pnl_pct"])
    g = sub.groupby(group_cols).agg(
        n=("anomaly_id", "count"),
        win_pct=("best_pnl_pct", lambda x: float((x > 0).mean() * 100)),
        mean_pct=("best_pnl_pct", "mean"),
        mean_dollar=("best_dollar", "mean"),
    )
    return g.round(2)


def main() -> None:
    load_env()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    df = pd.read_parquet(BACKTEST_PATH)
    df = df[df["ticker"] == "SPXW"].copy()
    df["alert_ts"] = pd.to_datetime(df["alert_ts"], utc=True)

    with psycopg2.connect(db_url) as conn:
        dp = fetch_dp_levels(conn)

    df = _attach_session_regime(df)
    print(f"Computing DP features for {len(df):,} SPXW alerts...", file=sys.stderr)
    feats = []
    for _, alert in df.iterrows():
        feats.append(compute_dp_features(float(alert["strike"]), alert["date"], dp))
    feat_df = pd.DataFrame(feats)
    df = pd.concat([df.reset_index(drop=True), feat_df.reset_index(drop=True)], axis=1)

    best = pick_best_strategy_per_ticker_regime(df)
    df["best_strategy"] = df.apply(lambda r: best.get((r["ticker"], r["regime"]), "pnl_eod"), axis=1)
    df["best_pnl_pct"] = df.apply(lambda r: r[r["best_strategy"]] if pd.notna(r[r["best_strategy"]]) else np.nan, axis=1)
    df["entry_dollars"] = df["entry_premium"].astype(float) * 100.0
    df["best_dollar"] = df["entry_dollars"] * df["best_pnl_pct"]

    # Buckets — boundaries align with `DP_BUCKETS` in api/_lib/constants.ts
    # so backfill labels match what the live endpoint shows. `right=False`
    # means [50, 200) goes to 50to200M (open on the right), matching the
    # TS endpoint's `< small / < medium / >= medium` logic.
    df["dp_prem_at_strike_bucket"] = pd.cut(
        df["dp_prem_at_strike"] / 1_000_000,
        bins=[-np.inf, 0, 50, 200, 500, np.inf],
        labels=["none", "lt50M", "50to200M", "200to500M", "500Mplus"],
        right=True,
    )
    df["dp_strike_share_bucket"] = pd.cut(
        df["dp_strike_share_of_day"],
        bins=[-0.01, 5, 15, 30, 50, 101],
        labels=["lt5pct", "5to15pct", "15to30pct", "30to50pct", "50plus"],
    )

    findings = {
        "n_total": int(len(df)),
        "n_alerts_with_at_strike_dp": int((df["dp_prem_at_strike"] > 0).sum()),
        "by_at_strike_bucket": aggregate(df, ["dp_prem_at_strike_bucket", "side"]).reset_index().to_dict(orient="records"),
        "by_at_strike_bucket_regime": aggregate(df, ["regime", "dp_prem_at_strike_bucket", "side"]).reset_index().to_dict(orient="records"),
        "by_strike_share_bucket": aggregate(df, ["dp_strike_share_bucket", "side"]).reset_index().to_dict(orient="records"),
    }
    OUT_FINDINGS.parent.mkdir(parents=True, exist_ok=True)
    OUT_FINDINGS.write_text(json.dumps(findings, indent=2, default=to_jsonable))
    print(f"Wrote {OUT_FINDINGS}")

    lines: list[str] = []
    lines.append("# IV-Anomaly Dark-Print Proximity (Phase E2) — 2026-04-25")
    lines.append(f"**Sample:** {len(df):,} SPXW alerts (E2 is SPXW-only; "
                 "dark_pool_levels is SPX-attributed only). "
                 f"{int((df['dp_prem_at_strike'] > 0).sum()):,} have non-zero "
                 "dark-print premium at the alerted strike.")
    lines.append("")
    lines.append("**Bands:**")
    lines.append("")
    lines.append(f"- `at_strike` — alert strike ± {AT_STRIKE_BAND}pts (SPX 5-pt grid; basically same strike)")
    lines.append(f"- `near_strike` — alert strike ± {NEAR_STRIKE_BAND}pts (broader magnetic zone)")
    lines.append("")

    lines.append("## At-strike DP premium bucket × side")
    lines.append("")
    lines.append("| dp_prem_at_strike | side | n | win% | mean% | mean $ |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
    for (b, side), row in aggregate(df, ["dp_prem_at_strike_bucket", "side"]).iterrows():
        n = int(row["n"])
        if n < 30:
            continue
        lines.append(
            f"| {b} | {side} | {n:,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    lines.append("## At-strike DP premium × regime × side")
    lines.append("")
    lines.append("| regime | dp_bucket | side | n | win% | mean% | mean $ |")
    lines.append("| --- | --- | --- | ---: | ---: | ---: | ---: |")
    for (regime, b, side), row in aggregate(df, ["regime", "dp_prem_at_strike_bucket", "side"]).iterrows():
        n = int(row["n"])
        if n < 30:
            continue
        lines.append(
            f"| {regime} | {b} | {side} | {n:,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    lines.append("## Share of day's total DP premium at this strike")
    lines.append("")
    lines.append("| share_bucket | side | n | win% | mean% | mean $ |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
    for (b, side), row in aggregate(df, ["dp_strike_share_bucket", "side"]).iterrows():
        n = int(row["n"])
        if n < 30:
            continue
        lines.append(
            f"| {b} | {side} | {n:,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    OUT_REPORT.parent.mkdir(parents=True, exist_ok=True)
    OUT_REPORT.write_text("\n".join(lines))
    print(f"Wrote {OUT_REPORT}")


if __name__ == "__main__":
    main()
