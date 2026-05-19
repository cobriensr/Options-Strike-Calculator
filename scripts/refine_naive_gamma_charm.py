"""Naive (gex_strike_0dte) gamma + charm filter analysis — FAST.

Mirrors the Periscope I + L filter analyses but uses naive OI-weighted
gex_strike_0dte data:
  - net_gamma = call_gamma_oi + put_gamma_oi
  - net_charm = call_charm_oi + put_charm_oi

Speed optimizations vs first attempt:
  1. Pre-filter events to candidates BEFORE the parquet R lookup loop.
     Only events with lvl_rank OR chg_rank >= 0.75 (top-25%) move forward.
  2. Per-day pre-loaded trade dict keyed by strike, sorted by time.
  3. Binary search via numpy searchsorted for entry + max within horizon.

Pipeline per day (30 full-coverage days, 2026-04-07 → 2026-05-18):
  1. Load gex_strike_0dte rows for the day.
  2. Per strike, compute delta + per-day percentile ranks.
  3. Filter to broad candidate set (top-25% on either axis).
  4. Pre-load parquet calls + puts for relevant strike ranges.
  5. Vectorized R lookup for each (event, offset, horizon).
"""
from __future__ import annotations

import os
import warnings
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
import pyarrow.parquet as pq
from dotenv import load_dotenv

warnings.filterwarnings('ignore')
load_dotenv('.env.local')

BOT_EOD = Path('/Users/charlesobrien/Desktop/Bot-Eod-parquet')
FULL_TAPE = Path('/Users/charlesobrien/Desktop/Eod-Full-Tape-parquet')
OUT = Path('docs/tmp/forensic-multi-day')
DB_URL = os.environ['DATABASE_URL_UNPOOLED']

OFFSETS_CALL = [25, 50, 75, 100]
OFFSETS_PUT = [25, 50, 75, 100]
HORIZONS_I = [60, 120]
HORIZONS_L = [120, 180]
PCT_THRESHOLDS = [0.005, 0.01, 0.02, 0.05, 0.10, 0.20]
TP_RULES = [0.5, 1.0, 2.0, 5.0, 10.0]

# Filter upstream: only compute R for events in top-25% per axis.
# This is loose enough to permit the full grid sweep down to top-25%
# but tight enough to cut compute by ~75%.
CANDIDATE_RANK_FLOOR = 0.75


def db_query(sql: str) -> pd.DataFrame:
    with psycopg2.connect(DB_URL) as conn:
        return pd.read_sql(sql, conn)


def get_parquet_path(d: date) -> Path | None:
    bot = BOT_EOD / f'{d.isoformat()}-trades.parquet'
    if bot.exists():
        return bot
    ft = FULL_TAPE / f'{d.isoformat()}-fulltape.parquet'
    if ft.exists():
        return ft
    return None


def load_day_trades_indexed(d: date, strike_lo: float, strike_hi: float,
                             option_type: str) -> dict:
    """Returns dict of {strike: (np.array of timestamps, np.array of prices)}.
    Each strike's arrays are sorted by timestamp for binary search.
    """
    path = get_parquet_path(d)
    if path is None:
        return {}
    tbl = pq.read_table(
        path,
        filters=[
            ('underlying_symbol', '=', 'SPXW'),
            ('expiry', '=', d),
            ('option_type', '=', option_type),
            ('strike', '>=', strike_lo),
            ('strike', '<=', strike_hi),
        ],
        columns=['executed_at', 'strike', 'price'],
    )
    if tbl.num_rows == 0:
        return {}
    df = tbl.to_pandas().sort_values('executed_at')
    df['executed_at'] = pd.to_datetime(df['executed_at'], utc=True)
    # Index by strike, store (sorted ts array, price array)
    out: dict = {}
    for strike, g in df.groupby('strike'):
        # Cast to ns resolution explicitly. Parquet stores us-resolution
        # timestamps; pd.Timestamp.value always returns ns. Keep both in
        # ns so np.searchsorted compares apples to apples.
        ts_arr = (g['executed_at'].dt.tz_convert('UTC')
                   .astype('datetime64[ns, UTC]')
                   .astype('int64').to_numpy())
        px_arr = g['price'].to_numpy().astype(float)
        out[float(strike)] = (ts_arr, px_arr)
    return out


