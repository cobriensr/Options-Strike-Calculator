"""
Lottery fire score training: the training half of the nightly refit.

Trains a linear per-feature uplift model on a 90-day window of aligned,
single-leg lottery fires and returns it as a validated weights object, the shape
``lottery_weights.validate_weights`` checks and the TypeScript scorer reads.
Nothing here writes: no JSON file, no database row. The nightly refit step calls
``fetch_frame`` and ``train_weights`` and stores the result itself; run by hand,
``main`` prints a dry run.

The training population is defined once (plan D7, docs/superpowers/plans/
2026-11-05-nightly-pipeline-phase4.md), in ``TRAINING_FILTER_SQL``:
  - aligned: a call needs cum_ncp > cum_npp at the fire, a put the reverse, both
    non-null (spec decision 6);
  - ``SINGLE_LEG_FILTER``: the exchange's own trade code marks the anchor print
    as a single-leg trade; multi-leg, stock-tied and unknown rows stay out;
  - an outcome present.
The window is explicit: ``date > start AND date <= end``, with the end the
session the refit trains through. No query asks the database for the date.
``drop_bug_rows`` then drops, in pandas, rows with
realized_flow_inversion_pct > peak_ceiling_pct * 1.05, a value impossible for
clean data.

Outcome metric: COALESCE(realized_flow_inversion_pct, realized_eod_pct), a
flow-inversion exit with a held-to-EOD fallback (spec decision 2). It is the
``outcome_pct`` column ``fetch_frame`` builds.

Features modeled (in order of EDA lift concentration):
  1. tod (categorical: AM_open, MID, LUNCH, PM), with a Monday table
  2. dte (categorical: 0, 1, 2, 3)
  3. trigger_vol_to_oi_window (quintile, inverted-U, Q3 sweet spot)
  4. gamma_at_trigger (quintile, Q4 highest mean)
  5. trigger_ask_pct (quintile, monotonic-decreasing)
  6. option_type (C vs P)
  7. underlying_symbol (per-ticker, clamped [-5, +10])
Not trained: reload_tagged (UI badge only, negative EV found in EDA),
range_pos_at_trigger (no signal), trigger_iv (outlier data quality issue).

The composite bonuses and the feed cutoffs are not trained. ``train_weights``
copies them from the version it is given as ``base``.

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

Run by hand: ml/.venv/Scripts/python ml/src/lottery_scoring.py --through YYYY-MM-DD
(DATABASE_URL from the repo-root .env). It reads and prints and writes nothing.

This file is copied into the nightly image (Python 3.12) with lottery_weights.py
and lottery_refit_gates.py. At import it needs numpy, pandas and those two
files: scipy and ``utils`` (psycopg2) load inside ``main``, which the image
never calls, and nothing here is newer than 3.12.
"""

from __future__ import annotations

import argparse
import copy
import logging
from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any

import numpy as np
import pandas as pd

from lottery_refit_gates import OUTCOME_COLUMN, TRAIN_WINDOW_DAYS
from lottery_weights import (
    SCHEMA_VERSION,
    SCORE_COLUMNS,
    WeightsInvalid,
    load_pointer,
    score_frame,
    validate_weights,
)

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# The training method, stored as the weights object's model_version.
MODEL_VERSION = "rescore-v1-2026-05-22"

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

TOD_BUCKETS = ("AM_open", "MID", "LUNCH", "PM")

# A flow-inversion value above peak_ceiling_pct times this is the enrichment
# bug's signature: the exit cannot beat the session's peak.
BUG_PEAK_MULTIPLE = 1.05

# (the stem of the weights object's keys, the fire column, the scale)
_QUINTILE_FEATURES = (
    ("vol_oi", "trigger_vol_to_oi_window", VOL_OI_SCALE),
    ("gamma", "gamma_at_trigger", GAMMA_SCALE),
    ("ask_pct", "trigger_ask_pct", ASK_PCT_SCALE),
)


# ---------------------------------------------------------------------------
# The training population (plan D7)
# ---------------------------------------------------------------------------

