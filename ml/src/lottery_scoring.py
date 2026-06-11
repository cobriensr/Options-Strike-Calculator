"""
Lottery fire scoring model — rescore-v1 (2026-05-22).

Trains a linear per-feature uplift model on the last 90 days of aligned
lottery fires and emits ml/output/lottery_score_weights.json.

Outcome metric: COALESCE(realized_flow_inversion_pct, realized_eod_pct)
  → "flow-inversion exit or held-to-EOD proxy" per spec decision 2.

Alignment gate (spec decision 6): only fires where option direction agrees
  with the cum_ncp/npp flow at trigger time are included in training.
  Call = ncp > npp, Put = npp > ncp.

Drops (spec decisions 3, 7):
  - inferred_structure IS NOT NULL (35% enrichment bug in structure rows)
  - rows where realized_flow_inversion_pct > peak_ceiling_pct * 1.05 (0.5%
    bug tail in non-structure rows)
  - reload_tagged (UI badge only, negative EV found in EDA)
  - range_pos_at_trigger (no signal)
  - trigger_iv (outlier data quality issue, defer)

Features modeled (in order of EDA lift concentration):
  1. tod (categorical: AM_open, MID, LUNCH, PM)
  2. dte (categorical: 0, 1, 2, 3)
  3. trigger_vol_to_oi_window (quintile, inverted-U, Q3 sweet spot)
  4. gamma_at_trigger (quintile, Q4 highest mean)
  5. trigger_ask_pct (quintile, monotonic-decreasing)
  6. option_type (C vs P)
  7. underlying_symbol (per-ticker, clamped [-5, +10])

V2.2 Phase D context features (spx_spot_charm_oi, spx_spot_vanna_oi,
mkt_tide_ncp, mkt_tide_npp, mkt_tide_diff, mkt_tide_otm_diff,
spx_spot_gamma_oi) are EXCLUDED from training.

Walk-forward backtest (commit f5029e6a, report docs/tmp/v22-walk-forward-
backtest-2026-05-23.md) found these 7 context features are systematically
overfit: removing them from V2.2 IMPROVES out-of-sample tier1 Sharpe by
+0.099 (the largest single contributor to the V2.2 underperformance).
The code-path in score_components.py and the TS function signature keep the
context parameters as optional/dormant so they can be re-enabled in the
future without a flag day.

Run: ml/.venv/bin/python ml/src/lottery_scoring.py
     (DATABASE_URL sourced from repo-root .env)

WARNING — Phase 2 of the rescore project (`scripts/sync_lottery_score_weights.py`)
is not yet updated to read this new schema or output path. Until Phase 2 ships:
  - Output writes to `ml/output/` (new path) — NOT `ml/data/` where the current
    sync script reads.
  - Nightly `make refit` will keep regenerating the OLD `ml/data/` weights via
    the unchanged sync script — which currently re-reads its own stale input.
  - There is no regression: production scoring keeps using the existing TS
    weights file until Phase 2-5 wires this new model in.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

# conftest.py at repo root adds ml/src/ to sys.path for pytest; running
# directly, we need it in place for `from utils import ...`
sys.path.insert(0, str(Path(__file__).resolve().parent))

from utils import get_connection

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Weight normalization: max contribution per feature is ~6-8 pts to stay
# within the existing magnitude conventions (MODE_WEIGHTS / TOD_WEIGHTS were
# 0-5 range in v0).  Scale is chosen per-feature to hit that target.
TOD_SCALE = 8.0
DTE_SCALE = 6.0
VOL_OI_SCALE = 5.0
GAMMA_SCALE = 5.0
ASK_PCT_SCALE = 6.0
OPT_TYPE_SCALE = 4.0
TICKER_CLAMP_MIN = -5
TICKER_CLAMP_MAX = 10

# Minimum observations required for a bucket / ticker to get a real weight
# instead of falling back to 0 (global mean). Bucket gets 30 (small categorical
# / quintile populations); ticker gets 100 (we have ~80 tickers across 150k
# fires, so a typical ticker has ~1.8k fires — 100 is a conservative floor).
MIN_OBS_BUCKET = 30
MIN_OBS_TICKER = 100


# ---------------------------------------------------------------------------
# Data fetch
# ---------------------------------------------------------------------------

FETCH_QUERY = """
SELECT
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
    date
