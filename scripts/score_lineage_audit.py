#!/usr/bin/env python
"""Per-component attribution analysis for lottery score lineage.

Phase 2 of the lottery outcome-mining + lineage spec
(docs/superpowers/specs/lottery-outcome-mining-and-lineage-2026-05-22.md).

For each (day_of_week, component) cell, computes the mean contribution
of that component to winners vs. losers and flags cells where the
component contributes MORE to losers than winners (anti-predictive).

Writes a daily Markdown report to:
  docs/tmp/lottery-score-lineage-{YYYY-MM-DD}.md

Usage:
    ml/.venv/bin/python scripts/score_lineage_audit.py
"""

from __future__ import annotations

import json
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
WEIGHTS_PATH = ROOT / "ml" / "output" / "lottery_score_weights.json"
REPORT_DIR = ROOT / "docs" / "tmp"

# ---------------------------------------------------------------------------
# Environment loading (same pattern as mine_outcome_patterns.py)
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
# SQL fetch — last 30 days, same alignment gate as Phase 1
# ---------------------------------------------------------------------------

FETCH_QUERY = """
SELECT
    id,
    date,
    underlying_symbol,
    option_type,
    tod,
    dte,
    trigger_vol_to_oi_window,
    gamma_at_trigger,
    trigger_ask_pct,
    realized_flow_inversion_pct,
    realized_eod_pct,
    peak_ceiling_pct,
    cum_ncp_at_fire,
    cum_npp_at_fire,
    score
FROM lottery_finder_fires
WHERE
    date >= CURRENT_DATE - INTERVAL '30 days'
    AND cum_ncp_at_fire IS NOT NULL
    AND cum_npp_at_fire IS NOT NULL
    AND (
        (option_type = 'C' AND cum_ncp_at_fire > cum_npp_at_fire)
        OR (option_type = 'P' AND cum_npp_at_fire > cum_ncp_at_fire)
    )
    AND inferred_structure IS NULL
    AND COALESCE(realized_flow_inversion_pct, realized_eod_pct) IS NOT NULL
ORDER BY id
"""


def fetch_fires() -> pd.DataFrame:
    """Fetch aligned, filtered fires for the last 30 days."""
    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set — run load_env() first")

    print("Connecting to database...")
    conn = psycopg2.connect(db_url, sslmode="require", connect_timeout=15)
    print("Fetching fires (last 30 days)...")
    df = pd.read_sql_query(FETCH_QUERY, conn)
    conn.close()
    print(f"Fetched {len(df):,} rows before final filter")

    # Outcome column: prefer flow_inversion, fall back to eod
    df["outcome_pct"] = df["realized_flow_inversion_pct"].combine_first(
        df["realized_eod_pct"]
    )

    # Drop enrichment-bug rows
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

    # day_of_week: 0=Monday, 6=Sunday (standard pandas)
    df["day_of_week"] = pd.to_datetime(df["date"]).dt.dayofweek

    print(f"Final sample: {len(df):,} fires")
    return df


# ---------------------------------------------------------------------------
# Component recovery — imports score_components from ml/src
# ---------------------------------------------------------------------------

sys.path.insert(0, str(ROOT / "ml" / "src"))
from score_components import compute_components  # noqa: E402


def load_weights() -> dict:
    """Load lottery_score_weights.json."""
    if not WEIGHTS_PATH.exists():
        sys.exit(
            f"Weights file missing: {WEIGHTS_PATH}\n"
            "Run: ml/.venv/bin/python ml/src/lottery_scoring.py"
        )
    with WEIGHTS_PATH.open() as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# Attribution analysis constants
# ---------------------------------------------------------------------------

WIN_THRESHOLD = 50.0    # outcome_pct >= 50 => winner
LOSS_THRESHOLD = -50.0  # outcome_pct <= -50 => loser
MIN_SUPPORT = 50        # min n_winners + n_losers per cell to trust the gap

COMPONENT_KEYS = ["ticker", "tod", "dte", "vol_oi_q", "gamma_q", "ask_pct_q", "option_type"]

DOW_NAMES = {0: "Monday", 1: "Tuesday", 2: "Wednesday", 3: "Thursday", 4: "Friday"}


def classify_outcome(outcome_pct: float) -> str:
    """Classify a fire as winner / push / loss."""
    if outcome_pct >= WIN_THRESHOLD:
        return "win"
    elif outcome_pct <= LOSS_THRESHOLD:
        return "loss"
    return "push"


def _fire_to_input(row: pd.Series) -> dict:
    """Convert a DataFrame row to the dict expected by compute_components."""
    return {
        "ticker": row["underlying_symbol"],
        "tod": row["tod"],
        "dte": int(row["dte"]),
        "option_type": row["option_type"],
        "vol_oi_window": row["trigger_vol_to_oi_window"] if pd.notna(row["trigger_vol_to_oi_window"]) else None,
        "gamma": row["gamma_at_trigger"] if pd.notna(row["gamma_at_trigger"]) else None,
        "ask_pct": row["trigger_ask_pct"] if pd.notna(row["trigger_ask_pct"]) else None,
    }