# The one definition of "not part of a multi-leg structure" for the lottery
# refit. Keeps only fires whose anchor print the exchange's OPRA trade code
# marks as a single-leg trade (migration #197). Multi-leg, stock-tied and NULL
# (unknown) rows are excluded on purpose.
SINGLE_LEG_FILTER = "anchor_leg_kind = 'single'"

# The population as a WHERE-clause body, without a date window. There is no
# filter on how the inversion was sourced: a row still waiting for its tape
# inversion falls back to realized_eod_pct through the outcome's COALESCE.
TRAINING_FILTER_SQL = f"""
    cum_ncp_at_fire IS NOT NULL
    AND cum_npp_at_fire IS NOT NULL
    AND (
        (option_type = 'C' AND cum_ncp_at_fire > cum_npp_at_fire)
        OR (option_type = 'P' AND cum_npp_at_fire > cum_ncp_at_fire)
    )
    AND {SINGLE_LEG_FILTER}
    AND COALESCE(realized_flow_inversion_pct, realized_eod_pct) IS NOT NULL
"""

# What ``score_frame`` reads (it includes ``date``), plus the columns the
# outcome is built from.
TRAINING_COLUMNS = (
    *SCORE_COLUMNS,
    "realized_flow_inversion_pct",
    "realized_eod_pct",
    "peak_ceiling_pct",
)

_TEXT_COLUMNS = ("underlying_symbol", "option_type", "tod")
_NUMERIC_COLUMNS = tuple(
    c for c in TRAINING_COLUMNS if c not in (*_TEXT_COLUMNS, "date")
)
_SELECT_LIST = ", ".join(TRAINING_COLUMNS)

_FETCH_SQL = f"""
SELECT {_SELECT_LIST}
FROM lottery_finder_fires
WHERE date > %s AND date <= %s
    AND {TRAINING_FILTER_SQL}
ORDER BY date
"""


def drop_bug_rows(df: pd.DataFrame) -> pd.DataFrame:
    """The rows of ``df`` without the enrichment-bug signature.

    A row whose realized_flow_inversion_pct is above peak_ceiling_pct times
    ``BUG_PEAK_MULTIPLE`` is dropped: that is impossible for clean data. A row
    with no inversion yet (it scores on the EOD fallback) or no peak is kept:
    a comparison with NaN is False. Returns a copy; ``df`` is left alone.
    """
    bug = df["realized_flow_inversion_pct"] > df["peak_ceiling_pct"] * BUG_PEAK_MULTIPLE
    return df[~bug].copy()


def fetch_frame(conn: Any, start: date, end: date) -> pd.DataFrame:
    """The training population with ``date > start AND date <= end``.

    ``conn`` is a psycopg2 connection; this runs one SELECT. The frame has the
    ``TRAINING_COLUMNS`` as floats (text columns and ``date`` as they come) and
    ``outcome_pct``, the flow-inversion value or, where there is none yet, the
    EOD one. Rows with the enrichment-bug signature are dropped.
    """
    with conn.cursor() as cur:
        cur.execute(_FETCH_SQL, (start, end))
        rows = cur.fetchall()
    df = pd.DataFrame(rows, columns=list(TRAINING_COLUMNS))
    # NUMERIC arrives as Decimal in an object column.
    for column in _NUMERIC_COLUMNS:
        df[column] = pd.to_numeric(df[column]).astype("float64")
    df[OUTCOME_COLUMN] = df["realized_flow_inversion_pct"].combine_first(
        df["realized_eod_pct"]
    )
    kept = drop_bug_rows(df)
    dropped = len(df) - len(kept)
    if dropped:
        _log.info("Dropped %s rows with flow_inv > peak*1.05 (enrichment bug)", dropped)
    return kept


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
# Training
# ---------------------------------------------------------------------------


