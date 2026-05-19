"""SPY/QQQ flow features + Out-of-sample validation on 2026-04-01 → 04-10.

Task 1: For each in-sample I and L event, pull SPY/QQQ net flow from
        net_flow_per_ticker_history at the event timestamp + rolling
        windows. Test as discriminators.

Task 2: OOS validation. Pull periscope gamma/charm events for 2026-04-01
        through 2026-04-12 (7 trading days, fully out-of-sample for
        Bot-Eod parquet — uses Eod-Full-Tape parquet for option prices).
        Apply v3 filters. Report hit rates.

Outputs:
  refine_spy_qqq_features.csv
  refine_oos_I_events.csv
  refine_oos_L_events.csv
  refine_spy_qqq_oos.md
"""
from __future__ import annotations

import os
import warnings
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
import pyarrow.parquet as pq
from dotenv import load_dotenv
from scipy import stats

warnings.filterwarnings('ignore')
load_dotenv('.env.local')

BOT_EOD = Path('/Users/charlesobrien/Desktop/Bot-Eod-parquet')
FULL_TAPE = Path('/Users/charlesobrien/Desktop/Eod-Full-Tape-parquet')
OUT = Path('docs/tmp/forensic-multi-day')
DB_URL = os.environ['DATABASE_URL_UNPOOLED']


def db_query(sql: str, params=None) -> pd.DataFrame:
    with psycopg2.connect(DB_URL) as conn:
        return pd.read_sql(sql, conn, params=params)


def get_parquet_path(d: date) -> Path | None:
    bot = BOT_EOD / f'{d.isoformat()}-trades.parquet'
    if bot.exists():
        return bot
    ft = FULL_TAPE / f'{d.isoformat()}-fulltape.parquet'
    if ft.exists():
        return ft
    return None


# ========================================================================
# TASK 1: SPY/QQQ flow features for existing I and L events
# ========================================================================


def pull_index_flow_window(ticker: str, end_ts: pd.Timestamp,
                            window_min: int) -> dict:
    """Sum/aggregate net_flow stats over (end_ts - window, end_ts]."""
    start = end_ts - pd.Timedelta(minutes=window_min)
    df = db_query(
        f"""
        SELECT net_call_prem, net_put_prem, net_call_vol, net_put_vol,
               call_volume, call_volume_ask_side, call_volume_bid_side,
               put_volume, put_volume_ask_side, put_volume_bid_side
        FROM net_flow_per_ticker_history
        WHERE ticker = %s AND ts > %s AND ts <= %s
        """,
        (ticker, start.to_pydatetime(), end_ts.to_pydatetime()),
    )
    if df.empty:
        return {}
    sums = df.sum(numeric_only=True).to_dict()
    out = {}
    for k, v in sums.items():
        out[f'{ticker}_{k}_{window_min}m'] = float(v) if pd.notna(v) else None
    # Derived
    call_v = sums.get('call_volume', 0) or 0
    put_v = sums.get('put_volume', 0) or 0
    call_ask = sums.get('call_volume_ask_side', 0) or 0
    put_ask = sums.get('put_volume_ask_side', 0) or 0
    out[f'{ticker}_call_ask_pct_{window_min}m'] = (
        call_ask / call_v if call_v > 0 else None)
    out[f'{ticker}_put_ask_pct_{window_min}m'] = (
        put_ask / put_v if put_v > 0 else None)
    net_prem = (sums.get('net_call_prem', 0) or 0) - (sums.get('net_put_prem', 0) or 0)
    total_prem = abs(sums.get('net_call_prem', 0) or 0) + abs(sums.get('net_put_prem', 0) or 0)
    out[f'{ticker}_net_prem_balance_{window_min}m'] = (
        net_prem / total_prem if total_prem > 0 else None)
    return out


def task1_add_spy_qqq(events: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict] = []
    for _, e in events.iterrows():
        ts = pd.Timestamp(e['captured_at'])
        if ts.tzinfo is None:
            ts = ts.tz_localize('UTC')
        row = {'idx': e.name}
        for ticker in ['SPY', 'QQQ']:
            for w in [5, 15, 30]:
                row.update(pull_index_flow_window(ticker, ts, w))
        rows.append(row)
    return pd.DataFrame(rows)


# ========================================================================
# TASK 2: OOS validation 2026-04-01 → 04-10
# ========================================================================


OOS_DAYS = [
    date(2026, 4, 1), date(2026, 4, 2), date(2026, 4, 6), date(2026, 4, 7),
    date(2026, 4, 8), date(2026, 4, 9), date(2026, 4, 10),
]


