#!/usr/bin/env python3
"""
NDX cross-validation of SPX 0DTE signals (2026-05-21)
=====================================================

Background: three SPX signals validated on `index_candles_1m` (SPX) +
`periscope_snapshots` (SPX 0DTE strikes):
  - E1 long call: bar.open<+γ ceiling, close>ceiling, 3-bar hold.
  - E5 long put: failed v4 down-wick → 1pt break below wick low in 10 min.
  - Monday PCS pocket: Mon + |gex|≤500k floor + down-wick rejection.

Goal: run E5 and E1 on NDX candles and quantify whether the same edge
exists, plus measure cross-asset confluence and any NDX-leads-SPX lead time.

DATA REALITY
------------
- index_candles_1m has NDX RTH data from 2026-03-23 to 2026-05-20
  (~16k 1-min RTH bars).
- periscope_snapshots is SPX-only (strike range 6010-7890, no NDX-scale
  strikes). NDX has zero rows in periscope.
- strike_exposures has NDX rows but ONLY MONTHLY expiry (no 0DTE — NDX
  is monthly listings only at the exchange level). Granularity also
  starts ~2026-04-28 for intraday (~80 snapshots/day); pre-2026-04-28 is
  only 1 daily snapshot.

So a true periscope-style NDX +γ floor/ceiling map at 1-min resolution
DOES NOT EXIST in this DB. We approximate "+γ ceiling" / "+γ floor" with
**technical levels**: prior-session high/low and recent swing pivots.
This is a TECHNICAL ANALOGUE of the SPX dealer-positioning event, not a
direct replication. Stated explicitly in the findings doc.

TESTS
-----
1. Data availability — print NDX coverage + confirm periscope is SPX-only.
2. E5 on NDX: detect down-wick events using prior swing low as the
   pseudo-+γ-floor. Filter to failed-reversal continuation. Compute +30m
   forward return signed for long put. Matched same-day random controls.
   Walk-forward H1/H2 if n>=20.
3. E1 on NDX: clean breakthrough of prior-session-high (proxy ceiling)
   with 3-bar hold. Forward returns signed for long call.
4. Cross-asset confluence: for each SPX E5 event, was there an NDX E5
   event within ±5 min? If yes, was the SPX-only edge amplified by NDX
   confirmation?
5. NDX-leads-SPX timing: for each SPX E5 entry time, check NDX's pattern
   1-5 min EARLIER. Quantify any tradeable lead-time.

Outputs:
  - docs/tmp/forensic-multi-day/ndx_cross_validation_findings.md
  - per-test CSVs (suffix _ndx)

Run: ml/.venv/bin/python scripts/ndx_cross_validation.py
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from scipy import stats

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / '.env.local')
DB_URL = os.environ['DATABASE_URL_UNPOOLED']

OUT = ROOT / 'docs/tmp/forensic-multi-day'
OUT.mkdir(parents=True, exist_ok=True)
MD_PATH = OUT / 'ndx_cross_validation_findings.md'

V4_CSV = OUT / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'

HORIZONS_MIN = [15, 30, 60]
LATEST_EVENT_CT_MINUTES = 14 * 60  # 14:00 CT cutoff
SWING_LOOKBACK = 30  # bars to look back for swing high/low pivot


# =============================================================================
# DB helpers
# =============================================================================


def query_df(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


def load_candles(conn, symbol):
    """1-min RTH candles for symbol."""
    q = """
        SELECT timestamp, open, high, low, close, date
        FROM index_candles_1m
        WHERE symbol = %s
          AND market_time = 'r'
        ORDER BY timestamp
    """
    df = query_df(conn, q, (symbol,))
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    for c in ('open', 'high', 'low', 'close'):
        df[c] = df[c].astype(float)
    df['range'] = df['high'] - df['low']
    df['ct'] = df['timestamp'].dt.tz_convert('America/Chicago')
    df['ct_date'] = df['ct'].dt.date
    df['ct_minute'] = df['ct'].dt.hour * 60 + df['ct'].dt.minute
    return df.sort_values('timestamp').reset_index(drop=True)


# =============================================================================
# Test 1: Data availability
# =============================================================================


def run_data_check(conn):
    print('\n[1] Data availability check')
    spx = load_candles(conn, 'SPX')
    ndx = load_candles(conn, 'NDX')
    print(f'  SPX RTH 1-min bars: {len(spx):,}, '
          f'date range {spx["ct_date"].min()} → {spx["ct_date"].max()}')
    print(f'  NDX RTH 1-min bars: {len(ndx):,}, '
          f'date range {ndx["ct_date"].min()} → {ndx["ct_date"].max()}')

    # Check periscope: SPX-only?
    p = query_df(conn, """
        SELECT panel, MIN(strike) AS smin, MAX(strike) AS smax,
               COUNT(*) AS n
        FROM periscope_snapshots
        GROUP BY panel
    """)
    print('  Periscope strike ranges:')
    for _, r in p.iterrows():
        print(f"    {r['panel']}: {r['smin']}-{r['smax']} ({r['n']:,} rows)")

    # Check strike_exposures for NDX 0DTE
    se = query_df(conn, """
        SELECT date, MIN(expiry-date) AS min_dte, MAX(expiry-date) AS max_dte,
               COUNT(*) AS rows
        FROM strike_exposures
        WHERE ticker='NDX'
        GROUP BY date
        ORDER BY date
    """)
    n_0dte_rows = (se['min_dte'] == 0).sum()
    print(f'  strike_exposures NDX days: {len(se)}, '
          f'days containing 0DTE rows: {n_0dte_rows}')

    return {
        'spx_bars': len(spx),
        'ndx_bars': len(ndx),
        'spx_date_range': (str(spx['ct_date'].min()), str(spx['ct_date'].max())),
        'ndx_date_range': (str(ndx['ct_date'].min()), str(ndx['ct_date'].max())),
        'periscope_strike_ranges': [
            (r['panel'], float(r['smin']), float(r['smax']), int(r['n']))
            for _, r in p.iterrows()
        ],
        'ndx_strike_exposures_days': len(se),
        'ndx_0dte_days': int(n_0dte_rows),
        'spx': spx,
        'ndx': ndx,
    }


# =============================================================================
# Event detection — technical proxy for periscope levels
# =============================================================================


def detect_e5_events(candles):
    """E5-equivalent on a candle series WITHOUT periscope.

    Definition:
      - Bar has range >= same-day p75 range (volatility filter).
      - bar.low touches or breaks the rolling 30-bar swing low.
      - bar.close > bar.low + 0.4 * bar.range (rejection wick on the lows).
      - bar's 30-min forward return is NEGATIVE (failed bounce → continuation).
      - Within next 10 min, a bar closes ≤ wick_low - tick (tick = 1pt for SPX,
        ~5pt for NDX since NDX trades ~5x SPX in absolute level).
      - Forward returns signed for LONG PUT (positive = price down).

    Returns DataFrame with one row per confirmed event.
    """
    df = candles.copy()
    # Per-day p75 range for the volatility filter
    p75_per_day = df.groupby('ct_date')['range'].quantile(0.75).rename('p75')
    df = df.merge(p75_per_day, left_on='ct_date', right_index=True)

    # Rolling 30-bar swing low / high (strict swing pivot proxy)
    df['swing_low_30'] = df['low'].rolling(SWING_LOOKBACK, min_periods=10).min().shift(1)
    df['swing_high_30'] = df['high'].rolling(SWING_LOOKBACK, min_periods=10).max().shift(1)

    # Tick size for breakdown trigger — proportional to bar range
    spx_or_ndx_tick = df['close'].iloc[0] if len(df) else 0
    tick = 1.0 if spx_or_ndx_tick < 10000 else 5.0  # SPX ~6500 vs NDX ~24000

    ts_to_idx = {ts: i for i, ts in enumerate(df['timestamp'])}

    # Candidate bars: range >= p75, breaks 30-bar swing low, wick with close
    # in upper 60% of range, before 14:00 CT
    cands = df[
        (df['range'] >= df['p75'])
        & (df['low'] <= df['swing_low_30'])
        & (df['close'] >= df['low'] + 0.4 * df['range'])
        & (df['ct_minute'] < LATEST_EVENT_CT_MINUTES)
    ].copy()
    print(f'    candidate down-wicks (range≥p75 + swing-low + rejection): '
          f'{len(cands):,}')

    rows = []
    for _, ev in cands.iterrows():
        ev_ts = ev['timestamp']
        wick_low = float(ev['low'])
        ev_close = float(ev['close'])
        idx = ts_to_idx.get(ev_ts)
        if idx is None:
            continue

        # 30-min forward return of the event bar itself — must be negative
        # (failed bounce = price kept going down)
        ti_30 = idx + 30
        if ti_30 >= len(df):
            continue
        ev_close_30 = float(df.iloc[ti_30]['close'])
        ev_ret_30m = ev_close_30 - ev_close  # raw delta
        if ev_ret_30m >= 0:
            continue  # bounce held; not a failed reversal

        # Look for confirmation: bar low <= wick_low - tick within next 10 min
        trigger_level = wick_low - tick
        confirm_idx = None
        for offset in range(1, 11):
            ti = idx + offset
            if ti >= len(df):
                break
            b = df.iloc[ti]
            if (b['timestamp'] - ev_ts) > pd.Timedelta(minutes=15):
                break
            if b['low'] <= trigger_level:
                confirm_idx = ti
                break
        if confirm_idx is None:
            continue
        confirm = df.iloc[confirm_idx]

        row = {
            'event_ts': ev_ts,
            'confirm_ts': confirm['timestamp'],
            'confirm_close': float(confirm['close']),
            'wick_low': wick_low,
            'trigger_level': trigger_level,
            'tick': tick,
            'offset_min': confirm_idx - idx,
            'bar_range': float(ev['range']),
            'p75_range': float(ev['p75']),
            'swing_low_30': float(ev['swing_low_30']),
            'ct_minute': int(ev['ct_minute']),
            'ct_date': ev['ct_date'],
        }
        for h in HORIZONS_MIN:
            ti = confirm_idx + h
            if ti >= len(df):
                row[f'ret_{h}m'] = np.nan
                continue
            end_close = float(df.iloc[ti]['close'])
            # Long put: positive when price falls
            row[f'ret_{h}m'] = -(end_close - confirm['close'])
        rows.append(row)
    return pd.DataFrame(rows)


def detect_e1_events(candles):
    """E1-equivalent: clean breakthrough of prior-session high (proxy ceiling).

    Definition:
      - Bar's range >= same-day p75.
      - bar.open < swing_high_30, bar.high > swing_high_30, bar.close > swing_high_30.
      - bars +1, +2, +3 all close > swing_high_30 (hold).
      - Long-call sign (positive forward return = price up).

    Also runs the DOWN mirror: breakdown of swing_low_30 with hold.
    """
    df = candles.copy()
    p75_per_day = df.groupby('ct_date')['range'].quantile(0.75).rename('p75')
    df = df.merge(p75_per_day, left_on='ct_date', right_index=True)
    df['swing_low_30'] = df['low'].rolling(SWING_LOOKBACK, min_periods=10).min().shift(1)
    df['swing_high_30'] = df['high'].rolling(SWING_LOOKBACK, min_periods=10).max().shift(1)

    ts_to_idx = {ts: i for i, ts in enumerate(df['timestamp'])}

    cands = df[
        (df['range'] >= df['p75'])
        & (df['ct_minute'] < LATEST_EVENT_CT_MINUTES)
    ]
    rows = []
    for _, bar in cands.iterrows():
        idx = ts_to_idx.get(bar['timestamp'])
        if idx is None or idx + 3 >= len(df):
            continue
        b1 = df.iloc[idx + 1]
        b2 = df.iloc[idx + 2]
        b3 = df.iloc[idx + 3]
        if (b1['timestamp'] - bar['timestamp']) > pd.Timedelta(minutes=2):
            continue

        sh = bar['swing_high_30']
        sl = bar['swing_low_30']

        # UP breakthrough of prior swing high
        if (not np.isnan(sh) and bar['open'] < sh and bar['high'] > sh
                and bar['close'] > sh and b1['close'] > sh
                and b2['close'] > sh and b3['close'] > sh):
            rows.append(_e1_row(df, idx, bar, sh, 'up'))

        # DOWN breakdown of prior swing low (long put)
        if (not np.isnan(sl) and bar['open'] > sl and bar['low'] < sl
                and bar['close'] < sl and b1['close'] < sl
                and b2['close'] < sl and b3['close'] < sl):
            rows.append(_e1_row(df, idx, bar, sl, 'down'))

    return pd.DataFrame(rows)


def _e1_row(df, idx, bar, level, direction):
    row = {
        'event_ts': bar['timestamp'],
        'direction': direction,
        'bar_open': float(bar['open']),
        'bar_high': float(bar['high']),
        'bar_low': float(bar['low']),
        'bar_close': float(bar['close']),
        'bar_range': float(bar['range']),
        'level': float(level),
        'ct_minute': int(bar['ct_minute']),
        'ct_date': bar['ct_date'],
    }
    for h in HORIZONS_MIN:
        ti = idx + h
        if ti >= len(df):
            row[f'ret_{h}m'] = np.nan
            continue
        end_close = float(df.iloc[ti]['close'])
        delta = end_close - bar['close']
        row[f'ret_{h}m'] = delta if direction == 'up' else -delta
    return row


def attach_controls(events, candles, ts_col='confirm_ts',
                    close_col='confirm_close', sign_field=None, seed=42):
    """Attach matched same-day random controls + their forward returns
    signed identically to the events."""
    if events.empty:
        return events
    rng = np.random.default_rng(seed)
    df = candles.copy()
    ts_to_idx = {ts: i for i, ts in enumerate(df['timestamp'])}

    events_out = events.copy()
    event_ts_set = set(events[ts_col])
    pool = df[
        (df['ct_minute'] < LATEST_EVENT_CT_MINUTES)
        & (~df['timestamp'].isin(event_ts_set))
    ]

    for h in HORIZONS_MIN:
        events_out[f'control_ret_{h}m'] = np.nan
    events_out['control_ts'] = pd.Series(
        [pd.NaT] * len(events_out), dtype='datetime64[ns, UTC]')

    for i, row in events_out.iterrows():
        ev_ts = row[ts_col]
        if pd.isna(ev_ts):
            continue
        ev_date = pd.Timestamp(ev_ts).tz_convert('America/Chicago').date()
        day_pool = pool[pool['ct_date'] == ev_date]
        if day_pool.empty:
            continue
        pi = int(rng.integers(0, len(day_pool)))
        ctrl = day_pool.iloc[pi]
        cidx = ts_to_idx.get(ctrl['timestamp'])
        if cidx is None:
            continue
        events_out.at[i, 'control_ts'] = ctrl['timestamp']
        for h in HORIZONS_MIN:
            ti = cidx + h
            if ti >= len(df):
                continue
            end_close = float(df.iloc[ti]['close'])
            delta = end_close - ctrl['close']
            if sign_field and sign_field in row:
                # E1 case: sign per row direction
                sign = 1.0 if row[sign_field] == 'up' else -1.0
            else:
                # E5 case: always long-put sign (negative delta = profit)
                sign = -1.0
            events_out.at[i, f'control_ret_{h}m'] = delta * sign
    return events_out


def paired_stats(df, ev_col='ret_30m', ct_col='control_ret_30m'):
    paired = df[[ev_col, ct_col]].dropna()
    n = len(paired)
    if n < 3:
        return {'n': n, 'ev_mean': np.nan, 'ct_mean': np.nan,
                'delta': np.nan, 't': np.nan, 'p': np.nan, 'p_mw': np.nan}
    ev_mean = paired[ev_col].mean()
    ct_mean = paired[ct_col].mean()
    diffs = paired[ev_col] - paired[ct_col]
    t_stat, p_paired = stats.ttest_1samp(diffs, 0)
    try:
        _, p_mw = stats.mannwhitneyu(
            paired[ev_col], paired[ct_col], alternative='two-sided')
    except ValueError:
        p_mw = np.nan
    return {'n': n, 'ev_mean': float(ev_mean),
            'ct_mean': float(ct_mean), 'delta': float(ev_mean - ct_mean),
            't': float(t_stat), 'p': float(p_paired),
            'p_mw': float(p_mw) if not np.isnan(p_mw) else np.nan}


# =============================================================================
# Test 2: E5 on NDX
# =============================================================================


def run_e5_ndx(ndx_candles):
    print('\n[2] E5 replication on NDX')
    events = detect_e5_events(ndx_candles)
    print(f'  confirmed NDX E5 breakdown events: {len(events):,}')
    if events.empty:
        return {'n': 0, 'events': events, 'stats': {},
                'wf': None, 'summary': 'no events'}

    events = attach_controls(events, ndx_candles)
    events.to_csv(OUT / 'e5_ndx_events.csv', index=False)

    out = {'n': len(events), 'events': events,
           'stats': {h: paired_stats(events, f'ret_{h}m', f'control_ret_{h}m')
                     for h in HORIZONS_MIN}}

    # Walk-forward
    if len(events) >= 20:
        sub = events.sort_values('confirm_ts').reset_index(drop=True)
        half = len(sub) // 2
        out['wf'] = {
            'h1': paired_stats(sub.iloc[:half]),
            'h2': paired_stats(sub.iloc[half:]),
            'h1_dates': (str(sub.iloc[:half]['ct_date'].min()),
                         str(sub.iloc[:half]['ct_date'].max())),
            'h2_dates': (str(sub.iloc[half:]['ct_date'].min()),
                         str(sub.iloc[half:]['ct_date'].max())),
        }
    else:
        out['wf'] = None
    return out


# =============================================================================
# Test 3: E1 on NDX
# =============================================================================


def run_e1_ndx(ndx_candles):
    print('\n[3] E1 replication on NDX')
    events = detect_e1_events(ndx_candles)
    print(f'  NDX E1 events: {len(events):,} '
          f'(up={(events["direction"]=="up").sum()}, '
          f'down={(events["direction"]=="down").sum()})')
    if events.empty:
        return {'events': events, 'up': {'n': 0}, 'down': {'n': 0}}

    events = attach_controls(events, ndx_candles, ts_col='event_ts',
                             close_col='bar_close', sign_field='direction')
    events.to_csv(OUT / 'e1_ndx_events.csv', index=False)

    out = {'events': events}
    for d in ('up', 'down'):
        sub = events[events['direction'] == d]
        out[d] = {
            'n': len(sub),
            'stats': {h: paired_stats(sub, f'ret_{h}m', f'control_ret_{h}m')
                      for h in HORIZONS_MIN},
        }
        if len(sub) >= 20:
            sorted_sub = sub.sort_values('event_ts').reset_index(drop=True)
            half = len(sorted_sub) // 2
            out[d]['wf'] = {
                'h1': paired_stats(sorted_sub.iloc[:half]),
                'h2': paired_stats(sorted_sub.iloc[half:]),
            }
    return out


# =============================================================================
# Test 4: Cross-asset confluence
# =============================================================================


def run_confluence(spx_e5_csv, ndx_e5_events, ndx_candles, spx_candles):
    """For each SPX E5 confirmed-breakdown event, check if any NDX E5
    confirmed-breakdown happens within ±5 minutes of the SPX confirm bar.

    Also compute SPX-alone forward returns vs SPX+NDX-confirmation
    forward returns to test confluence boost.
    """
    print('\n[4] Cross-asset confluence (SPX E5 ∩ NDX E5)')
    if not spx_e5_csv.exists():
        print('  SPX E5 CSV missing; skipping')
        return {}
    spx_e5 = pd.read_csv(spx_e5_csv)
    spx_e5['confirm_ts'] = pd.to_datetime(spx_e5['confirm_ts'], utc=True)
    print(f'  SPX E5 events on disk: {len(spx_e5):,}')

    # Restrict SPX E5 to NDX date coverage (we can only test overlap days)
    ndx_dates = set(ndx_candles['ct_date'].unique())
    spx_e5['ct_date'] = spx_e5['confirm_ts'].dt.tz_convert(
        'America/Chicago').dt.date
    spx_e5_overlap = spx_e5[spx_e5['ct_date'].isin(ndx_dates)].copy()
    print(f'  SPX E5 events on NDX-coverage days: {len(spx_e5_overlap):,}')

    if ndx_e5_events.empty or spx_e5_overlap.empty:
        return {'n_overlap': 0, 'summary': 'no overlap'}

    # For each SPX E5 confirm_ts, find any NDX E5 confirm_ts within ±5 min
    ndx_ts_series = ndx_e5_events['confirm_ts'].sort_values().reset_index(drop=True)
    spx_e5_overlap = spx_e5_overlap.copy()
    spx_e5_overlap['ndx_confluence'] = False
    spx_e5_overlap['ndx_offset_min'] = np.nan
    for i, row in spx_e5_overlap.iterrows():
        ts = pd.Timestamp(row['confirm_ts'])
        diffs_td = ndx_ts_series - ts  # Series of Timedeltas (tz-aware safe)
        diffs = diffs_td.dt.total_seconds().to_numpy() / 60.0
        within = np.where(np.abs(diffs) <= 5)[0]
        if len(within):
            spx_e5_overlap.at[i, 'ndx_confluence'] = True
            # pick smallest |offset|
            best = within[np.argmin(np.abs(diffs[within]))]
            spx_e5_overlap.at[i, 'ndx_offset_min'] = float(diffs[best])

    n_conf = int(spx_e5_overlap['ndx_confluence'].sum())
    n_total = len(spx_e5_overlap)
    print(f'  SPX E5 with NDX-E5 within ±5min: {n_conf}/{n_total} '
          f'({n_conf/n_total:.1%})')

    spx_e5_overlap.to_csv(OUT / 'e5_confluence_ndx.csv', index=False)

    def one_sample_stats(sub):
        # ret_30m is the SPX-E5 long-put forward return (signed for long put).
        # No controls in the SPX E5 CSV — fall back to one-sample t-test vs 0.
        vals = sub['ret_30m'].dropna()
        if len(vals) < 3:
            return {'n': len(vals), 'mean': float('nan'),
                    't': float('nan'), 'p': float('nan')}
        t_stat, p = stats.ttest_1samp(vals, 0)
        return {'n': int(len(vals)), 'mean': float(vals.mean()),
                't': float(t_stat), 'p': float(p)}

    confluence_stats = one_sample_stats(
        spx_e5_overlap[spx_e5_overlap['ndx_confluence']])
    alone_stats = one_sample_stats(
        spx_e5_overlap[~spx_e5_overlap['ndx_confluence']])

    # Two-sample test (confluence vs alone)
    a = spx_e5_overlap[spx_e5_overlap['ndx_confluence']]['ret_30m'].dropna()
    b = spx_e5_overlap[~spx_e5_overlap['ndx_confluence']]['ret_30m'].dropna()
    two_sample = {'t': float('nan'), 'p': float('nan')}
    if len(a) >= 3 and len(b) >= 3:
        ts, ps = stats.ttest_ind(a, b, equal_var=False)
        two_sample = {'t': float(ts), 'p': float(ps)}

    return {
        'n_overlap': n_total,
        'n_confluence': n_conf,
        'pct_confluence': n_conf / n_total if n_total else 0,
        'confluence_stats': confluence_stats,
        'alone_stats': alone_stats,
        'two_sample': two_sample,
    }


# =============================================================================
# Test 5: NDX-leads-SPX timing
# =============================================================================


def run_lead_lag(ndx_e5_events, spx_e5_csv, ndx_candles):
    """For each SPX E5 confirm bar, check NDX 1-5 min EARLIER for a similar
    failed-bounce pattern (NDX bar low < its 30-bar swing low AND close
    rejection wick AND its forward 5-min ret < 0).

    Also report distribution of NDX-confluence ndx_offset_min from test 4
    — negative offset means NDX confirmed BEFORE SPX.
    """
    print('\n[5] NDX-leads-SPX timing')
    if not spx_e5_csv.exists():
        return {}
    spx_e5 = pd.read_csv(spx_e5_csv)
    spx_e5['confirm_ts'] = pd.to_datetime(spx_e5['confirm_ts'], utc=True)
    spx_e5['ct_date'] = spx_e5['confirm_ts'].dt.tz_convert(
        'America/Chicago').dt.date
    ndx_dates = set(ndx_candles['ct_date'].unique())
    spx_e5 = spx_e5[spx_e5['ct_date'].isin(ndx_dates)].copy()
    if spx_e5.empty:
        return {'n': 0}

    # Compute NDX rolling p75 + swing low for each bar
    df = ndx_candles.copy()
    p75_per_day = df.groupby('ct_date')['range'].quantile(0.75).rename('p75')
    df = df.merge(p75_per_day, left_on='ct_date', right_index=True)
    df['swing_low_30'] = df['low'].rolling(SWING_LOOKBACK, min_periods=10).min().shift(1)

    ts_to_idx = {ts: i for i, ts in enumerate(df['timestamp'])}

    # For each SPX confirm_ts, check NDX bar at confirm_ts - k minutes
    # for k in [1..5]. Pattern match: NDX bar low < swing_low_30 AND
    # NDX range >= p75 AND wick rejection.
    results_by_lag = {k: 0 for k in range(1, 6)}
    total = 0
    rows = []
    for _, ev in spx_e5.iterrows():
        ts = pd.Timestamp(ev['confirm_ts'])
        # Find NDX bar at same minute as SPX confirm
        bar_at_zero = df[df['timestamp'] == ts.floor('min')]
        if bar_at_zero.empty:
            continue
        zidx = ts_to_idx.get(bar_at_zero['timestamp'].iloc[0])
        if zidx is None:
            continue
        total += 1
        row = {'spx_confirm_ts': ts}
        for k in range(1, 6):
            ti = zidx - k
            if ti < 0:
                continue
            b = df.iloc[ti]
            if b['ct_date'] != ev['ct_date']:
                continue
            # NDX failed-bounce signature: low<swing_low AND wick
            if (b['range'] >= b['p75']
                    and not np.isnan(b['swing_low_30'])
                    and b['low'] <= b['swing_low_30']
                    and b['close'] >= b['low'] + 0.4 * b['range']):
                results_by_lag[k] += 1
                row[f'ndx_lead_{k}m'] = True
            else:
                row[f'ndx_lead_{k}m'] = False
        rows.append(row)
    lead_df = pd.DataFrame(rows)
    lead_df.to_csv(OUT / 'e5_ndx_lead_lag.csv', index=False)
    print(f'  SPX E5 events tested: {total}')
    for k in range(1, 6):
        if total:
            print(f'  NDX shows pattern {k}min earlier: {results_by_lag[k]}/{total} '
                  f'({results_by_lag[k]/total:.1%})')
    return {
        'n_total': total,
        'by_lag': results_by_lag,
        'pct_by_lag': {k: (results_by_lag[k] / total) if total else 0
                        for k in range(1, 6)},
    }


# =============================================================================
# Reporting
# =============================================================================


def fmt_stats_line(label, s):
    if not s or s.get('n', 0) < 3:
        return f'| {label} | {s.get("n", 0)} | — | — | — | — | — |\n'
    return (f'| {label} | {s["n"]} | {s["ev_mean"]:+.2f} | '
            f'{s["ct_mean"]:+.2f} | {s["delta"]:+.2f} | '
            f'{s["t"]:+.2f} | {s["p"]:.4f} |\n')


def write_findings(results):
    lines = []
    lines.append('# NDX cross-validation of SPX 0DTE signals (2026-05-21)\n\n')
    lines.append(
        'Cross-validating SPX E1/E5 long-call/put signals on NDX using '
        '`index_candles_1m` for NDX (~16k RTH bars, 2026-03-23 → 2026-05-20).\n\n')

    # === DATA AVAILABILITY
    dc = results['data_check']
    lines.append('## 1. Data availability\n\n')
    lines.append(f'- SPX RTH 1-min bars: **{dc["spx_bars"]:,}**, '
                 f'range {dc["spx_date_range"][0]} → {dc["spx_date_range"][1]}\n')
    lines.append(f'- NDX RTH 1-min bars: **{dc["ndx_bars"]:,}**, '
                 f'range {dc["ndx_date_range"][0]} → {dc["ndx_date_range"][1]}\n')
    lines.append('- Periscope strike ranges (panel): '
                 + ', '.join(f'{p}={smin:.0f}-{smax:.0f} ({n:,})'
                             for p, smin, smax, n
                             in dc['periscope_strike_ranges'])
                 + '\n')
    lines.append('  → **SPX-only**: NDX strikes (~22k-30k) are absent from '
                 '`periscope_snapshots`.\n')
    lines.append(f'- `strike_exposures` NDX days: {dc["ndx_strike_exposures_days"]}, '
                 f'days containing 0DTE rows: {dc["ndx_0dte_days"]}\n')
    lines.append('  → NDX has NO 0DTE chain — only monthly expirations are '
                 'listed for NDX in this DB. The dealer-positioning +γ '
                 'floor/ceiling map cannot be reconstructed for NDX 0DTE.\n\n')

    lines.append('**Proxy used**: 30-bar rolling swing low/high serves as the '
                 '"+γ floor / +γ ceiling" technical analogue. The E5 event '
                 'detector requires a `range ≥ same-day p75` wick that closes '
                 'in the upper 60% of its range AND breaks the rolling swing '
                 'low (or high for E1 up-breakthrough). This is a TECHNICAL '
                 'replication, not a dealer-positioning replication. Effect '
                 'sizes are expected to be smaller and less specific.\n\n')

    # === TEST 2: E5 on NDX
    lines.append('## 2. E5 long-put replication on NDX\n\n')
    e5 = results['e5_ndx']
    lines.append(f'- Confirmed NDX E5 breakdown events: **n = {e5["n"]}**\n\n')
    if e5['n'] >= 3:
        lines.append('| Horizon | n | Event mean | Ctrl mean | Δ | t | p |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
        for h in HORIZONS_MIN:
            lines.append(fmt_stats_line(f'+{h}m', e5['stats'][h]))
        lines.append('\n')
    if e5.get('wf'):
        wf = e5['wf']
        lines.append('**Walk-forward halves @ +30m:**\n\n')
        lines.append('| Half | n | Δ | p | Date range |\n')
        lines.append('|---|---:|---:|---:|:---|\n')
        lines.append(f'| H1 | {wf["h1"]["n"]} | {wf["h1"]["delta"]:+.2f} '
                     f'| {wf["h1"]["p"]:.4f} | {wf["h1_dates"][0]} → '
                     f'{wf["h1_dates"][1]} |\n')
        lines.append(f'| H2 | {wf["h2"]["n"]} | {wf["h2"]["delta"]:+.2f} '
                     f'| {wf["h2"]["p"]:.4f} | {wf["h2_dates"][0]} → '
                     f'{wf["h2_dates"][1]} |\n')
        lines.append('\n')

    # === TEST 3: E1 on NDX
    lines.append('## 3. E1 breakthrough+hold replication on NDX\n\n')
    e1 = results['e1_ndx']
    for d in ('up', 'down'):
        sub = e1.get(d, {})
        n = sub.get('n', 0)
        label = 'long call' if d == 'up' else 'long put'
        lines.append(f'### {d}-breakthrough ({label}): n = {n}\n\n')
        if n >= 3 and 'stats' in sub:
            lines.append('| Horizon | n | Event mean | Ctrl mean | Δ | t | p |\n')
            lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
            for h in HORIZONS_MIN:
                lines.append(fmt_stats_line(f'+{h}m', sub['stats'][h]))
            lines.append('\n')
        if 'wf' in sub:
            lines.append(
                f'- Walk-forward @ +30m: '
                f'H1 n={sub["wf"]["h1"]["n"]}, Δ {sub["wf"]["h1"]["delta"]:+.2f}, '
                f'p={sub["wf"]["h1"]["p"]:.4f}; '
                f'H2 n={sub["wf"]["h2"]["n"]}, Δ {sub["wf"]["h2"]["delta"]:+.2f}, '
                f'p={sub["wf"]["h2"]["p"]:.4f}\n\n')

    # === TEST 4: confluence
    lines.append('## 4. Cross-asset confluence (SPX E5 ∩ NDX E5 within ±5 min)\n\n')
    conf = results['confluence']
    if not conf or conf.get('n_overlap', 0) == 0:
        lines.append('- No overlap days available.\n\n')
    else:
        lines.append(f'- SPX E5 events on NDX-coverage days: '
                     f'**{conf["n_overlap"]}**\n')
        lines.append(f'- Of those, **{conf["n_confluence"]}** '
                     f'({conf["pct_confluence"]:.1%}) had an NDX E5 confirm '
                     f'within ±5 minutes.\n\n')
        lines.append('**SPX E5 forward +30m returns (long-put signed) '
                     'by NDX-confluence:**\n\n')
        lines.append('| Bucket | n | mean ret_30m | t vs 0 | p vs 0 |\n')
        lines.append('|---|---:|---:|---:|---:|\n')
        cs = conf['confluence_stats']
        als = conf['alone_stats']
        lines.append(f'| NDX confirms (confluence) | {cs["n"]} '
                     f'| {cs["mean"]:+.2f} | {cs["t"]:+.2f} '
                     f'| {cs["p"]:.4f} |\n')
        lines.append(f'| SPX alone (no NDX confirm) | {als["n"]} '
                     f'| {als["mean"]:+.2f} | {als["t"]:+.2f} '
                     f'| {als["p"]:.4f} |\n')
        ts2 = conf.get('two_sample', {})
        if ts2.get('p') is not None and not np.isnan(ts2.get('p', np.nan)):
            lines.append(f'\nTwo-sample Welch t-test (confluence vs alone): '
                         f't={ts2["t"]:+.2f}, p={ts2["p"]:.4f}\n')
        lines.append('\n')

    # === TEST 5: lead-lag
    lines.append('## 5. NDX-leads-SPX timing\n\n')
    ll = results['lead_lag']
    if not ll or ll.get('n_total', 0) == 0:
        lines.append('- No data to test.\n\n')
    else:
        lines.append(f'- SPX E5 events tested: {ll["n_total"]}\n\n')
        lines.append('| Lead (min before SPX) | NDX shows pattern | % |\n')
        lines.append('|---:|---:|---:|\n')
        for k in range(1, 6):
            n = ll['by_lag'].get(k, 0)
            pct = ll['pct_by_lag'].get(k, 0)
            lines.append(f'| {k} | {n}/{ll["n_total"]} | {pct:.1%} |\n')
        lines.append('\n')

    # === Final verdict
    lines.append('---\n\n## Verdict\n\n')

    # E5
    e5_30 = e5.get('stats', {}).get(30, {})
    e5_pass = (e5.get('n', 0) >= 20 and e5_30.get('p', 1) < 0.10
               and e5_30.get('delta', 0) > 0)
    lines.append(f'- **E5 on NDX**: '
                 f'{"REPLICATES" if e5_pass else "DOES NOT REPLICATE"} '
                 f'(n={e5.get("n", 0)}, Δ '
                 f'{e5_30.get("delta", float("nan")):+.2f} pts at +30m, '
                 f'p={e5_30.get("p", float("nan")):.4f}). Note technical '
                 f'proxy used; SPX uses real dealer-+γ floor.\n')

    # E1
    e1_up_30 = e1.get('up', {}).get('stats', {}).get(30, {})
    e1_up_pass = (e1.get('up', {}).get('n', 0) >= 20
                  and e1_up_30.get('p', 1) < 0.10
                  and e1_up_30.get('delta', 0) > 0)
    lines.append(f'- **E1 up-breakthrough on NDX (long call)**: '
                 f'{"REPLICATES" if e1_up_pass else "DOES NOT REPLICATE"} '
                 f'(n={e1.get("up", {}).get("n", 0)}, Δ '
                 f'{e1_up_30.get("delta", float("nan")):+.2f} pts at +30m, '
                 f'p={e1_up_30.get("p", float("nan")):.4f}).\n')

    e1_down_30 = e1.get('down', {}).get('stats', {}).get(30, {})
    e1_down_pass = (e1.get('down', {}).get('n', 0) >= 20
                    and e1_down_30.get('p', 1) < 0.10
                    and e1_down_30.get('delta', 0) > 0)
    lines.append(f'- **E1 down-breakdown on NDX (long put)**: '
                 f'{"REPLICATES" if e1_down_pass else "DOES NOT REPLICATE"} '
                 f'(n={e1.get("down", {}).get("n", 0)}, Δ '
                 f'{e1_down_30.get("delta", float("nan")):+.2f} pts at +30m, '
                 f'p={e1_down_30.get("p", float("nan")):.4f}).\n')

    # confluence boost
    if conf and conf.get('n_confluence', 0) >= 5:
        cs = conf['confluence_stats']
        als = conf['alone_stats']
        boost = cs['mean'] - als['mean']
        ts2 = conf.get('two_sample', {})
        ts2_p = ts2.get('p', float('nan'))
        lines.append(f'- **Confluence boost**: SPX E5 with NDX confirmation '
                     f'has mean ret_30m={cs["mean"]:+.2f} pts vs SPX-alone '
                     f'{als["mean"]:+.2f} pts at +30m. '
                     f'Boost = {boost:+.2f} pts (Welch p={ts2_p:.4f}).\n')

    # lead-lag
    if ll.get('n_total', 0):
        best_k = max(ll['by_lag'], key=lambda k: ll['by_lag'][k])
        lines.append(f'- **NDX-leads-SPX**: highest hit rate at lag '
                     f'{best_k}min ({ll["pct_by_lag"][best_k]:.1%} of SPX '
                     f'E5 events). Tradeable lead-time depends on whether '
                     f'this exceeds the false-positive rate of the pattern '
                     f'occurring at random NDX bars on the same days '
                     f'(not measured here — caveat).\n')

    MD_PATH.write_text(''.join(lines))
    print(f'\nFindings written → {MD_PATH}')


# =============================================================================
# Main
# =============================================================================


def main():
    conn = psycopg2.connect(DB_URL)
    try:
        data_check = run_data_check(conn)
        spx_candles = data_check['spx']
        ndx_candles = data_check['ndx']

        e5_ndx = run_e5_ndx(ndx_candles)
        e1_ndx = run_e1_ndx(ndx_candles)

        spx_e5_csv = OUT / 'category_e_e5_failed_reversal.csv'
        confluence = run_confluence(spx_e5_csv, e5_ndx['events'],
                                    ndx_candles, spx_candles)
        lead_lag = run_lead_lag(e5_ndx['events'], spx_e5_csv, ndx_candles)

        results = {
            'data_check': data_check,
            'e5_ndx': e5_ndx,
            'e1_ndx': e1_ndx,
            'confluence': confluence,
            'lead_lag': lead_lag,
        }
        write_findings(results)
    finally:
        conn.close()
    print('\nDone.')


if __name__ == '__main__':
    main()
