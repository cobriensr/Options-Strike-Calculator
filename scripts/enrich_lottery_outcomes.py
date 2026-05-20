#!/usr/bin/env python
"""Local enrichment for lottery_finder_fires using the EOD parquet tape.

Replaces api/cron/enrich-lottery-outcomes.ts for the realized exit-policy
columns. The Vercel cron reads ws_option_trades, which is incomplete
relative to the EOD parquet written by `make ingest` to
`~/Desktop/Bot-Eod-parquet/{DATE}-trades.parquet`. Running this locally
after ingest gives full coverage.

Computes:
  - realized_trail30_10_pct
  - realized_hard30m_pct
  - realized_tier50_holdeod_pct
  - realized_eod_pct
  - peak_ceiling_pct
  - minutes_to_peak
  - realized_flow_inversion_pct (second pass — needs net_flow_per_ticker_history;
    runs `make backfill-flow` first if that table is empty for the date)

Usage
-----
    ml/.venv/bin/python scripts/enrich_lottery_outcomes.py
    ml/.venv/bin/python scripts/enrich_lottery_outcomes.py --date 2026-05-05
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import re
import statistics
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date as DateType, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values


# ============================================================
# Ticker inversion-quality refit (Phase 2 of the inversion-quality filter)
# ============================================================

INVERSION_WIN_THRESHOLD = 50.0  # realized_flow_inversion_pct >= 50 = "win"
SAMPLE_SIZE_FLOOR = 10
WILSON_Z = 1.96  # 95% CI
WINDOW_WEIGHT_21D = 0.6
WINDOW_WEIGHT_90D = 0.4
INVERSION_BONUS_BY_QUINTILE = {1: -5, 2: -2, 3: 0, 4: 3, 5: 5}


def wilson_lcb(wins: int, n: int) -> float | None:
    """Wilson 95% lower confidence bound on P(win | n trials).

    Returns None when n < SAMPLE_SIZE_FLOOR.
    """
    if n < SAMPLE_SIZE_FLOOR:
        return None
    if n == 0:
        return None
    p = wins / n
    z = WILSON_Z
    denom = 1 + z * z / n
    center = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (center - margin) / denom)


def inversion_blend(
    lcb_21d: float | None,
    lcb_90d: float | None,
) -> float | None:
    """Weighted blend of the 21d and 90d Wilson LCBs.

    Both present  -> 0.6 * 21d + 0.4 * 90d
    Only one      -> that one
    Neither       -> None
    """
    if lcb_21d is not None and lcb_90d is not None:
        return WINDOW_WEIGHT_21D * lcb_21d + WINDOW_WEIGHT_90D * lcb_90d
    if lcb_21d is not None:
        return lcb_21d
    if lcb_90d is not None:
        return lcb_90d
    return None


def quintile_cuts(
    blends: dict[str, float | None],
) -> dict[str, int]:
    """Map each ticker's non-NULL blend to a quintile (1..5).

    Quintile 1 = worst (smallest blend), Quintile 5 = best. Tickers with
    NULL blends are omitted from the output. Rank-based: sort the valid
    blends ascending, then assign quintile by sorted rank so every group
    gets an equal share (vs. pandas qcut's duplicates='drop' behavior
    which can shrink the output, or boundary-based comparisons which
    miscount at exact-boundary ties).
    """
    valid = {t: b for t, b in blends.items() if b is not None}
    if not valid:
        return {}
    # Stable sort by (value, ticker) so ties don't reshuffle across runs.
    ordered = sorted(valid.items(), key=lambda kv: (kv[1], kv[0]))
    n = len(ordered)
    out: dict[str, int] = {}
    if n == 1:
        out[ordered[0][0]] = 1
        return out
    for rank, (ticker, _b) in enumerate(ordered):
        # rank in [0..n-1]; map to quintile in [1..5].
        q = int(rank * 5 / (n - 1)) + 1 if rank < n - 1 else 5
        if q > 5:
            q = 5
        out[ticker] = q
    return out

DEFAULT_PARQUET_DIR = Path.home() / 'Desktop' / 'Bot-Eod-parquet'
PARQUET_FORMATS = {
    'trades': '{date}-trades.parquet',
    'fulltape': '{date}-fulltape.parquet',
}
# Module-level mutable so functions can read without threading args
# through every call. Populated in main() from CLI args.
PARQUET_DIR = DEFAULT_PARQUET_DIR
PARQUET_FILE_PATTERN = PARQUET_FORMATS['trades']
ENV_FILE = Path(__file__).resolve().parent.parent / '.env.local'


# ============================================================
# Pure exit-policy functions — direct port of
# api/_lib/lottery-exit-policies.ts. Tested for parity in
# scripts/test_enrich_lottery_outcomes.py.
# ============================================================


def realized_trail_act30_trail10(prices: list[float], entry: float) -> float:
    return _trail_pp(prices, entry, act=30.0, drop_pp=10.0)


def realized_hard_stop_30m(
    prices: list[float],
    entry: float,
    minutes_since_entry: list[float],
    stop_min: float = 30.0,
) -> float:
    if entry <= 0 or len(prices) == 0:
        return 0.0
    last_in = -1
    for i, m in enumerate(minutes_since_entry):
        if m <= stop_min:
            last_in = i
        else:
            break
    if last_in == -1:
        return 0.0
    return ((prices[last_in] - entry) / entry) * 100.0


def realized_tier50_hold_eod(prices: list[float], entry: float) -> float:
    if entry <= 0 or len(prices) == 0:
        return 0.0
    last = prices[-1]
    tier1_idx = -1
    for i, px in enumerate(prices):
        r = ((px - entry) / entry) * 100.0
        if r >= 50.0:
            tier1_idx = i
            break
    if tier1_idx == -1:
        return ((last - entry) / entry) * 100.0
    tier1_ret = ((prices[tier1_idx] - entry) / entry) * 100.0
    tier2_ret = ((last - entry) / entry) * 100.0
    return (tier1_ret + tier2_ret) / 2.0


def peak_ceiling(prices: list[float], entry: float) -> float:
    if entry <= 0 or len(prices) == 0:
        return 0.0
    mx = max(prices)
    return ((mx - entry) / entry) * 100.0


def minutes_to_peak(
    prices: list[float], minutes_since_entry: list[float]
) -> float:
    if len(prices) == 0:
        return 0.0
    max_idx = 0
    max_px = prices[0]
    for i in range(1, len(prices)):
        if prices[i] > max_px:
            max_px = prices[i]
            max_idx = i
    return minutes_since_entry[max_idx] if max_idx < len(minutes_since_entry) else 0.0


def _trail_pp(
    prices: list[float], entry: float, act: float, drop_pp: float
) -> float:
    if entry <= 0 or len(prices) == 0:
        return 0.0
    activated = False
    peak = float('-inf')
    for px in prices:
        r = ((px - entry) / entry) * 100.0
        if not activated:
            if r >= act:
                activated = True
                peak = r
        else:
            if r > peak:
                peak = r
            elif r <= peak - drop_pp:
                return r
    return ((prices[-1] - entry) / entry) * 100.0


# ============================================================
# Flow-inversion port — direct port of api/_lib/flow-inversion.ts.
# Constants are frozen; do not retune. Tested for parity in
# scripts/test_enrich_lottery_outcomes.py.
# ============================================================

PEAK_PROMINENCE_RATIO = 0.05
INVERSION_SLOPE_WINDOW_MIN = 5
INVERSION_NEG_PERSIST_MIN = 3
EOD_CT_HOUR = 15

_CT_TZ = ZoneInfo('America/Chicago')


def find_prominent_peaks(
    values: list[float], min_prominence: float
) -> list[tuple[int, float]]:
    """Returns [(idx, prominence), ...]. Mirrors scipy.signal.find_peaks
    for unimodal cumulative-flow signals (no plateau handling)."""
    out: list[tuple[int, float]] = []
    n = len(values)
    for i in range(1, n - 1):
        v = values[i]
        if not (v > values[i - 1] and v > values[i + 1]):
            continue
        left_min = v
        for j in range(i - 1, -1, -1):
            if values[j] >= v:
                break
            if values[j] < left_min:
                left_min = values[j]
        right_min = v
        for k in range(i + 1, n):
            if values[k] >= v:
                break
            if values[k] < right_min:
                right_min = values[k]
        prominence = v - max(left_min, right_min)
        if prominence >= min_prominence:
            out.append((i, prominence))
    return out


def eod_ct_for_trigger(trigger_ts: datetime) -> datetime:
    """15:00 CT on the trigger's CT day, returned as UTC."""
    if trigger_ts.tzinfo is None:
        trigger_ts = trigger_ts.replace(tzinfo=timezone.utc)
    ct_date = trigger_ts.astimezone(_CT_TZ).date()
    eod_ct = datetime(
        ct_date.year, ct_date.month, ct_date.day,
        EOD_CT_HOUR, 0, 0, tzinfo=_CT_TZ,
    )
    return eod_ct.astimezone(timezone.utc)