def load_periscope_events_for_day(d: date, panel: str) -> pd.DataFrame:
    """Match in-sample pipeline: first detect top-1% per-day magnitude-jump
    events, THEN rank within that subset for the AND filter."""
    df = db_query(
        f"""
        SELECT captured_at, strike, value
        FROM periscope_snapshots
        WHERE expiry = '{d.isoformat()}' AND panel = '{panel}'
        ORDER BY strike, captured_at
        """
    )
    if df.empty:
        return df
    df['captured_at'] = pd.to_datetime(df['captured_at'], utc=True)
    df['strike'] = df['strike'].astype(float)
    df['value'] = df['value'].astype(float)
    df = df.sort_values(['strike', 'captured_at']).copy()
    df['prior_value'] = df.groupby('strike')['value'].shift(1)
    df['delta'] = df['value'] - df['prior_value']
    df = df.dropna(subset=['delta'])
    # Stage 1: top-1% per-day by |delta| (matches in-sample event detection)
    threshold = df['delta'].abs().quantile(0.99)
    df = df[df['delta'].abs() >= threshold].copy()
    # Stage 2: rank WITHIN the top-1% subset (matches in-sample
    # refine_top5_v2 nested ranking)
    df['abs_value'] = df['value'].abs()
    df['abs_delta'] = df['delta'].abs()
    df['lvl_rank'] = df['abs_value'].rank(pct=True)
    df['chg_rank'] = df['abs_delta'].rank(pct=True)
    return df


def load_spot_day(d: date) -> pd.DataFrame:
    df = db_query(
        f"""
        SELECT timestamp, close FROM index_candles_1m
        WHERE symbol='SPX' AND timestamp >= '{d.isoformat()}'
          AND timestamp < '{(d + timedelta(days=1)).isoformat()}'
        ORDER BY timestamp
        """
    )
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    df['close'] = df['close'].astype(float)
    return df.set_index('timestamp')


def attach_spot(events_df: pd.DataFrame, spot: pd.DataFrame
                 ) -> pd.DataFrame:
    if events_df.empty or spot.empty:
        return events_df
    ev = events_df.sort_values('captured_at').copy()
    sp = spot.reset_index().sort_values('timestamp').rename(
        columns={'timestamp': 'captured_at'})
    return pd.merge_asof(ev, sp[['captured_at', 'close']],
                         on='captured_at', direction='backward').rename(
        columns={'close': 'spot_at_event'})


def load_trades_day(d: date, strike_lo: float, strike_hi: float,
                     option_type: str) -> dict:
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
    df = tbl.to_pandas().sort_values('executed_at').reset_index(drop=True)
    df['executed_at'] = pd.to_datetime(df['executed_at'], utc=True)
    out = {}
    for strike, g in df.groupby('strike'):
        ts_arr = (g['executed_at'].dt.tz_convert('UTC')
                   .astype('datetime64[ns, UTC]').astype('int64').to_numpy())
        px_arr = g['price'].to_numpy().astype(float)
        out[float(strike)] = (ts_arr, px_arr)
    return out


def compute_R(trades: dict, strike: float, ts_ns: int,
              horizons: list[int]) -> dict:
    if strike not in trades:
        return {}
    ts_arr, px_arr = trades[strike]
    entry_end = ts_ns + 5 * 60 * 1_000_000_000
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
        out[f'R_{h}m'] = (max_px - entry_px) / entry_px
    return out


def fetch_gex_target(strike: float, ts: pd.Timestamp) -> dict:
    df = db_query(
        f"""
        SELECT gex_dollars, call_ratio
        FROM gex_target_features
        WHERE strike = %s AND mode = 'oi' AND timestamp <= %s
        ORDER BY timestamp DESC LIMIT 1
        """,
        (float(strike), ts.to_pydatetime()),
    )
    if df.empty:
        return {}
    return {'gex_dollars': float(df.iloc[0]['gex_dollars']),
            'call_ratio': float(df.iloc[0]['call_ratio'])}


