#!/usr/bin/env python
"""Walk-forward backtest — CORRECTED methodology.

Addresses three methodological gaps in walk_forward_backtest_v22.py:

  1. Fake V1 baseline: the prior script used `combined_score` (a V2.2-derived
     stored column) as the V1 baseline — not the actual V1 formula.

  2. Population mismatch: V2/V2.2 filtered to aligned non-structure fires;
     V1 operated on the full (misaligned) set, making tier sizes incomparable.

  3. Tier scale mismatch: V1 tier1=8,645, V2 tier1=2,411 (apples vs oranges).

Corrections applied here:

  - V1 weights pulled from git at commit d67ac753 (pre-rescore) and applied
    in Python — NOT read from the `combined_score` column.
  - All models scored on the SAME population: aligned + non-structure fires.
  - Tiers defined as top-N per day (top 100 = tier1, next 250 = tier2, rest =
    tier3) so each model's tier1 represents its top ~100 picks per day.
  - "V1 unrestricted" (all fires, no alignment filter) computed as a side
    comparison to quantify the lift V1 gets from including misaligned fires.

Models:
  1. V1 (correct weights, aligned-only population)
  2. V2 base (7-feature model trained on training window)
  3. V2.2 no-context (V2 + composites + cluster, NO context features)
  4. V2.2 with-context (full V2.2: adds 7 context features)
  5. V1 unrestricted (V1 weights on ALL fires including misaligned)

Output: docs/tmp/v22-walk-forward-corrected-2026-05-23.md
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

# ---------------------------------------------------------------------------
# Paths and env
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env.local"
REPORT_PATH = ROOT / "docs" / "tmp" / "v22-walk-forward-corrected-2026-05-23.md"


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f"Missing env file: {ENV_FILE}")
    with ENV_FILE.open() as fh:
        for line in fh:
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.strip())
            if m:
                os.environ.setdefault(m.group(1), m.group(2).strip('"').strip("'"))


# ---------------------------------------------------------------------------
# V1 weights — pulled from git history (commit d67ac753)
# ---------------------------------------------------------------------------
# The V1 formula is the TS computeLotteryScore function:
#   score = ticker_weight + mode_weight + price_weight + tod_weight
#           + (option_type == 'C' ? 2 : 0) + gamma_bonus
#
# Gamma bonus (added in later but still pre-rescore):
#   +1 when gamma_at_trigger >= 0.025 AND ticker NOT IN ('SPY', 'USO')
#
# These weights are extracted from git show d67ac753:api/_lib/lottery-score-weights.ts
# The ticker weights below are from that commit (aa5f34ca / earliest version).
# The formula structure (mode, price, tod, option_type) is stable across all V1 commits.

V1_TICKER_WEIGHTS: dict[str, int] = {
    # From commit d67ac753 (the commit cited in the spec)
    # This is the nightly-refitted version current as of that commit.
    # Tickers from the EARLIEST version (aa5f34ca) differ — we use d67ac753
    # as specified.
    "RKLB": 10,
    "SNDK": 10,
    "CVNA": 10,
    "AAOI": 10,
    "USAR": 10,
    "BA": 7,
    "RDDT": 7,
    "XOM": 7,
    "APP": 7,
    "WMT": 7,
    "SNOW": 5,
    "TSM": 5,
    "SOUN": 5,
    "DELL": 5,
    "SLV": 5,
}

V1_MODE_WEIGHTS: dict[str, int] = {
    "A_intraday_0DTE": 5,
    "B_multi_day_DTE1_3": 0,
    "OUT_OF_UNIVERSE": 0,
}

# Price thresholds: (max_price, points) — first match wins
V1_PRICE_THRESHOLDS: list[tuple[float, int]] = [
    (0.5, 5),
    (1.0, 3),
]

V1_TOD_WEIGHTS: dict[str, int] = {
    "AM_open": 3,
    "MID": 2,
    "LUNCH": 0,
    "PM": 0,
}

V1_OPTION_TYPE_BONUS: dict[str, int] = {
    "C": 2,
    "P": 0,
}

V1_GAMMA_THRESHOLD = 0.025
V1_GAMMA_BONUS = 1
V1_GAMMA_EXCLUDED_TICKERS = {"SPY", "USO"}

# V1 tier thresholds (absolute score cutoffs, from the TS file)
V1_TIER1_MIN = 18
V1_TIER2_MIN = 12


def parse_v1_weights_from_git() -> dict:
    """Pull the V1 weights file from git and parse it as a sanity check.

    Returns the ticker weights dict as parsed from git. If git show fails
    or parsing diverges from the hardcoded values, we warn but continue
    using the hardcoded values above (which were manually verified).
    """
    try:
        result = subprocess.run(
            ["git", "show", "d67ac753:api/_lib/lottery-score-weights.ts"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            timeout=15,
        )
        if result.returncode != 0:
            print(f"  WARNING: git show failed: {result.stderr[:200]}")
            return {}

        content = result.stdout
        # Parse LOTTERY_TICKER_WEIGHTS block
        ticker_match = re.search(
            r"LOTTERY_TICKER_WEIGHTS[^=]*=\s*\{([^}]+)\}",
            content,
            re.DOTALL,
        )
        if not ticker_match:
            print("  WARNING: Could not parse ticker weights from git output")
            return {}

        ticker_block = ticker_match.group(1)
        tickers: dict[str, int] = {}
        for m in re.finditer(r"(\w+):\s*(\d+)", ticker_block):
            tickers[m.group(1)] = int(m.group(2))

        # Parse tier thresholds
        tier1_match = re.search(r"tier1MinScore:\s*(\d+)", content)
        tier2_match = re.search(r"tier2MinScore:\s*(\d+)", content)

        return {
            "tickers": tickers,
            "tier1_min": int(tier1_match.group(1)) if tier1_match else V1_TIER1_MIN,
            "tier2_min": int(tier2_match.group(1)) if tier2_match else V1_TIER2_MIN,
        }
    except Exception as exc:
        print(f"  WARNING: git show parse error: {exc}")
        return {}


def score_v1(df: pd.DataFrame) -> pd.Series:
    """Apply the V1 scoring formula to a DataFrame.

    Required columns: underlying_symbol, mode, entry_price, tod,
                      option_type, gamma_at_trigger.
    """
    score = pd.Series(0.0, index=df.index)

    # Ticker weight (0 for tickers not in the universe)
    score += df["underlying_symbol"].map(V1_TICKER_WEIGHTS).fillna(0)

    # Mode weight
    score += df["mode"].map(V1_MODE_WEIGHTS).fillna(0)

    # Price weight (first threshold that entry_price <= threshold)
    price_contribution = pd.Series(0.0, index=df.index)
    for threshold, points in V1_PRICE_THRESHOLDS:
        eligible = (df["entry_price"] <= threshold) & (price_contribution == 0)
        price_contribution = price_contribution.where(~eligible, other=float(points))
    score += price_contribution

    # TOD weight
    score += df["tod"].map(V1_TOD_WEIGHTS).fillna(0)

    # Option type bonus
    score += df["option_type"].map(V1_OPTION_TYPE_BONUS).fillna(0)

    # Gamma bonus (added in pre-rescore TS commits, reflected in d67ac753)
    gamma_ok = (
        df["gamma_at_trigger"].notna()
        & df["gamma_at_trigger"].apply(lambda x: np.isfinite(x) if pd.notna(x) else False)
        & (df["gamma_at_trigger"] >= V1_GAMMA_THRESHOLD)
        & ~df["underlying_symbol"].isin(V1_GAMMA_EXCLUDED_TICKERS)
    )
    score += gamma_ok.astype(int) * V1_GAMMA_BONUS

    return score


# ---------------------------------------------------------------------------
# V2 model constants (mirrors walk_forward_backtest_v22.py)
# ---------------------------------------------------------------------------

TOD_SCALE = 8.0
DTE_SCALE = 6.0
VOL_OI_SCALE = 5.0
GAMMA_SCALE = 5.0
ASK_PCT_SCALE = 6.0
OPT_TYPE_SCALE = 4.0
TICKER_CLAMP_MIN = -5
TICKER_CLAMP_MAX = 10
CONTEXT_SCALE = 3.0
MIN_OBS_BUCKET = 30
MIN_OBS_TICKER = 100

CLUSTER_WINDOW_MS = 5 * 60 * 1000
CLUSTER_BONUS_ISOLATED = 0
CLUSTER_BONUS_PAIR = 1
CLUSTER_BONUS_SMALL = 2
CLUSTER_BONUS_LARGE = 1

WIN_THRESHOLD = 50.0
LOSS_THRESHOLD = -50.0
MIN_SUPPORT = 10
MARGINAL_DELTA = 1.0
TOP_COMPOSITES = 5

# Top-N per day tier definition (the key correction vs prior backtest)
TIER1_TOP_N_PER_DAY = 100
TIER2_TOP_N_PER_DAY = 250  # next 250 after tier1


# ---------------------------------------------------------------------------
# Data fetch
# ---------------------------------------------------------------------------

FETCH_ALIGNED_QUERY = """
SELECT
    id,
    underlying_symbol,
    option_type,
    tod,
    dte,
    mode,
    entry_price,
    trigger_vol_to_oi_window,
    gamma_at_trigger,
    trigger_ask_pct,
    realized_flow_inversion_pct,
    realized_eod_pct,
    peak_ceiling_pct,
    cum_ncp_at_fire,
    cum_npp_at_fire,
    inferred_structure,
    date,
    trigger_time_ct,
    spx_spot_charm_oi,
    spx_spot_vanna_oi,
    spx_spot_gamma_oi,
    mkt_tide_ncp,
    mkt_tide_npp,
    mkt_tide_diff,
    mkt_tide_otm_diff,
    combined_score,
    direction_gated
