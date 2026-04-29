"""Touch-ITM win rule + path diagnostics for outlier prints.

Combines outliers (from `flow_outliers.find_outliers`) with per-ticker
minute bars (synthesized from the same archive's `underlying_price`
column) to answer the only question that matters for 0DTE:

    "Did this trade touch its strike in the trade's favor before close?"

Buyer wins if the underlying touched the strike at any point in the
session — even at 14:55 with a slow grind. Seller wins if the underlying
NEVER touched the strike against them.

Spec: docs/superpowers/specs/options-flow-archive-2026-04-28.md (Phase 5)
"""

from __future__ import annotations

import polars as pl

# Cash session ends at 15:00 CT = 20:00 UTC (consistent with ingest filter).
# Used to define the per-print outcome window: [print_time, session_close).
SESSION_CLOSE_UTC_HOUR = 20


# --- Minute-bar synthesis -----------------------------------------


def synthesize_minute_bars(flow_df: pl.DataFrame) -> pl.DataFrame:
    """Per (underlying_symbol, minute), synthetic OHLC from `underlying_price`.

    Per-minute high/low/close are derived from every option print on that
    underlying within the minute. For the liquid index/ETF universe each
    minute has thousands of prints, giving a tight high/low. For thinner
    tickers there will be gaps (no prints in a given minute → no bar);
    callers wanting full coverage can `.fill_null(strategy="forward")`
    after sorting.
    """
    return (
        flow_df.select(["executed_at", "underlying_symbol", "underlying_price"])
        .sort("executed_at")
        .with_columns(minute=pl.col("executed_at").dt.truncate("1m"))
        .group_by(["underlying_symbol", "minute"])
        .agg(
            high=pl.col("underlying_price").max(),
            low=pl.col("underlying_price").min(),
            close=pl.col("underlying_price").last(),
        )
        .sort(["underlying_symbol", "minute"])
    )


# --- Per-outlier outcome computation ------------------------------


