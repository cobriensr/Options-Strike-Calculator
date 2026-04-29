"""Outlier detection and scoring for the EOD options flow archive.

Multi-criteria scoring — each print earns 1 point per criterion satisfied,
default min_score=4 picks the genuine "needles in the haystack." Pure DataFrame
operations; no I/O except for the load_flow call inside `find_outliers`.

Spec: docs/superpowers/specs/options-flow-archive-2026-04-28.md (Phase 4)
"""

from __future__ import annotations

from datetime import date as dt_date

import polars as pl

# --- Scoring thresholds (v1 — locked in spec Constants section) ---

PREMIUM_TIER_1_USD = 1_000_000  # $1M premium = capital committed
PREMIUM_TIER_2_USD = 5_000_000  # $5M premium = whale-level conviction
DELTA_WEIGHTED_NOTIONAL_USD = 10_000_000  # $10M abs(size × delta × 100 × spot)
SWEEP_FLAG = "intermarket_sweep"
REPEAT_PRINT_FLOOR_USD = 500_000  # threshold for "big enough to count" repeats

# --- Bucket boundaries for stratified analysis (Phase 5 input) ---

# Time-of-day buckets in US/Central (cash session: 08:30–15:00 CT).
# Boundaries: open 08:30–10:00, morning 10:00–11:30, midday 11:30–13:00,
# afternoon 13:00–14:30, close 14:30–15:00 (exclusive of 15:00:00 itself,
# matching the ingest-script time filter).
TIME_BUCKET_BOUNDARIES_CT_MIN = (
    (510, 600, "open"),  # 08:30–10:00
    (600, 690, "morning"),  # 10:00–11:30
    (690, 780, "midday"),  # 11:30–13:00
    (780, 870, "afternoon"),  # 13:00–14:30
    (870, 900, "close"),  # 14:30–15:00 exclusive
)

# Ticker family classification for stratification.
SPX_COMPLEX = {"SPX", "SPXW", "SPXP", "SPXPM"}
INDEX_ETFS = {"SPY", "QQQ", "IWM", "DIA", "NDX", "NDXP", "RUT", "RUTW", "VIX"}


# --- Print-time derived features (legal scoring inputs, no leakage) ---


def enrich_print_features(df: pl.DataFrame) -> pl.DataFrame:
    """Add v1 print-time derived features.

    All features are derivable from the row itself plus prior same-chain
    rows in the same day — no external joins, no future-looking data.
    """
    mid = (pl.col("nbbo_ask") + pl.col("nbbo_bid")) / 2
    half_spread = (pl.col("nbbo_ask") - pl.col("nbbo_bid")) / 2
    enriched = df.with_columns(
        # Spread width as % of mid; wide spread → noisier signal
        ((pl.col("nbbo_ask") - pl.col("nbbo_bid")) / mid).alias("spread_width_pct"),
        # NBBO position: -1.0 = bid hit, +1.0 = ask paid, 0 = mid
        # Guard divide-by-zero: when spread is 0 (rare), nbbo_position is null
        pl.when(half_spread > 0)
        .then((pl.col("price") - mid) / half_spread)
        .otherwise(None)
        .alias("nbbo_position"),
        # Distance from spot
        ((pl.col("strike") - pl.col("underlying_price")).abs() / pl.col("underlying_price"))
        .alias("distance_from_spot_pct"),
        (pl.col("strike") - pl.col("underlying_price")).abs().alias("distance_from_spot_pts"),
    )
    # Repeat-print intensity within the day. Cumulative count of PRIOR
    # large prints (premium >= REPEAT_PRINT_FLOOR_USD) on the same chain,
    # ordered by executed_at. This is "how many big prints came before THIS
    # one on this contract today?" — a >0 value means clustering.
    enriched = enriched.with_columns(
        (pl.col("premium") >= REPEAT_PRINT_FLOOR_USD).cast(pl.Int32).alias("_is_big"),
    )
    enriched = enriched.with_columns(
        pl.col("_is_big")
        .cum_sum()
        .over("option_chain_id", order_by="executed_at")
        .alias("_cum_big_inclusive"),
    )
    enriched = enriched.with_columns(
        # Subtract self if this print itself qualifies, leaving prior count
        (pl.col("_cum_big_inclusive") - pl.col("_is_big")).alias("repeat_print_count_today"),
    )
    return enriched.drop("_is_big", "_cum_big_inclusive")


# --- Bucket columns (used by summarize_outliers + Phase 5 stratification) ---