def compute_R_fast(trades_dict: dict, trade_k: float,
                   ts_ns: int, horizons: list[int]) -> dict:
    """Binary-search lookup for entry + max forward at trade_k.
    ts_ns is event timestamp as int64 nanoseconds since epoch (UTC).
    """
    if trade_k not in trades_dict:
        return {}
    ts_arr, px_arr = trades_dict[trade_k]
    entry_end = ts_ns + 5 * 60 * 1_000_000_000  # +5 minutes in ns
    i0 = np.searchsorted(ts_arr, ts_ns, side='left')
    i1 = np.searchsorted(ts_arr, entry_end, side='right')
    if i0 >= i1:
        return {}
    entry_px = float(px_arr[i0])
    if entry_px <= 0:
        return {}
    out = {'entry_px': entry_px}
    for h in horizons:
        h_end = ts_ns + h * 60 * 1_000_000_000
        j = np.searchsorted(ts_arr, h_end, side='right')
        if i0 >= j:
            continue
        max_px = float(px_arr[i0:j].max())
        out[f'max_px_{h}m'] = max_px
        out[f'R_{h}m'] = (max_px - entry_px) / entry_px
    return out


def detect_events_filtered(gex_day: pd.DataFrame, value_col: str,
                            rank_floor: float = CANDIDATE_RANK_FLOOR
                            ) -> pd.DataFrame:
    df = gex_day.sort_values(['strike', 'timestamp']).copy()
    df['prior_value'] = df.groupby('strike')[value_col].shift(1)
    df['delta'] = df[value_col] - df['prior_value']
    df = df.dropna(subset=['delta'])
    df['abs_value'] = df[value_col].abs()
    df['abs_delta'] = df['delta'].abs()
    df['lvl_rank'] = df['abs_value'].rank(pct=True)
    df['chg_rank'] = df['abs_delta'].rank(pct=True)
    df['post_sign'] = np.sign(df[value_col])
    # Pre-filter: only events with lvl OR chg in top-25%
    return df[(df['lvl_rank'] >= rank_floor)
               | (df['chg_rank'] >= rank_floor)]


def load_spot(start: str, end: str) -> pd.DataFrame:
    df = db_query(f"""
        SELECT timestamp, close FROM index_candles_1m
        WHERE symbol='SPX' AND timestamp >= '{start}' AND timestamp < '{end}'
        ORDER BY timestamp
    """)
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    df['close'] = df['close'].astype(float)
    return df.set_index('timestamp')


def attach_spot(events_df: pd.DataFrame, spot: pd.DataFrame) -> pd.DataFrame:
    """Vectorized spot-at-event lookup using merge_asof."""
    if events_df.empty or spot.empty:
        events_df['spot_at_event'] = np.nan
        return events_df
    ev = events_df.copy().sort_values('timestamp')
    sp = spot.reset_index().sort_values('timestamp')
    out = pd.merge_asof(ev, sp[['timestamp', 'close']], on='timestamp',
                         direction='backward')
    out = out.rename(columns={'close': 'spot_at_event'})
    return out


# --------------------------- I (call lottery) ----------------------------


def process_day_I(d: date, gex_day: pd.DataFrame,
                   spot_full: pd.DataFrame) -> pd.DataFrame:
    g = gex_day.copy()
    g['net_gamma'] = (g['call_gamma_oi'].astype(float)
                      + g['put_gamma_oi'].astype(float))
    events = detect_events_filtered(g, 'net_gamma')
    if events.empty:
        return pd.DataFrame()

    events = attach_spot(events, spot_full).dropna(subset=['spot_at_event'])
    events['strike'] = events['strike'].astype(float)
    events = events[events['strike'] > events['spot_at_event']]
    if events.empty:
        return pd.DataFrame()

    strike_lo = float(events['strike'].min()) - 5
    strike_hi = float(events['strike'].max()) + max(OFFSETS_CALL) + 5
    trades = load_day_trades_indexed(d, strike_lo, strike_hi, 'call')
    if not trades:
        return pd.DataFrame()

    rows: list[dict] = []
    for _, ev in events.iterrows():
        ts_ns = pd.Timestamp(ev['timestamp']).value  # int64 ns since epoch UTC
        for off in OFFSETS_CALL:
            trade_k = float(ev['strike']) + off
            R = compute_R_fast(trades, trade_k, ts_ns, HORIZONS_I)
            if not R:
                continue
            rows.append({
                'day': d.isoformat(),
                'timestamp': ev['timestamp'],
                'event_strike': float(ev['strike']),
                'spot_at_event': float(ev['spot_at_event']),
                'net_gamma_post': float(ev['net_gamma']),
                'net_gamma_delta': float(ev['delta']),
                'lvl_rank': float(ev['lvl_rank']),
                'chg_rank': float(ev['chg_rank']),
                'post_sign': float(ev['post_sign']),
                'offset': off,
                'trade_strike': trade_k,
                **R,
            })
    return pd.DataFrame(rows)