def _exit_at_or_after(
    minutes: list[tuple[datetime, float]],
    target_ts: datetime,
    entry_price: float,
    status: str,
) -> tuple[float | None, datetime | None, str]:
    for ts, mid in minutes:
        if ts >= target_ts:
            return ((mid - entry_price) / entry_price) * 100.0, ts, status
    if not minutes:
        return None, None, status
    last_ts, last_mid = minutes[-1]
    return (
        ((last_mid - entry_price) / entry_price) * 100.0,
        last_ts,
        f'{status}_eod_fallback',
    )


def simulate_flow_inversion(
    minutes: list[tuple[datetime, float]],
    flow: list[tuple[datetime, float]],
    entry_price: float,
    trigger_ts: datetime,
) -> tuple[float | None, datetime | None, str]:
    """Returns (exitPct, exitTs, status). See
    api/_lib/flow-inversion.ts:simulateFlowInversion for spec."""
    post = [m for m in minutes if m[0] > trigger_ts]
    if not post:
        return None, None, 'no_post_trigger_prices'

    eod_ts = eod_ct_for_trigger(trigger_ts)
    flow_post = [f for f in flow if trigger_ts < f[0] <= eod_ts]
    if len(flow_post) < 5:
        return None, None, 'insufficient_flow_data'

    cum: list[float] = []
    running = 0.0
    for _, v in flow_post:
        running += v
        cum.append(running)
    rng = max(cum) - min(cum)
    if rng <= 0:
        return None, None, 'flat_flow_no_peak'

    peaks = find_prominent_peaks(cum, rng * PEAK_PROMINENCE_RATIO)
    if not peaks:
        return None, None, 'no_flow_peak_detected'
    peak_idx = max(peaks, key=lambda p: p[1])[0]

    flow_after_peak = flow_post[peak_idx:]
    min_required = INVERSION_SLOPE_WINDOW_MIN + INVERSION_NEG_PERSIST_MIN
    if len(flow_after_peak) < min_required:
        return _exit_at_or_after(
            post, eod_ts, entry_price, 'eod_no_inversion_window'
        )

    cum_after: list[float] = []
    running = 0.0
    for _, v in flow_after_peak:
        running += v
        cum_after.append(running)

    neg_streak = 0
    inversion_idx: int | None = None
    for i in range(INVERSION_SLOPE_WINDOW_MIN, len(cum_after)):
        slope = (
            cum_after[i] - cum_after[i - INVERSION_SLOPE_WINDOW_MIN]
        ) / INVERSION_SLOPE_WINDOW_MIN
        if slope < 0:
            neg_streak += 1
            if neg_streak >= INVERSION_NEG_PERSIST_MIN:
                inversion_idx = i
                break
        else:
            neg_streak = 0

    if inversion_idx is None:
        return _exit_at_or_after(
            post, eod_ts, entry_price, 'eod_no_inversion_found'
        )

    inversion_ts = flow_after_peak[inversion_idx][0]
    return _exit_at_or_after(post, inversion_ts, entry_price, 'inversion')