def train_weights(
    df: pd.DataFrame, *, base: Mapping[str, Any], trained_through: date
) -> dict[str, Any]:
    """Train a weights object on ``df``, a frame ``fetch_frame`` returns.

    Returns a new object that passed ``validate_weights``. Reads and writes
    nothing else: ``df`` and ``base`` are left as they were.

    * The feature tables (tod with its Monday override, DTE, three quintile
      features, option type, tickers) are trained on ``df``.
    * ``composite_bonuses`` and ``feed_cutoffs`` are copied from ``base``. The
      composites are curated by hand, and the feed cutoffs are matched to the
      active version by the refit step after training.
    * ``cutoffs`` t1 and t2 are the 95th and 85th percentile of the score the
      full scorer (``score_frame``: composites, weekday tables, gates) gives
      the rows of ``df``, rounded. Rows the scorer gates out (a DTE outside
      0-3) have no score and take no part.

    Raises ``WeightsInvalid`` when ``base`` or the result breaks a rule: a
    feature with no spread (equal quintile boundaries) or cutoffs that round to
    the same number. Raises a plain ``ValueError`` for a frame with no rows or
    none the scorer scores.
    """
    validate_weights(base)
    if df.empty:
        raise ValueError("train_weights: no training rows")

    work = df.copy()
    global_mean = float(work[OUTCOME_COLUMN].mean())
    features: dict[str, Any] = {}

    features["tod_weights"] = compute_categorical_weights(
        work, "tod", list(TOD_BUCKETS), TOD_SCALE, global_mean
    )

    # Monday-specific TOD weights (lineage finding 2026-05-22). The 90-day data
    # showed Monday's TOD pattern inverted from Tue-Fri: AM_open was the worst
    # Monday slot and LUNCH the only positive one, the reverse of the global
    # table. Only Monday has an override; other weekdays may follow once more
    # data has accumulated.
    weekday = pd.to_datetime(work["date"]).dt.day_name()
    monday = work[weekday == "Monday"]
    overrides: dict[str, dict[str, int]] = {}
    if len(monday) >= MIN_OBS_BUCKET * 2:
        overrides["Monday"] = compute_categorical_weights(
            monday,
            "tod",
            list(TOD_BUCKETS),
            TOD_SCALE,
            float(monday[OUTCOME_COLUMN].mean()),
        )
    else:
        _log.warning(
            "Monday subset too small (%s rows < %s): no Monday TOD override",
            len(monday),
            MIN_OBS_BUCKET * 2,
        )
    features["tod_weights_dow_overrides"] = overrides

    work["dte_str"] = work["dte"].clip(upper=3).astype(int).astype(str)
    features["dte_weights"] = compute_categorical_weights(
        work, "dte_str", ["0", "1", "2", "3"], DTE_SCALE, global_mean
    )

    # A NULL feature value (gamma has many) gets no quintile and adds 0 to a
    # score; the boundaries come from the non-null rows.
    for stem, column, scale in _QUINTILE_FEATURES:
        bounds = quintile_boundaries(work[column])
        if any(b <= a for a, b in zip(bounds, bounds[1:])):
            # pd.cut would raise a bare ValueError on equal edges; this is the
            # error the validator gives for the same object.
            raise WeightsInvalid(f"features.{stem}_quintile_boundaries", "increasing")
        work["quintile"] = assign_quintile(work[column], bounds)
        features[f"{stem}_quintile_weights"] = compute_quintile_weights(
            work, "quintile", scale, global_mean
        )
        features[f"{stem}_quintile_boundaries"] = bounds

    features["option_type_weights"] = compute_categorical_weights(
        work, "option_type", ["C", "P"], OPT_TYPE_SCALE, global_mean
    )
    features["ticker_weights"] = compute_ticker_weights(work, global_mean)
    features["composite_bonuses"] = copy.deepcopy(base["features"]["composite_bonuses"])

    weights: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "model_version": MODEL_VERSION,
        "trained_through": trained_through.isoformat(),
        "features": features,
        # score_frame validates its input, so the object needs a valid pair
        # before it can score; the real pair is derived from those scores.
        "cutoffs": {"t1": 1, "t2": 0},
        "feed_cutoffs": copy.deepcopy(base["feed_cutoffs"]),
    }
    scores = score_frame(weights, work).dropna()
    if scores.empty:
        raise ValueError("train_weights: no scorable rows (DTE outside 0-3?)")
    values = scores.to_numpy(dtype="float64")
    weights["cutoffs"] = {
        "t1": int(round(float(np.percentile(values, 95)))),
        "t2": int(round(float(np.percentile(values, 85)))),
    }
    validate_weights(weights)
    return weights


