#!/usr/bin/env python
"""Outcome-conditioned combinatorial feature mining for lottery fires.

Phase 1 of the lottery outcome-mining + lineage spec
(docs/superpowers/specs/lottery-outcome-mining-and-lineage-2026-05-22.md).

Queries last 90-day aligned non-structure fires, computes a 7-element
feature tuple per fire, then scans all 2- and 3-feature sub-tuples for
combinations that lift winners (outcome_pct >= 50) or losers
(outcome_pct <= -50) beyond the marginal threshold.

Writes a daily Markdown report to:
  docs/tmp/lottery-composite-candidates-{YYYY-MM-DD}.md

Usage:
    ml/.venv/bin/python scripts/mine_outcome_patterns.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime, timezone
from itertools import combinations
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
# Environment loading (mirrors scripts/backfill_lottery_scores.py pattern)
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
# SQL fetch (mirrors FETCH_QUERY in ml/src/lottery_scoring.py)
# ---------------------------------------------------------------------------

FETCH_QUERY = """
SELECT
    id,
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
ORDER BY id
"""


def fetch_fires() -> pd.DataFrame:
    """Fetch aligned, filtered fires and return with outcome_pct column."""
    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set — run load_env() first")

    print("Connecting to database...")
    conn = psycopg2.connect(db_url, sslmode="require", connect_timeout=15)
    print("Fetching fires...")
    df = pd.read_sql_query(FETCH_QUERY, conn)
    conn.close()
    print(f"Fetched {len(df):,} rows before final filter")

    # Outcome column: prefer flow_inversion, fall back to eod
    df["outcome_pct"] = df["realized_flow_inversion_pct"].combine_first(
        df["realized_eod_pct"]
    )

    # Drop 0.5%-enrichment-bug rows
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

    print(f"Final sample: {len(df):,} fires")
    return df


# ---------------------------------------------------------------------------
# Feature tuple construction
# ---------------------------------------------------------------------------

# Import assign_quintile from score_components.  The script lives in
# scripts/, so we add ml/src/ to path explicitly (mirrors lottery_scoring.py).
sys.path.insert(0, str(ROOT / "ml" / "src"))
from score_components import assign_quintile  # noqa: E402


def load_weights() -> dict:
    """Load lottery_score_weights.json."""
    if not WEIGHTS_PATH.exists():
        sys.exit(f"Weights file missing: {WEIGHTS_PATH}\n"
                 "Run: ml/.venv/bin/python ml/src/lottery_scoring.py")
    with WEIGHTS_PATH.open() as fh:
        return json.load(fh)


def build_feature_tuples(df: pd.DataFrame, weights: dict) -> pd.DataFrame:
    """
    Add one categorical column per feature dimension to df.

    Quintile features map continuous values to int labels 0-4 using
    assign_quintile() from score_components. NULL continuous values are
    encoded as the string "null" (not dropped).

    Returned df has columns: ticker, tod, dte, vol_oi_q, gamma_q,
    ask_pct_q, option_type — all as strings (uniform categorical type).
    """
    f = weights["features"]

    # Categorical features: keep as-is (DTE capped at 3 to match model)
    out = pd.DataFrame(index=df.index)
    out["ticker"] = df["underlying_symbol"].astype(str)
    out["tod"] = df["tod"].astype(str)
    out["dte"] = df["dte"].clip(upper=3).astype(int).astype(str)
    out["option_type"] = df["option_type"].astype(str)

    # Quintile features: int label or "null"
    vol_bounds = f["vol_oi_quintile_boundaries"]
    gamma_bounds = f["gamma_quintile_boundaries"]
    ask_pct_bounds = f["ask_pct_quintile_boundaries"]

    def _quintile_str(val) -> str:
        q = assign_quintile(val if pd.notna(val) else None, vol_bounds)
        return "null" if q is None else str(q)

    out["vol_oi_q"] = df["trigger_vol_to_oi_window"].apply(
        lambda v: _quintile_str_with(v, vol_bounds)
    )
    out["gamma_q"] = df["gamma_at_trigger"].apply(
        lambda v: _quintile_str_with(v, gamma_bounds)
    )
    out["ask_pct_q"] = df["trigger_ask_pct"].apply(
        lambda v: _quintile_str_with(v, ask_pct_bounds)
    )

    # Outcome
    out["outcome_pct"] = df["outcome_pct"].values
    return out


def _quintile_str_with(val, bounds: list[float]) -> str:
    """Map a single value to a quintile string label, or 'null'."""
    q = assign_quintile(val if pd.notna(val) else None, bounds)
    return "null" if q is None else str(q)


# ---------------------------------------------------------------------------
# Mining algorithm
# ---------------------------------------------------------------------------

FEATURE_KEYS = ["ticker", "tod", "dte", "vol_oi_q", "gamma_q", "ask_pct_q", "option_type"]
WIN_THRESHOLD = 50.0   # outcome_pct >= 50 => winner
LOSS_THRESHOLD = -50.0  # outcome_pct <= -50 => loser
MIN_SUPPORT = 10        # minimum n_winners OR n_losers for a combo to qualify
MARGINAL_DELTA = 0.3    # combo must beat best singleton net_score by at least this


def _label_flags(df: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """Return boolean Series for winners and losers."""
    is_winner = df["outcome_pct"] >= WIN_THRESHOLD
    is_loser = df["outcome_pct"] <= LOSS_THRESHOLD
    return is_winner, is_loser


def compute_singleton_net_scores(
    df: pd.DataFrame,
    is_winner: pd.Series,
    is_loser: pd.Series,
    p_win: float,
    p_loss: float,
) -> dict[tuple, float]:
    """
    Compute net_score = lift_win - lift_loss for every single-feature value.

    Keys are (feature_name, value) tuples.
    """
    n_total = len(df)
    singleton_scores: dict[tuple, float] = {}

    for feat in FEATURE_KEYS:
        for val, grp_idx in df.groupby(feat).groups.items():
            n_combo = len(grp_idx)
            n_win = int(is_winner.iloc[grp_idx].sum()) if isinstance(grp_idx[0], int) else int(is_winner[grp_idx].sum())
            n_loss = int(is_loser.iloc[grp_idx].sum()) if isinstance(grp_idx[0], int) else int(is_loser[grp_idx].sum())

            lift_win = (n_win / n_combo) / p_win if p_win > 0 else 0.0
            lift_loss = (n_loss / n_combo) / p_loss if p_loss > 0 else 0.0
            net = lift_win - lift_loss
            singleton_scores[(feat, str(val))] = net

    return singleton_scores


def _best_singleton_net(
    combo_keys: tuple[str, ...],
    combo_vals: tuple[str, ...],
    singleton_scores: dict[tuple, float],
) -> float:
    """Return the max singleton net_score among the components of a combo."""
    return max(
        singleton_scores.get((k, v), 0.0)
        for k, v in zip(combo_keys, combo_vals)
    )


def scan_combos(
    df: pd.DataFrame,
    is_winner: pd.Series,
    is_loser: pd.Series,
    p_win: float,
    p_loss: float,
    singleton_scores: dict[tuple, float],
    combo_size: int,
) -> list[dict]:
    """
    Scan all sub-tuples of `combo_size` features.

    Returns a list of result dicts for combos that pass both the support
    threshold and the marginal-above-singleton threshold.
    """
    results = []
    feature_pairs = list(combinations(FEATURE_KEYS, combo_size))
    n_scanned = 0
    n_passed_support = 0

    for feat_tuple in feature_pairs:
        # Group by the combination of feature values
        grouped = df.groupby(list(feat_tuple))
        for val_tuple, grp in grouped:
            if not isinstance(val_tuple, tuple):
                val_tuple = (val_tuple,)
            val_strs = tuple(str(v) for v in val_tuple)

            n_combo = len(grp)
            n_win = int(is_winner[grp.index].sum())
            n_loss = int(is_loser[grp.index].sum())

            n_scanned += 1

            # Support gate: at least MIN_SUPPORT winners OR losers
            if n_win < MIN_SUPPORT and n_loss < MIN_SUPPORT:
                continue

            n_passed_support += 1

            lift_win = (n_win / n_combo) / p_win if p_win > 0 else 0.0
            lift_loss = (n_loss / n_combo) / p_loss if p_loss > 0 else 0.0
            net_score = lift_win - lift_loss

            best_single = _best_singleton_net(feat_tuple, val_strs, singleton_scores)
            marginal = net_score - best_single

            if marginal < MARGINAL_DELTA:
                continue

            combo_label = " & ".join(
                f"{k}={v}" for k, v in zip(feat_tuple, val_strs)
            )
            results.append(
                {
                    "combo": combo_label,
                    "feat_tuple": feat_tuple,
                    "val_tuple": val_strs,
                    "n_total": n_combo,
                    "n_winners": n_win,
                    "n_losers": n_loss,
                    "lift_win": round(lift_win, 3),
                    "lift_loss": round(lift_loss, 3),
                    "net_score": round(net_score, 3),
                    "best_singleton_net": round(best_single, 3),
                    "marginal": round(marginal, 3),
                }
            )

    return results, n_scanned, n_passed_support


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------

TOP_N = 25
WINNING_COLS = [
    "Combo", "n total", "n winners", "n losers",
    "lift_win", "lift_loss", "net_score", "best singleton net", "marginal",
]


def _row_to_md(r: dict) -> str:
    return (
        f"| {r['combo']} "
        f"| {r['n_total']} "
        f"| {r['n_winners']} "
        f"| {r['n_losers']} "
        f"| {r['lift_win']:.3f} "
        f"| {r['lift_loss']:.3f} "
        f"| {r['net_score']:.3f} "
        f"| {r['best_singleton_net']:.3f} "
        f"| {r['marginal']:.3f} |"
    )


def _table_header() -> str:
    cols = "| " + " | ".join(WINNING_COLS) + " |"
    sep = "| " + " | ".join(["---"] * len(WINNING_COLS)) + " |"
    return cols + "\n" + sep


def render_report(
    today: date,
    n_total: int,
    n_winners: int,
    n_losers: int,
    n_scanned: int,
    n_passed_support: int,
    winning: list[dict],
    losing: list[dict],
) -> str:
    """Render the full Markdown report string."""
    date_str = today.strftime("%Y-%m-%d")

    # Determine summary stats
    n_win_candidates = len(winning)
    n_loss_candidates = len(losing)

    if n_win_candidates == 0 and n_loss_candidates == 0:
        summary_action = (
            "No marginal interaction effects detected above the noise floor. "
            "Consider lowering the marginal threshold to 0.15 to detect weaker "
            "interactions, or accept that the additive linear model captures most "
            "of the signal already."
        )
    else:
        top_win = winning[0]["combo"] if winning else "none"
        summary_action = (
            f"Top winning composite is '{top_win}' — "
            f"review for overlap with V2 model features before adding weight. "
            f"Losing composites indicate negative-weight overlays to test."
        )

    lines: list[str] = [
        f"# Lottery composite candidates — {date_str}",
        "",
        f"Trigger: nightly mine_outcome_patterns.py",
        f"Sample: last 90d aligned non-structure (n={n_total:,}) | "
        f"winners (>=50%) = {n_winners:,} | losers (<=-50%) = {n_losers:,}",
        f"Mining threshold: support >= {MIN_SUPPORT}, "
        f"net_score lift over best singleton >= {MARGINAL_DELTA}",
        "",
        "## Top 25 winning composites (high lift_win, low lift_loss)",
        "",
    ]

    if winning:
        lines.append(_table_header())
        for r in winning[:TOP_N]:
            lines.append(_row_to_md(r))
    else:
        lines.append("_No winning composites passed both the support and marginal thresholds._")

    lines += [
        "",
        "## Top 25 losing composites (high lift_loss, low lift_win)",
        "",
    ]

    if losing:
        lines.append(_table_header())
        for r in losing[:TOP_N]:
            lines.append(_row_to_md(r))
    else:
        lines.append("_No losing composites passed both the support and marginal thresholds._")

    lines += [
        "",
        "## Summary",
        "",
        f"- Total combinations scanned: {n_scanned:,} ({n_passed_support:,} passed support threshold)",
        f"- New winning candidates not already in V2 model: {n_win_candidates}",
        f"- New losing candidates suggesting negative-weight overlays: {n_loss_candidates}",
        f"- Suggested next action: {summary_action}",
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

    df_raw = fetch_fires()
    df = build_feature_tuples(df_raw, weights)

    n_total = len(df)
    is_winner, is_loser = _label_flags(df)
    n_winners = int(is_winner.sum())
    n_losers = int(is_loser.sum())

    print(f"\nSample breakdown:")
    print(f"  Total fires:  {n_total:,}")
    print(f"  Winners (>= +50%): {n_winners:,}  ({100*n_winners/n_total:.1f}%)")
    print(f"  Losers  (<= -50%): {n_losers:,}  ({100*n_losers/n_total:.1f}%)")

    p_win = n_winners / n_total
    p_loss = n_losers / n_total

    # Singleton net scores (used for the marginal filter)
    print("\nComputing singleton net scores...")
    singleton_scores = {}
    for feat in FEATURE_KEYS:
        for val, grp in df.groupby(feat):
            n_combo = len(grp)
            n_win = int(is_winner[grp.index].sum())
            n_loss = int(is_loser[grp.index].sum())
            lift_win = (n_win / n_combo) / p_win if p_win > 0 else 0.0
            lift_loss = (n_loss / n_combo) / p_loss if p_loss > 0 else 0.0
            net = lift_win - lift_loss
            singleton_scores[(feat, str(val))] = net

    print(f"  {len(singleton_scores):,} singleton (feature, value) pairs computed")

    # Scan 2- and 3-feature combos
    all_results: list[dict] = []
    total_scanned = 0
    total_passed_support = 0

    for size in (2, 3):
        print(f"\nScanning {size}-feature combos...")
        results, n_scanned, n_passed = scan_combos(
            df, is_winner, is_loser, p_win, p_loss, singleton_scores, size
        )
        print(f"  Scanned: {n_scanned:,}  |  passed support: {n_passed:,}  |  passed marginal: {len(results):,}")
        all_results.extend(results)
        total_scanned += n_scanned
        total_passed_support += n_passed

    print(f"\nTotal: {total_scanned:,} combos scanned, {total_passed_support:,} passed support, "
          f"{len(all_results):,} passed both thresholds")

    # Split and sort
    winning_combos = sorted(
        [r for r in all_results if r["lift_win"] > r["lift_loss"]],
        key=lambda r: (-r["net_score"], -r["n_winners"]),
    )
    losing_combos = sorted(
        [r for r in all_results if r["lift_loss"] > r["lift_win"]],
        key=lambda r: (r["net_score"], -r["n_losers"]),
    )

    # Print top 3 winning + losing
    print("\n--- Top 3 WINNING combos ---")
    for r in winning_combos[:3]:
        print(
            f"  {r['combo']}\n"
            f"    n={r['n_total']:,}  win={r['n_winners']}  loss={r['n_losers']}"
            f"  lift_win={r['lift_win']:.3f}  lift_loss={r['lift_loss']:.3f}"
            f"  net={r['net_score']:.3f}  marginal={r['marginal']:.3f}"
        )

    print("\n--- Top 3 LOSING combos ---")
    for r in losing_combos[:3]:
        print(
            f"  {r['combo']}\n"
            f"    n={r['n_total']:,}  win={r['n_winners']}  loss={r['n_losers']}"
            f"  lift_win={r['lift_win']:.3f}  lift_loss={r['lift_loss']:.3f}"
            f"  net={r['net_score']:.3f}  marginal={r['marginal']:.3f}"
        )

    # Marginal filter diagnosis
    n_candidates = len(all_results)
    if n_candidates < 10:
        print(
            f"\n  NOTE: Only {n_candidates} combo(s) passed the marginal threshold of {MARGINAL_DELTA}. "
            "This may indicate the additive linear V2 model already captures most signal, "
            "or that 90-day data is insufficient for reliable interaction detection. "
            "Consider lowering MARGINAL_DELTA to 0.15 to surface weaker interactions."
        )

    # Render and write report
    today = date.today()
    report_md = render_report(
        today=today,
        n_total=n_total,
        n_winners=n_winners,
        n_losers=n_losers,
        n_scanned=total_scanned,
        n_passed_support=total_passed_support,
        winning=winning_combos,
        losing=losing_combos,
    )

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORT_DIR / f"lottery-composite-candidates-{today.strftime('%Y-%m-%d')}.md"
    report_path.write_text(report_md, encoding="utf-8")
    print(f"\nWrote report: {report_path}")


if __name__ == "__main__":
    main()