FROM lottery_finder_fires
WHERE
    date >= CURRENT_DATE - INTERVAL '90 days'
    -- alignment gate (cum_ncp/npp must both be non-null)
    AND cum_ncp_at_fire IS NOT NULL
    AND cum_npp_at_fire IS NOT NULL
    -- hard alignment filter (spec decision 6)
    AND (
        (option_type = 'C' AND cum_ncp_at_fire > cum_npp_at_fire)
        OR (option_type = 'P' AND cum_npp_at_fire > cum_ncp_at_fire)
    )
    -- drop structure rows (enrichment bug; spec decision 7)
    AND inferred_structure IS NULL
    -- require at least one outcome column to be non-null
    AND COALESCE(realized_flow_inversion_pct, realized_eod_pct) IS NOT NULL
ORDER BY date
"""


def fetch_training_data() -> pd.DataFrame:
    """Fetch aligned, filtered fires and return as DataFrame with outcome_pct."""
    print("Connecting to database...")
    conn = get_connection()
    print("Fetching training data...")
    df = pd.read_sql_query(FETCH_QUERY, conn)
    conn.close()
    print(f"Fetched {len(df):,} rows before final filters")

    # Compute outcome column (spec decision 2)
    df["outcome_pct"] = df["realized_flow_inversion_pct"].combine_first(
        df["realized_eod_pct"]
    )

    # Drop the 0.5% of non-structure rows with the enrichment bug
    # (flow_inv > peak_ceiling * 1.05 is mathematically impossible for clean data)
    pre_len = len(df)
    mask_bug = (
        df["realized_flow_inversion_pct"].notna()
        & df["peak_ceiling_pct"].notna()
        & (df["realized_flow_inversion_pct"] > df["peak_ceiling_pct"] * 1.05)
    )
    df = df[~mask_bug].copy()
    dropped = pre_len - len(df)
    if dropped > 0:
        print(f"Dropped {dropped:,} rows with flow_inv > peak*1.05 (enrichment bug)")

    print(f"Final training sample: {len(df):,} rows")
    return df


# ---------------------------------------------------------------------------
# Feature bucket helpers
# ---------------------------------------------------------------------------

def quintile_boundaries(series: pd.Series) -> list[float]:
    """Compute the 4 quintile cut-points (Q1/Q2/Q3/Q4/Q5 boundaries)."""
    clean = series.dropna()
    return [float(np.percentile(clean, p)) for p in [20, 40, 60, 80]]


def assign_quintile(series: pd.Series, boundaries: list[float]) -> pd.Series:
    """Map series values to quintile labels 0-4 (Q1=0 ... Q5=4)."""
    return pd.cut(
        series,
        bins=[-np.inf] + boundaries + [np.inf],
        labels=[0, 1, 2, 3, 4],
        right=True,
    ).astype(float)


# ---------------------------------------------------------------------------
# Weight computation
# ---------------------------------------------------------------------------

def compute_categorical_weights(
    df: pd.DataFrame,
    feature_col: str,
    categories: list[str | int],
    scale: float,
    global_mean: float,
) -> dict[str, int]:
    """
    Per-bucket mean uplift, normalized by spread, scaled, rounded to int.

    weight_bucket = round(scale * (mean_bucket - global_mean) / spread)

    where spread = max_mean - min_mean across the valid buckets.
    Returns dict {str(category): int_weight}.
    """
    bucket_means: dict[str, float] = {}
    for cat in categories:
        subset = df[df[feature_col] == cat]["outcome_pct"]
        if len(subset) >= MIN_OBS_BUCKET:
            bucket_means[str(cat)] = float(subset.mean())
        else:
            bucket_means[str(cat)] = global_mean  # fallback to global

    spread = max(bucket_means.values()) - min(bucket_means.values())
    if spread < 1e-6:
        return {k: 0 for k in bucket_means}

    weights: dict[str, int] = {}
    for cat, mean_val in bucket_means.items():
        raw = scale * (mean_val - global_mean) / spread
        weights[cat] = int(round(raw))

    return weights


def compute_quintile_weights(
    df: pd.DataFrame,
    quintile_col: str,
    scale: float,
    global_mean: float,
) -> list[int]:
    """
    Same logic as compute_categorical_weights, but for quintile features
    stored as integer labels 0-4. Returns list of 5 ints [Q1_w, ..., Q5_w].
    """
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

    weights: list[int] = []
    for q in range(5):
        raw = scale * (bucket_means[q] - global_mean) / spread
        weights.append(int(round(raw)))

    return weights


def compute_ticker_weights(
    df: pd.DataFrame,
    global_mean: float,
    min_obs: int = MIN_OBS_TICKER,
) -> dict[str, int]:
    """
    Per-ticker: clamp mean-uplift weights to [TICKER_CLAMP_MIN, TICKER_CLAMP_MAX].

    Scale: use ASK_PCT_SCALE (6) so a ticker at +2× global_mean gets ~+6 pts.
    Tickers with < min_obs fires fall back to 0.
    """
    ticker_stats = (
        df.groupby("underlying_symbol")["outcome_pct"]
        .agg(["mean", "count"])
        .rename(columns={"mean": "mean_outcome", "count": "n"})
    )

    # Compute global spread (max ticker mean - min ticker mean among reliable tickers)
    reliable = ticker_stats[ticker_stats["n"] >= min_obs]
    if len(reliable) < 2:
        # Fall back to a fixed spread if not enough reliable tickers
        spread = max(global_mean, 10.0)
    else:
        spread = float(reliable["mean_outcome"].max() - reliable["mean_outcome"].min())
        if spread < 1e-6:
            spread = max(global_mean, 10.0)

    weights: dict[str, int] = {}
    for ticker, row in ticker_stats.iterrows():
        if row["n"] < min_obs:
            weights[str(ticker)] = 0
            continue
        raw = ASK_PCT_SCALE * (row["mean_outcome"] - global_mean) / spread
        clamped = int(round(max(TICKER_CLAMP_MIN, min(TICKER_CLAMP_MAX, raw))))
        weights[str(ticker)] = clamped

    return weights


# ---------------------------------------------------------------------------
# Score application
# ---------------------------------------------------------------------------

def apply_weights(
    df: pd.DataFrame,
    weights: dict,
    vol_oi_boundaries: list[float],
    gamma_boundaries: list[float],
    ask_pct_boundaries: list[float],
) -> pd.Series:
    """Apply the full additive weight model to df, return score Series."""
    score = pd.Series(0.0, index=df.index)
    f = weights["features"]

    # TOD
    tod_w = f["tod_weights"]
    score += df["tod"].map(tod_w).fillna(0)

    # DTE (capped at 3)
    dte_w = f["dte_weights"]
    score += df["dte"].clip(upper=3).astype(str).map(dte_w).fillna(0)

    # Vol/OI quintile
    vol_q = assign_quintile(df["trigger_vol_to_oi_window"], vol_oi_boundaries)
    vol_w = f["vol_oi_quintile_weights"]
    score += vol_q.map(lambda q: vol_w[int(q)] if not pd.isna(q) else 0)

    # Gamma quintile (drops NULLs → 0 contribution)
    gamma_q = assign_quintile(df["gamma_at_trigger"], gamma_boundaries)
    gamma_w = f["gamma_quintile_weights"]
    score += gamma_q.map(lambda q: gamma_w[int(q)] if not pd.isna(q) else 0)

    # Ask pct quintile
    ask_q = assign_quintile(df["trigger_ask_pct"], ask_pct_boundaries)
    ask_w = f["ask_pct_quintile_weights"]
    score += ask_q.map(lambda q: ask_w[int(q)] if not pd.isna(q) else 0)

    # Option type
    opt_w = f["option_type_weights"]
    score += df["option_type"].map(opt_w).fillna(0)

    # Ticker
    ticker_w = f["ticker_weights"]
    score += df["underlying_symbol"].map(ticker_w).fillna(0)

    # NOTE: V2.2 Phase D context features (spx_spot_charm_oi, spx_spot_vanna_oi,
    # spx_spot_gamma_oi, mkt_tide_ncp, mkt_tide_npp, mkt_tide_diff,
    # mkt_tide_otm_diff) are intentionally excluded.
    # Walk-forward validation (2026-05-23) found them systematically overfit:
    # removing them improves OOS tier1 Sharpe by +0.099. They are dormant in
    # score_components.py and the TS function signature for future re-evaluation.

    return score


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    df = fetch_training_data()

    global_mean = float(df["outcome_pct"].mean())
    print(f"\nGlobal mean outcome_pct: {global_mean:.2f}")
    print(f"Sample: {len(df):,} rows | date range: {df['date'].min()} → {df['date'].max()}")

    # ---- Quintile boundaries (computed from training set) ----
    vol_oi_boundaries = quintile_boundaries(df["trigger_vol_to_oi_window"])
    gamma_boundaries = quintile_boundaries(df["gamma_at_trigger"])
    ask_pct_boundaries = quintile_boundaries(df["trigger_ask_pct"])

    print(f"\nVol/OI quintile boundaries: {[round(b,4) for b in vol_oi_boundaries]}")
    print(f"Gamma quintile boundaries:  {[round(b,4) for b in gamma_boundaries]}")
    print(f"Ask_pct quintile boundaries:{[round(b,4) for b in ask_pct_boundaries]}")

    # ---- Add quintile columns to df ----
    df["vol_q"] = assign_quintile(df["trigger_vol_to_oi_window"], vol_oi_boundaries)
    df["gamma_q"] = assign_quintile(df["gamma_at_trigger"], gamma_boundaries)
    df["ask_q"] = assign_quintile(df["trigger_ask_pct"], ask_pct_boundaries)

    # ---- TOD weights ----
    tod_weights = compute_categorical_weights(
        df, "tod", ["AM_open", "MID", "LUNCH", "PM"], TOD_SCALE, global_mean
    )
    print(f"\nTOD weights: {tod_weights}")

    # ---- Monday-specific TOD weights (per lineage finding 2026-05-22) ----
    # 90-day data shows Monday's TOD outcome pattern is fully inverted from
    # Tue-Fri: AM_open is the WORST Monday slot (-22.4 mean) while LUNCH is
    # the only positive Monday slot (+5.2). The global weights assign +4 to
    # AM_open and -4 to LUNCH, which is backwards on Mondays.
    # Only Monday is added here — other DOWs may follow once more data
    # accumulates (the lineage spec calls for a 10-day re-validation window).
    df["date"] = pd.to_datetime(df["date"])
    df["day_of_week"] = df["date"].dt.day_name()
    monday_df = df[df["day_of_week"] == "Monday"].copy()
    monday_global_mean = float(monday_df["outcome_pct"].mean()) if len(monday_df) > 0 else global_mean
    print(f"\nMonday subset: {len(monday_df):,} rows | mean outcome_pct: {monday_global_mean:.2f}")
    if len(monday_df) >= MIN_OBS_BUCKET * 2:
        monday_tod_weights = compute_categorical_weights(
            monday_df, "tod", ["AM_open", "MID", "LUNCH", "PM"],
            TOD_SCALE, monday_global_mean
        )
        print(f"Monday TOD weights: {monday_tod_weights}")
        print(f"  (vs global TOD weights: {tod_weights})")
        tod_weights_dow_overrides: dict[str, dict[str, int]] = {"Monday": monday_tod_weights}
    else:
        print(
            f"WARNING: Monday subset too small ({len(monday_df)} rows < {MIN_OBS_BUCKET * 2} "
            f"minimum) — skipping Monday TOD override. Falling back to global weights."
        )
        tod_weights_dow_overrides = {}

    # ---- DTE weights ----
    df["dte_str"] = df["dte"].clip(upper=3).astype(int).astype(str)
    dte_weights_raw = compute_categorical_weights(
        df, "dte_str", ["0", "1", "2", "3"], DTE_SCALE, global_mean
    )
    dte_weights = {k: dte_weights_raw[k] for k in ["0", "1", "2", "3"]}
    print(f"DTE weights: {dte_weights}")

    # ---- Vol/OI quintile weights ----
    vol_oi_weights = compute_quintile_weights(df, "vol_q", VOL_OI_SCALE, global_mean)
    print(f"Vol/OI quintile weights (Q1→Q5): {vol_oi_weights}")

    # ---- Gamma quintile weights ----
    # Gamma has ~40k NULLs — quintiles computed on non-null subset only;
    # NULL gamma rows contribute 0 to score (no gamma signal).
    gamma_weights = compute_quintile_weights(df, "gamma_q", GAMMA_SCALE, global_mean)
    print(f"Gamma quintile weights (Q1→Q5): {gamma_weights}")

    # ---- Ask pct quintile weights ----
    ask_pct_weights = compute_quintile_weights(df, "ask_q", ASK_PCT_SCALE, global_mean)
    print(f"Ask_pct quintile weights (Q1→Q5): {ask_pct_weights}")

    # ---- Option type weights ----
    opt_type_weights = compute_categorical_weights(
        df, "option_type", ["C", "P"], OPT_TYPE_SCALE, global_mean
    )
    print(f"Option type weights: {opt_type_weights}")

    # ---- Ticker weights ----
    ticker_weights = compute_ticker_weights(df, global_mean, min_obs=100)
    print(f"Ticker weights ({len(ticker_weights)} tickers): "
          f"min={min(ticker_weights.values())}, max={max(ticker_weights.values())}")

    # ---- Build weights dict ----
    weights = {
        "model_version": "rescore-v1-2026-05-22",
        "trained_at": datetime.now(UTC).isoformat(),
        "training_sample": {
            "n": int(len(df)),
            "date_range": [
                str(df["date"].min()),
                str(df["date"].max()),
            ],
            "filters_applied": [
                "last 90 days",
                "aligned only (cum_ncp > cum_npp for calls, vice versa for puts)",
                "inferred_structure IS NULL (enrichment bug on structure rows)",
                "realized_flow_inversion_pct <= peak_ceiling_pct * 1.05",
                "outcome_pct = COALESCE(realized_flow_inversion_pct, realized_eod_pct)",
            ],
        },
        "features": {
            "tod_weights": {k: int(v) for k, v in tod_weights.items()},
            "tod_weights_dow_overrides": {
                dow: {k: int(v) for k, v in w.items()}
                for dow, w in tod_weights_dow_overrides.items()
            },
            "dte_weights": {k: int(v) for k, v in dte_weights.items()},
            "vol_oi_quintile_weights": [int(w) for w in vol_oi_weights],
            "vol_oi_quintile_boundaries": [float(b) for b in vol_oi_boundaries],
            "gamma_quintile_weights": [int(w) for w in gamma_weights],
            "gamma_quintile_boundaries": [float(b) for b in gamma_boundaries],
            "ask_pct_quintile_weights": [int(w) for w in ask_pct_weights],
            "ask_pct_quintile_boundaries": [float(b) for b in ask_pct_boundaries],
            "option_type_weights": {k: int(v) for k, v in opt_type_weights.items()},
            "ticker_weights": {k: int(v) for k, v in ticker_weights.items()},
            # NOTE: V2.2 Phase D context feature blocks (spx_spot_charm_oi etc.)
            # intentionally absent — overfit as of walk-forward 2026-05-23.
            # score_components.py and the TS function handle their absence
            # gracefully (each context component defaults to 0).
        },
    }

    # ---- Compute scores on training set ----
    print("\nApplying weights to training set to derive cutoffs and validation...")
    scores = apply_weights(
        df, weights, vol_oi_boundaries, gamma_boundaries, ask_pct_boundaries
    )
    df["score"] = scores

    # ---- Cutoffs: t1 = 95th percentile, t2 = 85th percentile ----
    t1 = int(round(np.percentile(scores, 95)))
    t2 = int(round(np.percentile(scores, 85)))
    weights["cutoffs"] = {
        "t1": t1,
        "t2": t2,
        "derivation": "Phase 1 placeholder: 95th/85th percentile of training-set score distribution. To be re-derived in Phase 5 against the full post-backfill distribution; values may shift.",
    }
    print(f"\nCutoffs: t1={t1} (95th pct), t2={t2} (85th pct) — PLACEHOLDER, Phase 5 will re-derive")

    # ---- Validation metrics ----
    tier1 = df[df["score"] >= t1]
    tier2 = df[(df["score"] >= t2) & (df["score"] < t1)]
    tier3 = df[df["score"] < t2]

    spearman_r, spearman_p = stats.spearmanr(df["score"], df["outcome_pct"])

    weights["validation"] = {
        "tier1_count": int(len(tier1)),
        "tier2_count": int(len(tier2)),
        "tier3_count": int(len(tier3)),
        "tier1_mean_outcome_pct": float(tier1["outcome_pct"].mean()) if len(tier1) > 0 else 0.0,
        "tier2_mean_outcome_pct": float(tier2["outcome_pct"].mean()) if len(tier2) > 0 else 0.0,
        "tier3_mean_outcome_pct": float(tier3["outcome_pct"].mean()) if len(tier3) > 0 else 0.0,
        "spearman_score_outcome": float(spearman_r),
        "spearman_p_value": float(spearman_p),
    }

    # ---- Write output ----
    # Preserve manually-curated fields from any prior weights JSON so
    # retraining doesn't nuke them. This is the recovery path for the
    # Phase D step 1 regression where retraining wiped the Phase B
    # composite_bonuses block (caught by failing tests in commit
    # b9315b73 follow-up). Fields preserved:
    #   - features.composite_bonuses (human-curated mining-derived overrides)
    # If you add more human-curated fields, list them here too.
    output_dir = Path(__file__).resolve().parent.parent / "output"
    output_dir.mkdir(exist_ok=True)
    output_path = output_dir / "lottery_score_weights.json"

    PRESERVED_FEATURE_KEYS = ["composite_bonuses"]
    if output_path.exists():
        try:
            prior = json.loads(output_path.read_text())
            prior_features = prior.get("features", {})
            for k in PRESERVED_FEATURE_KEYS:
                if k in prior_features:
                    weights["features"][k] = prior_features[k]
                    print(f"[preserve] carried over features.{k} from prior JSON")
        except (json.JSONDecodeError, OSError) as e:
            print(f"[preserve] couldn't read prior JSON ({e}); skipping preservation")

    with open(output_path, "w") as f:
        json.dump(weights, f, indent=2)

    print(f"\nWrote weights to: {output_path}")

    # ---- Summary table (printed to stdout) ----
    print("\n" + "=" * 70)
    print("RESCORE-V1 MODEL SUMMARY")
    print("=" * 70)
    print(f"\nTraining sample: {len(df):,} rows  |  global mean outcome_pct: {global_mean:.1f}%")
    print("\nTOD weights (target: AM_open > PM):")
    for k, v in tod_weights.items():
        bar = "#" * (v + 5)
        print(f"  {k:10s}: {v:+4d}  {bar}")

    print("\nDTE weights (target: '1' > '0'):")
    for k in ["0", "1", "2", "3"]:
        v = dte_weights[k]
        bar = "#" * (v + 5)
        print(f"  DTE {k}: {v:+4d}  {bar}")

    print("\nVol/OI quintile weights (target: Q3 highest):")
    for i, w in enumerate(vol_oi_weights):
        lo = vol_oi_boundaries[i - 1] if i > 0 else 0
        hi = vol_oi_boundaries[i] if i < 4 else float("inf")
        bar = "#" * (w + 5)
        print(f"  Q{i+1} [{lo:.3f},{hi:.3f}): {w:+4d}  {bar}")

    print("\nGamma quintile weights (target: Q4 highest or near-top):")
    for i, w in enumerate(gamma_weights):
        lo = gamma_boundaries[i - 1] if i > 0 else 0
        hi = gamma_boundaries[i] if i < 4 else float("inf")
        bar = "#" * (w + 5)
        print(f"  Q{i+1} [{lo:.4f},{hi:.4f}): {w:+4d}  {bar}")

    print("\nAsk_pct quintile weights (target: Q1 highest, monotonic-decreasing):")
    for i, w in enumerate(ask_pct_weights):
        lo = ask_pct_boundaries[i - 1] if i > 0 else 0.0
        hi = ask_pct_boundaries[i] if i < 4 else 1.0
        bar = "#" * (w + 5)
        print(f"  Q{i+1} [{lo:.3f},{hi:.3f}): {w:+4d}  {bar}")

    print(f"\nOption type weights: C={opt_type_weights.get('C', 0):+d}, P={opt_type_weights.get('P', 0):+d}")
    print("\nTicker weights (non-zero only):")
    nonzero = {k: v for k, v in sorted(ticker_weights.items(), key=lambda x: -x[1]) if v != 0}
    for ticker, w in nonzero.items():
        bar = "#" * (w + 6)
        print(f"  {ticker:8s}: {w:+4d}  {bar}")

    print(f"\nCutoffs: t1={t1}, t2={t2}")
    print("\nTier distribution (training set):")
    print(f"  Tier 1 (score >= {t1}): {len(tier1):6,}  | mean outcome: {weights['validation']['tier1_mean_outcome_pct']:.1f}%")
    print(f"  Tier 2 (score >= {t2}): {len(tier2):6,}  | mean outcome: {weights['validation']['tier2_mean_outcome_pct']:.1f}%")
    print(f"  Tier 3 (score <  {t2}): {len(tier3):6,}  | mean outcome: {weights['validation']['tier3_mean_outcome_pct']:.1f}%")

    print(f"\nSpearman(score, outcome_pct): r={spearman_r:.4f}, p={spearman_p:.2e}")

    # ---- Verification assertions ----
    print("\n" + "=" * 70)
    print("VERIFICATION CHECKS")
    print("=" * 70)

    # Each check is (label, passed, detail, hard).
    #
    # HARD checks gate the build — a failure means a genuine bug (e.g. a NaN
    # weight, which would corrupt scoring) and must abort the nightly pipeline.
    #
    # ADVISORY checks (hard=False) are regime-sensitive heuristics about the
    # EXPECTED SHAPE of the weights, not correctness. They legitimately flip on
    # normal market activity — e.g. a put-dominant down market makes puts
    # outperform calls (flips "C > P"), and this model's signal is inherently
    # weak so the Spearman bounces around zero. We still print them (they're a
    # useful "review before leaning on these weights" signal), but they do NOT
    # fail `make refit` / the nightly pipeline.
    checks: list[tuple[str, bool, str, bool]] = [
        (
            "TOD: AM_open > PM",
            tod_weights.get("AM_open", 0) > tod_weights.get("PM", 0),
            f"AM_open={tod_weights.get('AM_open')}, PM={tod_weights.get('PM')}",
            False,
        ),
        (
            "DTE: '1' > '0'",
            dte_weights.get("1", 0) > dte_weights.get("0", 0),
            f"DTE1={dte_weights.get('1')}, DTE0={dte_weights.get('0')}",
            False,
        ),
        (
            "Vol/OI: Q3 is highest weight",
            vol_oi_weights[2] == max(vol_oi_weights),
            f"weights={vol_oi_weights}",
            False,
        ),
        (
            "Ask_pct: Q1 >= Q5 (monotonic start)",
            ask_pct_weights[0] >= ask_pct_weights[4],
            f"Q1={ask_pct_weights[0]}, Q5={ask_pct_weights[4]}",
            False,
        ),
        (
            "Option type: C > P",
            opt_type_weights.get("C", 0) > opt_type_weights.get("P", 0),
            f"C={opt_type_weights.get('C')}, P={opt_type_weights.get('P')}",
            False,
        ),
        (
            "All ticker weights numeric (no NaN)",
            all(isinstance(v, int) and not pd.isna(v) for v in ticker_weights.values()),
            f"{len(ticker_weights)} tickers checked",
            True,  # HARD: a NaN weight is a real bug.
        ),
        (
            "Spearman r > 0.05 (some signal)",
            spearman_r > 0.05,
            f"r={spearman_r:.4f}",
            False,
        ),
    ]

    hard_failed = False
    soft_failed = False
    for label, passed, detail, hard in checks:
        status = "PASS" if passed else "FAIL"
        tag = "" if passed else ("  [HARD]" if hard else "  [advisory]")
        print(f"  [{status}] {label}  ({detail}){tag}")
        if not passed:
            if hard:
                hard_failed = True
            else:
                soft_failed = True

    if hard_failed:
        print(
            "\nHARD verification check FAILED (genuine bug, e.g. NaN weights) — "
            "aborting; weights not safe to use."
        )
        sys.exit(1)
    elif soft_failed:
        print(
            "\nAdvisory checks failed — these are regime-sensitive heuristics "
            "(e.g. a put-dominant regime flips 'C > P', or a noisy near-zero "
            "Spearman). Weights were written; review before leaning on them. "
            "This does NOT block the nightly pipeline."
        )
    else:
        print("\nAll verification checks passed.")

    # ---- EDA-vs-clean inversion warnings ----
    # The EDA memo (docs/tmp/lottery-rescore-eda-2026-05-22.md) was run against
    # data that included structure-tagged rows with a 35% enrichment bug. Some
    # feature lifts shift when we train on the clean (non-structure) subset.
    # Flag any inversions here so a human reviewer can decide whether the
    # clean-data signal is real or an artifact of the enrichment fix.
    print("\nEDA vs clean-data sign check:")
    if gamma_weights[3] != max(gamma_weights):
        # EDA said Q4 (0.041-0.066) had highest mean (267). Clean data may differ.
        best_q = gamma_weights.index(max(gamma_weights)) + 1
        print(
            f"  WARNING: Gamma highest weight is at Q{best_q}, not Q4 as the EDA "
            f"memo predicted. Clean data shows weights={gamma_weights}. The EDA "
            f"was on contaminated data; the clean signal is what gets trained. "
            f"Worth verifying in Phase 7."
        )
    if ask_pct_weights[0] != max(ask_pct_weights):
        # EDA said Q1 (0.52-0.53) had highest mean (108). Clean data may differ.
        best_q = ask_pct_weights.index(max(ask_pct_weights)) + 1
        print(
            f"  WARNING: Ask_pct highest weight is at Q{best_q}, not Q1 as the EDA "
            f"memo predicted. Clean data shows weights={ask_pct_weights}. Same "
            f"caveat as gamma above."
        )


if __name__ == "__main__":
    main()
