#!/usr/bin/env python3
"""
E5 deep-dive validation (2026-05-21)
====================================

Validate the E5 "failed reversal becomes continuation" → long-put signal.

Original finding (category_e_brainstorm.py):
  - n=86 confirmed breakdown events
  - Δ +8.95 pts vs control at +30m
  - paired t≈5.32, p<0.0001
  - Walk-forward halves +11.07 → +4.64 (decay but still positive)

This script runs the eight follow-ups:
  1. Walk-forward H1 vs H2 (p<0.10 and Δ>0 in both halves)
  2. DOW stratification
  3. GEX-Q stratification on |wicked node gex|
  4. Time-of-day buckets (pre-10:30, 10:30-12:00, 12:00-13:30, 13:30+)
  5. Cross with Monday filter
  6. Cross with D3 anti-filter (flat-gap days)
  7. Overlap with the Monday + small-gex PCS pocket
  8. Rough option-P&L proxy

Run: ml/.venv/bin/python scripts/e5_deep_dive.py
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
V4_CSV = OUT / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
MD_PATH = OUT / 'e5_deep_dive_findings.md'

LOOKBACK_PERISCOPE_MIN = 10
HORIZONS_MIN = [15, 30, 60]
LATEST_EVENT_CT_MINUTES = 14 * 60  # 14:00 CT cutoff

GEX_FLOOR = 500.0  # |node_gex| <= 500 = "small-gex pocket" (from category_d)
FLAT_GAP_PCT = 0.001  # ±0.1% open gap = "flat-gap day" (D3 definition)

DOW_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']


# =============================================================================
# DB / data helpers (mirroring category_e_brainstorm.py)
# =============================================================================


def query_df(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


def load_spx_candles(conn):
    q = """
        SELECT timestamp, open, high, low, close
        FROM index_candles_1m
        WHERE symbol = 'SPX'
          AND market_time = 'r'
          AND date >= (
              SELECT (MIN(captured_at) AT TIME ZONE 'UTC')::date
              FROM periscope_snapshots
          )
        ORDER BY timestamp
    """
    df = query_df(conn, q)
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    for c in ('open', 'high', 'low', 'close'):
        df[c] = df[c].astype(float)
    return df


def load_daily_spx(conn):
    """Daily SPX OHLC and open_gap from 1m candles (RTH only)."""
    q = """
        SELECT timestamp, open, high, low, close
        FROM index_candles_1m
        WHERE symbol='SPX'
          AND timestamp::time >= '14:30:00'
          AND timestamp::time <= '21:00:00'
        ORDER BY timestamp ASC
    """
    df = query_df(conn, q)
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    for c in ('open', 'high', 'low', 'close'):
        df[c] = df[c].astype(float)
    df['date'] = df['timestamp'].dt.date
    daily = df.groupby('date').agg(
        day_open=('open', 'first'),
        day_close=('close', 'last'),
        day_high=('high', 'max'),
        day_low=('low', 'min'),
    ).reset_index()
    daily = daily.sort_values('date').reset_index(drop=True)
    daily['prev_close'] = daily['day_close'].shift(1)
    daily['day_ret'] = daily['day_close'] / daily['prev_close'] - 1
    daily['open_gap'] = daily['day_open'] / daily['prev_close'] - 1
    return daily


# =============================================================================
# Rebuild E5 events (same logic as category_e_brainstorm.run_e5)
# =============================================================================


def build_e5_events(conn):
    """Return DataFrame of confirmed breakdown events with event-level returns
    AND matched same-day random control returns. Enriched with metadata:
      - dow, ct_minute, tod_bucket
      - node_gex, |node_gex|, gex_quartile
      - open_gap (% of prior close), gap_bucket
      - prior event ret_30m (failed-bounce magnitude)
      - whether the row also qualified as a PCS-pocket fire
    """
    v4 = pd.read_csv(V4_CSV)
    v4['event_ts'] = pd.to_datetime(v4['event_ts'], utc=True)
    v4['control_ts'] = pd.to_datetime(v4['control_ts'], utc=True, errors='coerce')

    candles = load_spx_candles(conn)
    candles_sorted = candles.sort_values('timestamp').reset_index(drop=True)
    ts_to_idx = {ts: i for i, ts in enumerate(candles_sorted['timestamp'])}

    # E5 filter: down-wick + ret_30m < 0 (failed bounce)
    failed = v4[(v4['direction'] == 'down') & (v4['ret_30m'] < 0)].copy()

    rows = []
    for _, ev in failed.iterrows():
        ev_ts = ev['event_ts']
        wick_low = float(ev['bar_low'])
        ev_ret_30m = float(ev['ret_30m'])  # signed for long-put on down-wick;
        # in v4 down direction the signed ret_30m is positive when SPX
        # mean-reverts UP — so ret_30m < 0 means SPX kept falling
        # (failed bounce / continuation already showing through).
        trigger_level = wick_low - 1.0
        idx = ts_to_idx.get(ev_ts)
        if idx is None:
            continue
        confirm_idx = None
        for offset in range(1, 11):
            ti = idx + offset
            if ti >= len(candles_sorted):
                break
            b = candles_sorted.iloc[ti]
            if b['low'] <= trigger_level:
                confirm_idx = ti
                break
        if confirm_idx is None:
            continue
        confirm = candles_sorted.iloc[confirm_idx]

        row = {
            'event_ts': ev_ts,
            'confirm_ts': confirm['timestamp'],
            'confirm_close': float(confirm['close']),
            'wick_low': wick_low,
            'trigger_level': trigger_level,
            'offset_min': confirm_idx - idx,
            'node_strike': int(ev['node_strike']),
            'node_gex': float(ev['node_gex']),
            'abs_node_gex': abs(float(ev['node_gex'])),
            'orig_ret_30m': ev_ret_30m,
            'bar_open': float(ev['bar_open']),
            'bar_close': float(ev['bar_close']),
        }
        for h in HORIZONS_MIN:
            ti = confirm_idx + h
            if ti >= len(candles_sorted):
                row[f'ret_{h}m'] = np.nan
                continue
            end_close = float(candles_sorted.iloc[ti]['close'])
            # Long-put sign: positive return when SPX falls
            row[f'ret_{h}m'] = -(end_close - confirm['close'])
        rows.append(row)
    df = pd.DataFrame(rows)
    if df.empty:
        return df

    # Same-day random controls (one per event), forward returns signed for long-put
    rng = np.random.default_rng(42)
    candles_sorted['ct'] = candles_sorted['timestamp'].dt.tz_convert(
        'America/Chicago')
    candles_sorted['ct_date'] = candles_sorted['ct'].dt.date
    candles_sorted['ct_minute'] = (
        candles_sorted['ct'].dt.hour * 60 + candles_sorted['ct'].dt.minute)
    eligible = candles_sorted[candles_sorted['ct_minute']
                              < LATEST_EVENT_CT_MINUTES]
    confirm_ts_set = set(df['confirm_ts'])
    pool = eligible[~eligible['timestamp'].isin(confirm_ts_set)]

    for h in HORIZONS_MIN:
        df[f'control_ret_{h}m'] = np.nan
    # Use tz-aware NaT to match ctrl timestamps
    df['control_ts'] = pd.Series(
        [pd.NaT] * len(df), dtype='datetime64[ns, UTC]')
    for i, row in df.iterrows():
        ev_date = pd.Timestamp(row['confirm_ts']).tz_convert(
            'America/Chicago').date()
        day_pool = pool[pool['ct_date'] == ev_date]
        if day_pool.empty:
            continue
        pi = int(rng.integers(0, len(day_pool)))
        ctrl = day_pool.iloc[pi]
        cidx = ts_to_idx.get(ctrl['timestamp'])
        if cidx is None:
            continue
        df.at[i, 'control_ts'] = ctrl['timestamp']
        for h in HORIZONS_MIN:
            ti = cidx + h
            if ti >= len(candles_sorted):
                continue
            end_close = float(candles_sorted.iloc[ti]['close'])
            df.at[i, f'control_ret_{h}m'] = -(end_close - ctrl['close'])

    # Metadata: DOW, time-of-day bucket
    df['confirm_ct'] = df['confirm_ts'].dt.tz_convert('America/Chicago')
    df['dow'] = df['confirm_ct'].dt.dayofweek
    df['dow_name'] = df['dow'].map(lambda i: DOW_NAMES[i] if i is not None else None)
    df['ct_minute'] = df['confirm_ct'].dt.hour * 60 + df['confirm_ct'].dt.minute
    df['date'] = df['confirm_ct'].dt.date

    def tod_bucket(m):
        if m < 10 * 60 + 30:
            return 'pre_10_30'
        if m < 12 * 60:
            return '10_30_to_12_00'
        if m < 13 * 60 + 30:
            return '12_00_to_13_30'
        return '13_30_plus'

    df['tod_bucket'] = df['ct_minute'].apply(tod_bucket)

    return df


# =============================================================================
# Stats helper
# =============================================================================


def paired_stats(df, ev_col='ret_30m', ct_col='control_ret_30m'):
    paired = df[[ev_col, ct_col]].dropna()
    n = len(paired)
    if n < 3:
        return {'n': n, 'ev_mean': np.nan, 'ct_mean': np.nan,
                'delta': np.nan, 't': np.nan, 'p': np.nan}
    ev_mean = paired[ev_col].mean()
    ct_mean = paired[ct_col].mean()
    diffs = paired[ev_col] - paired[ct_col]
    t_stat, p_paired = stats.ttest_1samp(diffs, 0)
    return {'n': n, 'ev_mean': float(ev_mean),
            'ct_mean': float(ct_mean), 'delta': float(ev_mean - ct_mean),
            't': float(t_stat), 'p': float(p_paired)}


def fmt_row(label, s):
    return (f'| {label} | {s["n"]} | {s["ev_mean"]:+.2f} | '
            f'{s["ct_mean"]:+.2f} | {s["delta"]:+.2f} | '
            f'{s["t"]:+.2f} | {s["p"]:.4f} |\n')


# =============================================================================
# Tests 1..8
# =============================================================================


def test_walk_forward(df):
    sub = df.sort_values('confirm_ts').reset_index(drop=True)
    half = len(sub) // 2
    h1 = sub.iloc[:half]
    h2 = sub.iloc[half:]
    return {
        'full': paired_stats(sub),
        'h1': paired_stats(h1),
        'h2': paired_stats(h2),
        'h1_dates': (str(h1['date'].min()), str(h1['date'].max())) if len(h1) else None,
        'h2_dates': (str(h2['date'].min()), str(h2['date'].max())) if len(h2) else None,
    }


def test_dow_strat(df):
    rows = []
    for dow in range(5):
        sub = df[df['dow'] == dow]
        if sub.empty:
            continue
        s = paired_stats(sub)
        s['label'] = DOW_NAMES[dow]
        rows.append(s)
    return rows


def test_gex_strat(df):
    """Quartile by |node_gex|. Also report a small-vs-large split at 500."""
    quart_rows = []
    if len(df) >= 8:
        try:
            df = df.copy()
            df['gex_q'] = pd.qcut(
                df['abs_node_gex'], q=4,
                labels=['Q1_small', 'Q2', 'Q3', 'Q4_large'],
                duplicates='drop')
            for q in df['gex_q'].dropna().unique():
                sub = df[df['gex_q'] == q]
                # Print range too
                lo = float(sub['abs_node_gex'].min())
                hi = float(sub['abs_node_gex'].max())
                s = paired_stats(sub)
                s['label'] = f'{q} ({lo:.0f}-{hi:.0f})'
                quart_rows.append(s)
        except ValueError:
            pass

    # Hard split at GEX_FLOOR
    small = df[df['abs_node_gex'] <= GEX_FLOOR]
    large = df[df['abs_node_gex'] > GEX_FLOOR]
    split = {
        'small_gex': paired_stats(small),
        'large_gex': paired_stats(large),
    }
    split['small_gex']['label'] = f'|gex| ≤ {GEX_FLOOR:.0f}'
    split['large_gex']['label'] = f'|gex| > {GEX_FLOOR:.0f}'
    return {'quartiles': quart_rows, 'split': split}


def test_tod(df):
    order = ['pre_10_30', '10_30_to_12_00', '12_00_to_13_30', '13_30_plus']
    rows = []
    for b in order:
        sub = df[df['tod_bucket'] == b]
        if sub.empty:
            rows.append({'label': b, 'n': 0, 'ev_mean': np.nan,
                         'ct_mean': np.nan, 'delta': np.nan,
                         't': np.nan, 'p': np.nan})
            continue
        s = paired_stats(sub)
        s['label'] = b
        rows.append(s)
    return rows


def test_monday_combo(df):
    mon = df[df['dow'] == 0]
    non_mon = df[df['dow'] != 0]
    return {
        'monday': paired_stats(mon),
        'non_monday': paired_stats(non_mon),
        'monday_label': f'Monday-only (n_dates={mon["date"].nunique()})',
    }


def test_d3_combo(df, daily):
    """Cross with D3 anti-filter: flat-gap days (|open_gap| < FLAT_GAP_PCT)."""
    daily_idx = daily.set_index('date')['open_gap'].to_dict()

    df = df.copy()
    df['open_gap'] = df['date'].map(daily_idx)
    df = df.dropna(subset=['open_gap'])

    def bucket(g):
        if g <= -FLAT_GAP_PCT:
            return 'gap_down'
        if g >= FLAT_GAP_PCT:
            return 'gap_up'
        return 'flat'

    df['gap_bucket'] = df['open_gap'].apply(bucket)
    rows = []
    for b in ('gap_down', 'flat', 'gap_up'):
        sub = df[df['gap_bucket'] == b]
        s = paired_stats(sub)
        s['label'] = b
        rows.append(s)
    return rows, df


def test_pcs_overlap(df, v4):
    """How many E5 confirmed events were PCS-pocket fires (Monday + small-gex
    down-wicks)?"""
    v4 = v4.copy()
    v4['abs_node_gex'] = v4['node_gex'].abs()
    v4['event_ct'] = v4['event_ts'].dt.tz_convert('America/Chicago')
    v4['dow'] = v4['event_ct'].dt.dayofweek
    pcs_pocket = v4[(v4['direction'] == 'down') & (v4['dow'] == 0)
                    & (v4['abs_node_gex'] <= GEX_FLOOR)].copy()
    pcs_keys = set(
        zip(pcs_pocket['event_ts'], pcs_pocket['node_strike'].astype(int)))

    e5 = df.copy()
    e5['is_pcs_pocket'] = [
        (ts, k) in pcs_keys
        for ts, k in zip(e5['event_ts'], e5['node_strike'].astype(int))
    ]

    # Of all PCS pocket down-wicks, how many had ret_30m < 0 (i.e. could have
    # qualified as E5)?
    pcs_failed = pcs_pocket[pcs_pocket['ret_30m'] < 0]
    pcs_total = len(pcs_pocket)
    pcs_failed_n = len(pcs_failed)

    overlap_n = int(e5['is_pcs_pocket'].sum())
    pure_e5 = e5[~e5['is_pcs_pocket']]
    overlap_e5 = e5[e5['is_pcs_pocket']]
    return {
        'pcs_pocket_n': pcs_total,
        'pcs_pocket_failed_n': pcs_failed_n,  # pre-confirmation
        'pcs_failure_rate': pcs_failed_n / pcs_total if pcs_total else np.nan,
        'e5_n': len(e5),
        'overlap_n': overlap_n,
        'overlap_pct_of_e5': overlap_n / len(e5) if len(e5) else np.nan,
        'pure_e5_stats': paired_stats(pure_e5),
        'overlap_stats': paired_stats(overlap_e5),
    }


def test_option_pnl(df):
    """Rough trade-P&L framing.

    For a 0DTE long put struck at the wicked node:
      - Δ at confirmation ≈ -0.50 (ATM-ish since node is near spot)
      - Δ-adjusted move: |ret_30m| × |Δ| ≈ |ret_30m| × 0.5
      - Premium proxy at entry: distance from spot to wick × scaling
        plus theta — too noisy without iv. We'll just report the underlying
        Δ-adjusted move and percentage of wick distance.
    """
    paired = df[df['ret_30m'].notna()].copy()
    if paired.empty:
        return {}
    paired['delta_move'] = paired['ret_30m'] * 0.50  # rough ATM Δ
    paired['delta_move_60m'] = paired['ret_60m'] * 0.50
    return {
        'mean_underlying_pts_30m': float(paired['ret_30m'].mean()),
        'mean_delta_move_30m': float(paired['delta_move'].mean()),
        'mean_underlying_pts_60m': float(paired['ret_60m'].mean(skipna=True)),
        'mean_delta_move_60m': float(paired['delta_move_60m'].mean(skipna=True)),
        'pct_profitable_30m': float((paired['ret_30m'] > 0).mean()),
        'median_underlying_30m': float(paired['ret_30m'].median()),
        'p25_30m': float(paired['ret_30m'].quantile(0.25)),
        'p75_30m': float(paired['ret_30m'].quantile(0.75)),
    }


# =============================================================================
# Render markdown
# =============================================================================


def write_findings(results):
    lines = []
    lines.append('# E5 Deep-Dive Findings (2026-05-21)\n\n')
    lines.append('Validation of E5 — failed-reversal continuation → long put. '
                 'Eight sequential follow-up tests on the n=86 confirmed-'
                 'breakdown sample.\n\n')

    lines.append(
        'Primary metric: paired t-test on `ret_30m` vs `control_ret_30m`. '
        'Δ = mean(event − control). Long-put sign: positive = SPX fell '
        'after confirmation, the put profits.\n\n')

    # === Headline
    full = results['walk_forward']['full']
    h1 = results['walk_forward']['h1']
    h2 = results['walk_forward']['h2']
    lines.append('## Headline\n\n')
    surv = (h1['p'] < 0.10 and h2['p'] < 0.10
            and h1['delta'] > 0 and h2['delta'] > 0)
    verdict = 'SURVIVES walk-forward' if surv else 'FAILS walk-forward'
    lines.append(f'**E5 {verdict}.**\n\n')
    lines.append(
        f'- Full sample: n={full["n"]}, Δ {full["delta"]:+.2f}, '
        f'p={full["p"]:.4f}\n')
    lines.append(
        f'- H1 (first half chronologically): n={h1["n"]}, '
        f'Δ {h1["delta"]:+.2f}, p={h1["p"]:.4f} '
        f'(dates {results["walk_forward"]["h1_dates"]})\n')
    lines.append(
        f'- H2 (second half): n={h2["n"]}, Δ {h2["delta"]:+.2f}, '
        f'p={h2["p"]:.4f} '
        f'(dates {results["walk_forward"]["h2_dates"]})\n\n')

    # === 1. Walk-forward
    lines.append('## 1. Walk-forward H1 vs H2\n\n')
    lines.append('Sorted by `confirm_ts`. Cutoff at the median event '
                 'index.\n\n')
    lines.append('| Bucket | n | Event mean | Ctrl mean | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    lines.append(fmt_row('Full', full))
    lines.append(fmt_row('H1', h1))
    lines.append(fmt_row('H2', h2))
    lines.append('\n')
    pass_p = h1['p'] < 0.10 and h2['p'] < 0.10
    pass_delta = h1['delta'] > 0 and h2['delta'] > 0
    lines.append(f'- H1 & H2 both Δ>0: **{pass_delta}**\n')
    lines.append(f'- H1 & H2 both p<0.10: **{pass_p}**\n')
    lines.append(f'- Walk-forward verdict: '
                 f'**{"PASS" if surv else "FAIL"}**\n\n')

    # === 2. DOW
    lines.append('## 2. DOW stratification\n\n')
    lines.append('| DOW | n | Event mean | Ctrl mean | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    for r in results['dow']:
        lines.append(fmt_row(r['label'], r))
    lines.append('\n')

    # === 3. GEX
    lines.append('## 3. |node_gex| stratification\n\n')
    gex = results['gex']
    lines.append('**Quartiles (by |node_gex|):**\n\n')
    lines.append('| Q | n | Event mean | Ctrl mean | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    for r in gex['quartiles']:
        lines.append(fmt_row(r['label'], r))
    lines.append('\n')
    lines.append('**Hard split at |gex| = 500 (PCS-pocket threshold):**\n\n')
    lines.append('| Bucket | n | Event mean | Ctrl mean | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    lines.append(fmt_row(gex['split']['small_gex']['label'],
                         gex['split']['small_gex']))
    lines.append(fmt_row(gex['split']['large_gex']['label'],
                         gex['split']['large_gex']))
    lines.append('\n')

    # === 4. Time-of-day
    lines.append('## 4. Time-of-day buckets (CT)\n\n')
    lines.append('| Bucket | n | Event mean | Ctrl mean | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    for r in results['tod']:
        lines.append(fmt_row(r['label'], r))
    lines.append('\n')

    # === 5. Monday combo
    lines.append('## 5. Cross with Monday filter\n\n')
    mc = results['monday']
    lines.append('| Bucket | n | Event mean | Ctrl mean | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    lines.append(fmt_row(mc['monday_label'], mc['monday']))
    lines.append(fmt_row('Non-Monday', mc['non_monday']))
    lines.append('\n')

    # === 6. D3 combo
    lines.append('## 6. Cross with D3 (flat-gap) anti-filter\n\n')
    lines.append(f'Gap bucket: flat = |open_gap| < {FLAT_GAP_PCT*100:.1f}%, '
                 'gap_down/gap_up otherwise.\n\n')
    lines.append('| Bucket | n | Event mean | Ctrl mean | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    for r in results['d3']:
        lines.append(fmt_row(r['label'], r))
    lines.append('\n')

    # === 7. PCS overlap
    lines.append('## 7. Overlap with Monday + small-gex PCS pocket\n\n')
    pcs = results['pcs_overlap']
    lines.append(
        f'- PCS pocket (Monday + direction=down + |gex| ≤ {GEX_FLOOR:.0f}) '
        f'down-wick total: **{pcs["pcs_pocket_n"]}**\n')
    lines.append(
        f'- PCS pocket with ret_30m < 0 (failed bounce): '
        f'**{pcs["pcs_pocket_failed_n"]}** '
        f'({pcs["pcs_failure_rate"]:.1%} of pocket)\n')
    lines.append(
        f'- E5 confirmed breakdowns that overlap PCS pocket: '
        f'**{pcs["overlap_n"]}** ({pcs["overlap_pct_of_e5"]:.1%} of E5)\n\n')

    lines.append('**E5 split by PCS-pocket overlap:**\n\n')
    lines.append('| Bucket | n | Event mean | Ctrl mean | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    lines.append(fmt_row('Pure E5 (no PCS overlap)', pcs['pure_e5_stats']))
    lines.append(fmt_row('E5 ∩ PCS pocket', pcs['overlap_stats']))
    lines.append('\n')

    # === 8. Option P&L
    lines.append('## 8. Rough option-P&L proxy\n\n')
    op = results['option_pnl']
    if op:
        lines.append(
            'Assumes ATM-ish long 0DTE put struck at the wicked node, Δ ≈ '
            '−0.50 at confirmation. Underlying-points figures are the raw '
            'SPX move after confirm, signed positive when SPX falls. '
            'Δ-adjusted move = underlying × 0.50 (rough $ value per 1-lot '
            '$1 multiplier).\n\n')
        lines.append(
            f'- Mean underlying +30m: {op["mean_underlying_pts_30m"]:+.2f} pts\n')
        lines.append(
            f'- Mean Δ-adjusted +30m: {op["mean_delta_move_30m"]:+.2f}\n')
        lines.append(
            f'- Mean underlying +60m: {op["mean_underlying_pts_60m"]:+.2f} pts\n')
        lines.append(
            f'- Mean Δ-adjusted +60m: {op["mean_delta_move_60m"]:+.2f}\n')
        lines.append(
            f'- Median underlying +30m: '
            f'{op["median_underlying_30m"]:+.2f} pts\n')
        lines.append(
            f'- IQR underlying +30m: [{op["p25_30m"]:+.2f}, '
            f'{op["p75_30m"]:+.2f}] pts\n')
        lines.append(
            f'- % of trades profitable at +30m: '
            f'{op["pct_profitable_30m"]:.1%}\n\n')
        lines.append(
            'Caveat: real option P&L also subtracts theta and vega/IV-crush, '
            'and entry premium varies with distance from spot. This proxy '
            'understates risk and ignores spread cost.\n\n')

    # === Final verdict
    lines.append('---\n\n')
    lines.append('## Final verdict\n\n')
    lines.append(f'- Walk-forward survival: '
                 f'**{"PASS" if surv else "FAIL"}**\n')

    # Identify strongest sub-segments
    sub_summaries = []
    for r in results['dow']:
        if r['n'] >= 10 and r['p'] < 0.10 and r['delta'] > 0:
            sub_summaries.append(
                f'DOW={r["label"]} (n={r["n"]}, Δ {r["delta"]:+.2f}, '
                f'p={r["p"]:.3f})')
    for r in results['tod']:
        if r['n'] >= 10 and r['p'] < 0.10 and r['delta'] > 0:
            sub_summaries.append(
                f'ToD={r["label"]} (n={r["n"]}, Δ {r["delta"]:+.2f}, '
                f'p={r["p"]:.3f})')
    for r in results['gex']['quartiles']:
        if r['n'] >= 10 and r['p'] < 0.10 and r['delta'] > 0:
            sub_summaries.append(
                f'|gex|={r["label"]} (n={r["n"]}, Δ {r["delta"]:+.2f}, '
                f'p={r["p"]:.3f})')
    if sub_summaries:
        lines.append('- Strongest sub-segments:\n')
        for s in sub_summaries:
            lines.append(f'  - {s}\n')
    else:
        lines.append('- No sub-segment cleared n≥10, Δ>0, p<0.10.\n')

    MD_PATH.write_text(''.join(lines))
    print(f'\nFindings written → {MD_PATH}')


# =============================================================================
# Main
# =============================================================================


def main():
    conn = psycopg2.connect(DB_URL)
    try:
        print('Building E5 events ...')
        df = build_e5_events(conn)
        print(f'  E5 confirmed breakdown events: {len(df):,}')
        if df.empty:
            print('No events — aborting.')
            return

        # Save enriched events CSV
        out_csv = OUT / 'e5_deep_dive_events.csv'
        df.to_csv(out_csv, index=False)
        print(f'  Enriched events → {out_csv}')

        print('Loading daily SPX ...')
        daily = load_daily_spx(conn)

        print('Loading v4 master CSV for PCS overlap ...')
        v4 = pd.read_csv(V4_CSV)
        v4['event_ts'] = pd.to_datetime(v4['event_ts'], utc=True)

        print('\n--- Test 1: Walk-forward H1 vs H2 ---')
        wf = test_walk_forward(df)
        print(f'  Full: n={wf["full"]["n"]}, Δ={wf["full"]["delta"]:+.2f}, '
              f'p={wf["full"]["p"]:.4f}')
        print(f'  H1:   n={wf["h1"]["n"]}, Δ={wf["h1"]["delta"]:+.2f}, '
              f'p={wf["h1"]["p"]:.4f}')
        print(f'  H2:   n={wf["h2"]["n"]}, Δ={wf["h2"]["delta"]:+.2f}, '
              f'p={wf["h2"]["p"]:.4f}')

        print('\n--- Test 2: DOW stratification ---')
        dow = test_dow_strat(df)
        for r in dow:
            print(f'  {r["label"]}: n={r["n"]}, Δ={r["delta"]:+.2f}, '
                  f'p={r["p"]:.4f}')

        print('\n--- Test 3: GEX stratification ---')
        gex = test_gex_strat(df)
        for r in gex['quartiles']:
            print(f'  {r["label"]}: n={r["n"]}, Δ={r["delta"]:+.2f}, '
                  f'p={r["p"]:.4f}')

        print('\n--- Test 4: Time-of-day ---')
        tod = test_tod(df)
        for r in tod:
            print(f'  {r["label"]}: n={r["n"]}, Δ={r["delta"]:+.2f}, '
                  f'p={r["p"]:.4f}')

        print('\n--- Test 5: Monday combo ---')
        mc = test_monday_combo(df)
        print(f'  Monday:     n={mc["monday"]["n"]}, '
              f'Δ={mc["monday"]["delta"]:+.2f}, p={mc["monday"]["p"]:.4f}')
        print(f'  Non-Monday: n={mc["non_monday"]["n"]}, '
              f'Δ={mc["non_monday"]["delta"]:+.2f}, '
              f'p={mc["non_monday"]["p"]:.4f}')

        print('\n--- Test 6: D3 (flat-gap) combo ---')
        d3, _ = test_d3_combo(df, daily)
        for r in d3:
            print(f'  {r["label"]}: n={r["n"]}, Δ={r["delta"]:+.2f}, '
                  f'p={r["p"]:.4f}')

        print('\n--- Test 7: PCS pocket overlap ---')
        pcs = test_pcs_overlap(df, v4)
        print(f'  PCS pocket total: {pcs["pcs_pocket_n"]}')
        print(f'  PCS pocket failed: {pcs["pcs_pocket_failed_n"]} '
              f'({pcs["pcs_failure_rate"]:.1%})')
        print(f'  E5 ∩ PCS pocket: {pcs["overlap_n"]} '
              f'({pcs["overlap_pct_of_e5"]:.1%} of E5)')

        print('\n--- Test 8: Option P&L proxy ---')
        op = test_option_pnl(df)
        print(f'  Mean underlying +30m: '
              f'{op["mean_underlying_pts_30m"]:+.2f}')
        print(f'  Mean Δ-adjusted +30m: {op["mean_delta_move_30m"]:+.2f}')
        print(f'  Pct profitable +30m: {op["pct_profitable_30m"]:.1%}')

        results = {
            'walk_forward': wf,
            'dow': dow,
            'gex': gex,
            'tod': tod,
            'monday': mc,
            'd3': d3,
            'pcs_overlap': pcs,
            'option_pnl': op,
        }
        write_findings(results)
    finally:
        conn.close()
    print('\nDone.')


if __name__ == '__main__':
    main()