# --------------------------- L (put lottery) -----------------------------


def process_day_L(d: date, gex_day: pd.DataFrame,
                   spot_full: pd.DataFrame) -> pd.DataFrame:
    g = gex_day.copy()
    g['net_charm'] = (g['call_charm_oi'].astype(float)
                      + g['put_charm_oi'].astype(float))
    events = detect_events_filtered(g, 'net_charm')
    if events.empty:
        return pd.DataFrame()

    events = attach_spot(events, spot_full).dropna(subset=['spot_at_event'])
    events['strike'] = events['strike'].astype(float)
    events = events[events['strike'] < events['spot_at_event']]
    if events.empty:
        return pd.DataFrame()

    strike_lo = float(events['strike'].min()) - max(OFFSETS_PUT) - 5
    strike_hi = float(events['strike'].max()) + 5
    trades = load_day_trades_indexed(d, strike_lo, strike_hi, 'put')
    if not trades:
        return pd.DataFrame()

    rows: list[dict] = []
    for _, ev in events.iterrows():
        ts_ns = pd.Timestamp(ev['timestamp']).value  # int64 ns since epoch UTC
        for off in OFFSETS_PUT:
            trade_k = float(ev['strike']) - off
            R = compute_R_fast(trades, trade_k, ts_ns, HORIZONS_L)
            if not R:
                continue
            rows.append({
                'day': d.isoformat(),
                'timestamp': ev['timestamp'],
                'event_strike': float(ev['strike']),
                'spot_at_event': float(ev['spot_at_event']),
                'net_charm_post': float(ev['net_charm']),
                'net_charm_delta': float(ev['delta']),
                'lvl_rank': float(ev['lvl_rank']),
                'chg_rank': float(ev['chg_rank']),
                'post_sign': float(ev['post_sign']),
                'offset': off,
                'trade_strike': trade_k,
                **R,
            })
    return pd.DataFrame(rows)


# --------------------------- THRESHOLD SWEEP -----------------------------


def sweep_grid(events_df: pd.DataFrame, horizons: list[int],
                filter_kind: str) -> pd.DataFrame:
    if events_df.empty:
        return pd.DataFrame()
    rows: list[dict] = []
    for pct in PCT_THRESHOLDS:
        cut = 1.0 - pct
        if filter_kind == 'I':
            sign_specs = [
                ('all', events_df),
                ('deep_neg', events_df[events_df['post_sign'] < 0]),
                ('deep_pos', events_df[events_df['post_sign'] > 0]),
            ]
            axis_specs = lambda df: [
                ('and', df[(df['lvl_rank'] >= cut) & (df['chg_rank'] >= cut)]),
                ('change_only', df[df['chg_rank'] >= cut]),
                ('level_only', df[df['lvl_rank'] >= cut]),
            ]
        else:
            sign_specs = [
                ('all', events_df),
                ('post_pos', events_df[events_df['post_sign'] > 0]),
                ('post_neg', events_df[events_df['post_sign'] < 0]),
            ]
            axis_specs = lambda df: [
                ('change_only', df[df['chg_rank'] >= cut]),
            ]
        for sign_label, sign_df in sign_specs:
            for axis_label, axis_df in axis_specs(sign_df):
                for off in OFFSETS_CALL if filter_kind == 'I' else OFFSETS_PUT:
                    for h in horizons:
                        col = f'R_{h}m'
                        if col not in axis_df.columns:
                            continue
                        sub = axis_df[axis_df['offset'] == off][col].dropna()
                        if len(sub) < 5:
                            continue
                        R = sub.clip(lower=-1)
                        row = {
                            'pct': pct,
                            'sign': sign_label,
                            'axis': axis_label,
                            'offset': off,
                            'horizon': h,
                            'n': len(R),
                            'mean_R': float(R.mean()),
                            'max_R': float(R.max()),
                        }
                        for TP in TP_RULES:
                            row[f'hit_R{TP}'] = float((R >= TP).mean())
                            real = np.where(R >= TP, TP, -1.0)
                            row[f'realR_TP{TP}'] = float(real.mean())
                        rows.append(row)
    return pd.DataFrame(rows)