# ============================================================
# DB + parquet IO
# ============================================================


@dataclass
class Fire:
    id: int
    option_chain_id: str
    entry_time_ct: pd.Timestamp
    entry_price: float


@dataclass
class FlowFire:
    id: int
    option_chain_id: str
    underlying_symbol: str
    option_type: str  # 'C' or 'P'
    trigger_time_ct: pd.Timestamp
    entry_price: float
    fire_date: str  # YYYY-MM-DD


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env file: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(m.group(1), m.group(2).strip('"').strip("'"))


def detect_latest_date() -> str:
    suffix = PARQUET_FILE_PATTERN.format(date='')
    files = sorted(PARQUET_DIR.glob(f'*{suffix}'))
    if not files:
        sys.exit(f'No *{suffix} files in {PARQUET_DIR}')
    m = re.match(rf'(\d{{4}}-\d{{2}}-\d{{2}}){re.escape(suffix)}', files[-1].name)
    if not m:
        sys.exit(f'Cannot parse date from {files[-1].name}')
    return m.group(1)


def fetch_unenriched(conn, target_date: str) -> list[Fire]:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, option_chain_id, entry_time_ct, entry_price
        FROM lottery_finder_fires
        WHERE date = %s AND enriched_at IS NULL
        ORDER BY inserted_at ASC
        """,
        (target_date,),
    )
    rows = cur.fetchall()
    return [
        Fire(
            id=r[0],
            option_chain_id=r[1],
            entry_time_ct=pd.Timestamp(r[2]),
            entry_price=float(r[3]),
        )
        for r in rows
    ]


def load_parquet_chain_index(
    target_date: str,
    fired_chains: set[str],
    include_nbbo: bool = False,
) -> dict[str, pd.DataFrame]:
    """Load the day's parquet, filter to fired chains, return a dict of
    chain_id → sorted DataFrame. Includes nbbo_bid/nbbo_ask columns when
    include_nbbo=True (used by the flow-inversion second pass)."""
    path = PARQUET_DIR / PARQUET_FILE_PATTERN.format(date=target_date)
    if not path.exists():
        sys.exit(f'Parquet not found: {path}')

    cols = ['executed_at', 'option_chain_id', 'price', 'canceled']
    if include_nbbo:
        cols += ['nbbo_bid', 'nbbo_ask', 'size']

    # `canceled` was bool in older parquets and string ('f'/'t') in
    # newer ones — push only the chain filter, then post-filter
    # canceled in pandas to handle both shapes.
    df = pd.read_parquet(
        path,
        columns=cols,
        filters=[('option_chain_id', 'in', list(fired_chains))],
    )
    # Older fulltape parquets (Jan-Apr 2026) store numeric columns as
    # decimal128 instead of float64; pandas returns those as Python
    # Decimal objects that don't interop with floats in the exit-policy
    # math. Coerce all numerics to float64 at the boundary.
    for col in ('price', 'nbbo_bid', 'nbbo_ask', 'size'):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').astype('float64')
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[
            df['canceled'].astype(str).str.lower().isin(['f', 'false', '0', ''])
        ]
    df = df[df['price'] > 0].copy()
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    df = df.sort_values(['option_chain_id', 'executed_at'], kind='stable')

    return dict(iter(df.groupby('option_chain_id', sort=False)))


def resample_minute_mid(
    chain_df: pd.DataFrame,
) -> list[tuple[datetime, float]]:
    """Per-minute synthetic mid from NBBO bid/ask, size-weighted,
    skipping rows where either side is 0 (missing quote)."""
    if 'nbbo_bid' not in chain_df.columns:
        return []
    valid = chain_df[
        (chain_df['nbbo_bid'] > 0) & (chain_df['nbbo_ask'] > 0)
    ]
    if valid.empty:
        return []
    mid = (valid['nbbo_bid'] + valid['nbbo_ask']) / 2.0
    sz = valid['size'].astype(float).clip(lower=1.0)
    weighted = (mid * sz).rename('wm')
    df = pd.DataFrame({
        'ts': valid['executed_at'].dt.floor('min'),
        'wm': weighted.values,
        'sz': sz.values,
    })
    grouped = df.groupby('ts', sort=True).agg(
        wm_sum=('wm', 'sum'), sz_sum=('sz', 'sum')
    )
    grouped['mid'] = grouped['wm_sum'] / grouped['sz_sum']
    return [(ts.to_pydatetime(), float(m)) for ts, m in grouped['mid'].items()]


def load_matched_flow(
    conn, target_date: str, ticker: str, option_type: str
) -> list[tuple[datetime, float]]:
    """Per-minute matched-side flow (net_call_prem for C, net_put_prem
    for P). Cached at the call site by (ticker, option_type)."""
    cur = conn.cursor()
    col = 'net_call_prem' if option_type == 'C' else 'net_put_prem'
    cur.execute(
        f"""
        SELECT ts, {col}
        FROM net_flow_per_ticker_history
        WHERE ticker = %s
          AND ts >= %s::timestamptz
          AND ts <  %s::timestamptz + INTERVAL '1 day'
        ORDER BY ts ASC
        """,
        (ticker, f'{target_date}T00:00:00Z', f'{target_date}T00:00:00Z'),
    )
    out: list[tuple[datetime, float]] = []
    for ts, val in cur.fetchall():
        if val is None:
            continue
        try:
            v = float(val)
        except (TypeError, ValueError):
            continue
        if not np.isfinite(v):
            continue
        out.append((ts, v))
    return out


def fetch_flow_unfilled(conn, target_date: str) -> list[FlowFire]:
    """Fires for the target date that lack realized_flow_inversion_pct.
    Independent of the main pass's enriched_at WHERE clause — even
    fires we already marked enriched-with-NULLs for the trail/peak
    metrics get a flow-inversion attempt here."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, option_chain_id, underlying_symbol, option_type,
               trigger_time_ct, entry_price, date
        FROM lottery_finder_fires
        WHERE date = %s AND realized_flow_inversion_pct IS NULL
        ORDER BY id ASC
        """,
        (target_date,),
    )
    rows = cur.fetchall()
    return [
        FlowFire(
            id=r[0],
            option_chain_id=r[1],
            underlying_symbol=r[2],
            option_type=r[3],
            trigger_time_ct=pd.Timestamp(r[4]),
            entry_price=float(r[5]),
            fire_date=r[6].isoformat() if hasattr(r[6], 'isoformat') else str(r[6])[:10],
        )
        for r in rows
    ]


def update_flow_inversion(conn, updates: list[tuple[int, float]]) -> None:
    if not updates:
        return
    cur = conn.cursor()
    execute_values(
        cur,
        """
        UPDATE lottery_finder_fires AS f
        SET realized_flow_inversion_pct = v.exit_pct
        FROM (VALUES %s) AS v(id, exit_pct)
        WHERE f.id = v.id
        """,
        updates,
        template='(%s::bigint, %s::numeric)',
        page_size=500,
    )
    conn.commit()


def run_flow_inversion_pass(conn, target_date: str) -> None:
    fires = fetch_flow_unfilled(conn, target_date)
    print(f'[flow-inv] fires lacking flow_inversion: {len(fires):,}')
    if not fires:
        return

    chain_index = load_parquet_chain_index(
        target_date, {f.option_chain_id for f in fires}, include_nbbo=True
    )

    # Per (option_chain) cache of resampled per-minute mids.
    minute_cache: dict[str, list[tuple[datetime, float]]] = {}
    # Per (ticker, option_type) cache of matched-side flow.
    flow_cache: dict[tuple[str, str], list[tuple[datetime, float]]] = {}

    t0 = time.time()
    updates: list[tuple[int, float]] = []
    status_counts: dict[str, int] = {}

    for fire in fires:
        chain_df = chain_index.get(fire.option_chain_id)
        if chain_df is None:
            status_counts['no_chain'] = status_counts.get('no_chain', 0) + 1
            continue

        if fire.option_chain_id not in minute_cache:
            minute_cache[fire.option_chain_id] = resample_minute_mid(chain_df)
        minutes = minute_cache[fire.option_chain_id]

        flow_key = (fire.underlying_symbol, fire.option_type)
        if flow_key not in flow_cache:
            flow_cache[flow_key] = load_matched_flow(
                conn, target_date, fire.underlying_symbol, fire.option_type
            )
        flow = flow_cache[flow_key]

        trigger_dt = fire.trigger_time_ct
        if trigger_dt.tz is None:
            trigger_dt = trigger_dt.tz_localize('UTC')
        trigger_dt = trigger_dt.to_pydatetime()

        exit_pct, _, status = simulate_flow_inversion(
            minutes, flow, fire.entry_price, trigger_dt
        )
        status_counts[status] = status_counts.get(status, 0) + 1
        if exit_pct is not None and np.isfinite(exit_pct):
            updates.append((fire.id, exit_pct))

    print(
        f'[flow-inv] computed {len(updates):,} exits '
        f'in {time.time() - t0:.1f}s'
    )
    for status, n in sorted(status_counts.items(), key=lambda x: -x[1]):
        print(f'[flow-inv]   {status}: {n}')

    update_flow_inversion(conn, updates)
    print(f'[flow-inv] DB updated: {len(updates):,} rows')


def compute_fire_outcomes(
    fire: Fire, chain_df: pd.DataFrame
) -> tuple[float, float, float, float, float, float] | None:
    entry_ts = fire.entry_time_ct
    if entry_ts.tz is None:
        entry_ts = entry_ts.tz_localize('UTC')
    post = chain_df[chain_df['executed_at'] >= entry_ts]
    if len(post) == 0:
        return None

    prices = post['price'].astype(float).tolist()
    minutes = ((post['executed_at'] - entry_ts).dt.total_seconds() / 60.0).tolist()

    trail = realized_trail_act30_trail10(prices, fire.entry_price)
    hard30 = realized_hard_stop_30m(prices, fire.entry_price, minutes)
    tier50 = realized_tier50_hold_eod(prices, fire.entry_price)
    eod = ((prices[-1] - fire.entry_price) / fire.entry_price) * 100.0
    peak = peak_ceiling(prices, fire.entry_price)
    mtp = minutes_to_peak(prices, minutes)
    return trail, hard30, tier50, eod, peak, mtp


def update_fires(conn, updates: list[tuple]) -> None:
    """Bulk UPDATE via VALUES + UPDATE FROM. Faster than per-row UPDATE."""
    if not updates:
        return
    cur = conn.cursor()
    execute_values(
        cur,
        """
        UPDATE lottery_finder_fires AS f
        SET realized_trail30_10_pct       = v.trail,
            realized_hard30m_pct          = v.hard30,
            realized_tier50_holdeod_pct   = v.tier50,
            realized_eod_pct              = v.eod,
            peak_ceiling_pct              = v.peak,
            minutes_to_peak               = v.mtp,
            enriched_at                   = NOW()
        FROM (VALUES %s) AS v(id, trail, hard30, tier50, eod, peak, mtp)
        WHERE f.id = v.id
        """,
        updates,
        template='(%s::bigint, %s, %s, %s, %s, %s, %s)',
        page_size=500,
    )
    conn.commit()


def mark_no_post_ticks(conn, fire_ids: list[int]) -> None:
    """Mark fires whose entry was the last print as enriched-with-NULLs so
    we stop re-scanning them on every nightly run. Realized columns stay
    NULL — there is no realizable exit by definition.
    """
    if not fire_ids:
        return
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE lottery_finder_fires
        SET enriched_at = NOW()
        WHERE id = ANY(%s::bigint[])
        """,
        (fire_ids,),
    )
    conn.commit()
    # Warn if the UPDATE silently affected fewer rows than expected — happens
    # if a fire row was deleted between the fetch and this UPDATE. Without
    # this guard we'd commit cleanly and re-scan those IDs on the next nightly.
    if cur.rowcount != len(fire_ids):
        print(
            f'[enrich] WARN mark_no_post_ticks: expected {len(fire_ids)} rows '
            f'updated, got {cur.rowcount}',
            file=sys.stderr,
        )


