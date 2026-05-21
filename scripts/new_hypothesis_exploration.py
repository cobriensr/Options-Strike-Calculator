#!/usr/bin/env python3
"""Explore 5 brand-new hypothesis directions for the gamma-node rejection
signal (v4 dataset).

N1. Strike-distance-to-spot quartiles.
N2. Multi-snapshot Δgex at the node strike (30 min before → event_ts).
N3. Realized-vol momentum (5d RV / 20d RV).
N4. Prior-day OHLC echo (close-position-in-range).
N5. Bollinger-band position over 20-bar SPX 1-min closes.

For each: feature → buckets → paired event vs control t-test on
ret_30m / control_ret_30m. If best bucket n ≥ 20, walk-forward H1 vs H2.

Writes findings to docs/tmp/forensic-multi-day/new_hypothesis_findings.md.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from scipy import stats

load_dotenv('.env.local')
DB_URL = os.environ['DATABASE_URL_UNPOOLED']
OUT = Path('docs/tmp/forensic-multi-day')
V4_CSV = OUT / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
MD_PATH = OUT / 'new_hypothesis_findings.md'


# ----------------------------- helpers -------------------------------------


def query_df(conn, sql, params=None) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


def report_paired(label: str, sub: pd.DataFrame,
                  ev_col: str = 'ret_30m',
                  ct_col: str = 'control_ret_30m') -> dict:
    paired = sub[[ev_col, ct_col]].dropna()
    n = len(paired)
    if n < 5:
        return {'label': label, 'n': n, 'event': np.nan,
                'control': np.nan, 'delta': np.nan,
                't': np.nan, 'p': np.nan}
    ev = paired[ev_col].mean()
    ct = paired[ct_col].mean()
    diffs = paired[ev_col] - paired[ct_col]
    t, p = stats.ttest_1samp(diffs, 0)
    return {'label': label, 'n': n, 'event': ev, 'control': ct,
            'delta': ev - ct, 't': t, 'p': p}


def fmt_row(r: dict) -> str:
    if r['n'] < 5 or np.isnan(r['delta']):
        return f"| {r['label']} | {r['n']} | n/a | n/a | n/a | n/a | n/a |"
    return (f"| {r['label']} | {r['n']} | {r['event']:+.2f} "
            f"| {r['control']:+.2f} | {r['delta']:+.2f} "
            f"| {r['t']:+.2f} | {r['p']:.4f} |")


def walk_forward(label: str, sub: pd.DataFrame) -> tuple[dict, dict]:
    sub_sorted = sub.sort_values('event_ts').reset_index(drop=True)
    mid = len(sub_sorted) // 2
    h1 = sub_sorted.iloc[:mid]
    h2 = sub_sorted.iloc[mid:]
    return report_paired('H1', h1), report_paired('H2', h2)


def bucket_section(name: str, df: pd.DataFrame, bucket_col: str,
                   bucket_order: list[str], md_lines: list[str]) -> None:
    """Run paired test for each bucket; walk-forward on the best bucket."""
    md_lines.append(f'## {name}\n\n')
    md_lines.append(f'Bucketing by **{bucket_col}**.\n\n')
    md_lines.append('| Bucket | n | Event +30m | Control +30m | Δ | t | p |\n')
    md_lines.append('|---|---:|---:|---:|---:|---:|---:|\n')

    best_bucket = None
    best_delta = -np.inf
    best_n = 0
    bucket_rows = {}
    for b in bucket_order:
        sub = df[df[bucket_col] == b]
        r = report_paired(str(b), sub)
        bucket_rows[b] = r
        md_lines.append(fmt_row(r) + '\n')
        # "Best" = largest positive Δ with n ≥ 15
        if r['n'] >= 15 and r['delta'] > best_delta:
            best_delta = r['delta']
            best_bucket = b
            best_n = r['n']
    md_lines.append('\n')

    # Walk-forward on best bucket if n ≥ 20
    if best_bucket is not None and best_n >= 20:
        sub = df[df[bucket_col] == best_bucket]
        r_h1, r_h2 = walk_forward(best_bucket, sub)
        md_lines.append(
            f'### Walk-forward on best bucket: **{best_bucket}** '
            f'(n={best_n})\n\n'
        )
        md_lines.append(
            '| Half | n | Event +30m | Control +30m | Δ | t | p |\n')
        md_lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
        md_lines.append(fmt_row(r_h1) + '\n')
        md_lines.append(fmt_row(r_h2) + '\n\n')

        h1_pass = (r_h1['n'] >= 10 and r_h1['delta'] > 0
                   and r_h1['p'] < 0.10)
        h2_pass = (r_h2['n'] >= 10 and r_h2['delta'] > 0
                   and r_h2['p'] < 0.10)
        verdict = 'PASS' if (h1_pass and h2_pass) else 'FAIL'
        md_lines.append(f'**Walk-forward verdict: {verdict}**\n\n')
    else:
        md_lines.append(
            f'_No bucket had n ≥ 20 with positive Δ; '
            f'best candidate: {best_bucket} (n={best_n}, '
            f'Δ={best_delta:+.2f}). Walk-forward skipped._\n\n'
        )


# ---------------------------- data loaders ---------------------------------


def load_v4() -> pd.DataFrame:
    df = pd.read_csv(V4_CSV, parse_dates=['event_ts', 'control_ts'])
    df['event_date'] = df['event_ts'].dt.date
    return df


def load_spx_minute(conn) -> pd.DataFrame:
    q = """
        SELECT timestamp, open, high, low, close, date
        FROM index_candles_1m
        WHERE symbol = 'SPX' AND market_time = 'r'
        ORDER BY timestamp
    """
    df = query_df(conn, q)
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    for c in ('open', 'high', 'low', 'close'):
        df[c] = df[c].astype(float)
    return df


# ============================== N1 =========================================


def run_n1(v4: pd.DataFrame, md: list[str]) -> None:
    """Strike-distance-to-spot quartiles (down-wicks only)."""
    md.append('# N1. Strike-Distance-to-Spot Quartile\n\n')
    md.append('Feature: `strike_dist = abs(node_strike - bar_close)`.\n')
    md.append('Hypothesis: very close (≤2 pts) = tactical hold; far '
              '= deep breakdown.\n\n')

    down = v4[v4['direction'] == 'down'].copy()
    down['strike_dist'] = (down['node_strike'] - down['bar_close']).abs()

    # Quartiles
    down['dist_q'] = pd.qcut(down['strike_dist'], q=4,
                             labels=['Q1_close', 'Q2', 'Q3', 'Q4_far'],
                             duplicates='drop')

    md.append('Quartile cutoffs (pts):\n')
    qs = down['strike_dist'].quantile([0.25, 0.5, 0.75]).values
    md.append(f'- Q1 ≤ {qs[0]:.1f}, Q2 ≤ {qs[1]:.1f}, '
              f'Q3 ≤ {qs[2]:.1f}, Q4 > {qs[2]:.1f}\n\n')

    bucket_section(
        'Distance quartile buckets',
        down, 'dist_q',
        ['Q1_close', 'Q2', 'Q3', 'Q4_far'],
        md,
    )

    # Also test specific narrow ≤2pt cutoff
    md.append('### Special: strike_dist ≤ 2 pts\n\n')
    very_close = down[down['strike_dist'] <= 2.0]
    r = report_paired('dist≤2pt', very_close)
    md.append('| Cell | n | Event +30m | Control +30m | Δ | t | p |\n')
    md.append('|---|---:|---:|---:|---:|---:|---:|\n')
    md.append(fmt_row(r) + '\n\n')


# ============================== N2 =========================================


def run_n2(v4: pd.DataFrame, conn, md: list[str]) -> None:
    """Multi-snapshot Δgex at node_strike, 30 min before → event_ts.

    Uses gex_strike_0dte (315 timestamps/day) as the snapshot source.
    Net gamma at the node strike = call_gamma_oi + put_gamma_oi (the OI is
    already signed by side; put_gamma_oi is typically negative for dealers
    short puts).
    """
    md.append('# N2. Multi-Snapshot Δgex at Node Strike\n\n')
    md.append('Feature: Δgex = net_gamma(strike, event_ts) − '
              'net_gamma(strike, event_ts − 30m).\n')
    md.append('Source: `gex_strike_0dte` (~315 captures/day, signed OI).\n\n')

    down = v4[v4['direction'] == 'down'].copy()

    # Pull the closest snapshot per (strike, ts) bucket. To stay efficient,
    # fetch one row per (event, strike, target_time) by joining LATERAL.
    delta_gex = []
    with conn.cursor() as cur:
        for _, ev in down.iterrows():
            strike = float(ev['node_strike'])
            ts_now = ev['event_ts']
            ts_pre = ts_now - pd.Timedelta(minutes=30)
            # Find nearest snapshot within ±10 min of each anchor
            sql = """
                SELECT
                  (SELECT call_gamma_oi + put_gamma_oi
                     FROM gex_strike_0dte
                    WHERE strike = %s
                      AND timestamp BETWEEN %s AND %s
                    ORDER BY ABS(EXTRACT(EPOCH FROM (timestamp - %s)))
                    LIMIT 1) AS gex_now,
                  (SELECT call_gamma_oi + put_gamma_oi
                     FROM gex_strike_0dte
                    WHERE strike = %s
                      AND timestamp BETWEEN %s AND %s
                    ORDER BY ABS(EXTRACT(EPOCH FROM (timestamp - %s)))
                    LIMIT 1) AS gex_pre
            """
            cur.execute(sql, (
                strike,
                ts_now - pd.Timedelta(minutes=10),
                ts_now + pd.Timedelta(minutes=10),
                ts_now,
                strike,
                ts_pre - pd.Timedelta(minutes=10),
                ts_pre + pd.Timedelta(minutes=10),
                ts_pre,
            ))
            row = cur.fetchone()
            delta_gex.append({
                'event_ts': ev['event_ts'],
                'gex_now': float(row[0]) if row[0] is not None else None,
                'gex_pre': float(row[1]) if row[1] is not None else None,
            })

    dg = pd.DataFrame(delta_gex)
    merged = down.merge(dg, on='event_ts', how='left')
    merged['delta_gex'] = merged['gex_now'] - merged['gex_pre']
    matched = merged.dropna(subset=['delta_gex'])
    md.append(f'Matched snapshots: {len(matched)} of {len(down)} '
              f'down-wick events.\n\n')

    if len(matched) < 20:
        md.append('_Too few matches; N2 inconclusive._\n\n')
        return

    # Sign-of-Δgex buckets
    matched['delta_gex_sign'] = np.where(matched['delta_gex'] > 0,
                                         'positive_build', 'negative_drain')
    bucket_section(
        'Δgex sign (build vs drain)',
        matched, 'delta_gex_sign',
        ['positive_build', 'negative_drain'],
        md,
    )

    # Quartile buckets on Δgex magnitude
    matched['delta_q'] = pd.qcut(matched['delta_gex'], q=4,
                                 labels=['Q1_most_drain', 'Q2',
                                         'Q3', 'Q4_most_build'],
                                 duplicates='drop')
    bucket_section(
        'Δgex magnitude quartiles',
        matched, 'delta_q',
        ['Q1_most_drain', 'Q2', 'Q3', 'Q4_most_build'],
        md,
    )


# ============================== N3 =========================================


def run_n3(v4: pd.DataFrame, conn, md: list[str]) -> None:
    """Realized-vol momentum: 5d RV / 20d RV."""
    md.append('# N3. Realized-Vol Momentum (5d / 20d RV)\n\n')
    md.append('Feature: ratio of trailing 5d realized vol to 20d realized '
              'vol of SPX daily close-to-close log returns. \n')
    md.append('Hypothesis: vol expansion (>1.5) vs contraction (<0.7) '
              'shows different edge.\n\n')

    # Build daily SPX close series. To cover the 20d trailing window for
    # the earliest event date (2026-02-27 in v4), we need ~30 trading days
    # of close prices prior. The DB only has from 2026-02-25, so for the
    # earliest events the 20d window will be partial. Use available data
    # and require complete 20d windows for inclusion.
    q = """
        WITH last_close AS (
          SELECT date,
                 close,
                 ROW_NUMBER() OVER (PARTITION BY date
                                    ORDER BY timestamp DESC) rn
            FROM index_candles_1m
           WHERE symbol='SPX' AND market_time='r'
        )
        SELECT date, close::float
          FROM last_close
         WHERE rn = 1
         ORDER BY date
    """
    daily = query_df(conn, q)
    daily['ret'] = np.log(daily['close']).diff()
    daily['rv5'] = daily['ret'].rolling(5).std() * np.sqrt(252)
    daily['rv20'] = daily['ret'].rolling(20).std() * np.sqrt(252)
    daily['rv_ratio'] = daily['rv5'] / daily['rv20']

    down = v4[v4['direction'] == 'down'].copy()
    # Use prior-day RV (i.e. compute RV using closes UP TO day before event)
    daily['date'] = pd.to_datetime(daily['date']).dt.date
    # Shift by one trading day so we use info up to but excluding event date
    daily['rv_ratio_pre'] = daily['rv_ratio'].shift(1)
    down = down.merge(daily[['date', 'rv_ratio_pre']],
                      left_on='event_date', right_on='date', how='left')

    matched = down.dropna(subset=['rv_ratio_pre'])
    md.append(f'Events with full RV history: {len(matched)} of {len(down)}.\n\n')

    if len(matched) < 20:
        md.append('_Too few; N3 inconclusive._\n\n')
        return

    md.append(f'RV-ratio range: {matched["rv_ratio_pre"].min():.2f} '
              f'→ {matched["rv_ratio_pre"].max():.2f}, '
              f'mean={matched["rv_ratio_pre"].mean():.2f}\n\n')

    # Defined buckets per spec
    def label_ratio(x):
        if x > 1.5:
            return 'expanding_>1.5'
        if x < 0.7:
            return 'contracting_<0.7'
        return 'neutral_0.7-1.5'

    matched = matched.copy()
    matched['rv_bucket'] = matched['rv_ratio_pre'].apply(label_ratio)
    bucket_section(
        'RV-ratio spec buckets',
        matched, 'rv_bucket',
        ['contracting_<0.7', 'neutral_0.7-1.5', 'expanding_>1.5'],
        md,
    )

    # Also quartile sweep for robustness
    matched['rv_q'] = pd.qcut(matched['rv_ratio_pre'], q=4,
                              labels=['Q1_low', 'Q2', 'Q3', 'Q4_high'],
                              duplicates='drop')
    bucket_section(
        'RV-ratio quartiles',
        matched, 'rv_q',
        ['Q1_low', 'Q2', 'Q3', 'Q4_high'],
        md,
    )


# ============================== N4 =========================================


def run_n4(v4: pd.DataFrame, conn, md: list[str]) -> None:
    """Prior-day OHLC echo: close-position-in-range."""
    md.append('# N4. Prior-Day OHLC Echo\n\n')
    md.append('Feature: prior_close_pos = (close - low) / (high - low).\n')
    md.append('Hypothesis: prior day weak close (<0.3) → follow-through '
              'bounce next morning.\n\n')

    # Compute daily OHLC from minute candles
    q = """
        SELECT date,
               MIN(low::float)  AS l,
               MAX(high::float) AS h,
               (SELECT close::float FROM index_candles_1m i2
                 WHERE i2.symbol='SPX' AND i2.market_time='r'
                   AND i2.date = i.date
                 ORDER BY timestamp DESC LIMIT 1) AS c
          FROM index_candles_1m i
         WHERE symbol='SPX' AND market_time='r'
         GROUP BY date
         ORDER BY date
    """
    daily = query_df(conn, q)
    daily['date'] = pd.to_datetime(daily['date']).dt.date
    daily['close_pos'] = (daily['c'] - daily['l']) / (daily['h'] - daily['l'])
    daily['range_pct'] = (daily['h'] - daily['l']) / daily['c']
    # Prior day stats
    daily['prior_close_pos'] = daily['close_pos'].shift(1)
    daily['prior_range_pct'] = daily['range_pct'].shift(1)
    daily['prior_close_ret'] = np.log(daily['c'] / daily['c'].shift(1)).shift(1)

    down = v4[v4['direction'] == 'down'].copy()
    down = down.merge(
        daily[['date', 'prior_close_pos', 'prior_range_pct',
               'prior_close_ret']],
        left_on='event_date', right_on='date', how='left',
    )
    matched = down.dropna(subset=['prior_close_pos'])
    md.append(f'Events with prior-day OHLC: {len(matched)} of {len(down)}.\n\n')

    if len(matched) < 20:
        md.append('_Too few; N4 inconclusive._\n\n')
        return

    md.append(f'prior_close_pos range: '
              f'{matched["prior_close_pos"].min():.2f} → '
              f'{matched["prior_close_pos"].max():.2f}\n\n')

    # Spec bucket: weak-close (<0.3) vs others
    def label_close(x):
        if x < 0.3:
            return 'weak_close_<0.3'
        if x > 0.7:
            return 'strong_close_>0.7'
        return 'mid_0.3-0.7'

    matched = matched.copy()
    matched['close_bucket'] = matched['prior_close_pos'].apply(label_close)
    bucket_section(
        'prior-day close-position buckets',
        matched, 'close_bucket',
        ['weak_close_<0.3', 'mid_0.3-0.7', 'strong_close_>0.7'],
        md,
    )

    # Tertile sweep
    matched['close_t'] = pd.qcut(matched['prior_close_pos'], q=3,
                                 labels=['T1_low', 'T2', 'T3_high'],
                                 duplicates='drop')
    bucket_section(
        'prior-day close-position tertiles',
        matched, 'close_t',
        ['T1_low', 'T2', 'T3_high'],
        md,
    )


# ============================== N5 =========================================


def run_n5(v4: pd.DataFrame, spx_min: pd.DataFrame, md: list[str]) -> None:
    """Bollinger band position on 20-bar SPX 1-min closes."""
    md.append('# N5. Bollinger-Band Position (20-bar)\n\n')
    md.append('Feature: bb_pos = (bar_close - mean20) / (2 * std20) over '
              'trailing 20 SPX 1-min closes ending at event_ts.\n')
    md.append('Hypothesis: down-wick events with bb_pos < −1.5 (very '
              'oversold) show stronger bounces.\n\n')

    # Index spx_min by timestamp
    spx_min = spx_min.sort_values('timestamp').reset_index(drop=True)
    spx_min['close_f'] = spx_min['close'].astype(float)

    # rolling 20-bar mean and std, computed over the entire concatenated
    # session series (NOTE: this will cross intraday boundaries between
    # consecutive sessions; the rolling window of 20 minutes overlaps
    # premarket only on the first event of a session. Filter market_time='r'
    # already ensures we are inside the regular session. The crossover at
    # session open is a minor edge artifact for the first 20 min of trading;
    # we'll flag those.
    spx_min['m20'] = spx_min['close_f'].rolling(20).mean()
    spx_min['s20'] = spx_min['close_f'].rolling(20).std()
    spx_min['bb_pos'] = ((spx_min['close_f'] - spx_min['m20'])
                        / (2 * spx_min['s20']))

    # Lookup table by timestamp string (UTC)
    bb_lookup = spx_min.set_index('timestamp')['bb_pos']

    down = v4[v4['direction'] == 'down'].copy()
    # Match event_ts → nearest minute bar
    bb_vals = []
    for _, ev in down.iterrows():
        ts = ev['event_ts']
        if ts in bb_lookup.index:
            bb_vals.append(bb_lookup.loc[ts])
        else:
            # find closest within 60s
            window = bb_lookup.loc[
                (bb_lookup.index >= ts - pd.Timedelta(minutes=2))
                & (bb_lookup.index <= ts + pd.Timedelta(minutes=2))
            ]
            bb_vals.append(window.iloc[0] if len(window) else np.nan)
    down['bb_pos'] = bb_vals
    matched = down.dropna(subset=['bb_pos'])
    md.append(f'Events with bb_pos: {len(matched)} of {len(down)}.\n\n')

    if len(matched) < 20:
        md.append('_Too few; N5 inconclusive._\n\n')
        return

    md.append(f'bb_pos range: {matched["bb_pos"].min():.2f} → '
              f'{matched["bb_pos"].max():.2f}, '
              f'mean={matched["bb_pos"].mean():.2f}\n\n')

    # Spec buckets
    def label_bb(x):
        if x < -1.0:
            return 'very_oversold_<-1.0'
        if x < 0:
            return 'oversold_-1to0'
        if x < 1.0:
            return 'overbought_0to1'
        return 'very_overbought_>1.0'

    matched = matched.copy()
    matched['bb_bucket'] = matched['bb_pos'].apply(label_bb)
    bucket_section(
        'bb_pos spec buckets',
        matched, 'bb_bucket',
        ['very_oversold_<-1.0', 'oversold_-1to0',
         'overbought_0to1', 'very_overbought_>1.0'],
        md,
    )

    # Extra: very-oversold cutoff bb_pos < -1.5
    md.append('### Special: bb_pos < −1.5 (very oversold)\n\n')
    deep = matched[matched['bb_pos'] < -1.5]
    r = report_paired('bb_pos<-1.5', deep)
    md.append('| Cell | n | Event +30m | Control +30m | Δ | t | p |\n')
    md.append('|---|---:|---:|---:|---:|---:|---:|\n')
    md.append(fmt_row(r) + '\n\n')


# =============================== main ======================================


def main() -> None:
    v4 = load_v4()
    conn = psycopg2.connect(DB_URL)

    md: list[str] = [
        '# New Hypothesis Exploration — 2026-05-21\n\n',
        f'**Dataset:** `gamma_node_rejection_2026-05-20_v4-vol-crush.csv` '
        f'(n={len(v4)} total, '
        f'{(v4["direction"] == "down").sum()} down-wick).\n\n',
        '**Convention:** paired event vs control on `ret_30m` / '
        '`control_ret_30m`. Walk-forward = equal-n event-order split.\n\n',
        '---\n\n',
    ]

    print('=== N1: Strike-distance-to-spot ===')
    run_n1(v4, md)
    md.append('---\n\n')

    print('=== N2: Multi-snapshot Δgex ===')
    run_n2(v4, conn, md)
    md.append('---\n\n')

    print('=== N3: Realized-vol momentum ===')
    run_n3(v4, conn, md)
    md.append('---\n\n')

    print('=== N4: Prior-day OHLC echo ===')
    run_n4(v4, conn, md)
    md.append('---\n\n')

    print('=== N5: Bollinger-band position ===')
    spx_min = load_spx_minute(conn)
    run_n5(v4, spx_min, md)

    MD_PATH.write_text(''.join(md))
    print(f'\nWrote findings → {MD_PATH}')
    conn.close()


if __name__ == '__main__':
    main()
