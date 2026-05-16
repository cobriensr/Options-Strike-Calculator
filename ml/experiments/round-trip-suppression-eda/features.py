"""Per-alert round-trip-suppression feature computation against the fulltape.

CRITICAL: UW fulltape `ask_vol` / `bid_vol` / `mid_vol` / `no_side_vol` / `multi_vol`
fields are CUMULATIVE running totals at print time — NOT per-print sizes.

  - Naive `sum(ask_vol)` overcounts by 10-20×.
  - Per-print attribution = current_row.ask_vol - prev_row.ask_vol (after sort).
  - Window aggregate = last_row.ask_vol - first_pre_window_row.ask_vol.

See docs/superpowers/specs/lottery-silent-boom-round-trip-suppression-2026-05-15.md
and memory `feedback_uw_fulltape_vols_cumulative.md`.

The canonical per-print side classification is the `tags` field literal
(`ask_side` / `bid_side` / `mid_side` / `no_side`), which we parse first;
the cumulative-vol delta is a fallback / sanity-check signal.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import polars as pl

# Tag literals UW uses for per-print side classification.
TAG_ASK = 'ask_side'
TAG_BID = 'bid_side'
TAG_MID = 'mid_side'
TAG_NO_SIDE = 'no_side'

# Re-tag mid prints by NBBO position when classification is ambiguous.
# price ≥ ask_threshold * (ask - bid) above bid → ask-leaning.
ASK_LEAN_THRESHOLD = 0.65
BID_LEAN_THRESHOLD = 0.35


@dataclass(frozen=True)
class AlertFeatures:
    """Suppression features computed for one alert against post-fire fulltape."""

    # Identity
    option_chain_id: str
    fire_time_utc: datetime

    # Volume coverage
    post_fire_print_count: int
    post_fire_total_size: int

    # Side flow — derived from `tags` field (canonical), per-print
    post_fire_ask_size: int
    post_fire_bid_size: int
    post_fire_mid_size: int
    post_fire_unknown_size: int
    post_fire_net_ask_minus_bid: int
    post_fire_net_pct_of_volume: float  # net / max(1, total_size)

    # Premium flow (delta-dollar magnitude — sign follows ask/bid)
    post_fire_ask_premium: float
    post_fire_bid_premium: float
    post_fire_net_premium: float

    # Multi-leg fraction (from multi_vol delta) — sanity check
    post_fire_multi_leg_size: int
    post_fire_multi_leg_pct: float

    # OI delta intraday
    oi_at_fire: int
    oi_at_eod: int
    oi_delta_intraday: int

    # Mid-print noise diagnostic
    mid_print_pct: float  # mid_size / total_size

    # NBBO-position reclassification of mid prints
    nbbo_reclassified_ask_size: int
    nbbo_reclassified_bid_size: int

    # Time-to-50%-reversal (None if never reverses)
    time_to_50pct_reversal_min: float | None

    # Window length actually scanned
    window_minutes: float


def _parse_tag_set(tag_str: str | None) -> set[str]:
    """Parse '{ask_side,bullish,etf}' into {'ask_side', 'bullish', 'etf'}.

    UW persists tags as Postgres array literals. Empty array is '{}'.
    """
    if not tag_str or tag_str == '{}':
        return set()
    inner = tag_str.strip()
    if inner.startswith('{') and inner.endswith('}'):
        inner = inner[1:-1]
    if not inner:
        return set()
    return {t.strip() for t in inner.split(',') if t.strip()}


def _side_from_tags(tag_str: str | None) -> str:
    """Classify per-print side from the tags field. Returns 'ask'/'bid'/'mid'/'unknown'."""
    tags = _parse_tag_set(tag_str)
    if TAG_ASK in tags:
        return 'ask'
    if TAG_BID in tags:
        return 'bid'
    if TAG_MID in tags:
        return 'mid'
    if TAG_NO_SIDE in tags:
        return 'unknown'
    return 'unknown'


def _nbbo_reclassify(price: float, bid: float, ask: float) -> str:
    """Re-classify a mid/unknown print by its position in the NBBO spread.

    Returns 'ask' / 'bid' / 'mid' (mid = genuinely between thresholds).
    Falls back to 'mid' when spread is degenerate (ask <= bid).
    """
    spread = ask - bid
    if spread <= 0 or price is None:
        return 'mid'
    pos = (price - bid) / spread
    if pos >= ASK_LEAN_THRESHOLD:
        return 'ask'
    if pos <= BID_LEAN_THRESHOLD:
        return 'bid'
    return 'mid'


def annotate_per_print_sides(df: pl.DataFrame) -> pl.DataFrame:
    """Add a 'side' column derived from tags. Also reclassify mid/unknown by NBBO.

    Adds columns:
      - tag_side:      ask|bid|mid|unknown (from tags field literal)
      - nbbo_side:     ask|bid|mid (reclassified by price-vs-NBBO position)
      - final_side:    tag_side if ask|bid, else nbbo_side
    """
    if len(df) == 0:
        return df.with_columns([
            pl.lit('unknown').alias('tag_side'),
            pl.lit('mid').alias('nbbo_side'),
            pl.lit('unknown').alias('final_side'),
        ])

    df = df.with_columns(
        pl.col('tags').map_elements(_side_from_tags, return_dtype=pl.Utf8).alias('tag_side')
    )
    df = df.with_columns(
        pl.struct(['price', 'nbbo_bid', 'nbbo_ask'])
        .map_elements(
            lambda r: _nbbo_reclassify(r['price'], r['nbbo_bid'], r['nbbo_ask']),
            return_dtype=pl.Utf8,
        )
        .alias('nbbo_side')
    )
    df = df.with_columns(
        pl.when(pl.col('tag_side').is_in(['ask', 'bid']))
        .then(pl.col('tag_side'))
        .otherwise(pl.col('nbbo_side'))
        .alias('final_side')
    )
    return df


def compute_per_print_multi_leg_size(df: pl.DataFrame) -> pl.DataFrame:
    """Compute per-print multi_leg size from cumulative multi_vol via delta.

    Adds column `per_print_multi_size` = clip(multi_vol - prev(multi_vol), 0, size).
    Clipped to [0, size] because UW occasionally emits non-monotonic cumulative
    values across cancellation events; we floor at 0 and cap at the print size.
    """
    if len(df) == 0:
        return df.with_columns(pl.lit(0, dtype=pl.Int64).alias('per_print_multi_size'))

    df = df.sort('executed_at')
    df = df.with_columns(
        (pl.col('multi_vol') - pl.col('multi_vol').shift(1).fill_null(0))
        .clip(lower_bound=0)
        .alias('multi_vol_delta')
    )
    # Cap at print size — multi_vol_delta should never exceed the contemporaneous size.
    df = df.with_columns(
        pl.when(pl.col('multi_vol_delta') > pl.col('size'))
        .then(pl.col('size'))
        .otherwise(pl.col('multi_vol_delta'))
        .alias('per_print_multi_size')
    )
    return df.drop('multi_vol_delta')


def features_for_alert(
    fulltape_day: pl.LazyFrame | pl.DataFrame,
    option_chain_id: str,
    fire_time_utc: datetime,
    window_minutes: float = 60.0,
) -> AlertFeatures:
    """Compute round-trip suppression features for ONE alert.

    Parameters
    ----------
    fulltape_day:
        Pre-loaded fulltape parquet for the alert's date (LazyFrame is fine).
        Will be filtered to the alert's option_chain_id and `executed_at > fire_time`.
    option_chain_id:
        OSI string, e.g. 'MU260522P00702500'.
    fire_time_utc:
        Alert fire time as a UTC datetime (timezone-aware).
    window_minutes:
        Look-forward window. Default 60 min. Set to a large number (e.g. 600)
        to capture EOD.

    Returns
    -------
    AlertFeatures dataclass with all suppression-relevant signals.
    """
    if fire_time_utc.tzinfo is None:
        raise ValueError('fire_time_utc must be timezone-aware (UTC)')
    if fire_time_utc.tzinfo != timezone.utc:
        fire_time_utc = fire_time_utc.astimezone(timezone.utc)

    lf = fulltape_day if isinstance(fulltape_day, pl.LazyFrame) else fulltape_day.lazy()
    contract = (
        lf
        .filter(pl.col('option_chain_id') == option_chain_id)
        .filter(~pl.col('canceled'))
        .sort('executed_at')
        .collect()
    )

    # OI bookends from the full day (not just post-fire) — gives us intraday delta.
    if len(contract) > 0:
        oi_first_print = int(contract['open_interest'][0])
        oi_last_print = int(contract['open_interest'][-1])
    else:
        oi_first_print = 0
        oi_last_print = 0

    # OI at fire — use the last pre-fire print's OI, or first print's OI if no pre-fire.
    pre_fire = contract.filter(pl.col('executed_at') <= fire_time_utc)
    oi_at_fire = int(pre_fire['open_interest'][-1]) if len(pre_fire) > 0 else oi_first_print

    # Post-fire window
    window_end = pl.lit(fire_time_utc).cast(pl.Datetime('us', 'UTC')) + pl.duration(
        minutes=window_minutes
    )
    post = contract.filter(
        (pl.col('executed_at') > fire_time_utc) & (pl.col('executed_at') <= window_end)
    )

    if len(post) == 0:
        return AlertFeatures(
            option_chain_id=option_chain_id,
            fire_time_utc=fire_time_utc,
            post_fire_print_count=0,
            post_fire_total_size=0,
            post_fire_ask_size=0,
            post_fire_bid_size=0,
            post_fire_mid_size=0,
            post_fire_unknown_size=0,
            post_fire_net_ask_minus_bid=0,
            post_fire_net_pct_of_volume=0.0,
            post_fire_ask_premium=0.0,
            post_fire_bid_premium=0.0,
            post_fire_net_premium=0.0,
            post_fire_multi_leg_size=0,
            post_fire_multi_leg_pct=0.0,
            oi_at_fire=oi_at_fire,
            oi_at_eod=oi_last_print,
            oi_delta_intraday=oi_last_print - oi_first_print,
            mid_print_pct=0.0,
            nbbo_reclassified_ask_size=0,
            nbbo_reclassified_bid_size=0,
            time_to_50pct_reversal_min=None,
            window_minutes=window_minutes,
        )

    post = annotate_per_print_sides(post)
    post = compute_per_print_multi_leg_size(post)

    # Side sums using tag_side first (canonical)
    by_tag = post.group_by('tag_side').agg(pl.col('size').sum().alias('s'))
    tag_sizes = {row['tag_side']: int(row['s']) for row in by_tag.to_dicts()}
    ask_size = tag_sizes.get('ask', 0)
    bid_size = tag_sizes.get('bid', 0)
    mid_size = tag_sizes.get('mid', 0)
    unknown_size = tag_sizes.get('unknown', 0)
    total_size = int(post['size'].sum())

    # NBBO reclassification — what would ask/bid look like if we re-tagged mid/unknown?
    by_final = post.group_by('final_side').agg(pl.col('size').sum().alias('s'))
    final_sizes = {row['final_side']: int(row['s']) for row in by_final.to_dicts()}
    nbbo_ask = final_sizes.get('ask', 0)
    nbbo_bid = final_sizes.get('bid', 0)

    net = ask_size - bid_size
    net_pct = net / max(1, total_size)

    # Premium aggregates
    ask_prem = float(post.filter(pl.col('tag_side') == 'ask')['premium'].sum())
    bid_prem = float(post.filter(pl.col('tag_side') == 'bid')['premium'].sum())
    net_prem = ask_prem - bid_prem

    multi_size = int(post['per_print_multi_size'].sum())
    multi_pct = multi_size / max(1, total_size)

    mid_pct = mid_size / max(1, total_size)

    # Time-to-50%-reversal: walking cumulative net from the alert's implied long bias.
    # We assume the alert was an ask-side opening (informed long); we look for when
    # cumulative bid_size first reaches 50% of cumulative ask_size since fire.
    cum = (
        post.with_columns([
            pl.when(pl.col('tag_side') == 'ask').then(pl.col('size')).otherwise(0).alias('a'),
            pl.when(pl.col('tag_side') == 'bid').then(pl.col('size')).otherwise(0).alias('b'),
        ])
        .with_columns([
            pl.col('a').cum_sum().alias('cum_ask'),
            pl.col('b').cum_sum().alias('cum_bid'),
        ])
    )
    # First row where cum_bid >= 0.5 * cum_ask AND cum_ask > 0
    reversal = cum.filter((pl.col('cum_ask') > 0) & (pl.col('cum_bid') >= 0.5 * pl.col('cum_ask')))
    if len(reversal) > 0:
        rev_ts = reversal['executed_at'][0]
        # rev_ts is a Polars-returned datetime; align to UTC for arithmetic
        if rev_ts.tzinfo is None:
            rev_ts = rev_ts.replace(tzinfo=timezone.utc)
        time_to_reversal = (rev_ts - fire_time_utc).total_seconds() / 60.0
    else:
        time_to_reversal = None

    actual_window_min = (
        (post['executed_at'][-1] - fire_time_utc).total_seconds() / 60.0
        if len(post) > 0
        else 0.0
    )

    return AlertFeatures(
        option_chain_id=option_chain_id,
        fire_time_utc=fire_time_utc,
        post_fire_print_count=len(post),
        post_fire_total_size=total_size,
        post_fire_ask_size=ask_size,
        post_fire_bid_size=bid_size,
        post_fire_mid_size=mid_size,
        post_fire_unknown_size=unknown_size,
        post_fire_net_ask_minus_bid=net,
        post_fire_net_pct_of_volume=net_pct,
        post_fire_ask_premium=ask_prem,
        post_fire_bid_premium=bid_prem,
        post_fire_net_premium=net_prem,
        post_fire_multi_leg_size=multi_size,
        post_fire_multi_leg_pct=multi_pct,
        oi_at_fire=oi_at_fire,
        oi_at_eod=oi_last_print,
        oi_delta_intraday=oi_last_print - oi_first_print,
        mid_print_pct=mid_pct,
        nbbo_reclassified_ask_size=nbbo_ask,
        nbbo_reclassified_bid_size=nbbo_bid,
        time_to_50pct_reversal_min=time_to_reversal,
        window_minutes=min(window_minutes, actual_window_min),
    )
