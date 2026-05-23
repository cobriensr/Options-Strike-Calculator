#!/usr/bin/env python
"""V2.2 Phase F — 0DTE-failure → 1DTE-recovery pattern analysis.

For each 0DTE fire that realised a loss (outcome <= -30%), look for a
subsequent DTE=1 fire on the same ticker + option_type with a strike
within ±2% that triggered AFTER the failure (same or next trading day,
within ~30 hours clock time).  Compare those recovery-fire outcomes
against the all-DTE=1 baseline to measure lift.

Decision rule (from spec):
  - Lift > +15pp on mean_pct OR > +5pp on win_rate → SHIP
  - Lift 0 to threshold → MARGINAL
  - Lift <= 0 → DROP

Writes:
  docs/tmp/v22-phase-f-1dte-recovery-2026-05-22.md

Usage:
    ml/.venv/bin/python scripts/phase_f_1dte_recovery_analysis.py
"""

from __future__ import annotations

import os
import re
import sys
from datetime import date
from pathlib import Path

import pandas as pd
import psycopg2

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env.local"
REPORT_DIR = ROOT / "docs" / "tmp"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

FAILURE_THRESHOLD = -30.0        # outcome_pct <= this = 0DTE failure
RECOVERY_WINDOW_HOURS = 30       # clock-hours after failure to search
STRIKE_BAND_PCT = 0.02           # ±2% of failure strike
WIN_THRESHOLD = 0.0              # outcome_pct > 0 = win for recovery analysis
HIT_50_THRESHOLD = 50.0          # outcome_pct >= 50 = hit-50

# lift thresholds from spec
LIFT_SHIP_MEAN = 15.0            # pp lift on mean_pct
LIFT_SHIP_WIN = 5.0              # pp lift on win_rate

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
# Fetch
# ---------------------------------------------------------------------------

FETCH_QUERY = """
SELECT
    id,
    underlying_symbol,
    option_type,
    strike,
    dte,
    date,
    trigger_time_ct,
    score,
    realized_flow_inversion_pct,
    realized_eod_pct,
    peak_ceiling_pct,
    cum_ncp_at_fire,
    cum_npp_at_fire
FROM lottery_finder_fires
WHERE
    date >= CURRENT_DATE - INTERVAL '90 days'
    AND cum_ncp_at_fire IS NOT NULL
    AND cum_npp_at_fire IS NOT NULL
    AND (
        (option_type = 'C' AND cum_ncp_at_fire > cum_npp_at_fire)
        OR (option_type = 'P' AND cum_npp_at_fire > cum_ncp_at_fire)
    )
    AND inferred_structure IS NULL
    AND COALESCE(realized_flow_inversion_pct, realized_eod_pct) IS NOT NULL
    AND strike IS NOT NULL
    AND trigger_time_ct IS NOT NULL
ORDER BY trigger_time_ct
"""


def fetch_fires() -> pd.DataFrame:
    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set — run load_env() first")

    print("Connecting to database...")
    conn = psycopg2.connect(db_url, sslmode="require", connect_timeout=15)
    print("Fetching fires (90-day aligned non-structure)...")
    df = pd.read_sql_query(FETCH_QUERY, conn)
    conn.close()
    print(f"Fetched {len(df):,} rows before enrichment-bug filter")

    # Outcome column: prefer flow_inversion, fall back to eod
    df["outcome_pct"] = df["realized_flow_inversion_pct"].combine_first(
        df["realized_eod_pct"]
    )

    # Drop enrichment-bug rows (flow_inv > peak * 1.05)
    pre = len(df)
    mask_bug = (
        df["realized_flow_inversion_pct"].notna()
        & df["peak_ceiling_pct"].notna()
        & (df["realized_flow_inversion_pct"] > df["peak_ceiling_pct"] * 1.05)
    )
    df = df[~mask_bug].copy()
    dropped = pre - len(df)
    if dropped:
        print(f"Dropped {dropped:,} enrichment-bug rows (flow_inv > peak*1.05)")

    # Ensure trigger_time_ct is timezone-aware (UTC) for comparison arithmetic
    df["trigger_time_ct"] = pd.to_datetime(df["trigger_time_ct"], utc=True)
    df["strike"] = df["strike"].astype(float)

    print(f"Final sample: {len(df):,} fires")
    return df


