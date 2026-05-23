#!/usr/bin/env python
"""V2.2 Phase A.3 — Stop/target backtest by tier.

For the last 30 days of aligned tier1/tier2 fires, simulates all
combinations of:
  - 5 exit policies  (flow_inversion, trail_30_10, hard_30m,
                      tier50_holdeod, eod)
  - 4 stop-loss tiers (none, -15%, -25%, -40%)
  - 4 take-profit tiers (none, +50%, +100%, +200%)

For each (tier × exit_policy × stop × tp) cell, reports:
  n, mean, median, win%, sharpe (mean/std), max_drawdown

Writes: docs/tmp/v22-stop-target-backtest-2026-05-22.md

Usage:
    ml/.venv/bin/python scripts/backtest_stop_target_by_tier.py
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env.local"
REPORT_PATH = ROOT / "docs" / "tmp" / "v22-stop-target-backtest-2026-05-22.md"

# ---------------------------------------------------------------------------
# Tier thresholds (mirrors api/_lib/lottery-score-weights.ts)
# ---------------------------------------------------------------------------
TIER1_MIN = 18
TIER2_MIN = 12

# ---------------------------------------------------------------------------
# Exit policy columns (the realized_* columns in lottery_finder_fires)
# ---------------------------------------------------------------------------
EXIT_POLICIES: list[tuple[str, str]] = [
    ("flow_inversion", "realized_flow_inversion_pct"),
    ("trail_30_10",    "realized_trail30_10_pct"),
    ("hard_30m",       "realized_hard30m_pct"),
    ("tier50_holdeod", "realized_tier50_holdeod_pct"),
    ("eod",            "realized_eod_pct"),
]

# Stop-loss grid: None means no cap
STOPS: list[float | None] = [None, -15.0, -25.0, -40.0]
# Take-profit grid: None means no cap
TPS: list[float | None] = [None, 50.0, 100.0, 200.0]

STOP_LABELS = {None: "none", -15.0: "-15%", -25.0: "-25%", -40.0: "-40%"}
TP_LABELS   = {None: "none",  50.0: "+50%", 100.0: "+100%", 200.0: "+200%"}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------


def load_env() -> None:
    """Load DATABASE_URL from .env.local into os.environ."""
    if not ENV_FILE.exists():
        sys.exit(f"Missing env file: {ENV_FILE}")
    with ENV_FILE.open() as fh:
        for line in fh:
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------

FETCH_QUERY = """
SELECT
    id,
    date,
    combined_score,
    realized_flow_inversion_pct,
    realized_trail30_10_pct,
    realized_hard30m_pct,
    realized_tier50_holdeod_pct,
    realized_eod_pct
FROM lottery_finder_fires
WHERE
    date >= CURRENT_DATE - INTERVAL '30 days'
    AND combined_score IS NOT NULL
    AND cum_ncp_at_fire IS NOT NULL
    AND cum_npp_at_fire IS NOT NULL
    AND (
        (option_type = 'C' AND cum_ncp_at_fire > cum_npp_at_fire)
        OR (option_type = 'P' AND cum_npp_at_fire > cum_ncp_at_fire)
    )
    AND inferred_structure IS NULL