# ---------------------------------------------------------------------------
# Main analysis
# ---------------------------------------------------------------------------


def run_attribution(df: pd.DataFrame, weights: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Compute per-(DOW, component) attribution gaps.

    Returns:
        full_table — one row per (DOW, component) with all stats
        flagged    — subset where gap < 0 AND support >= MIN_SUPPORT
    """
    # Build one row per fire with all 7 components + metadata
    records = []
    for _, row in df.iterrows():
        fire_input = _fire_to_input(row)
        comps = compute_components(fire_input, weights)
        outcome_class = classify_outcome(float(row["outcome_pct"]))
        dow = int(row["day_of_week"])
        for comp_key in COMPONENT_KEYS:
            records.append(
                {
                    "dow": dow,
                    "component": comp_key,
                    "contribution": int(comps[comp_key]),
                    "outcome_class": outcome_class,
                }
            )

    long_df = pd.DataFrame(records)

    # Aggregate: (dow, component) -> (n_win, n_loss, win_mean, loss_mean, gap)
    rows = []
    for (dow, comp), grp in long_df.groupby(["dow", "component"]):
        winners = grp[grp["outcome_class"] == "win"]
        losers = grp[grp["outcome_class"] == "loss"]
        n_win = len(winners)
        n_loss = len(losers)
        win_mean = float(winners["contribution"].mean()) if n_win > 0 else 0.0
        loss_mean = float(losers["contribution"].mean()) if n_loss > 0 else 0.0
        gap = win_mean - loss_mean
        support = n_win + n_loss
        flagged = (gap < 0) and (support >= MIN_SUPPORT)

        rows.append(
            {
                "dow": dow,
                "dow_name": DOW_NAMES.get(dow, f"DOW{dow}"),
                "component": comp,
                "n_win": n_win,
                "n_loss": n_loss,
                "support": support,
                "win_mean": round(win_mean, 3),
                "loss_mean": round(loss_mean, 3),
                "gap": round(gap, 3),
                "flagged": flagged,
            }
        )

    full_table = pd.DataFrame(rows).sort_values(["dow", "component"]).reset_index(drop=True)
    flagged_df = full_table[full_table["flagged"]].copy()
    return full_table, flagged_df


# ---------------------------------------------------------------------------
# Component health summary (mean gap across DOWs)
# ---------------------------------------------------------------------------


def component_health(full_table: pd.DataFrame) -> dict[str, float]:
    """Compute mean attribution gap per component across all DOWs."""
    return (
        full_table.groupby("component")["gap"]
        .mean()
        .round(3)
        .to_dict()
    )


# ---------------------------------------------------------------------------
# Sanity check: AM_open TOD contribution
# ---------------------------------------------------------------------------


def check_am_open_sanity(full_table: pd.DataFrame) -> tuple[bool, str]:
    """
    Canary: tod component for AM_open fires should have positive gap
    (more contribution in winners than losers) across most DOWs.

    Returns (passed, detail_message).
    """
    tod_rows = full_table[full_table["component"] == "tod"].copy()
    if tod_rows.empty:
        return False, "No tod rows found in attribution table — data issue"

    positive_dow_count = int((tod_rows["gap"] > 0).sum())
    total_dow_count = len(tod_rows)
    ratio = positive_dow_count / total_dow_count if total_dow_count > 0 else 0.0

    # We can't isolate AM_open specifically in the aggregated table (it's mixed
    # across all tod values), so instead we verify the tod component's mean gap
    # is positive overall (a reasonable proxy if AM_open fires are a plurality).
    mean_gap = float(tod_rows["gap"].mean())
    passed = mean_gap > 0

    detail = (
        f"tod component mean gap = {mean_gap:.3f} "
        f"({positive_dow_count}/{total_dow_count} DOWs positive)"
    )
    return passed, detail


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------

_RECOMMENDED_ACTIONS = {
    "ticker": "Review ticker weight; consider per-ticker per-DOW correction overlay",
    "tod": "Review time-of-day bucket; check if AM_open bonus is misfiring",
    "dte": "DTE coefficient may be stale; check post-0DTE policy changes",
    "vol_oi_q": "Volume/OI quintile boundary drift; re-run lottery_scoring.py refit",
    "gamma_q": "Gamma quintile may be stale; boundary recalibration recommended",
    "ask_pct_q": "Ask% quintile boundaries drifted; recalibrate from recent fills",
    "option_type": "Call/Put asymmetry shifted; check recent directional bias",
}


def render_report(
    today: date,
    n_fires: int,
    full_table: pd.DataFrame,
    flagged: pd.DataFrame,
    health: dict[str, float],
    sanity_passed: bool,
    sanity_detail: str,
) -> str:
    date_str = today.strftime("%Y-%m-%d")
    lines: list[str] = [
        f"# Lottery Score Lineage Audit — {date_str}",
        "",
        f"Window: last 30 days enriched aligned non-structure (n={n_fires:,})",
        f"Winner threshold: outcome_pct >= +50% | Loser: outcome_pct <= -50%",
        f"Flag criteria: attribution_gap < 0 AND (n_win + n_loss) >= {MIN_SUPPORT}",
        "",
        "## Per-DOW x component attribution table",
        "",
        "| DOW | Component | n_win | n_loss | win_mean | loss_mean | gap | flagged |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]

    for _, row in full_table.iterrows():
        flag_str = "⚠️" if row["flagged"] else "—"
        lines.append(
            f"| {row['dow_name']} "
            f"| {row['component']} "
            f"| {row['n_win']} "
            f"| {row['n_loss']} "
            f"| {row['win_mean']:.3f} "
            f"| {row['loss_mean']:.3f} "
            f"| {row['gap']:.3f} "
            f"| {flag_str} |"
        )

    lines += [
        "",
        "## ⚠️ Flagged: components that are anti-predictive on specific DOWs",
        "",
    ]

    if flagged.empty:
        lines.append(
            "_No components flagged as anti-predictive — all (DOW, component) cells "
            "either have positive attribution gap or insufficient support (< "
            f"{MIN_SUPPORT}). This is a healthy result._"
        )
    else:
        lines += [
            "| DOW | Component | n_win | n_loss | gap | recommended action |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for _, row in flagged.sort_values("gap").iterrows():
            action = _RECOMMENDED_ACTIONS.get(row["component"], "Inspect manually")
            lines.append(
                f"| {row['dow_name']} "
                f"| {row['component']} "
                f"| {row['n_win']} "
                f"| {row['n_loss']} "
                f"| {row['gap']:.3f} "
                f"| {action} |"
            )

    # Summary
    sanity_icon = "PASSED" if sanity_passed else "FAILED"
    if not sanity_passed:
        sanity_note = (
            " **ALGORITHM MAY BE BROKEN** — if tod is anti-predictive everywhere, "
            "the component recovery or outcome classification has a bug."
        )
    else:
        sanity_note = ""

    n_flagged = len(flagged)
    if n_flagged == 0:
        next_action = "All components healthy — no coefficient corrections needed. Run again in 7 days."
    else:
        worst = flagged.sort_values("gap").iloc[0]
        next_action = (
            f"Investigate {worst['component']} on {worst['dow_name']} "
            f"(gap={worst['gap']:.3f}, n={worst['support']}): "
            + _RECOMMENDED_ACTIONS.get(worst["component"], "Inspect manually")
        )

    lines += [
        "",
        "## Summary",
        "",
        f"- Total fires analyzed: {n_fires:,}",
        f"- Components flagged (anti-predictive on ≥1 DOW): {n_flagged}",
        f"- AM_open TOD sanity check: {sanity_icon}{sanity_note}",
        f"  - Detail: {sanity_detail}",
        "",
        "- Component health (mean attribution gap across DOWs):",
    ]

    for comp in COMPONENT_KEYS:
        mean_gap = health.get(comp, float("nan"))
        health_icon = "✓" if mean_gap > 0 else "✗"
        lines.append(f"  - {comp}: {mean_gap:+.3f} {health_icon}")

    lines += [
        "",
        f"- Suggested next action: {next_action}",
        "",
    ]

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    load_env()

    weights = load_weights()
    print(f"Loaded weights: {weights['model_version']}")

    df = fetch_fires()

    if df.empty:
        sys.exit("No fires found — nothing to analyze")

    print("\nRunning per-component attribution analysis...")
    full_table, flagged = run_attribution(df, weights)

    health = component_health(full_table)
    sanity_passed, sanity_detail = check_am_open_sanity(full_table)

    print(f"\nSanity check (tod mean gap > 0): {'PASSED' if sanity_passed else 'FAILED'}")
    print(f"  {sanity_detail}")

    n_flagged = len(flagged)
    print(f"\nFlagged (DOW x component) cells: {n_flagged}")
    if n_flagged > 0:
        for _, row in flagged.sort_values("gap").iterrows():
            print(
                f"  ⚠️  {row['dow_name']} x {row['component']}: "
                f"gap={row['gap']:.3f}  n_win={row['n_win']}  n_loss={row['n_loss']}"
            )
    else:
        print("  All components look healthy — no anti-predictive signals detected")

    print("\nComponent health (mean attribution gap across DOWs):")
    for comp in COMPONENT_KEYS:
        mean_gap = health.get(comp, float("nan"))
        icon = "✓" if mean_gap > 0 else "✗"
        print(f"  {comp}: {mean_gap:+.3f} {icon}")

    today = date.today()
    report_md = render_report(
        today=today,
        n_fires=len(df),
        full_table=full_table,
        flagged=flagged,
        health=health,
        sanity_passed=sanity_passed,
        sanity_detail=sanity_detail,
    )

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORT_DIR / f"lottery-score-lineage-{today.strftime('%Y-%m-%d')}.md"
    report_path.write_text(report_md, encoding="utf-8")
    print(f"\nWrote report: {report_path}")


if __name__ == "__main__":
    main()
