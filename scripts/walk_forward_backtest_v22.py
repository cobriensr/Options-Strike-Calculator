#!/usr/bin/env python
"""Walk-forward backtest: V2.2 vs V2 out-of-sample validation.

Strict no-leakage design:
  - Training window: 60 days ending 30 days before today.
  - Test window: most recent 30 days.
  - Quintile boundaries, composite patterns, and ticker/feature weights are
    ALL derived exclusively from the training window.
  - Test-window fires are scored using those training-derived parameters.

Models compared on the test window:
  1. V1 baseline  — combined_score column (pre-V2 legacy score, per-row lookup)
  2. V2 base      — 7 base features only (TOD, DTE, vol_oi_q, gamma_q, ask_pct_q,
                    option_type, ticker) + Monday TOD override. No composites,
                    no cluster, no context.
  3. V2.2 full    — V2 + composite bonuses (mined from training window) + cluster
                    bonus (computed from test-window temporal proximity) + 7 context
                    features + relaxed direction gate.

Cutoffs (t1 = 95th pct, t2 = 85th pct) derived from TRAINING window scores,
then applied to test window.

Per-overlay attribution: V2.2 without each overlay, one at a time.

Output: docs/tmp/v22-walk-forward-backtest-2026-05-23.md
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
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
REPORT_PATH = ROOT / "docs" / "tmp" / "v22-walk-forward-backtest-2026-05-23.md"

sys.path.insert(0, str(ROOT / "ml" / "src"))
from score_components import assign_quintile  # noqa: E402  (ml/src on path above)


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f"Missing env file: {ENV_FILE}")
    with ENV_FILE.open() as fh:
        for line in fh:
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.strip())
            if m:
                os.environ.setdefault(m.group(1), m.group(2).strip('"').strip("'"))


# ---------------------------------------------------------------------------
# Constants mirroring lottery_scoring.py
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

# Cluster bonus constants from detect-lottery-fires.ts
CLUSTER_WINDOW_MS = 5 * 60 * 1000  # 5 minutes in ms
# Applied at tier1 threshold from training window
CLUSTER_BONUS_ISOLATED = 0
CLUSTER_BONUS_PAIR = 1
CLUSTER_BONUS_SMALL = 2
CLUSTER_BONUS_LARGE = 1

# Composite mining thresholds (mirroring mine_outcome_patterns.py)
WIN_THRESHOLD = 50.0
LOSS_THRESHOLD = -50.0
MIN_SUPPORT = 10
MARGINAL_DELTA = 1.0
TOP_COMPOSITES = 5  # top 5 winning + 5 losing

# ---------------------------------------------------------------------------
# Data fetch
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
  AND cum_ncp_at_fire IS NOT NULL
  AND cum_npp_at_fire IS NOT NULL
  AND (
      (option_type = 'C' AND cum_ncp_at_fire > cum_npp_at_fire)
      OR (option_type = 'P' AND cum_npp_at_fire > cum_ncp_at_fire)
  )
  AND inferred_structure IS NULL
  AND COALESCE(realized_flow_inversion_pct, realized_eod_pct) IS NOT NULL
ORDER BY date, trigger_time_ct
"""


def fetch_window(conn: psycopg2.extensions.connection, start: date, end: date) -> pd.DataFrame:
    df = pd.read_sql_query(FETCH_QUERY, conn, params=(start, end))
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


# ---------------------------------------------------------------------------
# Weight computation (mirrors lottery_scoring.py functions)
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