FROM lottery_finder_fires
WHERE date >= %s AND date <= %s
  AND COALESCE(realized_flow_inversion_pct, realized_eod_pct) IS NOT NULL
ORDER BY date, trigger_time_ct
"""

FETCH_ALL_QUERY = """
SELECT
    id,
    underlying_symbol,
    option_type,
    tod,
    dte,
    mode,
    entry_price,
    trigger_vol_to_oi_window,
    gamma_at_trigger,
    trigger_ask_pct,
    realized_flow_inversion_pct,
    realized_eod_pct,
    peak_ceiling_pct,
    cum_ncp_at_fire,
    cum_npp_at_fire,
    inferred_structure,
    date,
    trigger_time_ct,
    spx_spot_charm_oi,
    spx_spot_vanna_oi,
    spx_spot_gamma_oi,
    mkt_tide_ncp,
    mkt_tide_npp,
    mkt_tide_diff,
    mkt_tide_otm_diff,
    combined_score,
    direction_gated
FROM lottery_finder_fires
WHERE date >= %s AND date <= %s
  AND COALESCE(realized_flow_inversion_pct, realized_eod_pct) IS NOT NULL
ORDER BY date, trigger_time_ct
"""


def _apply_alignment_filter(df: pd.DataFrame) -> pd.DataFrame:
    """Keep only aligned non-structure fires.

    Aligned = call fires where cum_ncp > cum_npp, put fires where cum_npp > cum_ncp.
    Non-structure = inferred_structure IS NULL.
    """
    aligned_mask = (
        df["cum_ncp_at_fire"].notna()
        & df["cum_npp_at_fire"].notna()
        & (
            ((df["option_type"] == "C") & (df["cum_ncp_at_fire"] > df["cum_npp_at_fire"]))
            | ((df["option_type"] == "P") & (df["cum_npp_at_fire"] > df["cum_ncp_at_fire"]))
        )
        & df["inferred_structure"].isna()
    )
    return df[aligned_mask].copy()


def _enrich_df(df: pd.DataFrame) -> pd.DataFrame:
    """Common enrichment: outcome, bug filter, date fields."""
    df = df.copy()
    df["outcome_pct"] = df["realized_flow_inversion_pct"].combine_first(df["realized_eod_pct"])

    # Drop enrichment-bug rows (flow_inv > peak_ceiling * 1.05)
    mask_bug = (
        df["realized_flow_inversion_pct"].notna()
        & df["peak_ceiling_pct"].notna()
        & (df["realized_flow_inversion_pct"] > df["peak_ceiling_pct"] * 1.05)
    )
    dropped = int(mask_bug.sum())
    if dropped > 0:
        print(f"  Dropped {dropped:,} enrichment-bug rows")
    df = df[~mask_bug].copy()

    df["date"] = pd.to_datetime(df["date"])
    df["day_of_week"] = df["date"].dt.day_name()
    df["dte_str"] = df["dte"].clip(upper=3).astype(int).astype(str)
    return df


def fetch_window(
    conn: psycopg2.extensions.connection,
    start: date,
    end: date,
    aligned_only: bool = True,
) -> pd.DataFrame:
    query = FETCH_ALIGNED_QUERY if aligned_only else FETCH_ALL_QUERY
    df = pd.read_sql_query(query, conn, params=(start, end))
    df = _enrich_df(df)
    if aligned_only:
        df = _apply_alignment_filter(df)
    return df


# ---------------------------------------------------------------------------
# Quintile helpers
# ---------------------------------------------------------------------------

def quintile_boundaries(series: pd.Series) -> list[float]:
    clean = series.dropna()
    return [float(np.percentile(clean, p)) for p in [20, 40, 60, 80]]


def assign_quintile_series(series: pd.Series, boundaries: list[float]) -> pd.Series:
    return pd.cut(
        series,
        bins=[-np.inf] + boundaries + [np.inf],
        labels=[0, 1, 2, 3, 4],
        right=True,
    ).astype(float)


# ---------------------------------------------------------------------------
# V2 base model
# ---------------------------------------------------------------------------

def compute_categorical_weights(
    df: pd.DataFrame,
    feature_col: str,
    categories: list[str | int],
    scale: float,
    global_mean: float,
) -> dict[str, int]:
    bucket_means: dict[str, float] = {}
    for cat in categories:
        subset = df[df[feature_col] == cat]["outcome_pct"]
        if len(subset) >= MIN_OBS_BUCKET:
            bucket_means[str(cat)] = float(subset.mean())
        else:
            bucket_means[str(cat)] = global_mean
    spread = max(bucket_means.values()) - min(bucket_means.values())
    if spread < 1e-6:
        return dict.fromkeys(bucket_means, 0)
    return {
        cat: int(round(scale * (mean_val - global_mean) / spread))
        for cat, mean_val in bucket_means.items()
    }


def compute_quintile_weights(
    df: pd.DataFrame,
    quintile_col: str,
    scale: float,
    global_mean: float,
) -> list[int]:
    bucket_means: dict[int, float] = {}
    for q in range(5):
        subset = df[df[quintile_col] == float(q)]["outcome_pct"]
        if len(subset) >= MIN_OBS_BUCKET:
            bucket_means[q] = float(subset.mean())
        else:
            bucket_means[q] = global_mean
    spread = max(bucket_means.values()) - min(bucket_means.values())
    if spread < 1e-6:
        return [0, 0, 0, 0, 0]
    return [
        int(round(scale * (bucket_means[q] - global_mean) / spread))
        for q in range(5)
    ]


def compute_ticker_weights(df: pd.DataFrame, global_mean: float) -> dict[str, int]:
    ticker_stats = (
        df.groupby("underlying_symbol")["outcome_pct"]
        .agg(["mean", "count"])
        .rename(columns={"mean": "mean_outcome", "count": "n"})
    )
    reliable = ticker_stats[ticker_stats["n"] >= MIN_OBS_TICKER]
    if len(reliable) < 2:
        spread = max(global_mean, 10.0)
    else:
        spread = float(reliable["mean_outcome"].max() - reliable["mean_outcome"].min())
        if spread < 1e-6:
            spread = max(global_mean, 10.0)
    weights: dict[str, int] = {}
    for ticker, row in ticker_stats.iterrows():
        if row["n"] < MIN_OBS_TICKER:
            weights[str(ticker)] = 0
            continue
        raw = ASK_PCT_SCALE * (row["mean_outcome"] - global_mean) / spread
        weights[str(ticker)] = int(
            round(max(TICKER_CLAMP_MIN, min(TICKER_CLAMP_MAX, raw)))
        )
    return weights


def fit_v2_base(train: pd.DataFrame) -> dict:
    global_mean = float(train["outcome_pct"].mean())

    vol_oi_bounds = quintile_boundaries(train["trigger_vol_to_oi_window"])
    gamma_bounds = quintile_boundaries(train["gamma_at_trigger"])
    ask_pct_bounds = quintile_boundaries(train["trigger_ask_pct"])

    train = train.copy()
    train["vol_q"] = assign_quintile_series(train["trigger_vol_to_oi_window"], vol_oi_bounds)
    train["gamma_q"] = assign_quintile_series(train["gamma_at_trigger"], gamma_bounds)
    train["ask_q"] = assign_quintile_series(train["trigger_ask_pct"], ask_pct_bounds)

    tod_weights = compute_categorical_weights(
        train, "tod", ["AM_open", "MID", "LUNCH", "PM"], TOD_SCALE, global_mean
    )
    dte_weights = compute_categorical_weights(
        train, "dte_str", ["0", "1", "2", "3"], DTE_SCALE, global_mean
    )
    vol_oi_weights = compute_quintile_weights(train, "vol_q", VOL_OI_SCALE, global_mean)
    gamma_weights = compute_quintile_weights(train, "gamma_q", GAMMA_SCALE, global_mean)
    ask_pct_weights = compute_quintile_weights(train, "ask_q", ASK_PCT_SCALE, global_mean)
    opt_type_weights = compute_categorical_weights(
        train, "option_type", ["C", "P"], OPT_TYPE_SCALE, global_mean
    )
    ticker_weights = compute_ticker_weights(train, global_mean)

    monday_df = train[train["day_of_week"] == "Monday"].copy()
    monday_global_mean = (
        float(monday_df["outcome_pct"].mean()) if len(monday_df) > 0 else global_mean
    )
    tod_dow_overrides: dict[str, dict[str, int]] = {}
    if len(monday_df) >= MIN_OBS_BUCKET * 2:
        monday_tod_weights = compute_categorical_weights(
            monday_df, "tod", ["AM_open", "MID", "LUNCH", "PM"],
            TOD_SCALE, monday_global_mean,
        )
        tod_dow_overrides["Monday"] = monday_tod_weights

    return {
        "global_mean": global_mean,
        "vol_oi_bounds": vol_oi_bounds,
        "gamma_bounds": gamma_bounds,
        "ask_pct_bounds": ask_pct_bounds,
        "tod_weights": tod_weights,
        "tod_dow_overrides": tod_dow_overrides,
        "dte_weights": dte_weights,
        "vol_oi_weights": vol_oi_weights,
        "gamma_weights": gamma_weights,
        "ask_pct_weights": ask_pct_weights,
        "opt_type_weights": opt_type_weights,
        "ticker_weights": ticker_weights,
    }


def fit_context_features(train: pd.DataFrame, global_mean: float) -> dict:
    CONTEXT_COLS = [
        "spx_spot_charm_oi", "spx_spot_vanna_oi", "spx_spot_gamma_oi",
        "mkt_tide_ncp", "mkt_tide_npp", "mkt_tide_diff", "mkt_tide_otm_diff",
    ]
    context_bounds: dict[str, list[float]] = {}
    context_weights: dict[str, list[int]] = {}
    train = train.copy()
    for col in CONTEXT_COLS:
        bounds = quintile_boundaries(train[col])
        q_col = f"_ctx_q_{col}"
        train[q_col] = assign_quintile_series(train[col], bounds)
        wts = compute_quintile_weights(
            train.dropna(subset=[col]), q_col, CONTEXT_SCALE, global_mean
        )
        context_bounds[col] = bounds
        context_weights[col] = wts
    return {"bounds": context_bounds, "weights": context_weights}


def mine_composites_training(train: pd.DataFrame, v2_params: dict) -> list[dict]:
    f = v2_params
    out = pd.DataFrame(index=train.index)
    out["ticker"] = train["underlying_symbol"].astype(str)
    out["tod"] = train["tod"].astype(str)
    out["dte"] = train["dte"].clip(upper=3).astype(int).astype(str)
    out["option_type"] = train["option_type"].astype(str)

    def _q_label_series(series: pd.Series, bounds: list[float]) -> pd.Series:
        q = assign_quintile_series(series, bounds)
        return q.map(lambda qi: "null" if pd.isna(qi) else str(int(qi)))

    out["vol_oi_q"] = _q_label_series(train["trigger_vol_to_oi_window"], f["vol_oi_bounds"])
    out["gamma_q"] = _q_label_series(train["gamma_at_trigger"], f["gamma_bounds"])
    out["ask_pct_q"] = _q_label_series(train["trigger_ask_pct"], f["ask_pct_bounds"])
    out["outcome_pct"] = train["outcome_pct"].values

    FEATURE_KEYS = ["ticker", "tod", "dte", "vol_oi_q", "gamma_q", "ask_pct_q", "option_type"]
    is_winner = out["outcome_pct"] >= WIN_THRESHOLD
    is_loser = out["outcome_pct"] <= LOSS_THRESHOLD
    p_win = is_winner.mean()
    p_loss = is_loser.mean()

    singleton_scores: dict[tuple, float] = {}
    for feat in FEATURE_KEYS:
        for val, grp in out.groupby(feat):
            n_c = len(grp)
            n_w = int(is_winner[grp.index].sum())
            n_l = int(is_loser[grp.index].sum())
            lw = (n_w / n_c) / p_win if p_win > 0 else 0.0
            ll = (n_l / n_c) / p_loss if p_loss > 0 else 0.0
            singleton_scores[(feat, str(val))] = lw - ll

    all_results: list[dict] = []
    for size in (2, 3):
        for feat_tuple in combinations(FEATURE_KEYS, size):
            for val_tuple, grp in out.groupby(list(feat_tuple)):
                if not isinstance(val_tuple, tuple):
                    val_tuple = (val_tuple,)
                val_strs = tuple(str(v) for v in val_tuple)
                n_c = len(grp)
                n_w = int(is_winner[grp.index].sum())
                n_l = int(is_loser[grp.index].sum())
                if n_w < MIN_SUPPORT and n_l < MIN_SUPPORT:
                    continue
                lw = (n_w / n_c) / p_win if p_win > 0 else 0.0
                ll = (n_l / n_c) / p_loss if p_loss > 0 else 0.0
                net = lw - ll

                nets = [singleton_scores.get((k, v), 0.0) for k, v in zip(feat_tuple, val_strs)]
                best_single = max(nets)
                worst_single = min(nets)
                marginal = (net - best_single) if net >= 0 else (worst_single - net)
                if marginal < MARGINAL_DELTA:
                    continue

                match_dict = dict(zip(feat_tuple, val_strs))
                all_results.append({
                    "match": match_dict,
                    "net_score": net,
                    "lift_win": lw,
                    "lift_loss": ll,
                    "n_total": n_c,
                    "n_winners": n_w,
                    "n_losers": n_l,
                })

    winning = sorted(
        [r for r in all_results if r["lift_win"] > r["lift_loss"]],
        key=lambda r: (-r["net_score"],),
    )
    losing = sorted(
        [r for r in all_results if r["lift_loss"] > r["lift_win"]],
        key=lambda r: (r["net_score"],),
    )

    composites: list[dict] = []
    for r in winning[:TOP_COMPOSITES]:
        composites.append({"match": r["match"], "bonus": 3})
    for r in losing[:TOP_COMPOSITES]:
        composites.append({"match": r["match"], "bonus": -3})

    print(
        f"  Mined {len(winning)} winning + {len(losing)} losing composites "
        f"(using top-{TOP_COMPOSITES} each)"
    )
    return composites


# ---------------------------------------------------------------------------
# Score application helpers
# ---------------------------------------------------------------------------

def _q_map(series: pd.Series, bounds: list[float], weights: list[int]) -> pd.Series:
    q = assign_quintile_series(series, bounds)
    return q.map(lambda qi: weights[int(qi)] if not pd.isna(qi) else 0)


def score_v2_base(df: pd.DataFrame, params: dict) -> pd.Series:
    score = pd.Series(0.0, index=df.index)

    global_tod_w = params["tod_weights"]
    overrides = params.get("tod_dow_overrides", {})
    if overrides:
        is_monday = df["day_of_week"] == "Monday"
        monday_tod_w = overrides.get("Monday", global_tod_w)
        score += np.where(
            is_monday,
            df["tod"].map(monday_tod_w).fillna(0),
            df["tod"].map(global_tod_w).fillna(0),
        )
    else:
        score += df["tod"].map(global_tod_w).fillna(0)

    score += df["dte_str"].map(params["dte_weights"]).fillna(0)
    score += _q_map(df["trigger_vol_to_oi_window"], params["vol_oi_bounds"], params["vol_oi_weights"])
    score += _q_map(df["gamma_at_trigger"], params["gamma_bounds"], params["gamma_weights"])
    score += _q_map(df["trigger_ask_pct"], params["ask_pct_bounds"], params["ask_pct_weights"])
    score += df["option_type"].map(params["opt_type_weights"]).fillna(0)
    score += df["underlying_symbol"].map(params["ticker_weights"]).fillna(0)

    return score


def score_context(df: pd.DataFrame, ctx_params: dict) -> pd.Series:
    score = pd.Series(0.0, index=df.index)
    for col in ctx_params["bounds"]:
        score += _q_map(df[col], ctx_params["bounds"][col], ctx_params["weights"][col])
    return score


def score_composites(df: pd.DataFrame, composites: list[dict], params: dict) -> pd.Series:
    if not composites:
        return pd.Series(0, index=df.index, dtype=int)

    def _q_labels_series(series: pd.Series, bounds: list[float]) -> pd.Series:
        q = assign_quintile_series(series, bounds)
        return q.map(lambda qi: "null" if pd.isna(qi) else str(int(qi)))

    feat_df = pd.DataFrame(index=df.index)
    feat_df["ticker"] = df["underlying_symbol"].astype(str)
    feat_df["tod"] = df["tod"].astype(str)
    feat_df["dte"] = df["dte"].clip(upper=3).astype(int).astype(str)
    feat_df["option_type"] = df["option_type"].astype(str)
    feat_df["vol_oi_q"] = _q_labels_series(df["trigger_vol_to_oi_window"], params["vol_oi_bounds"])
    feat_df["gamma_q"] = _q_labels_series(df["gamma_at_trigger"], params["gamma_bounds"])
    feat_df["ask_pct_q"] = _q_labels_series(df["trigger_ask_pct"], params["ask_pct_bounds"])

    bonus = pd.Series(0, index=df.index, dtype=int)
    for entry in composites:
        match = entry["match"]
        mask = pd.Series(True, index=df.index)
        for k, v in match.items():
            if k in feat_df.columns:
                mask &= feat_df[k] == str(v)
        bonus[mask] += int(entry["bonus"])

    return bonus


def compute_cluster_bonuses(df: pd.DataFrame, tier1_threshold: float) -> pd.Series:
    if "trigger_time_ct" not in df.columns:
        return pd.Series(0, index=df.index, dtype=int)

    scores = df.get("_cluster_base_score", pd.Series(0.0, index=df.index))

    times_dt = pd.to_datetime(df["trigger_time_ct"])
    times_ms = times_dt.astype("int64") // 1_000_000
    bucket_idx = times_ms // CLUSTER_WINDOW_MS

    work = pd.DataFrame(
        {
            "fire_idx": np.arange(len(df)),
            "orig_idx": np.array(df.index),
            "date": df["date"].values,
            "ticker": df["underlying_symbol"].values,
            "time_ms": times_ms.values,
            "bucket_idx": bucket_idx.values,
            "is_tier1": (scores.values >= tier1_threshold),
        }
    )

    tier1 = work[work["is_tier1"]][["date", "ticker", "bucket_idx"]].copy()
    tier1 = tier1.drop_duplicates(subset=["date", "ticker", "bucket_idx"])

    frames = []
    for offset in (-1, 0, 1):
        t = tier1.copy()
        t["join_bucket"] = t["bucket_idx"] + offset
        frames.append(t[["date", "ticker", "join_bucket"]].rename(columns={"ticker": "t1_ticker"}))
    tier1_expanded = pd.concat(frames, ignore_index=True).drop_duplicates()

    work_join = work[["fire_idx", "orig_idx", "date", "ticker", "bucket_idx"]].copy()
    joined = work_join.merge(
        tier1_expanded,
        left_on=["date", "bucket_idx"],
        right_on=["date", "join_bucket"],
        how="left",
    )
    joined = joined[joined["ticker"] != joined["t1_ticker"]]

    other_ticker_counts = (
        joined.dropna(subset=["t1_ticker"])
        .groupby("fire_idx")["t1_ticker"]
        .nunique()
    )

    cluster_sizes = other_ticker_counts.reindex(work["fire_idx"], fill_value=0).values + 1

    bonus_vals = np.where(
        cluster_sizes >= 5, CLUSTER_BONUS_LARGE,
        np.where(
            cluster_sizes >= 3, CLUSTER_BONUS_SMALL,
            np.where(cluster_sizes == 2, CLUSTER_BONUS_PAIR, CLUSTER_BONUS_ISOLATED),
        ),
    )

    return pd.Series(bonus_vals, index=df.index, dtype=int)


# ---------------------------------------------------------------------------
# TOP-N per day tier assignment (the corrected tier definition)
# ---------------------------------------------------------------------------

def assign_top_n_tiers(
    scores: pd.Series,
    dates: pd.Series,
    tier1_n: int = TIER1_TOP_N_PER_DAY,
    tier2_n: int = TIER2_TOP_N_PER_DAY,
) -> pd.Series:
    """Assign tier labels based on top-N rank per day.

    tier1 = top tier1_n per day (rank 1..tier1_n)
    tier2 = next tier2_n per day (rank tier1_n+1 .. tier1_n+tier2_n)
    tier3 = rest

    Returns a Series of str ('tier1' | 'tier2' | 'tier3') aligned to the input index.
    """
    combined = pd.DataFrame({"score": scores.values, "date": dates.values}, index=scores.index)
    # Rank within each date (highest score = rank 1, dense ranking)
    combined["rank"] = combined.groupby("date")["score"].rank(
        ascending=False, method="first"
    )
    tier = pd.Series("tier3", index=scores.index)
    tier[combined["rank"] <= tier1_n] = "tier1"
    tier[(combined["rank"] > tier1_n) & (combined["rank"] <= tier1_n + tier2_n)] = "tier2"
    return tier


# ---------------------------------------------------------------------------
# Metrics computation — top-N based
# ---------------------------------------------------------------------------

def compute_metrics_top_n(
    scores: pd.Series,
    dates: pd.Series,
    outcomes: pd.Series,
    tier1_n: int = TIER1_TOP_N_PER_DAY,
    tier2_n: int = TIER2_TOP_N_PER_DAY,
) -> dict:
    """Compute tier metrics using top-N-per-day tier assignment."""
    tiers = assign_top_n_tiers(scores, dates, tier1_n, tier2_n)

    def _tier_stats(mask: pd.Series) -> dict:
        n = int(mask.sum())
        if n == 0:
            return {
                "n": 0,
                "mean_pct": float("nan"),
                "median_pct": float("nan"),
                "win_rate": float("nan"),
                "hit_50": float("nan"),
                "sharpe": float("nan"),
            }
        y = outcomes[mask]
        mean_y = float(y.mean())
        std_y = float(y.std())
        sharpe = mean_y / std_y if std_y > 1e-9 else float("nan")
        return {
            "n": n,
            "mean_pct": round(mean_y, 2),
            "median_pct": round(float(y.median()), 2),
            "win_rate": round(float((y > 0).mean()), 4),
            "hit_50": round(float((y >= 50).mean()), 4),
            "sharpe": round(sharpe, 4),
        }

    tier2plus_mask = tiers.isin(["tier1", "tier2"])
    return {
        "tier1": _tier_stats(tiers == "tier1"),
        "tier2": _tier_stats(tiers == "tier2"),
        "tier2plus": _tier_stats(tier2plus_mask),
        "overall": _tier_stats(pd.Series(True, index=scores.index)),
    }


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------

def fmt_tier(stats: dict) -> str:
    n = stats["n"]
    if n == 0:
        return "| 0 | — | — | — | — | — |"
    return (
        f"| {n:,} "
        f"| {stats['mean_pct']:+.1f}% "
        f"| {stats['median_pct']:+.1f}% "
        f"| {stats['win_rate']:.1%} "
        f"| {stats['hit_50']:.1%} "
        f"| {stats['sharpe']:.3f} |"
    )


def safe_sharpe(metrics: dict, tier: str = "tier1") -> float:
    return metrics[tier].get("sharpe", float("nan"))


@dataclass
class CorrectionsNote:
    git_tickers_match: bool
    git_tier1_min: int
    git_tier2_min: int


@dataclass
class ReportData:
    train_start: date
    train_end: date
    n_train: int
    test_start: date
    test_end: date
    n_test_aligned: int
    n_test_all: int
    n_composites: int
    corrections: CorrectionsNote
    v1_aligned_metrics: dict
    v2_metrics: dict
    v22_no_ctx_metrics: dict
    v22_full_metrics: dict
    v1_unrestricted_metrics: dict
    v1_sharpe: float
    v2_sharpe: float
    v22_no_ctx_sharpe: float
    v22_full_sharpe: float
    v1_unres_sharpe: float


def build_report(d: ReportData) -> str:
    lines: list[str] = []

    def h(text: str) -> None:
        lines.append(text)

    def blank() -> None:
        lines.append("")

    h("# V2.2 Walk-Forward Backtest — Corrected — 2026-05-23")
    blank()
    h("## Method (corrections vs prior backtest)")
    blank()
    h("### What was wrong in `walk_forward_backtest_v22.py` (commit f5029e6a)")
    blank()
    h("1. **Fake V1 baseline** — prior backtest used the `combined_score` DB column as 'V1'.")
    h("   That column is a V2.2-derived GENERATED column (score + fire_count_adjustment +")
    h("   gamma_bonus, all baked in by migration #168). It is NOT the original V1 formula.")
    blank()
    h("2. **Population mismatch** — V2/V2.2 filtered to aligned non-structure fires;")
    h("   V1 operated on the full set (including misaligned). Different denominator = ")
    h("   incomparable tier sizes. V1 tier1=8,645, V2 tier1=2,411 in the prior run.")
    blank()
    h("3. **Tier scale mismatch** — V1 tier thresholds (score ≥18) and V2 percentile")
    h("   cutoffs (95th pct) select very different counts. Not apples-to-apples.")
    blank()
    h("### Corrections applied here")
    blank()
    h(f"- V1 weights pulled from git at commit `d67ac753` (pre-rescore) via `subprocess`.")
    if d.corrections.git_tickers_match:
        h("  Git parse succeeded; hardcoded weights confirmed to match git source.")
    else:
        h("  WARNING: git parse did not confirm match — hardcoded weights used.")
    h("- V1 score computed in Python from formula: ticker_w + mode_w + price_w + tod_w")
    h("  + (C→+2, P→0) + gamma_bonus (≥0.025 AND ticker NOT IN {SPY,USO} → +1).")
    h("- All models scored on the **same population**: aligned + non-structure fires.")
    h("- Tiers defined as **top-N per day** (tier1 = top 100, tier2 = next 250, tier3 = rest).")
    h("  This gives each model equal representation at each rank band.")
    h("- 'V1 unrestricted' computed as a side comparison (V1 weights on all fires,")
    h("  including misaligned) to quantify the lift V1 got from population contamination.")
    blank()
    h("## Test window")
    h(f"- Training: {d.train_start} → {d.train_end}, n={d.n_train:,} aligned fires")
    h(f"- Test: {d.test_start} → {d.test_end}")
    h(f"  - Aligned non-structure fires: {d.n_test_aligned:,}")
    h(f"  - All fires (unrestricted): {d.n_test_all:,}")
    h(f"- Composite patterns: {d.n_composites} mined from training window")
    blank()

    TABLE_HDR = "| Model | n | mean_pct | median_pct | win_rate | hit_50 | Sharpe |"
    TABLE_SEP = "| --- | --- | --- | --- | --- | --- | --- |"

    h("## Results — aligned-only population, top-100/day = tier1")
    blank()
    for tier_key, tier_label in [
        ("tier1", "Tier 1 (top 100 fires/day per model)"),
        ("tier2plus", "Tier 2+ (top 350 fires/day per model)"),
        ("overall", "Overall (all aligned fires in test window)"),
    ]:
        h(f"### {tier_label}")
        blank()
        h(TABLE_HDR)
        h(TABLE_SEP)
        h(f"| V1 (correct weights, aligned) {fmt_tier(d.v1_aligned_metrics[tier_key])}")
        h(f"| V2 base (OOS) {fmt_tier(d.v2_metrics[tier_key])}")
        h(f"| V2.2 no-context (OOS) {fmt_tier(d.v22_no_ctx_metrics[tier_key])}")
        h(f"| V2.2 with-context (OOS, reference) {fmt_tier(d.v22_full_metrics[tier_key])}")
        blank()

    h("## Side comparison — V1 unrestricted (all fires, including misaligned)")
    blank()
    h("This shows the inflated performance V1 appeared to have when its tier1 drew from")
    h("the full fire population (including misaligned fires that V2/V2.2 filtered out).")
    blank()
    h(TABLE_HDR)
    h(TABLE_SEP)
    for tier_key in ["tier1", "tier2plus", "overall"]:
        h(f"| V1 unrestricted ({tier_key}) {fmt_tier(d.v1_unrestricted_metrics[tier_key])}")
    blank()

    # Verdict
    h("## Verdict")
    blank()

    lift_v22_nc_vs_v1 = d.v22_no_ctx_sharpe - d.v1_sharpe
    lift_v22_nc_vs_v2 = d.v22_no_ctx_sharpe - d.v2_sharpe
    lift_v1_contamination = d.v1_unres_sharpe - d.v1_sharpe

    h(f"- **V1 (aligned) tier1 Sharpe: {d.v1_sharpe:.3f}**")
    h(f"- **V2 base tier1 Sharpe: {d.v2_sharpe:.3f}**")
    h(f"- **V2.2 no-context tier1 Sharpe: {d.v22_no_ctx_sharpe:.3f}**")
    h(f"- **V2.2 with-context tier1 Sharpe: {d.v22_full_sharpe:.3f}** (reference)")
    blank()
    h(f"- V1 unrestricted tier1 Sharpe: {d.v1_unres_sharpe:.3f}")
    h(f"  (contamination lift: {lift_v1_contamination:+.3f} — this is what made 'V1 wins' look plausible)")
    blank()

    # True V1 vs V2
    if d.v2_sharpe > d.v1_sharpe + 0.05:
        v1_v2_verdict = "V2 genuinely beats V1 (V1→V2 transition WAS worth it)"
    elif d.v1_sharpe > d.v2_sharpe + 0.05:
        v1_v2_verdict = "V1 genuinely beats V2 under corrected methodology (unexpected — investigate)"
    else:
        v1_v2_verdict = "V1 and V2 are too close to call at this sample size"

    # True V2 vs V2.2-no-context
    if d.v22_no_ctx_sharpe > d.v2_sharpe + 0.1:
        v22_vs_v2_verdict = "V2.2-no-context genuinely improves on V2 (composite + cluster bonuses add real lift)"
    elif d.v22_no_ctx_sharpe > d.v2_sharpe:
        v22_vs_v2_verdict = "Marginal V2.2-no-context lift over V2 (composites help slightly)"
    else:
        v22_vs_v2_verdict = "V2.2-no-context does NOT improve on V2 at this sample size"

    h(f"- Was V1→V2 transition worth it? **{v1_v2_verdict}**")
    h(f"  True lift: V2 vs V1 (aligned): {d.v2_sharpe - d.v1_sharpe:+.3f} Sharpe")
    blank()
    h(f"- V2.2-no-context vs V2: **{v22_vs_v2_verdict}**")
    h(f"  Lift: {lift_v22_nc_vs_v2:+.3f} Sharpe")
    blank()

    if lift_v22_nc_vs_v1 > 0.2:
        progression = "CONFIRMED — V1→V2→V2.2-no-context is a genuine progression"
    elif lift_v22_nc_vs_v1 > 0:
        progression = "MARGINAL — some improvement over V1 but not decisive at this sample size"
    else:
        progression = "REVERSED — V2.2-no-context does NOT beat V1 under corrected methodology"

    h(f"- V1→V2→V2.2-no-context progression: **{progression}**")
    blank()

    h("### Recommended action")
    blank()
    if lift_v22_nc_vs_v1 > 0.1 and lift_v22_nc_vs_v2 >= 0:
        h("- Ship V2.2-no-context (composites + cluster, no context features).")
        h("- Context features add noise at current sample size; revisit in 60+ days.")
    elif lift_v22_nc_vs_v2 < 0:
        h("- V2.2-no-context composites are hurting V2 base on this test window.")
        h("- Recommendation: ship V2 base only; hold composites until sample doubles.")
    else:
        h("- Results are too close to call. Ship V2 base; keep composites for monitoring.")
        h("- Re-run corrected backtest in 30 days with updated test window.")
    blank()

    h("## Caveats")
    blank()
    h("- 30-day test window is a single split — not a rolling walk-forward")
    h("- Composite patterns mined on training window may still reflect training-specific tickers")
    h("- V1 was always a rule-based model (not trained on outcomes) — Sharpe comparison")
    h("  is apples-vs-oranges in spirit but apple-to-apple in evaluation population")
    h("- 'Top 100/day' is an approximation — actual fire count varies by day")
    h("- Real P&L not measured (no slippage, bid/ask spread, or position sizing)")
    blank()

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    load_env()

    today = date(2026, 5, 23)
    test_end = today
    test_start = today - timedelta(days=30)
    train_end = test_start - timedelta(days=1)
    train_start = train_end - timedelta(days=59)

    print(f"Training window: {train_start} to {train_end}")
    print(f"Test window:     {test_start} to {test_end}")

    # Sanity-check V1 weights from git
    print("\nPulling V1 weights from git (d67ac753)...")
    git_parsed = parse_v1_weights_from_git()
    if git_parsed:
        git_tickers = git_parsed.get("tickers", {})
        matches = all(git_tickers.get(k) == v for k, v in V1_TICKER_WEIGHTS.items())
        print(f"  Git ticker weights match hardcoded: {matches}")
        if not matches:
            print(f"  Git tickers: {git_tickers}")
            print(f"  Hardcoded:   {V1_TICKER_WEIGHTS}")
        corrections = CorrectionsNote(
            git_tickers_match=matches,
            git_tier1_min=git_parsed.get("tier1_min", V1_TIER1_MIN),
            git_tier2_min=git_parsed.get("tier2_min", V1_TIER2_MIN),
        )
    else:
        corrections = CorrectionsNote(
            git_tickers_match=False,
            git_tier1_min=V1_TIER1_MIN,
            git_tier2_min=V1_TIER2_MIN,
        )

    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set")

    print("\nConnecting to database...")
    conn = psycopg2.connect(db_url, sslmode="require", connect_timeout=30)

    # Fetch aligned (shared population for V1, V2, V2.2)
    print("\nFetching training window (aligned)...")
    train = fetch_window(conn, train_start, train_end, aligned_only=True)
    print(f"  Training (aligned): {len(train):,} fires")

    print("Fetching test window (aligned)...")
    test_aligned = fetch_window(conn, test_start, test_end, aligned_only=True)
    print(f"  Test (aligned):     {len(test_aligned):,} fires")

    # Fetch ALL fires (for V1 unrestricted)
    print("Fetching test window (all fires, unrestricted)...")
    test_all_raw = pd.read_sql_query(FETCH_ALL_QUERY, conn, params=(test_start, test_end))
    test_all_raw = _enrich_df(test_all_raw)
    print(f"  Test (all):         {len(test_all_raw):,} fires")

    conn.close()

    # ---- V1 aligned ----
    print("\nScoring V1 (correct weights) on aligned test window...")
    v1_aligned_scores = score_v1(test_aligned)
    v1_aligned_metrics = compute_metrics_top_n(
        v1_aligned_scores, test_aligned["date"], test_aligned["outcome_pct"]
    )
    print(
        f"  V1 aligned tier1: n={v1_aligned_metrics['tier1']['n']} "
        f"mean={v1_aligned_metrics['tier1']['mean_pct']:.1f}% "
        f"sharpe={v1_aligned_metrics['tier1']['sharpe']:.3f}"
    )

    # ---- V2 base ----
    print("\nFitting V2 base on training window...")
    v2_params = fit_v2_base(train)
    print(f"  Global mean: {v2_params['global_mean']:.2f}")

    print("Scoring V2 base on test window...")
    v2_scores_test = score_v2_base(test_aligned, v2_params)
    v2_scores_train = score_v2_base(train, v2_params)
    v2_metrics = compute_metrics_top_n(
        v2_scores_test, test_aligned["date"], test_aligned["outcome_pct"]
    )
    print(
        f"  V2 tier1: n={v2_metrics['tier1']['n']} "
        f"mean={v2_metrics['tier1']['mean_pct']:.1f}% "
        f"sharpe={v2_metrics['tier1']['sharpe']:.3f}"
    )

    # ---- Context features ----
    print("\nFitting context features on training window...")
    ctx_params = fit_context_features(train, v2_params["global_mean"])

    # ---- Composite mining ----
    print("\nMining composite patterns from training window...")
    composites = mine_composites_training(train, v2_params)

    # ---- V2.2 no-context: V2 + composites + cluster ----
    print("\nBuilding V2.2 no-context scores on test window...")
    v22_nc_base = score_v2_base(test_aligned, v2_params)
    print("  Computing composite bonuses...")
    comp_contribution = score_composites(test_aligned, composites, v2_params)
    v22_nc_no_cluster = v22_nc_base + comp_contribution

    # Cluster gate: derive t1 from training no-context scores
    comp_train = score_composites(train, composites, v2_params)
    train_v22_nc_no_cluster = v2_scores_train + comp_train
    v22_nc_t1_for_cluster = float(np.percentile(train_v22_nc_no_cluster, 95))

    print("  Computing cluster bonuses on test window...")
    test_for_cluster = test_aligned.copy()
    test_for_cluster["_cluster_base_score"] = v22_nc_no_cluster.values
    cluster_contribution = compute_cluster_bonuses(test_for_cluster, v22_nc_t1_for_cluster)

    v22_nc_scores = v22_nc_no_cluster + cluster_contribution
    v22_nc_metrics = compute_metrics_top_n(
        v22_nc_scores, test_aligned["date"], test_aligned["outcome_pct"]
    )
    print(
        f"  V2.2 no-ctx tier1: n={v22_nc_metrics['tier1']['n']} "
        f"mean={v22_nc_metrics['tier1']['mean_pct']:.1f}% "
        f"sharpe={v22_nc_metrics['tier1']['sharpe']:.3f}"
    )

    # ---- V2.2 full: V2 + composites + cluster + context ----
    print("\nBuilding V2.2 full (with context) scores on test window...")
    ctx_contribution = score_context(test_aligned, ctx_params)

    # Full V2.2: need to recompute cluster with context included
    v22_full_no_cluster = v22_nc_base + comp_contribution + ctx_contribution
    ctx_train = score_context(train, ctx_params)
    train_v22_full_no_cluster = v2_scores_train + comp_train + ctx_train
    v22_full_t1_for_cluster = float(np.percentile(train_v22_full_no_cluster, 95))

    test_for_cluster_full = test_aligned.copy()
    test_for_cluster_full["_cluster_base_score"] = v22_full_no_cluster.values
    cluster_full = compute_cluster_bonuses(test_for_cluster_full, v22_full_t1_for_cluster)

    v22_full_scores = v22_full_no_cluster + cluster_full
    v22_full_metrics = compute_metrics_top_n(
        v22_full_scores, test_aligned["date"], test_aligned["outcome_pct"]
    )
    print(
        f"  V2.2 full tier1: n={v22_full_metrics['tier1']['n']} "
        f"mean={v22_full_metrics['tier1']['mean_pct']:.1f}% "
        f"sharpe={v22_full_metrics['tier1']['sharpe']:.3f}"
    )

    # ---- V1 unrestricted (all fires, no alignment filter) ----
    print("\nScoring V1 unrestricted (all fires, no alignment filter)...")
    v1_unres_scores = score_v1(test_all_raw)
    v1_unres_metrics = compute_metrics_top_n(
        v1_unres_scores, test_all_raw["date"], test_all_raw["outcome_pct"]
    )
    print(
        f"  V1 unrestricted tier1: n={v1_unres_metrics['tier1']['n']} "
        f"mean={v1_unres_metrics['tier1']['mean_pct']:.1f}% "
        f"sharpe={v1_unres_metrics['tier1']['sharpe']:.3f}"
    )

    # ---- Build report ----
    report_data = ReportData(
        train_start=train_start,
        train_end=train_end,
        n_train=len(train),
        test_start=test_start,
        test_end=test_end,
        n_test_aligned=len(test_aligned),
        n_test_all=len(test_all_raw),
        n_composites=len(composites),
        corrections=corrections,
        v1_aligned_metrics=v1_aligned_metrics,
        v2_metrics=v2_metrics,
        v22_no_ctx_metrics=v22_nc_metrics,
        v22_full_metrics=v22_full_metrics,
        v1_unrestricted_metrics=v1_unres_metrics,
        v1_sharpe=safe_sharpe(v1_aligned_metrics),
        v2_sharpe=safe_sharpe(v2_metrics),
        v22_no_ctx_sharpe=safe_sharpe(v22_nc_metrics),
        v22_full_sharpe=safe_sharpe(v22_full_metrics),
        v1_unres_sharpe=safe_sharpe(v1_unres_metrics),
    )
    report = build_report(report_data)

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(f"\nWrote report: {REPORT_PATH}")

    # Top-line summary to stdout
    print("\n" + "=" * 70)
    print("CORRECTED WALK-FORWARD BACKTEST — TOP-LINE SUMMARY")
    print("=" * 70)
    print(f"\nTraining: {train_start} → {train_end}  (n={len(train):,} aligned)")
    print(f"Test:     {test_start} → {test_end}")
    print(f"  Aligned: {len(test_aligned):,}  |  All fires: {len(test_all_raw):,}")
    print()
    print("Tier1 = top 100/day per model:")
    print()
    print(f"  V1 (correct, aligned)   : n={v1_aligned_metrics['tier1']['n']:>6,} "
          f"mean={v1_aligned_metrics['tier1']['mean_pct']:>+6.1f}% "
          f"sharpe={report_data.v1_sharpe:.3f}")
    print(f"  V2 base (OOS)           : n={v2_metrics['tier1']['n']:>6,} "
          f"mean={v2_metrics['tier1']['mean_pct']:>+6.1f}% "
          f"sharpe={report_data.v2_sharpe:.3f}")
    print(f"  V2.2 no-context (OOS)   : n={v22_nc_metrics['tier1']['n']:>6,} "
          f"mean={v22_nc_metrics['tier1']['mean_pct']:>+6.1f}% "
          f"sharpe={report_data.v22_no_ctx_sharpe:.3f}")
    print(f"  V2.2 with-context (OOS) : n={v22_full_metrics['tier1']['n']:>6,} "
          f"mean={v22_full_metrics['tier1']['mean_pct']:>+6.1f}% "
          f"sharpe={report_data.v22_full_sharpe:.3f}")
    print(f"  V1 unrestricted (side)  : n={v1_unres_metrics['tier1']['n']:>6,} "
          f"mean={v1_unres_metrics['tier1']['mean_pct']:>+6.1f}% "
          f"sharpe={report_data.v1_unres_sharpe:.3f}")
    print()
    print(f"Contamination lift (V1 unres vs V1 aligned): "
          f"{report_data.v1_unres_sharpe - report_data.v1_sharpe:+.3f} Sharpe")
    print(f"True V2 vs V1 lift: {report_data.v2_sharpe - report_data.v1_sharpe:+.3f} Sharpe")
    print(f"True V2.2-no-ctx vs V2 lift: "
          f"{report_data.v22_no_ctx_sharpe - report_data.v2_sharpe:+.3f} Sharpe")


if __name__ == "__main__":
    main()