# --------------------------- DRIVER --------------------------------------


def main() -> None:
    import time
    t_start = time.time()
    print('Identifying full-coverage days...')
    day_summary = db_query("""
        SELECT date, COUNT(DISTINCT timestamp) ts_count
        FROM gex_strike_0dte GROUP BY date ORDER BY date
    """)
    full_days = day_summary[day_summary['ts_count'] >= 50]['date'].tolist()
    print(f'  full-coverage days: {len(full_days)}')

    print('Loading SPX 1m candles...')
    spot_full = load_spot(full_days[0].isoformat(),
                            (pd.Timestamp(full_days[-1])
                             + pd.Timedelta(days=1)).date().isoformat())
    print(f'  spot bars: {len(spot_full):,}')

    print('\n=== Phase 1: I (naive gamma call lottery) ===')
    all_I: list[pd.DataFrame] = []
    for i, d in enumerate(full_days):
        d = d if isinstance(d, date) else pd.Timestamp(d).date()
        t0 = time.time()
        gex_day = db_query(f"""
            SELECT timestamp, strike, call_gamma_oi, put_gamma_oi
            FROM gex_strike_0dte WHERE date = '{d.isoformat()}'
            ORDER BY strike, timestamp
        """)
        gex_day['timestamp'] = pd.to_datetime(gex_day['timestamp'], utc=True)
        df = process_day_I(d, gex_day, spot_full)
        elapsed = time.time() - t0
        print(f'[{i + 1:>2}/{len(full_days)}] {d}: '
              f'{len(df)} rows ({elapsed:.1f}s)', flush=True)
        if not df.empty:
            all_I.append(df)
    I_all = pd.concat(all_I, ignore_index=True) if all_I else pd.DataFrame()
    I_all.to_csv(OUT / 'refine_naive_I_events.csv', index=False)
    print(f'I total events: {len(I_all)}, phase1 elapsed: {time.time() - t_start:.0f}s')

    print('\n=== Phase 2: L (naive charm put lottery) ===')
    t_phase2 = time.time()
    all_L: list[pd.DataFrame] = []
    for i, d in enumerate(full_days):
        d = d if isinstance(d, date) else pd.Timestamp(d).date()
        t0 = time.time()
        gex_day = db_query(f"""
            SELECT timestamp, strike, call_charm_oi, put_charm_oi
            FROM gex_strike_0dte WHERE date = '{d.isoformat()}'
            ORDER BY strike, timestamp
        """)
        gex_day['timestamp'] = pd.to_datetime(gex_day['timestamp'], utc=True)
        df = process_day_L(d, gex_day, spot_full)
        elapsed = time.time() - t0
        print(f'[{i + 1:>2}/{len(full_days)}] {d}: '
              f'{len(df)} rows ({elapsed:.1f}s)', flush=True)
        if not df.empty:
            all_L.append(df)
    L_all = pd.concat(all_L, ignore_index=True) if all_L else pd.DataFrame()
    L_all.to_csv(OUT / 'refine_naive_L_events.csv', index=False)
    print(f'L total events: {len(L_all)}, phase2 elapsed: {time.time() - t_phase2:.0f}s')

    print('\n=== Phase 3: Threshold sweep ===')
    if not I_all.empty:
        I_grid = sweep_grid(I_all, HORIZONS_I, 'I')
        I_grid.to_csv(OUT / 'refine_naive_I_grid.csv', index=False)
    if not L_all.empty:
        L_grid = sweep_grid(L_all, HORIZONS_L, 'L')
        L_grid.to_csv(OUT / 'refine_naive_L_grid.csv', index=False)

    print(f'\nTotal elapsed: {time.time() - t_start:.0f}s')


if __name__ == '__main__':
    main()