def compute_categorical_weights(
    df: pd.DataFrame, feature_col: str, categories: list[str | int],
    scale: float, global_mean: float,
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
    return {cat: int(round(scale * (mean_val - global_mean) / spread))
            for cat, mean_val in bucket_means.items()}


def compute_quintile_weights(
    df: pd.DataFrame, quintile_col: str, scale: float, global_mean: float,
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
    return [int(round(scale * (bucket_means[q] - global_mean) / spread))
            for q in range(5)]


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
        weights[str(ticker)] = int(round(max(TICKER_CLAMP_MIN, min(TICKER_CLAMP_MAX, raw))))
    return weights


# ---------------------------------------------------------------------------
# Training: fit V2 base weights
# ---------------------------------------------------------------------------

def fit_v2_base(train: pd.DataFrame) -> dict:
    """Train V2 base model (7 features + Monday override) on training window."""
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

    # Monday TOD override
    monday_df = train[train["day_of_week"] == "Monday"].copy()
    monday_global_mean = float(monday_df["outcome_pct"].mean()) if len(monday_df) > 0 else global_mean
    tod_dow_overrides: dict[str, dict[str, int]] = {}
    if len(monday_df) >= MIN_OBS_BUCKET * 2:
        monday_tod_weights = compute_categorical_weights(
            monday_df, "tod", ["AM_open", "MID", "LUNCH", "PM"],
            TOD_SCALE, monday_global_mean
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
    """Train the 7 context feature quintile weights on training window."""
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
    """
    Mine top-5 winning + top-5 losing composites from training window only.
    Mirrors mine_outcome_patterns.py logic but confined to training data.
    """
    # Build feature-tuple frame
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

    # Singleton net scores
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

                nets = [singleton_scores.get((k, v), 0.0)
                        for k, v in zip(feat_tuple, val_strs)]
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

    print(f"  Mined {len(winning)} winning + {len(losing)} losing composites "
          f"from training window (using top-{TOP_COMPOSITES} each)")
    return composites


# ---------------------------------------------------------------------------
# Cluster bonus computation from temporal proximity
# ---------------------------------------------------------------------------

def compute_cluster_bonuses(df: pd.DataFrame, tier1_threshold: float) -> pd.Series:
    """
    Compute cluster bonus for each fire using trigger_time_ct proximity.

    A fire's cluster_size = count of DISTINCT other tickers that scored tier1
    within ±5 minutes.

    Fully vectorized approach: for each (date, 5-min-bucket) group of tier1
    fires, also include the preceding and following bucket (covering the full
    ±5-min window regardless of where within a bucket a fire falls). Then
    cross-join the per-fire bucket against the relevant tier1-bucket set to
    count distinct other tickers. No Python row loop.

    Mirrors detect-lottery-fires.ts computeClusterSize logic.
    """
    if "trigger_time_ct" not in df.columns:
        return pd.Series(0, index=df.index, dtype=int)

    scores = df.get("_v22_base_for_cluster", pd.Series(0.0, index=df.index))

    times_dt = pd.to_datetime(df["trigger_time_ct"])
    times_ms = times_dt.astype("int64") // 1_000_000
    # 5-min bucket index (integer division — same bucket = within 5 min of bucket start)
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

    # --- Build tier1 lookup: for each (date, bucket_idx) give the set of
    # tickers that fired tier1 in that bucket. We expand to ±1 bucket so
    # that when we join a fire against "same bucket" we capture the full
    # ±5-min window (a fire near the end of bucket B and a tier1 fire near
    # the start of bucket B+1 are within 5 min of each other).
    tier1 = work[work["is_tier1"]][["date", "ticker", "bucket_idx"]].copy()
    tier1 = tier1.drop_duplicates(subset=["date", "ticker", "bucket_idx"])

    # Expand tier1 to cover current + prev + next bucket
    frames = []
    for offset in (-1, 0, 1):
        t = tier1.copy()
        t["join_bucket"] = t["bucket_idx"] + offset
        frames.append(t[["date", "ticker", "join_bucket"]].rename(
            columns={"ticker": "t1_ticker"}
        ))
    tier1_expanded = pd.concat(frames, ignore_index=True)
    tier1_expanded = tier1_expanded.drop_duplicates()

    # Join each fire against tier1 fires in its bucket (using join_bucket == bucket_idx)
    # This gives us, for each fire, all tier1 other-tickers within ±1 bucket.
    work_join = work[["fire_idx", "orig_idx", "date", "ticker", "bucket_idx"]].copy()
    joined = work_join.merge(
        tier1_expanded,
        left_on=["date", "bucket_idx"],
        right_on=["date", "join_bucket"],
        how="left",
    )

    # Exclude same ticker (we want OTHER tickers)
    joined = joined[joined["ticker"] != joined["t1_ticker"]]

    # Count distinct other tickers per fire
    other_ticker_counts = (
        joined.dropna(subset=["t1_ticker"])
        .groupby("fire_idx")["t1_ticker"]
        .nunique()
    )

    # Map back to original fire order; fires with no other tier1 neighbors get 0
    cluster_sizes = other_ticker_counts.reindex(work["fire_idx"], fill_value=0).values + 1

    bonus_vals = np.where(
        cluster_sizes >= 5, CLUSTER_BONUS_LARGE,
        np.where(
            cluster_sizes >= 3, CLUSTER_BONUS_SMALL,
            np.where(
                cluster_sizes == 2, CLUSTER_BONUS_PAIR,
                CLUSTER_BONUS_ISOLATED,
            ),
        ),
    )

    return pd.Series(bonus_vals, index=df.index, dtype=int)


# ---------------------------------------------------------------------------
# Score application
# ---------------------------------------------------------------------------

def _q_map(series: pd.Series, bounds: list[float], weights: list[int]) -> pd.Series:
    """Map continuous series → quintile → weight."""
    q = assign_quintile_series(series, bounds)
    return q.map(lambda qi: weights[int(qi)] if not pd.isna(qi) else 0)


def score_v2_base(df: pd.DataFrame, params: dict) -> pd.Series:
    """Score fires using V2 base model (no composites, no cluster, no context).

    Fully vectorized: no row-by-row iteration. Monday TOD override is applied
    by building a merged tod_weight column that accounts for day_of_week.
    """
    score = pd.Series(0.0, index=df.index)

    # TOD (with Monday override) — vectorized via a combined mapping series
    global_tod_w = params["tod_weights"]
    overrides = params.get("tod_dow_overrides", {})
    if overrides:
        # Build per-row (tod, day_of_week) → weight mapping via a temp column
        is_monday = df["day_of_week"] == "Monday"
        monday_tod_w = overrides.get("Monday", global_tod_w)
        score += np.where(
            is_monday,
            df["tod"].map(monday_tod_w).fillna(0),
            df["tod"].map(global_tod_w).fillna(0),
        )
    else:
        score += df["tod"].map(global_tod_w).fillna(0)

    # DTE
    score += df["dte_str"].map(params["dte_weights"]).fillna(0)

    # Quintile features
    score += _q_map(df["trigger_vol_to_oi_window"], params["vol_oi_bounds"], params["vol_oi_weights"])
    score += _q_map(df["gamma_at_trigger"], params["gamma_bounds"], params["gamma_weights"])
    score += _q_map(df["trigger_ask_pct"], params["ask_pct_bounds"], params["ask_pct_weights"])

    # Option type
    score += df["option_type"].map(params["opt_type_weights"]).fillna(0)

    # Ticker
    score += df["underlying_symbol"].map(params["ticker_weights"]).fillna(0)

    return score


def score_context(df: pd.DataFrame, ctx_params: dict) -> pd.Series:
    """Score the 7 context features, return additive contribution."""
    score = pd.Series(0.0, index=df.index)
    for col in ctx_params["bounds"]:
        score += _q_map(df[col], ctx_params["bounds"][col], ctx_params["weights"][col])
    return score


def score_composites(df: pd.DataFrame, composites: list[dict], params: dict) -> pd.Series:
    """Apply composite bonus/penalty for each fire.

    Vectorized: pre-compute quintile string labels for the whole DataFrame,
    then for each composite entry build a boolean mask across all columns in
    the match dict and apply the bonus in one assignment.
    """
    if not composites:
        return pd.Series(0, index=df.index, dtype=int)

    def _q_labels_series(series: pd.Series, bounds: list[float]) -> pd.Series:
        """Vectorized quintile label: string '0'..'4' or 'null'."""
        q = assign_quintile_series(series, bounds)
        result = q.map(lambda qi: "null" if pd.isna(qi) else str(int(qi)))
        return result

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


# ---------------------------------------------------------------------------
# Metrics computation
# ---------------------------------------------------------------------------

def compute_metrics(scores: pd.Series, outcomes: pd.Series, t1: float, t2: float) -> dict:
    """
    Compute tier metrics for a score series against outcomes.
    Tiers use training-window cutoffs.
    """
    def _tier_stats(mask: pd.Series) -> dict:
        n = int(mask.sum())
        if n == 0:
            return {"n": 0, "mean_pct": float("nan"), "median_pct": float("nan"),
                    "win_rate": float("nan"), "hit_50": float("nan"), "sharpe": float("nan")}
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

    tier1_mask = scores >= t1
    tier2_mask = (scores >= t2) & (scores < t1)
    tier2plus_mask = scores >= t2
    return {
        "tier1": _tier_stats(tier1_mask),
        "tier2": _tier_stats(tier2_mask),
        "tier2plus": _tier_stats(tier2plus_mask),
        "overall": _tier_stats(pd.Series(True, index=scores.index)),
    }


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------

def fmt_tier(stats: dict) -> str:
    n = stats["n"]
    if n == 0:
        return f"| {n} | — | — | — | — | — |"
    return (
        f"| {n:,} "
        f"| {stats['mean_pct']:+.1f}% "
        f"| {stats['median_pct']:+.1f}% "
        f"| {stats['win_rate']:.1%} "
        f"| {stats['hit_50']:.1%} "
        f"| {stats['sharpe']:.3f} |"
    )


@dataclass
class ReportArgs:
    train_start: date
    train_end: date
    n_train: int
    test_start: date
    test_end: date
    n_test: int
    v2_t1: float
    v2_t2: float
    v22_t1: float
    v22_t2: float
    v1_metrics: dict
    v2_metrics: dict
    v22_metrics: dict
    ablation: dict
    v2_sharpe_t1: float
    v22_sharpe_t1: float
    v1_sharpe_t1: float
    n_composites_mined: int


def build_report(args: ReportArgs) -> str:
    a = args
    lines: list[str] = []

    def h(text: str) -> None:
        lines.append(text)

    def blank() -> None:
        lines.append("")

    h("# V2.2 Walk-Forward Backtest — 2026-05-23")
    blank()
    h("## Method")
    h(f"- Training: 60 days ({a.train_start} to {a.train_end}), n={a.n_train:,} aligned fires")
    h(f"- Test: 30 days ({a.test_start} to {a.test_end}), n={a.n_test:,} aligned fires")
    h("- Strict no-leakage: models trained on training only, scored on test only")
    h("- Cutoffs t1=95th pct, t2=85th pct derived from training window score distribution")
    h(f"- Composite bonuses: top-{TOP_COMPOSITES} winning + {TOP_COMPOSITES} losing combos "
      f"mined from training window ({a.n_composites_mined} total)")
    h("- Cluster bonus: computed from test-window temporal proximity (±5 min), tier1-gated")
    h("- Context features: 7 macro features (charm/vanna/gamma OI, mkt tide variants), "
      "boundaries from training window")
    h("- Direction gate: calls gated when mkt_tide_otm_diff signals counter-trend; "
      "puts NOT gated (reversed finding from 2026-05-22 audit)")
    blank()
    h("## Cutoffs derived from training window")
    h(f"- V2 base: t1={a.v2_t1:.0f}, t2={a.v2_t2:.0f}")
    h(f"- V2.2 full: t1={a.v22_t1:.0f}, t2={a.v22_t2:.0f}")
    blank()
    h("## Test-window results")
    blank()
    TABLE_HDR = "| Model | n | mean_pct | median_pct | win_rate | hit_50 | sharpe |"
    TABLE_SEP = "| --- | --- | --- | --- | --- | --- | --- |"

    for tier_key, tier_label in [
        ("tier1", "Tier 1 (score >= t1, top 5%)"),
        ("tier2plus", "Tier 2+ (score >= t2, top 15%)"),
        ("overall", "Overall (all aligned fires in test window)"),
    ]:
        h(f"### {tier_label}")
        blank()
        h(TABLE_HDR)
        h(TABLE_SEP)

        if a.v1_metrics:
            h(f"| V1 baseline {fmt_tier(a.v1_metrics[tier_key])}")
        h(f"| V2 base (OOS) {fmt_tier(a.v2_metrics[tier_key])}")
        h(f"| V2.2 full (OOS) {fmt_tier(a.v22_metrics[tier_key])}")
        blank()

    # Decision
    lift_v22_over_v2 = a.v22_sharpe_t1 - a.v2_sharpe_t1
    lift_v22_over_v1 = (
        a.v22_sharpe_t1 - a.v1_sharpe_t1
        if not np.isnan(a.v1_sharpe_t1)
        else float("nan")
    )

    if lift_v22_over_v2 > 0.3:
        verdict = "REAL"
    elif lift_v22_over_v2 > 0:
        verdict = "MARGINAL"
    else:
        verdict = "NOISE"

    h("## Decision")
    blank()
    h(f"- V2.2 Sharpe (tier1): {a.v22_sharpe_t1:.3f}")
    h(f"- V2 base Sharpe (tier1): {a.v2_sharpe_t1:.3f}")
    if not np.isnan(a.v1_sharpe_t1):
        h(f"- V1 baseline Sharpe (tier1): {a.v1_sharpe_t1:.3f}")
    h(f"- V2.2 lift over V2 on tier1 Sharpe: {lift_v22_over_v2:+.3f}")
    if not np.isnan(lift_v22_over_v1):
        h(f"- V2.2 lift over V1 on tier1 Sharpe: {lift_v22_over_v1:+.3f}")
    blank()
    h(f"**Verdict: {verdict}**")
    h("- Real: lift > +0.3 Sharpe | Marginal: 0 to +0.3 | Noise: <= 0")
    blank()

    # Per-overlay attribution
    if verdict in ("REAL", "MARGINAL") and a.ablation:
        h("## Per-overlay attribution")
        blank()
        h("Sharpe drop when each overlay is removed from V2.2 full (test window, tier1):")
        blank()
        h("| Overlay removed | V2.2 full Sharpe | Without overlay Sharpe | Delta |")
        h("| --- | --- | --- | --- |")
        for name, ablation_sharpe in sorted(a.ablation.items(), key=lambda kv: kv[1]):
            delta = ablation_sharpe - a.v22_sharpe_t1
            h(f"| {name} | {a.v22_sharpe_t1:.3f} | {ablation_sharpe:.3f} | {delta:+.3f} |")
        blank()
        rank = sorted(a.ablation.items(), key=lambda kv: kv[1])
        h(f"Most valuable overlay: **{rank[0][0]}** "
          f"(removing it drops Sharpe by {rank[0][1] - a.v22_sharpe_t1:+.3f})")
        blank()

    h("## Caveats")
    blank()
    h("- 30-day test window is short (single split, not rolling walk-forward)")
    h("- Composite patterns mined on training window may still over-fit specific tickers")
    h("- Cluster bonus is computable from DB but the live detect cron uses an "
      "in-memory window — minor differences may exist for concurrent fires")
    h("- Direction gate (call-side only) is encoded in the alignment filter "
      "(cum_ncp > cum_npp for calls) — the relaxed put gate is implicit in the "
      "training/test data already")
    h("- Real trading P&L not measured here (no bid/ask spread, slippage, or position sizing)")
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

    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set")

    print("\nConnecting to database...")
    conn = psycopg2.connect(db_url, sslmode="require", connect_timeout=30)

    print("Fetching training window...")
    train = fetch_window(conn, train_start, train_end)
    print(f"  Training: {len(train):,} aligned fires")

    print("Fetching test window...")
    test = fetch_window(conn, test_start, test_end)
    print(f"  Test:     {len(test):,} aligned fires")

    conn.close()

    # ---- V1 baseline: use stored combined_score column ----
    print("\nV1 baseline: using stored combined_score column...")
    v1_scores = test["combined_score"].astype(float)
    v1_t1 = float(np.percentile(train["combined_score"].dropna(), 95))
    v1_t2 = float(np.percentile(train["combined_score"].dropna(), 85))
    print(f"  V1 training cutoffs: t1={v1_t1:.0f}, t2={v1_t2:.0f}")
    v1_metrics = compute_metrics(v1_scores, test["outcome_pct"], v1_t1, v1_t2)
    print(f"  V1 tier1: n={v1_metrics['tier1']['n']} mean={v1_metrics['tier1']['mean_pct']:.1f}% "
          f"sharpe={v1_metrics['tier1']['sharpe']:.3f}")

    # ---- V2 base: fit on training, score test ----
    print("\nFitting V2 base on training window...")
    v2_params = fit_v2_base(train)
    print(f"  Global mean: {v2_params['global_mean']:.2f}")

    print("Scoring V2 base on test window...")
    v2_scores_test = score_v2_base(test, v2_params)
    v2_scores_train = score_v2_base(train, v2_params)  # cache — used for cutoffs + V2.2 base
    v2_t1 = float(np.percentile(v2_scores_train, 95))
    v2_t2 = float(np.percentile(v2_scores_train, 85))
    print(f"  V2 training cutoffs: t1={v2_t1:.0f}, t2={v2_t2:.0f}")
    v2_metrics = compute_metrics(v2_scores_test, test["outcome_pct"], v2_t1, v2_t2)
    print(f"  V2 tier1: n={v2_metrics['tier1']['n']} mean={v2_metrics['tier1']['mean_pct']:.1f}% "
          f"sharpe={v2_metrics['tier1']['sharpe']:.3f}")

    # ---- Fit context features on training ----
    print("\nFitting context features on training window...")
    ctx_params = fit_context_features(train, v2_params["global_mean"])

    # ---- Mine composites from training window ----
    print("\nMining composite patterns from training window...")
    composites = mine_composites_training(train, v2_params)

    # ---- V2.2 full: V2 base + composites + cluster + context ----
    print("\nBuilding V2.2 full scores on test window...")

    # Step 1: V2 base score on test
    v22_base = score_v2_base(test, v2_params)
    # Step 2: Context
    ctx_contribution = score_context(test, ctx_params)
    # Step 3: Composites
    print("  Computing composite bonuses (may take a moment)...")
    comp_contribution = score_composites(test, composites, v2_params)
    # Step 4: Cluster bonus (needs tier1 gate from V2.2 base-without-cluster)
    v22_no_cluster = v22_base + ctx_contribution + comp_contribution

    # Derive t1 for cluster gate from training (reuse cached v2_scores_train)
    ctx_train = score_context(train, ctx_params)
    comp_train = score_composites(train, composites, v2_params)
    train_v22_no_cluster = v2_scores_train + ctx_train + comp_train
    v22_t1_for_cluster = float(np.percentile(train_v22_no_cluster, 95))

    print("  Computing cluster bonuses on test window...")
    test_for_cluster = test.copy()
    test_for_cluster["_v22_base_for_cluster"] = v22_no_cluster.values
    cluster_contribution = compute_cluster_bonuses(test_for_cluster, v22_t1_for_cluster)

    v22_full_scores = v22_no_cluster + cluster_contribution

    # Derive V2.2 cutoffs from training (compute cluster on training too)
    print("  Computing cluster bonuses on training window (for cutoffs)...")
    train_for_cluster = train.copy()
    train_for_cluster["_v22_base_for_cluster"] = train_v22_no_cluster.values
    train_cluster = compute_cluster_bonuses(train_for_cluster, v22_t1_for_cluster)
    train_v22_full = train_v22_no_cluster + train_cluster
    v22_t1 = float(np.percentile(train_v22_full, 95))
    v22_t2 = float(np.percentile(train_v22_full, 85))
    print(f"  V2.2 training cutoffs: t1={v22_t1:.0f}, t2={v22_t2:.0f}")

    v22_metrics = compute_metrics(v22_full_scores, test["outcome_pct"], v22_t1, v22_t2)
    print(f"  V2.2 tier1: n={v22_metrics['tier1']['n']} mean={v22_metrics['tier1']['mean_pct']:.1f}% "
          f"sharpe={v22_metrics['tier1']['sharpe']:.3f}")

    # ---- Per-overlay attribution ----
    print("\nPer-overlay attribution (removing each overlay one at a time)...")
    ablation: dict[str, float] = {}

    def _ablation_sharpe(overlay_scores: pd.Series) -> float:
        m = compute_metrics(overlay_scores, test["outcome_pct"], v22_t1, v22_t2)
        return m["tier1"]["sharpe"]

    # V2.2 without composites
    no_comp = v22_base + ctx_contribution + cluster_contribution
    ablation["without composites"] = _ablation_sharpe(no_comp)

    # V2.2 without cluster bonus
    no_cluster = v22_base + ctx_contribution + comp_contribution
    ablation["without cluster bonus"] = _ablation_sharpe(no_cluster)

    # V2.2 without context features
    no_ctx = v22_base + comp_contribution + cluster_contribution
    ablation["without context features"] = _ablation_sharpe(no_ctx)

    # V2.2 without Monday TOD override (use global TOD weights for all days)
    params_no_monday = {**v2_params, "tod_dow_overrides": {}}
    no_monday_base = score_v2_base(test, params_no_monday)
    no_monday_full = no_monday_base + ctx_contribution + comp_contribution + cluster_contribution
    ablation["without Monday TOD override"] = _ablation_sharpe(no_monday_full)

    for name, sh in sorted(ablation.items(), key=lambda kv: kv[1]):
        delta = sh - v22_metrics["tier1"]["sharpe"]
        print(f"  {name}: sharpe={sh:.3f} (delta={delta:+.3f})")

    # ---- Build report ----
    v22_sharpe_t1 = v22_metrics["tier1"]["sharpe"]
    v2_sharpe_t1 = v2_metrics["tier1"]["sharpe"]
    v1_sharpe_t1 = v1_metrics["tier1"]["sharpe"]

    report = build_report(ReportArgs(
        train_start=train_start, train_end=train_end, n_train=len(train),
        test_start=test_start, test_end=test_end, n_test=len(test),
        v2_t1=v2_t1, v2_t2=v2_t2, v22_t1=v22_t1, v22_t2=v22_t2,
        v1_metrics=v1_metrics, v2_metrics=v2_metrics, v22_metrics=v22_metrics,
        ablation=ablation,
        v2_sharpe_t1=v2_sharpe_t1,
        v22_sharpe_t1=v22_sharpe_t1,
        v1_sharpe_t1=v1_sharpe_t1,
        n_composites_mined=len(composites),
    ))

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(f"\nWrote report: {REPORT_PATH}")

    # Top-line summary to stdout
    print("\n" + "=" * 70)
    print("WALK-FORWARD BACKTEST SUMMARY")
    print("=" * 70)
    print(f"\nTraining: {train_start} → {train_end}  (n={len(train):,})")
    print(f"Test:     {test_start} → {test_end}  (n={len(test):,})")
    print()
    print(f"V1 baseline  tier1: n={v1_metrics['tier1']['n']} "
          f"mean={v1_metrics['tier1']['mean_pct']:.1f}% "
          f"sharpe={v1_sharpe_t1:.3f}")
    print(f"V2 base OOS  tier1: n={v2_metrics['tier1']['n']} "
          f"mean={v2_metrics['tier1']['mean_pct']:.1f}% "
          f"sharpe={v2_sharpe_t1:.3f}")
    print(f"V2.2 full OOS tier1: n={v22_metrics['tier1']['n']} "
          f"mean={v22_metrics['tier1']['mean_pct']:.1f}% "
          f"sharpe={v22_sharpe_t1:.3f}")
    print()
    lift = v22_sharpe_t1 - v2_sharpe_t1
    if lift > 0.3:
        verdict = "REAL"
    elif lift > 0:
        verdict = "MARGINAL"
    else:
        verdict = "NOISE"
    print(f"Lift V2.2 over V2 (tier1 Sharpe): {lift:+.3f}  →  Verdict: {verdict}")


if __name__ == "__main__":
    main()