# ---------------------------------------------------------------------------
# Recovery matching
# ---------------------------------------------------------------------------


def find_recovery_pairs(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Returns (failures_df, recovery_fires_df).

    recovery_fires_df has one row per (failure, matched-recovery-fire).
    Failures without any match are still counted in failures_df.
    """
    # Split by DTE
    failures = df[
        (df["dte"] == 0) & (df["outcome_pct"] <= FAILURE_THRESHOLD)
    ].copy()
    candidates_1dte = df[df["dte"] == 1].copy()

    print(f"\nFailure cohort (DTE=0, outcome<={FAILURE_THRESHOLD}%): {len(failures):,}")
    print(f"DTE=1 candidate pool: {len(candidates_1dte):,}")

    if failures.empty or candidates_1dte.empty:
        return failures, pd.DataFrame()

    # Build numpy arrays for vectorised matching
    fail_symbol = failures["underlying_symbol"].values
    fail_otype = failures["option_type"].values
    fail_strike = failures["strike"].values
    fail_time = failures["trigger_time_ct"].values  # numpy datetime64[ns, UTC]

    cand_symbol = candidates_1dte["underlying_symbol"].values
    cand_otype = candidates_1dte["option_type"].values
    cand_strike = candidates_1dte["strike"].values
    cand_time = candidates_1dte["trigger_time_ct"].values

    window_ns = RECOVERY_WINDOW_HOURS * 3_600 * 1_000_000_000  # hours → ns

    recovery_rows: list[dict] = []
    matched_failure_ids: set[int] = set()

    for i, fid in enumerate(failures["id"].values):
        f_sym = fail_symbol[i]
        f_otype = fail_otype[i]
        f_strike = fail_strike[i]
        f_time = fail_time[i]

        strike_lo = f_strike * (1 - STRIKE_BAND_PCT)
        strike_hi = f_strike * (1 + STRIKE_BAND_PCT)
        time_hi = f_time + window_ns

        mask = (
            (cand_symbol == f_sym)
            & (cand_otype == f_otype)
            & (cand_strike >= strike_lo)
            & (cand_strike <= strike_hi)
            & (cand_time > f_time)
            & (cand_time <= time_hi)
        )

        matched = candidates_1dte[mask]
        if not matched.empty:
            matched_failure_ids.add(fid)
            for _, row in matched.iterrows():
                recovery_rows.append(
                    {
                        "failure_id": fid,
                        "recovery_id": row["id"],
                        "underlying_symbol": row["underlying_symbol"],
                        "option_type": row["option_type"],
                        "recovery_strike": row["strike"],
                        "recovery_trigger_time_ct": row["trigger_time_ct"],
                        "recovery_outcome_pct": row["outcome_pct"],
                    }
                )

    failures["has_recovery"] = failures["id"].isin(matched_failure_ids)
    recovery_df = pd.DataFrame(recovery_rows)
    return failures, recovery_df


# ---------------------------------------------------------------------------
# Metrics helpers
# ---------------------------------------------------------------------------


def compute_metrics(outcomes: pd.Series) -> dict:
    """Compute n, mean_pct, win_rate, hit_50_pct for a Series of outcomes."""
    n = len(outcomes)
    if n == 0:
        return {"n": 0, "mean_pct": float("nan"), "win_rate": float("nan"), "hit_50_pct": float("nan")}
    mean_pct = float(outcomes.mean())
    win_rate = float((outcomes > WIN_THRESHOLD).mean()) * 100
    hit_50_pct = float((outcomes >= HIT_50_THRESHOLD).mean()) * 100
    return {"n": n, "mean_pct": mean_pct, "win_rate": win_rate, "hit_50_pct": hit_50_pct}


def lift_str(recovery_val: float, baseline_val: float) -> str:
    if any(v != v for v in (recovery_val, baseline_val)):  # NaN check
        return "n/a"
    delta = recovery_val - baseline_val
    sign = "+" if delta >= 0 else ""
    return f"{sign}{delta:.1f}pp"


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------


def render_report(
    today: date,
    n_total_fires: int,
    n_failures: int,
    n_with_recovery: int,
    recovery_metrics: dict,
    baseline_metrics: dict,
    sensitivity: dict | None = None,
) -> str:
    date_str = today.strftime("%Y-%m-%d")
    coverage_pct = 100 * n_with_recovery / n_failures if n_failures else 0.0

    lift_mean = recovery_metrics["mean_pct"] - baseline_metrics["mean_pct"]
    lift_win = recovery_metrics["win_rate"] - baseline_metrics["win_rate"]
    lift_hit50 = recovery_metrics["hit_50_pct"] - baseline_metrics["hit_50_pct"]

    # Decision
    if lift_mean > LIFT_SHIP_MEAN or lift_win > LIFT_SHIP_WIN:
        decision = "SHIP"
        decision_detail = (
            "Recovery lift clears at least one threshold. "
            "Implement '💊 Recovery' badge on any DTE=1 fire that matches a "
            "recent (within 6h) 0DTE failure on the same ticker + option_type + near-strike."
        )
    elif lift_mean > 0 or lift_win > 0:
        decision = "MARGINAL"
        decision_detail = (
            "Positive lift but below both thresholds. Defer implementation. "
            "Consider revisiting at 180 days or broadening the strike band."
        )
    else:
        decision = "DROP"
        decision_detail = (
            "No lift detected. The 0DTE failure does not predict better 1DTE "
            "outcomes on the same ticker/type/strike. The user's observation is "
            "likely selection bias. Do not implement recovery signal."
        )

    def fmt(v: float, decimals: int = 1) -> str:
        return f"{v:.{decimals}f}" if v == v else "n/a"

    lines = [
        f"# V2.2 Phase F — 0DTE-Failure → 1DTE-Recovery Pattern Analysis",
        "",
        f"Run date: {date_str}",
        "",
        "## Method",
        "",
        "- 90-day aligned non-structure window (same gate as all Phase A/B/C scripts)",
        f"- Failure: DTE=0, outcome <= {FAILURE_THRESHOLD}%",
        f"- Recovery candidate: same ticker + option_type, strike ±{STRIKE_BAND_PCT*100:.0f}%, "
        f"DTE=1, trigger_time_ct within {RECOVERY_WINDOW_HOURS}h after failure",
        "- Outcome: COALESCE(realized_flow_inversion_pct, realized_eod_pct)",
        "- Enrichment-bug rows (flow_inv > peak*1.05) excluded",
        "",
        "## Failure cohort",
        "",
        f"- Total 90-day aligned fires: {n_total_fires:,}",
        f"- 0DTE failures (outcome <= {FAILURE_THRESHOLD}%): {n_failures:,}",
        f"- Failures with a recovery 1DTE fire in window: {n_with_recovery:,} ({coverage_pct:.1f}%)",
        "",
        "## Recovery fire outcomes vs DTE=1 baseline",
        "",
        "| metric | recovery fires | all DTE=1 baseline | lift |",
        "| --- | --- | --- | --- |",
        f"| n | {recovery_metrics['n']} | {baseline_metrics['n']} | — |",
        f"| mean_pct | {fmt(recovery_metrics['mean_pct'])}% | {fmt(baseline_metrics['mean_pct'])}% "
        f"| {lift_str(recovery_metrics['mean_pct'], baseline_metrics['mean_pct'])} |",
        f"| win_rate (>0%) | {fmt(recovery_metrics['win_rate'])}% | {fmt(baseline_metrics['win_rate'])}% "
        f"| {lift_str(recovery_metrics['win_rate'], baseline_metrics['win_rate'])} |",
        f"| hit_50_pct (>=50%) | {fmt(recovery_metrics['hit_50_pct'])}% | {fmt(baseline_metrics['hit_50_pct'])}% "
        f"| {lift_str(recovery_metrics['hit_50_pct'], baseline_metrics['hit_50_pct'])} |",
        "",
        "## Decision",
        "",
        f"**{decision}** — {decision_detail}",
        "",
    ]

    if sensitivity:
        lines += [
            "## Sensitivity check (strike band ±5%)",
            "",
            "| metric | recovery fires (±5%) | all DTE=1 baseline | lift |",
            "| --- | --- | --- | --- |",
            f"| n | {sensitivity['n']} | {baseline_metrics['n']} | — |",
            f"| mean_pct | {fmt(sensitivity['mean_pct'])}% | {fmt(baseline_metrics['mean_pct'])}% "
            f"| {lift_str(sensitivity['mean_pct'], baseline_metrics['mean_pct'])} |",
            f"| win_rate (>0%) | {fmt(sensitivity['win_rate'])}% | {fmt(baseline_metrics['win_rate'])}% "
            f"| {lift_str(sensitivity['win_rate'], baseline_metrics['win_rate'])} |",
            f"| hit_50_pct (>=50%) | {fmt(sensitivity['hit_50_pct'])}% | {fmt(baseline_metrics['hit_50_pct'])}% "
            f"| {lift_str(sensitivity['hit_50_pct'], baseline_metrics['hit_50_pct'])} |",
            "",
        ]

    lines += [
        "## Caveats",
        "",
        "- 90-day window only; wider window may change conclusion",
        f"- Strike-proximity threshold (±{STRIKE_BAND_PCT*100:.0f}%) is somewhat arbitrary "
        "— sensitivity check with ±5% included above if MARGINAL",
        "- 'Recovery' does not imply causation; the baseline check controls for "
        "'DTE=1 is just generally better'",
        "- Recovery window (30h) spans same-session fires AND next-day opens; "
        "no distinction made between intra-day vs next-day recoveries in this version",
        "",
    ]

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    load_env()
    df = fetch_fires()

    if df.empty:
        sys.exit("No fires found — nothing to analyze")

    # Baseline: all DTE=1 fires in the 90-day window
    dte1_all = df[df["dte"] == 1]
    baseline_metrics = compute_metrics(dte1_all["outcome_pct"])
    print(f"\nDTE=1 baseline: n={baseline_metrics['n']:,}  "
          f"mean={baseline_metrics['mean_pct']:.1f}%  "
          f"win={baseline_metrics['win_rate']:.1f}%  "
          f"hit50={baseline_metrics['hit_50_pct']:.1f}%")

    # Find failure → recovery pairs
    failures, recovery_df = find_recovery_pairs(df)
    n_failures = len(failures)
    n_with_recovery = int(failures["has_recovery"].sum()) if not failures.empty else 0

    print(f"\nFailures matched to a recovery fire: {n_with_recovery:,} / {n_failures:,}")

    if recovery_df.empty:
        print("No recovery fires found. Decision: DROP.")
        recovery_metrics = {"n": 0, "mean_pct": float("nan"),
                            "win_rate": float("nan"), "hit_50_pct": float("nan")}
        sensitivity = None
    else:
        recovery_outcomes = recovery_df["recovery_outcome_pct"]
        recovery_metrics = compute_metrics(recovery_outcomes)
        print(f"Recovery fire outcomes: n={recovery_metrics['n']:,}  "
              f"mean={recovery_metrics['mean_pct']:.1f}%  "
              f"win={recovery_metrics['win_rate']:.1f}%  "
              f"hit50={recovery_metrics['hit_50_pct']:.1f}%")

        lift_mean = recovery_metrics["mean_pct"] - baseline_metrics["mean_pct"]
        lift_win = recovery_metrics["win_rate"] - baseline_metrics["win_rate"]
        print(f"\nLift: mean_pct={lift_mean:+.1f}pp  win_rate={lift_win:+.1f}pp")

        # Sensitivity check at ±5% strike band (run only if result is MARGINAL)
        decision_is_marginal = not (
            lift_mean > LIFT_SHIP_MEAN or lift_win > LIFT_SHIP_WIN
        ) and (lift_mean > 0 or lift_win > 0)
        decision_is_drop = lift_mean <= 0 and lift_win <= 0

        sensitivity = None
        if decision_is_marginal or decision_is_drop:
            print("\nRunning sensitivity check at ±5% strike band...")
            _, recovery_df_5 = find_recovery_pairs_band(df, band=0.05)
            if not recovery_df_5.empty:
                sensitivity = compute_metrics(recovery_df_5["recovery_outcome_pct"])
                print(f"Sensitivity (±5%): n={sensitivity['n']:,}  "
                      f"mean={sensitivity['mean_pct']:.1f}%  "
                      f"win={sensitivity['win_rate']:.1f}%")

    today = date.today()
    report_md = render_report(
        today=today,
        n_total_fires=len(df),
        n_failures=n_failures,
        n_with_recovery=n_with_recovery,
        recovery_metrics=recovery_metrics,
        baseline_metrics=baseline_metrics,
        sensitivity=sensitivity,
    )

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORT_DIR / f"v22-phase-f-1dte-recovery-{today.strftime('%Y-%m-%d')}.md"
    report_path.write_text(report_md, encoding="utf-8")
    print(f"\nWrote report: {report_path}")


# ---------------------------------------------------------------------------
# Parametric version of find_recovery_pairs for sensitivity testing
# ---------------------------------------------------------------------------


def find_recovery_pairs_band(df: pd.DataFrame, band: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Same as find_recovery_pairs but with a configurable strike band."""
    failures = df[
        (df["dte"] == 0) & (df["outcome_pct"] <= FAILURE_THRESHOLD)
    ].copy()
    candidates_1dte = df[df["dte"] == 1].copy()

    if failures.empty or candidates_1dte.empty:
        return failures, pd.DataFrame()

    fail_symbol = failures["underlying_symbol"].values
    fail_otype = failures["option_type"].values
    fail_strike = failures["strike"].values
    fail_time = failures["trigger_time_ct"].values

    cand_symbol = candidates_1dte["underlying_symbol"].values
    cand_otype = candidates_1dte["option_type"].values
    cand_strike = candidates_1dte["strike"].values
    cand_time = candidates_1dte["trigger_time_ct"].values

    window_ns = RECOVERY_WINDOW_HOURS * 3_600 * 1_000_000_000

    recovery_rows: list[dict] = []
    matched_failure_ids: set[int] = set()

    for i, fid in enumerate(failures["id"].values):
        f_sym = fail_symbol[i]
        f_otype = fail_otype[i]
        f_strike = fail_strike[i]
        f_time = fail_time[i]

        strike_lo = f_strike * (1 - band)
        strike_hi = f_strike * (1 + band)
        time_hi = f_time + window_ns

        mask = (
            (cand_symbol == f_sym)
            & (cand_otype == f_otype)
            & (cand_strike >= strike_lo)
            & (cand_strike <= strike_hi)
            & (cand_time > f_time)
            & (cand_time <= time_hi)
        )

        matched = candidates_1dte[mask]
        if not matched.empty:
            matched_failure_ids.add(fid)
            for _, row in matched.iterrows():
                recovery_rows.append(
                    {
                        "failure_id": fid,
                        "recovery_id": row["id"],
                        "underlying_symbol": row["underlying_symbol"],
                        "option_type": row["option_type"],
                        "recovery_strike": row["strike"],
                        "recovery_trigger_time_ct": row["trigger_time_ct"],
                        "recovery_outcome_pct": row["outcome_pct"],
                    }
                )

    failures["has_recovery"] = failures["id"].isin(matched_failure_ids)
    return failures, pd.DataFrame(recovery_rows)


if __name__ == "__main__":
    main()