def add_bucket_columns(df: pl.DataFrame) -> pl.DataFrame:
    """Add signed_direction, time_bucket, dte_bucket, ticker_family columns."""
    # Signed direction — interpret aggressor side × option type as bull/bear bet
    signed_direction = (
        pl.when((pl.col("option_type") == "call") & (pl.col("side") == "ask"))
        .then(pl.lit("bullish_call_buy"))
        .when((pl.col("option_type") == "call") & (pl.col("side") == "bid"))
        .then(pl.lit("bearish_call_sell"))
        .when((pl.col("option_type") == "put") & (pl.col("side") == "ask"))
        .then(pl.lit("bearish_put_buy"))
        .when((pl.col("option_type") == "put") & (pl.col("side") == "bid"))
        .then(pl.lit("bullish_put_sell"))
        .otherwise(pl.lit("undirected"))
    )

    # Time-of-day bucket in CT. Use convert_time_zone so DST is handled
    # automatically — a hardcoded -300 (CDT) breaks November–March when CT
    # shifts to UTC-6 (CST) and shifts every print by an hour.
    # Existing project convention (ml/src/pac/features.py) uses the same
    # America/Chicago tz conversion approach.
    # NB: must `.cast(Int32)` BEFORE multiplying — `dt.hour()` returns Int8
    # and `14 * 60` silently wraps mod 256 (840 → 72) → wrong buckets.
    ct_local = pl.col("executed_at").dt.convert_time_zone("America/Chicago")
    minute_of_day_ct = (
        ct_local.dt.hour().cast(pl.Int32) * 60
        + ct_local.dt.minute().cast(pl.Int32)
    )
    time_bucket = pl.lit("after_close")  # default for anything outside session
    for start, end, label in TIME_BUCKET_BOUNDARIES_CT_MIN:
        time_bucket = (
            pl.when((minute_of_day_ct >= start) & (minute_of_day_ct < end))
            .then(pl.lit(label))
            .otherwise(time_bucket)
        )

    # DTE bucket — days from print to expiry
    dte = (pl.col("expiry") - pl.col("executed_at").dt.date()).dt.total_days()
    dte_bucket = (
        pl.when(dte <= 0)
        .then(pl.lit("0DTE"))
        .when(dte == 1)
        .then(pl.lit("1DTE"))
        .when(dte <= 7)
        .then(pl.lit("2-7DTE"))
        .otherwise(pl.lit("8DTE+"))
    )

    # Ticker family
    ticker_family = (
        pl.when(pl.col("underlying_symbol").is_in(list(SPX_COMPLEX)))
        .then(pl.lit("spx_complex"))
        .when(pl.col("underlying_symbol").is_in(list(INDEX_ETFS)))
        .then(pl.lit("index_etf"))
        .otherwise(pl.lit("single_name"))
    )

    return df.with_columns(
        signed_direction=signed_direction,
        time_bucket=time_bucket,
        dte_bucket=dte_bucket,
        ticker_family=ticker_family,
    )


# --- Multi-criteria scoring ---


def score_prints(df: pl.DataFrame) -> pl.DataFrame:
    """Add `significance_score` (Int8) and `score_breakdown` (Struct).

    Each criterion contributes 1 to the score. Default min_score=4 in
    `find_outliers` filters to high-conviction prints.
    """
    delta_weighted_notional = (
        pl.col("size").cast(pl.Float64)
        * pl.col("delta").abs()
        * 100.0
        * pl.col("underlying_price")
    )
    return df.with_columns(
        c_premium_1m=(pl.col("premium") >= PREMIUM_TIER_1_USD).cast(pl.Int8),
        c_premium_5m=(pl.col("premium") >= PREMIUM_TIER_2_USD).cast(pl.Int8),
        c_zero_dte=(pl.col("expiry") == pl.col("executed_at").dt.date()).cast(pl.Int8),
        c_sweep=pl.col("report_flags")
        .str.contains(SWEEP_FLAG)
        .fill_null(False)
        .cast(pl.Int8),
        c_outside_nbbo=(
            (pl.col("price") > pl.col("nbbo_ask")) | (pl.col("price") < pl.col("nbbo_bid"))
        ).cast(pl.Int8),
        c_delta_weighted=(delta_weighted_notional >= DELTA_WEIGHTED_NOTIONAL_USD).cast(pl.Int8),
    ).with_columns(
        significance_score=(
            pl.col("c_premium_1m")
            + pl.col("c_premium_5m")
            + pl.col("c_zero_dte")
            + pl.col("c_sweep")
            + pl.col("c_outside_nbbo")
            + pl.col("c_delta_weighted")
        ).cast(pl.Int8),
        score_breakdown=pl.struct(
            [
                "c_premium_1m",
                "c_premium_5m",
                "c_zero_dte",
                "c_sweep",
                "c_outside_nbbo",
                "c_delta_weighted",
            ],
        ),
    ).drop(
        "c_premium_1m",
        "c_premium_5m",
        "c_zero_dte",
        "c_sweep",
        "c_outside_nbbo",
        "c_delta_weighted",
    )


# --- High-level entrypoint ---


def find_outliers(
    date_or_range: str | dt_date | tuple | list,
    *,
    min_score: int = 4,
    tickers: list[str] | None = None,
    token: str | None = None,
) -> pl.DataFrame:
    """Load flow → enrich → score → filter to score ≥ min_score, sorted high→low."""
    # Local import so this module can be tested without flow_archive available
    # in the test runner's sys.path on every host.
    from flow_archive import load_flow

    lf = load_flow(date_or_range, tickers=tickers, token=token)
    df = lf.collect()
    enriched = enrich_print_features(df)
    scored = score_prints(enriched)
    return (
        scored.filter(pl.col("significance_score") >= min_score)
        .pipe(add_bucket_columns)
        .sort(["significance_score", "premium"], descending=[True, True])
    )


# --- Aggregation (Phase 5 will plug in `won` column from compute_outcomes) ---


def summarize_outliers(
    outliers: pl.DataFrame,
    *,
    group_by: list[str] | None = None,
) -> pl.DataFrame:
    """Aggregate outliers into a stratified hit-rate table.

    If `outliers` has a `won` boolean column (added by Phase 5's compute_outcomes),
    `win_rate` is computed. Otherwise, returns just `n` per bucket.
    """
    cols = group_by or ["signed_direction", "time_bucket", "dte_bucket", "ticker_family"]
    aggs: list[pl.Expr] = [pl.len().alias("n")]
    if "won" in outliers.columns:
        aggs.append(pl.col("won").cast(pl.Float64).mean().alias("win_rate"))
        aggs.append(pl.col("won").cast(pl.Int32).sum().alias("n_won"))
    return outliers.group_by(cols).agg(aggs).sort("n", descending=True)