def compute_outcomes(
    outliers: pl.DataFrame,
    minute_bars: pl.DataFrame,
) -> pl.DataFrame:
    """For each outlier, compute touch-ITM `won` flag + path diagnostics.

    Diagnostics added:
      - `won` (Boolean): primary metric per the spec's win-rule table
      - `close_won` (Boolean): stricter — at session close, was direction matched?
      - `time_to_itm_min` (Int): minutes from print to first ITM touch (null if never)
      - `time_in_itm_min` (Int): total minutes spent ITM during the session
      - `mfe_pts` (Float): max favorable excursion in underlying points
                          (signed by direction, positive = good for the trade)
      - `mae_pts` (Float): closest underlying came to strike against the trade
                          (positive = comfortable, negative = breached)
      - `close_distance_from_strike_pts` (Float): underlying close vs strike,
                          signed in trade direction (buyer wants positive ITM,
                          seller wants positive distance away)

    Notes:
      - Touch-ITM uses minute high/low (not just close) for tighter detection
      - `time_to_first_breach_min` for sellers IS `time_to_itm_min` — same number,
         opposite interpretation (a buyer's win-time = a seller's breach-time)
      - Outliers without any matching minute bars (e.g. AAPL print but no AAPL
         underlying_price activity that minute) get null outcomes — caller
         should handle via .filter or .drop_nulls
    """
    if outliers.is_empty():
        # Empty outliers → empty outcomes with the right columns
        return outliers.with_columns(
            won=pl.lit(None, dtype=pl.Boolean),
            close_won=pl.lit(None, dtype=pl.Boolean),
            time_to_itm_min=pl.lit(None, dtype=pl.Int64),
            time_in_itm_min=pl.lit(None, dtype=pl.Int64),
            mfe_pts=pl.lit(None, dtype=pl.Float64),
            mae_pts=pl.lit(None, dtype=pl.Float64),
            close_distance_from_strike_pts=pl.lit(None, dtype=pl.Float64),
        )

    # 1. Add a row id so we can join results back per-outlier
    indexed = outliers.with_row_index("_outlier_id")

    # 2. Compute per-print session-close timestamp (20:00 UTC on the print date)
    indexed = indexed.with_columns(
        _session_close=pl.col("executed_at").dt.truncate("1d")
        + pl.duration(hours=SESSION_CLOSE_UTC_HOUR),
    )

    # 3. Cross-join outliers with minute bars on underlying_symbol; filter to
    #    bars in [print_time, session_close).
    joined = (
        indexed.select(
            [
                "_outlier_id",
                "underlying_symbol",
                "executed_at",
                "_session_close",
                "strike",
                "option_type",
                "side",
            ]
        )
        .join(
            minute_bars.rename(
                {"minute": "_bar_min", "high": "_bar_high", "low": "_bar_low", "close": "_bar_close"}
            ),
            on="underlying_symbol",
            how="inner",
        )
        .filter(
            (pl.col("_bar_min") >= pl.col("executed_at"))
            & (pl.col("_bar_min") < pl.col("_session_close"))
        )
    )

    if joined.is_empty():
        # No matching bars at all — return nulls for everything
        return _attach_null_outcomes(outliers)

    # 4. Per-bar ITM-in-buyer's-direction flag (used for both win-detection
    #    and for time-in-itm diagnostics).
    is_call = pl.col("option_type") == "call"
    bar_itm_for_buyer = (
        (is_call & (pl.col("_bar_high") >= pl.col("strike")))
        | (~is_call & (pl.col("_bar_low") <= pl.col("strike")))
    )

    # 5. Per-outlier aggregations.
    per_outlier = (
        joined.with_columns(_bar_itm_buyer=bar_itm_for_buyer)
        .sort("_bar_min")
        .group_by("_outlier_id", maintain_order=True)
        .agg(
            _max_high=pl.col("_bar_high").max(),
            _min_low=pl.col("_bar_low").min(),
            _last_close=pl.col("_bar_close").last(),
            _any_itm_buyer=pl.col("_bar_itm_buyer").any(),
            _first_itm_bar=pl.when(pl.col("_bar_itm_buyer"))
            .then(pl.col("_bar_min"))
            .otherwise(None)
            .min(),
            _time_in_itm_count=pl.col("_bar_itm_buyer").cast(pl.Int32).sum(),
        )
    )

    # 6. Join aggregations back to outliers and compute the final outcome columns.
    is_buyer = pl.col("side") == "ask"
    is_seller = pl.col("side") == "bid"
    is_call_col = pl.col("option_type") == "call"

    enriched = (
        indexed.join(per_outlier, on="_outlier_id", how="left").with_columns(
            # PRIMARY: won
            # Buyer wins if any bar was ITM. Seller wins if NO bar was ITM.
            # 'no_side' / 'mid' get null — undirected.
            won=pl.when(is_buyer)
            .then(pl.col("_any_itm_buyer"))
            .when(is_seller)
            .then(pl.col("_any_itm_buyer").not_())
            .otherwise(None),
            # CLOSE-WON: stricter, based on the last bar's close vs strike
            close_won=pl.when(is_buyer & is_call_col)
            .then(pl.col("_last_close") >= pl.col("strike"))
            .when(is_buyer & ~is_call_col)
            .then(pl.col("_last_close") <= pl.col("strike"))
            .when(is_seller & is_call_col)
            .then(pl.col("_last_close") < pl.col("strike"))
            .when(is_seller & ~is_call_col)
            .then(pl.col("_last_close") > pl.col("strike"))
            .otherwise(None),
            # TIME TO ITM (buyer-frame; for sellers same number = time to breach)
            time_to_itm_min=(pl.col("_first_itm_bar") - pl.col("executed_at")).dt.total_minutes(),
            time_in_itm_min=pl.col("_time_in_itm_count").cast(pl.Int64),
            # MFE = max favorable excursion in trade direction (in pts).
            # Buyer call: max_high - strike (positive when above strike)
            # Buyer put: strike - min_low
            # Seller call: strike - max_high (positive when stayed below strike, "favorable")
            # Seller put: min_low - strike
            mfe_pts=pl.when(is_buyer & is_call_col)
            .then(pl.col("_max_high") - pl.col("strike"))
            .when(is_buyer & ~is_call_col)
            .then(pl.col("strike") - pl.col("_min_low"))
            .when(is_seller & is_call_col)
            .then(pl.col("strike") - pl.col("_max_high"))
            .when(is_seller & ~is_call_col)
            .then(pl.col("_min_low") - pl.col("strike"))
            .otherwise(None),
            # MAE = closest the underlying came to the strike AGAINST the trade.
            # For buyers, this is the same as MFE direction (their MFE IS the
            # adverse-vs-target distance flipped). To keep meaningful, MAE for
            # buyers is "lowest favorable distance" = same shape as MFE but
            # using the adverse extreme.
            # Buyer call: min_low - strike (negative when stayed below strike, bad)
            # Buyer put: strike - max_high
            # Seller call: strike - max_high (same as MFE — already adverse-aware)
            # Seller put: min_low - strike (same as MFE)
            mae_pts=pl.when(is_buyer & is_call_col)
            .then(pl.col("_min_low") - pl.col("strike"))
            .when(is_buyer & ~is_call_col)
            .then(pl.col("strike") - pl.col("_max_high"))
            .when(is_seller & is_call_col)
            .then(pl.col("strike") - pl.col("_max_high"))
            .when(is_seller & ~is_call_col)
            .then(pl.col("_min_low") - pl.col("strike"))
            .otherwise(None),
            # Close distance from strike (signed in trade direction)
            close_distance_from_strike_pts=pl.when(is_buyer & is_call_col)
            .then(pl.col("_last_close") - pl.col("strike"))
            .when(is_buyer & ~is_call_col)
            .then(pl.col("strike") - pl.col("_last_close"))
            .when(is_seller & is_call_col)
            .then(pl.col("strike") - pl.col("_last_close"))
            .when(is_seller & ~is_call_col)
            .then(pl.col("_last_close") - pl.col("strike"))
            .otherwise(None),
        )
    )

    # 7. Drop scratch columns
    return enriched.drop(
        "_outlier_id",
        "_session_close",
        "_max_high",
        "_min_low",
        "_last_close",
        "_any_itm_buyer",
        "_first_itm_bar",
        "_time_in_itm_count",
    )


def _attach_null_outcomes(outliers: pl.DataFrame) -> pl.DataFrame:
    """Helper: attach all-null outcome columns when the bars-join was empty."""
    return outliers.with_columns(
        won=pl.lit(None, dtype=pl.Boolean),
        close_won=pl.lit(None, dtype=pl.Boolean),
        time_to_itm_min=pl.lit(None, dtype=pl.Int64),
        time_in_itm_min=pl.lit(None, dtype=pl.Int64),
        mfe_pts=pl.lit(None, dtype=pl.Float64),
        mae_pts=pl.lit(None, dtype=pl.Float64),
        close_distance_from_strike_pts=pl.lit(None, dtype=pl.Float64),
    )