# ---------------------------------------------------------------------------
# Main: a dry run
# ---------------------------------------------------------------------------


def _print_summary(
    df: pd.DataFrame,
    weights: Mapping[str, Any],
    scores: pd.Series,
    rho: float,
    p_value: float,
) -> None:
    f = weights["features"]
    t1, t2 = weights["cutoffs"]["t1"], weights["cutoffs"]["t2"]
    print(
        f"Training sample: {len(df):,} rows, {df['date'].nunique()} sessions, "
        f"{df['date'].min()} to {df['date'].max()}"
    )
    print(f"Global mean {OUTCOME_COLUMN}: {df[OUTCOME_COLUMN].mean():.2f}")
    print(f"\nTOD weights: {f['tod_weights']}")
    print(
        f"Monday TOD override: {f['tod_weights_dow_overrides'].get('Monday', 'none')}"
    )
    print(f"DTE weights: {f['dte_weights']}")
    for stem, label in (
        ("vol_oi", "Vol/OI"),
        ("gamma", "Gamma"),
        ("ask_pct", "Ask_pct"),
    ):
        bounds = [round(b, 4) for b in f[f"{stem}_quintile_boundaries"]]
        print(f"{label} quintile boundaries: {bounds}")
        print(f"{label} quintile weights (Q1-Q5): {f[f'{stem}_quintile_weights']}")
    print(f"Option type weights: {f['option_type_weights']}")
    ticker_weights = f["ticker_weights"]
    nonzero = {
        k: v for k, v in sorted(ticker_weights.items(), key=lambda kv: -kv[1]) if v
    }
    print(f"Ticker weights ({len(ticker_weights)} tickers): {nonzero}")
    print(f"\nComposites kept from the active version: {len(f['composite_bonuses'])}")
    print(f"Feed cutoffs kept from the active version: {weights['feed_cutoffs']}")
    print(f"Cutoffs: t1={t1} (p95), t2={t2} (p85)")

    scored = scores.notna()
    score = scores[scored].astype("float64")
    outcome = df.loc[scored, OUTCOME_COLUMN]
    print("\nTier distribution (training set):")
    for name, mask in (
        (f"Tier 1 (score >= {t1})", score >= t1),
        (f"Tier 2 (score >= {t2})", (score >= t2) & (score < t1)),
        (f"Tier 3 (score <  {t2})", score < t2),
    ):
        print(
            f"  {name}: {int(mask.sum()):6,} | mean outcome {outcome[mask].mean():.1f}%"
        )
    print(
        f"\nIn-sample Spearman(score, {OUTCOME_COLUMN}): r={rho:.4f}, p={p_value:.2e}"
    )
    print("\nDry run: nothing was written.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Dry run of the lottery refit's training: read the training window "
            "that ends at --through, train weights and print them. Writes "
            "nothing."
        )
    )
    parser.add_argument(
        "--through",
        type=date.fromisoformat,
        required=True,
        metavar="YYYY-MM-DD",
        help="the last session of the window; it starts 90 days before",
    )
    args = parser.parse_args()

    # A hand run needs these; the nightly image has neither.
    from scipy import stats

    from utils import get_connection

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    start = args.through - timedelta(days=TRAIN_WINDOW_DAYS)
    conn = get_connection()
    try:
        conn.set_session(readonly=True)
        df = fetch_frame(conn, start, args.through)
        _, base = load_pointer(conn, "active")
    finally:
        conn.close()

    weights = train_weights(df, base=base, trained_through=args.through)
    scores = score_frame(weights, df)
    scored = scores.notna()
    rho, p_value = stats.spearmanr(
        scores[scored].astype("float64"), df.loc[scored, OUTCOME_COLUMN]
    )
    _print_summary(df, weights, scores, float(rho), float(p_value))


if __name__ == "__main__":
    main()