def oos_run() -> tuple[pd.DataFrame, pd.DataFrame]:
    I_rows: list[dict] = []
    L_rows: list[dict] = []
    for d in OOS_DAYS:
        print(f'  {d}', flush=True)
        # I (gamma)
        g = load_periscope_events_for_day(d, 'gamma')
        if g.empty:
            print(f'    no gamma events')
            continue
        spot = load_spot_day(d)
        if spot.empty:
            print(f'    no spot')
            continue
        g = attach_spot(g, spot).dropna(subset=['spot_at_event'])
        g['strike_dist'] = g['strike'] - g['spot_at_event']
        # I v3 filter: above-spot + top-10% AND + deep_neg + strike_dist >= 15
        i_cand = g[
            (g['strike'] > g['spot_at_event'])
            & (g['lvl_rank'] >= 0.90)
            & (g['chg_rank'] >= 0.90)
            & (g['value'] < 0)
            & (g['strike_dist'] >= 15)
        ].copy()

        if not i_cand.empty:
            strike_lo = float(i_cand['strike'].min()) - 5
            strike_hi = float(i_cand['strike'].max()) + 105
            trades_c = load_trades_day(d, strike_lo, strike_hi, 'call')
            for _, e in i_cand.iterrows():
                trade_k = float(e['strike']) + 50
                ts = e['captured_at']
                ts_ns = pd.Timestamp(ts).value
                R = compute_R(trades_c, trade_k, ts_ns, [60, 120])
                gex = fetch_gex_target(e['strike'], ts)
                if not R:
                    continue
                row = {
                    'day': d.isoformat(), 'captured_at': ts,
                    'strike': float(e['strike']), 'trade_strike': trade_k,
                    'spot_at_event': float(e['spot_at_event']),
                    'strike_dist': float(e['strike_dist']),
                    'gamma_post': float(e['value']),
                    'gamma_delta': float(e['delta']),
                    **R, **gex,
                }
                I_rows.append(row)
            print(f'    I: {len(i_cand)} candidates, {sum(1 for r in I_rows if r["day"] == d.isoformat())} matched in parquet')

        # L (charm)
        c = load_periscope_events_for_day(d, 'charm')
        if c.empty:
            print(f'    no charm events')
            continue
        c = attach_spot(c, spot).dropna(subset=['spot_at_event'])
        c['strike_dist'] = c['spot_at_event'] - c['strike']
        # L v3: below-spot + top-5% per-day charm + strike_dist >= 10
        l_cand = c[
            (c['strike'] < c['spot_at_event'])
            & (c['chg_rank'] >= 0.95)
            & (c['strike_dist'] >= 10)
        ].copy()
        if not l_cand.empty:
            strike_lo = float(l_cand['strike'].min()) - 105
            strike_hi = float(l_cand['strike'].max()) + 5
            trades_p = load_trades_day(d, strike_lo, strike_hi, 'put')
            for _, e in l_cand.iterrows():
                trade_k = float(e['strike']) - 50
                ts = e['captured_at']
                ts_ns = pd.Timestamp(ts).value
                R = compute_R(trades_p, trade_k, ts_ns, [120, 180])
                gex = fetch_gex_target(e['strike'], ts)
                if not R:
                    continue
                row = {
                    'day': d.isoformat(), 'captured_at': ts,
                    'strike': float(e['strike']), 'trade_strike': trade_k,
                    'spot_at_event': float(e['spot_at_event']),
                    'strike_dist': float(e['strike_dist']),
                    'charm_post': float(e['value']),
                    'charm_delta': float(e['delta']),
                    **R, **gex,
                }
                L_rows.append(row)
            print(f'    L: {len(l_cand)} candidates, {sum(1 for r in L_rows if r["day"] == d.isoformat())} matched in parquet')

    return pd.DataFrame(I_rows), pd.DataFrame(L_rows)


def report_filter(label: str, df: pd.DataFrame, R_col: str = 'R_120m') -> None:
    if df.empty:
        print(f'  {label:<50} n=0')
        return
    R = df[R_col].clip(lower=-1).dropna() if R_col in df.columns else pd.Series()
    if R.empty:
        print(f'  {label:<50} n=0 (no R data)')
        return
    hit_150 = (R >= 0.5).mean() * 100
    hit_200 = (R >= 1.0).mean() * 100
    real_5 = np.where(R >= 5, 5, -1.0).mean()
    print(f'  {label:<50} n={len(R):>3} hit150={hit_150:>5.1f}% '
          f'hit200={hit_200:>5.1f}% realR_TP5={real_5:>+5.2f} max={R.max():.2f}')


# ========================================================================
# DRIVER
# ========================================================================