ORDER BY date DESC, id DESC
"""


def fetch_fires() -> pd.DataFrame:
    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get(
        "DATABASE_URL"
    )
    if not db_url:
        sys.exit("DATABASE_URL not set")

    print("Connecting to database...")
    conn = psycopg2.connect(db_url, sslmode="require", connect_timeout=15)
    try:
        df = pd.read_sql_query(FETCH_QUERY, conn)
    finally:
        conn.close()

    print(f"  Raw rows fetched: {len(df):,}")
    return df


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------


def apply_stop_tp(
    series: pd.Series, stop: float | None, tp: float | None
) -> pd.Series:
    """Cap a returns series at stop-loss floor and take-profit ceiling."""
    s = series.copy()
    if stop is not None:
        s = s.clip(lower=stop)
    if tp is not None:
        s = s.clip(upper=tp)
    return s


def sharpe(returns: pd.Series) -> float:
    """mean / std — returns NaN if std == 0 or n < 2."""
    if len(returns) < 2:
        return float("nan")
    std = returns.std(ddof=1)
    if std == 0:
        return float("nan")
    return float(returns.mean() / std)


def simulate_tier(df: pd.DataFrame, tier_label: str) -> pd.DataFrame:
    """Run the full grid for a single tier dataframe. Returns a results df."""
    rows = []
    for policy_name, col in EXIT_POLICIES:
        avail = df[col].dropna()
        if len(avail) == 0:
            print(f"  WARNING: {policy_name} has no non-null values for {tier_label}")
        for stop in STOPS:
            for tp in TPS:
                raw = df[col].dropna()
                if len(raw) == 0:
                    continue
                capped = apply_stop_tp(raw, stop, tp)

                n = len(capped)
                mean_r = float(capped.mean())
                median_r = float(capped.median())
                win_pct = float((capped > 0).mean() * 100)
                sh = sharpe(capped)
                max_dd = float(capped.min())

                rows.append(
                    {
                        "exit_policy": policy_name,
                        "stop": STOP_LABELS[stop],
                        "tp": TP_LABELS[tp],
                        "n": n,
                        "mean": round(mean_r, 2),
                        "median": round(median_r, 2),
                        "win_pct": round(win_pct, 1),
                        "sharpe": round(sh, 3) if not np.isnan(sh) else float("nan"),
                        "max_dd": round(max_dd, 2),
                    }
                )

    result = pd.DataFrame(rows)
    result = result.sort_values("sharpe", ascending=False)
    return result


# ---------------------------------------------------------------------------
# Report formatting
# ---------------------------------------------------------------------------


def fmt_row(r: dict) -> str:
    sharpe_str = (
        f"{r['sharpe']:.3f}" if not np.isnan(r["sharpe"]) else "n/a"
    )
    return (
        f"| {r['exit_policy']:<20} | {r['stop']:<6} | {r['tp']:<7} "
        f"| {r['n']:>5} | {r['mean']:>7.2f}% | {r['median']:>7.2f}% "
        f"| {r['win_pct']:>6.1f}% | {sharpe_str:>8} | {r['max_dd']:>8.2f}% |"
    )


HEADER = (
    "| Exit Policy          | Stop   | TP      "
    "|     n |    mean |  median |   win% |   sharpe | max_dd   |"
)
DIVIDER = (
    "|----------------------|--------|---------|"
    "-------|---------|---------|--------|----------|----------|"
)


def build_table(results: pd.DataFrame) -> str:
    lines = [HEADER, DIVIDER]
    for _, r in results.iterrows():
        lines.append(fmt_row(r.to_dict()))
    return "\n".join(lines)


def best_row(results: pd.DataFrame, min_n: int = 5) -> dict | None:
    """Return the row with highest sharpe that has at least min_n fires."""
    filtered = results[results["n"] >= min_n].sort_values(
        "sharpe", ascending=False
    )
    if filtered.empty:
        return None
    return filtered.iloc[0].to_dict()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    load_env()
    df = fetch_fires()

    # Assign tier based on combined_score
    df["tier"] = df["combined_score"].apply(
        lambda s: "tier1" if s >= TIER1_MIN else ("tier2" if s >= TIER2_MIN else "tier3")
    )

    tier1_df = df[df["tier"] == "tier1"].copy()
    tier2_df = df[df["tier"] == "tier2"].copy()

    print(f"  Tier 1 fires: {len(tier1_df):,}")
    print(f"  Tier 2 fires: {len(tier2_df):,}")
    print(f"  Tier 3 fires (excluded): {len(df[df['tier'] == 'tier3']):,}")

    # Date range
    min_date = df["date"].min()
    max_date = df["date"].max()
    print(f"  Date range: {min_date} — {max_date}")

    print("\nRunning grid for tier 1...")
    t1_results = simulate_tier(tier1_df, "tier1")
    print("Running grid for tier 2...")
    t2_results = simulate_tier(tier2_df, "tier2")

    # --- Data coverage summary ---
    print("\nData coverage (% non-null per policy):")
    for policy_name, col in EXIT_POLICIES:
        t1_pct = tier1_df[col].notna().mean() * 100 if len(tier1_df) > 0 else 0
        t2_pct = tier2_df[col].notna().mean() * 100 if len(tier2_df) > 0 else 0
        print(f"  {policy_name:<22} tier1={t1_pct:.1f}%  tier2={t2_pct:.1f}%")

    t1_best = best_row(t1_results, min_n=5)
    t2_best = best_row(t2_results, min_n=5)

    # Build report
    lines = [
        "# V2.2 Stop/Target Backtest by Tier — 2026-05-22",
        "",
        "## Method",
        "",
        f"- 30-day window of aligned tier1/tier2 fires: "
        f"{len(tier1_df):,} tier1, {len(tier2_df):,} tier2",
        f"- Date range: {min_date} — {max_date}",
        "- **Alignment filter**: `cum_ncp_at_fire IS NOT NULL`, directionally aligned "
        "(call + ncp>npp OR put + npp>ncp), no inferred structure",
        "- **Tiers**: tier1 = combined_score >= 18, tier2 = 12–17",
        "- 5 exit policies × 4 stop tiers (none, -15%, -25%, -40%) × "
        "4 TP tiers (none, +50%, +100%, +200%) = 80 combos per tier",
        "- Simulation is approximate: stop/TP caps are applied to the realized "
        "column value, not full tick replay. A fire capped at -15% means the "
        "realized column showed worse than -15% and we floor it.",
        "- **Sharpe**: mean / std (trade-level, not annualised)",
        "- **Win%**: fraction of fires where capped return > 0",
        "",
        "## Data coverage",
        "",
        "| Policy            | Tier1 non-null% | Tier2 non-null% |",
        "|-------------------|-----------------|-----------------|",
    ]

    for policy_name, col in EXIT_POLICIES:
        t1_pct = tier1_df[col].notna().mean() * 100 if len(tier1_df) > 0 else 0
        t2_pct = tier2_df[col].notna().mean() * 100 if len(tier2_df) > 0 else 0
        lines.append(
            f"| {policy_name:<17} | {t1_pct:>15.1f}% | {t2_pct:>15.1f}% |"
        )

    lines += [
        "",
        "## Tier 1 results (sorted by Sharpe, top 20)",
        "",
        build_table(t1_results.head(20)),
        "",
        "### Tier 1 — Bottom 5 by Sharpe",
        "",
        build_table(t1_results.tail(5)),
        "",
        "## Tier 2 results (sorted by Sharpe, top 20)",
        "",
        build_table(t2_results.head(20)),
        "",
        "### Tier 2 — Bottom 5 by Sharpe",
        "",
        build_table(t2_results.tail(5)),
        "",
        "## Recommended trading rules",
        "",
    ]

    if t1_best:
        lines.append(
            f"- **Tier 1**: exit via `{t1_best['exit_policy']}` with stop "
            f"{t1_best['stop']} and TP {t1_best['tp']} — "
            f"mean {t1_best['mean']:.2f}%, "
            f"win {t1_best['win_pct']:.1f}%, "
            f"sharpe {t1_best['sharpe']:.3f}, "
            f"n={t1_best['n']}"
        )
    else:
        lines.append("- **Tier 1**: insufficient data for recommendation")

    if t2_best:
        lines.append(
            f"- **Tier 2**: exit via `{t2_best['exit_policy']}` with stop "
            f"{t2_best['stop']} and TP {t2_best['tp']} — "
            f"mean {t2_best['mean']:.2f}%, "
            f"win {t2_best['win_pct']:.1f}%, "
            f"sharpe {t2_best['sharpe']:.3f}, "
            f"n={t2_best['n']}"
        )
    else:
        lines.append("- **Tier 2**: insufficient data for recommendation")

    lines += [
        "",
        "## Caveats",
        "",
        "- Simulation is approximate (uses realized columns, not full tick replay)",
        "- Stop/TP caps applied post-hoc: the realized value is capped, but actual "
        "intraday path (e.g. hit +200% then fell back) is not reconstructed",
        "- 30-day window — short by backtest standards; sample size per cell is small",
        "- `tier50_holdeod` and `hard_30m` columns may have lower fill rates than "
        "`flow_inversion` and `eod`; interpret low-n cells cautiously",
        "- Sharpe is trade-level (mean/std per fire), not time-series Sharpe; "
        "not directly comparable to annualised metrics",
        "- Data as of 2026-05-22",
    ]

    report = "\n".join(lines) + "\n"
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(f"\nReport written to: {REPORT_PATH}")

    # Print headline recommendations to stdout
    print("\n=== HEADLINE RECOMMENDATIONS ===")
    if t1_best:
        print(
            f"TIER 1: {t1_best['exit_policy']} | stop {t1_best['stop']} | "
            f"TP {t1_best['tp']} | mean {t1_best['mean']:.2f}% | "
            f"win {t1_best['win_pct']:.1f}% | sharpe {t1_best['sharpe']:.3f} | "
            f"n={t1_best['n']}"
        )
    if t2_best:
        print(
            f"TIER 2: {t2_best['exit_policy']} | stop {t2_best['stop']} | "
            f"TP {t2_best['tp']} | mean {t2_best['mean']:.2f}% | "
            f"win {t2_best['win_pct']:.1f}% | sharpe {t2_best['sharpe']:.3f} | "
            f"n={t2_best['n']}"
        )


if __name__ == "__main__":
    main()