def refit_ticker_inversion_stats(
    conn,
    write_db: bool,
    sim_csv_path: Path | None = None,
) -> None:
    """Recompute lottery_ticker_stats.inversion_* columns from the rolling
    21d / 90d window of realized_flow_inversion_pct values.

    When sim_csv_path is provided, also writes the tune-before-ship CSV
    (one row per historical fire in the last 90 days) so the operator
    can lock Tier 1/2 cutoffs.
    """
    # NB: the table's fire-time column is `trigger_time_ct` (TIMESTAMPTZ).
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              underlying_symbol AS ticker,
              COUNT(*) FILTER (
                WHERE trigger_time_ct >= NOW() - INTERVAL '21 days'
                  AND realized_flow_inversion_pct IS NOT NULL
              ) AS n_21d,
              COUNT(*) FILTER (
                WHERE trigger_time_ct >= NOW() - INTERVAL '21 days'
                  AND realized_flow_inversion_pct >= %s
              ) AS w_21d,
              COUNT(*) FILTER (
                WHERE trigger_time_ct >= NOW() - INTERVAL '90 days'
                  AND realized_flow_inversion_pct IS NOT NULL
              ) AS n_90d,
              COUNT(*) FILTER (
                WHERE trigger_time_ct >= NOW() - INTERVAL '90 days'
                  AND realized_flow_inversion_pct >= %s
              ) AS w_90d
            FROM lottery_finder_fires
            WHERE trigger_time_ct >= NOW() - INTERVAL '90 days'
            GROUP BY underlying_symbol
            """,
            (INVERSION_WIN_THRESHOLD, INVERSION_WIN_THRESHOLD),
        )
        rows = cur.fetchall()

    blends: dict[str, float | None] = {}
    per_ticker: dict[str, dict] = {}
    for ticker, n_21d, w_21d, n_90d, w_90d in rows:
        lcb_21 = wilson_lcb(w_21d, n_21d)
        lcb_90 = wilson_lcb(w_90d, n_90d)
        blend = inversion_blend(lcb_21, lcb_90)
        blends[ticker] = blend
        per_ticker[ticker] = {
            'lcb_21d': lcb_21,
            'lcb_90d': lcb_90,
            'blend': blend,
            'n_21d': n_21d,
            'n_90d': n_90d,
        }

    quintiles = quintile_cuts(blends)

    upsert_rows = []
    for ticker, stats in per_ticker.items():
        upsert_rows.append((
            ticker,
            stats['lcb_21d'],
            stats['lcb_90d'],
            stats['blend'],
            quintiles.get(ticker),
            stats['n_21d'],
            stats['n_90d'],
        ))

    quintile_counts = Counter(quintiles.values())
    print(f'[ticker-quality] {len(per_ticker)} tickers seen in 90d window')
    print(
        f'[ticker-quality] quintile distribution: '
        f'{dict(sorted(quintile_counts.items()))}'
    )
    null_count = sum(1 for b in blends.values() if b is None)
    print(
        f'[ticker-quality] {null_count} tickers had NULL blend '
        f'(no window with N >= {SAMPLE_SIZE_FLOOR})'
    )

    if not write_db:
        print('[ticker-quality] WRITE_DB not set — skipping UPSERT')
    else:
        with conn.cursor() as cur:
            batch_size = 500
            for i in range(0, len(upsert_rows), batch_size):
                batch = upsert_rows[i:i + batch_size]
                execute_values(
                    cur,
                    """
                    INSERT INTO lottery_ticker_stats (
                      ticker, inversion_lcb_21d, inversion_lcb_90d,
                      inversion_blend, inversion_quintile,
                      inversion_n_21d, inversion_n_90d, updated_at
                    )
                    VALUES %s
                    ON CONFLICT (ticker) DO UPDATE SET
                      inversion_lcb_21d = EXCLUDED.inversion_lcb_21d,
                      inversion_lcb_90d = EXCLUDED.inversion_lcb_90d,
                      inversion_blend = EXCLUDED.inversion_blend,
                      inversion_quintile = EXCLUDED.inversion_quintile,
                      inversion_n_21d = EXCLUDED.inversion_n_21d,
                      inversion_n_90d = EXCLUDED.inversion_n_90d,
                      updated_at = NOW()
                    """,
                    batch,
                    template='(%s, %s, %s, %s, %s, %s, %s, NOW())',
                )
        conn.commit()
        print(
            f'[ticker-quality] UPSERTed {len(upsert_rows)} rows '
            f'into lottery_ticker_stats'
        )

    if sim_csv_path is not None:
        _write_tune_csv(conn, quintiles, sim_csv_path)


def _write_tune_csv(
    conn, quintiles: dict[str, int], out_path: Path
) -> None:
    """Simulate quality_adjusted_score for the last 90d of fires and emit a
    CSV that lets the operator pick Tier 1/2 cutoffs hitting the 40-50/day target.
    """
    # NB: the table's fire-time column is `trigger_time_ct` and the score
    # column added in migration #174 is `score` (INTEGER).
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, underlying_symbol, date AS fire_date, score
            FROM lottery_finder_fires
            WHERE trigger_time_ct >= NOW() - INTERVAL '90 days'
              AND score IS NOT NULL
            """
        )
        fires = cur.fetchall()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    daily_passes: dict[tuple[int, int], dict] = defaultdict(
        lambda: defaultdict(int)
    )
    all_fire_dates: set = set()
    with out_path.open('w', newline='') as f:
        w = csv.writer(f)
        w.writerow([
            'fire_id', 'ticker', 'fire_date',
            'score', 'quintile', 'bonus',
            'quality_adjusted_score', 'would_be_filtered',
        ])
        for fid, ticker, fire_date, score in fires:
            all_fire_dates.add(fire_date)
            q = quintiles.get(ticker)
            bonus = (
                INVERSION_BONUS_BY_QUINTILE.get(q, 0)
                if q is not None
                else 0
            )
            qas = float(score) + bonus
            filtered = q in (1, 2) if q is not None else False
            w.writerow([
                fid, ticker, fire_date, score, q, bonus, qas, int(filtered)
            ])
            if not filtered:
                for t1 in range(22, 31):
                    for t2 in range(18, 27):
                        if t2 >= t1:
                            continue
                        if qas >= t2:
                            daily_passes[(t1, t2)][fire_date] += 1

    # Median must be computed over ALL trading dates with 0 as default —
    # otherwise stricter thresholds (which exclude low-count days) show
    # inflated medians because the low-count days are silently dropped.
    print(f'[ticker-quality] wrote simulation CSV to {out_path}')
    print(
        f'[ticker-quality] median daily Tier 1+2 count by cutoff '
        f'(over {len(all_fire_dates)} trading days in window):'
    )
    print('  tier1  tier2  median/day')
    for (t1, t2), per_day in sorted(daily_passes.items()):
        values = [per_day.get(d, 0) for d in all_fire_dates]
        med = statistics.median(values) if values else 0
        marker = '  <-- target' if 40 <= med <= 50 else ''
        print(f'  >={t1:>2}   >={t2:>2}     {med:>5.1f}{marker}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--date',
        help='YYYY-MM-DD; defaults to the latest matching parquet on disk',
    )
    parser.add_argument(
        '--parquet-dir',
        default=str(DEFAULT_PARQUET_DIR),
        help=f'Default: {DEFAULT_PARQUET_DIR}',
    )
    parser.add_argument(
        '--parquet-format',
        choices=sorted(PARQUET_FORMATS.keys()),
        default='trades',
        help='Parquet schema and filename suffix.',
    )
    args = parser.parse_args()

    global PARQUET_DIR, PARQUET_FILE_PATTERN
    PARQUET_DIR = Path(args.parquet_dir).expanduser()
    PARQUET_FILE_PATTERN = PARQUET_FORMATS[args.parquet_format]

    load_env()
    target_date = args.date or detect_latest_date()
    # Validate format.
    DateType.fromisoformat(target_date)

    print(f'[enrich] target date: {target_date}')

    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ.get(
        'DATABASE_URL'
    )
    if not db_url:
        sys.exit('DATABASE_URL_UNPOOLED / DATABASE_URL not set')

    conn = psycopg2.connect(db_url)
    try:
        fires = fetch_unenriched(conn, target_date)
        print(f'[enrich] unenriched fires: {len(fires):,}')
        if not fires:
            print('[enrich] main pass: nothing to do')
        else:
            chain_index = load_parquet_chain_index(
                target_date, {f.option_chain_id for f in fires}
            )
            print(f'[enrich] chains in parquet: {len(chain_index):,}')

            t0 = time.time()
            updates: list[tuple] = []
            no_post_tick_ids: list[int] = []
            skipped_chain_missing = 0
            for fire in fires:
                chain_df = chain_index.get(fire.option_chain_id)
                if chain_df is None:
                    skipped_chain_missing += 1
                    continue
                res = compute_fire_outcomes(fire, chain_df)
                if res is None:
                    no_post_tick_ids.append(fire.id)
                    continue
                trail, hard30, tier50, eod, peak, mtp = res
                updates.append(
                    (fire.id, trail, hard30, tier50, eod, peak, mtp)
                )

            print(
                f'[enrich] computed {len(updates):,} outcomes '
                f'in {time.time() - t0:.1f}s '
                f'(skipped: {skipped_chain_missing} no-chain, '
                f'{len(no_post_tick_ids)} no-post-ticks)'
            )

            update_fires(conn, updates)
            mark_no_post_ticks(conn, no_post_tick_ids)
            print(
                f'[enrich] DB updated: {len(updates):,} rows '
                f'(+ {len(no_post_tick_ids)} marked enriched-with-NULLs)'
            )

        # Second pass — flow-inversion. Targets `realized_flow_inversion_pct
        # IS NULL` regardless of enriched_at, so it backfills both the
        # rows we just enriched AND any historical fires the Vercel cron
        # missed.
        run_flow_inversion_pass(conn, target_date)

        # Third pass — per-ticker inversion-quality refit (Phase 2 of the
        # inversion-quality filter). Runs against whatever is in
        # lottery_finder_fires regardless of whether today's main pass ran.
        sim_csv = Path(f'docs/tmp/lottery-quality-sim-{target_date}.csv')
        refit_ticker_inversion_stats(
            conn,
            write_db=bool(int(os.environ.get('WRITE_DB', '0'))),
            sim_csv_path=sim_csv,
        )

    finally:
        conn.close()


if __name__ == '__main__':
    main()