def main():
    # ----- TASK 1: SPY/QQQ on existing I/L sets -----
    print('=== TASK 1: SPY/QQQ flow on existing 19 I + 19 L events ===\n')
    I_ctx = pd.read_csv(OUT / 'refine_context_I.csv')
    L_ctx = pd.read_csv(OUT / 'refine_context_L.csv')
    I_ctx['captured_at'] = pd.to_datetime(I_ctx['captured_at'], utc=True,
                                            format='ISO8601')
    # L_ctx is missing captured_at — rejoin from L_horiz
    L_horiz = pd.read_csv(OUT / 'refine_v2_horizons_L.csv')
    L_horiz = L_horiz[L_horiz.horizon == 180]
    # idx in L_ctx corresponds to row index of merged L data; safest is to
    # rebuild via (day, strike, R) match
    L_ctx = L_ctx.merge(
        L_horiz[['day', 'captured_at', 'strike', 'R']],
        on=['day', 'R'], how='left', suffixes=('', '_h'))
    L_ctx['captured_at'] = pd.to_datetime(L_ctx['captured_at'], utc=True,
                                            format='ISO8601')

    print('Pulling SPY/QQQ flow for I events...')
    I_flow = task1_add_spy_qqq(I_ctx)
    I_full = I_ctx.merge(I_flow, on='idx', how='left')
    I_full.to_csv(OUT / 'refine_I_with_spy_qqq.csv', index=False)

    print('Pulling SPY/QQQ flow for L events...')
    L_flow = task1_add_spy_qqq(L_ctx)
    L_full = L_ctx.merge(L_flow, on='idx', how='left')
    L_full.to_csv(OUT / 'refine_L_with_spy_qqq.csv', index=False)

    print('\nI feature ranking (SPY/QQQ flow):')
    print(f'{"Feature":<48} {"W_med":>15} {"L_med":>15} {"p":>8} {"d":>8}')
    flow_features = [c for c in I_full.columns if any(
        x in c for x in ['SPY_', 'QQQ_'])]
    for f in flow_features:
        w = I_full[I_full['win']][f].dropna()
        l = I_full[~I_full['win']][f].dropna()
        if len(w) < 3 or len(l) < 3: continue
        try:
            _, p = stats.mannwhitneyu(w, l, alternative='two-sided')
        except: p = float('nan')
        pooled = np.sqrt((w.var(ddof=1) + l.var(ddof=1)) / 2)
        d = (w.mean() - l.mean()) / pooled if pooled > 0 else 0
        marker = '  *' if p < 0.10 else ''
        if abs(d) >= 0.5:
            print(f'{f:<48} {w.median():>15.2f} {l.median():>15.2f} '
                  f'{p:>8.4f} {d:>+8.2f}{marker}')

    print('\nL feature ranking (SPY/QQQ flow):')
    print(f'{"Feature":<48} {"W_med":>15} {"L_med":>15} {"p":>8} {"d":>8}')
    for f in flow_features:
        w = L_full[L_full['win']][f].dropna()
        l = L_full[~L_full['win']][f].dropna()
        if len(w) < 3 or len(l) < 3: continue
        try:
            _, p = stats.mannwhitneyu(w, l, alternative='two-sided')
        except: p = float('nan')
        pooled = np.sqrt((w.var(ddof=1) + l.var(ddof=1)) / 2)
        d = (w.mean() - l.mean()) / pooled if pooled > 0 else 0
        marker = '  *' if p < 0.10 else ''
        if abs(d) >= 0.5:
            print(f'{f:<48} {w.median():>15.2f} {l.median():>15.2f} '
                  f'{p:>8.4f} {d:>+8.2f}{marker}')

    # ----- TASK 2: OOS validation -----
    print('\n\n=== TASK 2: Out-of-Sample on 2026-04-01 → 04-10 ===\n')
    I_oos, L_oos = oos_run()
    I_oos.to_csv(OUT / 'refine_oos_I_events.csv', index=False)
    L_oos.to_csv(OUT / 'refine_oos_L_events.csv', index=False)
    print(f'\nOOS I events: {len(I_oos)}, L events: {len(L_oos)}')

    if not I_oos.empty:
        print('\nI OOS filter combinations (R_120m):')
        report_filter('baseline (v2: deep_neg + strike_dist>=15)', I_oos)
        report_filter('v3: + gex_dollars < 1e9', I_oos[I_oos['gex_dollars'] < 1e9])
        report_filter('v3: + call_ratio < 1.5',
                      I_oos[I_oos['call_ratio'] < 1.5] if 'call_ratio' in I_oos.columns else pd.DataFrame())

    if not L_oos.empty:
        print('\nL OOS filter combinations (R_180m):')
        report_filter('baseline (v2: + strike_dist>=10)', L_oos, R_col='R_180m')
        report_filter('v3: + call_ratio < 1.5',
                      L_oos[L_oos['call_ratio'] < 1.5] if 'call_ratio' in L_oos.columns else pd.DataFrame(), R_col='R_180m')
        report_filter('v3 alt: + entry_px <= 1.0',
                      L_oos[L_oos['entry_px'] <= 1.0], R_col='R_180m')


if __name__ == '__main__':
    main()
