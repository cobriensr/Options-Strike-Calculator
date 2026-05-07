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
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import date as DateType, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

PARQUET_DIR = Path.home() / 'Desktop' / 'Bot-Eod-parquet'
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
    files = sorted(PARQUET_DIR.glob('*-trades.parquet'))
    if not files:
        sys.exit(f'No *-trades.parquet files in {PARQUET_DIR}')
    m = re.match(r'(\d{4}-\d{2}-\d{2})-trades\.parquet', files[-1].name)
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
    path = PARQUET_DIR / f'{target_date}-trades.parquet'
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--date',
        help='YYYY-MM-DD; defaults to the latest *-trades.parquet on disk',
    )
    args = parser.parse_args()

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
            run_flow_inversion_pass(conn, target_date)
            return

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

    finally:
        conn.close()


if __name__ == '__main__':
    main()
