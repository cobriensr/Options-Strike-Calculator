"""
Category D — Macro/context signals for SPX gamma-node-rejection signal.

Tests three day-level features against the master v4 event sample:
  D1. Friday close strength → Monday setup quality
  D2. Days since last validated bounce (cooldown effect)
  D3. Pre-market gap direction & magnitude

Base universe for D1/D2: chop pocket = (DOW=Monday, direction=down, |node_gex|<=500k)
D3 tests both down-wicks on gap-down days and up-wicks on gap-up days.

Inputs:
  docs/tmp/forensic-multi-day/gamma_node_rejection_2026-05-20_v4-vol-crush.csv
  Neon: index_candles_1m (symbol='SPX')

Outputs:
  Prints structured findings to stdout; writes to
  docs/tmp/forensic-multi-day/category_d_brainstorm_findings.md
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from scipy import stats

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / '.env.local')

CSV_PATH = ROOT / 'docs/tmp/forensic-multi-day/gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
OUT_PATH = ROOT / 'docs/tmp/forensic-multi-day/category_d_brainstorm_findings.md'

GEX_FLOOR = 500.0  # |node_gex| <= 500k -> "small gex" chop pocket
WALK_FORWARD_MIN_N = 20


def connect():
    return psycopg2.connect(os.environ['DATABASE_URL_UNPOOLED'])


def load_events() -> pd.DataFrame:
    df = pd.read_csv(CSV_PATH, parse_dates=['event_ts', 'control_ts'])
    # event_ts is UTC; ET 9:30 = UTC 14:30 (winter) / 13:30 (summer). Just keep date as UTC date,
    # which lines up with the trade date we use for SPX candles. Master CSV all uses 14:30 UTC,
    # so we are inside DST winter window where 14:30 UTC = 09:30 ET = 08:30 CT (correct).
    df['event_date'] = df['event_ts'].dt.date
    df['dow'] = df['event_ts'].dt.dayofweek  # 0=Monday
    df['abs_node_gex'] = df['node_gex'].abs()
    return df


def load_daily_spx() -> pd.DataFrame:
    """Build daily SPX OHLC from 1m candles. Returns df indexed by date with
    open (first RTH bar), close (last RTH bar), high, low, prev_close, day_range_pct.

    RTH = 14:30 UTC to 21:00 UTC inclusive (09:30-16:00 ET DST winter; same window
    as event_ts in the master CSV).
    """
    conn = connect()
    q = """
        SELECT timestamp, open, high, low, close
        FROM index_candles_1m
        WHERE symbol='SPX'
          AND timestamp::time >= '14:30:00'
          AND timestamp::time <= '21:00:00'
        ORDER BY timestamp ASC
    """
    df = pd.read_sql(q, conn)
    conn.close()

    df['date'] = df['timestamp'].dt.date
    daily = df.groupby('date').agg(
        day_open=('open', 'first'),
        day_close=('close', 'last'),
        day_high=('high', 'max'),
        day_low=('low', 'min'),
    ).reset_index()
    daily = daily.sort_values('date').reset_index(drop=True)
    daily['prev_close'] = daily['day_close'].shift(1)
    daily['prev_date'] = daily['date'].shift(1)
    daily['day_ret'] = daily['day_close'] / daily['prev_close'] - 1
    daily['day_range_pct'] = (daily['day_high'] - daily['day_low']) / daily['day_close']
    daily['open_gap'] = daily['day_open'] / daily['prev_close'] - 1
    return daily


def paired_t(event: np.ndarray, control: np.ndarray) -> tuple[float, float, float, float]:
    """Returns (event_mean, control_mean, delta, p) using paired t-test on differences."""
    if len(event) < 2:
        return float(np.mean(event) if len(event) else 0), float(np.mean(control) if len(control) else 0), 0.0, 1.0
    diff = event - control
    _, p = stats.ttest_rel(event, control, nan_policy='omit')
    return float(np.mean(event)), float(np.mean(control)), float(np.mean(diff)), float(p)


def walk_forward_split(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    df = df.sort_values('event_ts').reset_index(drop=True)
    mid = len(df) // 2
    return df.iloc[:mid].copy(), df.iloc[mid:].copy()


def fmt_bucket(name: str, sub: pd.DataFrame) -> dict:
    n = len(sub)
    if n == 0:
        return {'name': name, 'n': 0, 'event_mean': None, 'control_mean': None, 'delta': None, 'p': None}
    e = sub['ret_30m'].to_numpy()
    c = sub['control_ret_30m'].to_numpy()
    e_mean, c_mean, delta, p = paired_t(e, c)
    return {
        'name': name,
        'n': n,
        'event_mean': e_mean,
        'control_mean': c_mean,
        'delta': delta,
        'p': p,
    }


def bucket_rows(rows: list[dict]) -> str:
    """Format bucket result rows as markdown."""
    out = ['| Bucket | n | Event Δ | Control Δ | Edge | p |',
           '|---|---:|---:|---:|---:|---:|']
    for r in rows:
        if r['n'] == 0:
            out.append(f"| {r['name']} | 0 | — | — | — | — |")
        else:
            out.append(
                f"| {r['name']} | {r['n']} | {r['event_mean']:+.2f} | "
                f"{r['control_mean']:+.2f} | {r['delta']:+.2f} | {r['p']:.4f} |"
            )
    return '\n'.join(out)


# ---------------------------------------------------------------------------
# D1: Friday close strength → Monday setup quality
# ---------------------------------------------------------------------------

def d1_friday_to_monday(events: pd.DataFrame, daily: pd.DataFrame) -> dict:
    """Mondays + direction=down + |gex|<=500k segmented by prior Friday return."""
    pocket = events[
        (events['dow'] == 0)
        & (events['direction'] == 'down')
        & (events['abs_node_gex'] <= GEX_FLOOR)
    ].copy()

    daily_idx = daily.set_index('date')

    def prior_friday(d: date) -> date | None:
        # walk backward up to 5 calendar days looking for the Friday (weekday 4) in daily index
        for back in range(1, 8):
            cand = d - timedelta(days=back)
            if cand in daily_idx.index and cand.weekday() == 4:
                return cand
        return None

    rows = []
    for _, r in pocket.iterrows():
        fri = prior_friday(r['event_date'])
        if fri is None:
            continue
        fri_row = daily_idx.loc[fri]
        rows.append({
            'event_ts': r['event_ts'],
            'event_date': r['event_date'],
            'ret_30m': r['ret_30m'],
            'control_ret_30m': r['control_ret_30m'],
            'friday_ret': fri_row['day_ret'],
            'friday_range_pct': fri_row['day_range_pct'],
        })
    pf = pd.DataFrame(rows)
    if pf.empty:
        return {'pocket_n': 0, 'buckets': [], 'walkforward': None, 'detail': pf}

    # Split by Friday return: weak = bottom 40%, strong = top 40%, middle = rest
    p40 = pf['friday_ret'].quantile(0.4)
    p60 = pf['friday_ret'].quantile(0.6)

    def label(x):
        if x <= p40:
            return 'weak-Fri'
        if x >= p60:
            return 'strong-Fri'
        return 'mid-Fri'

    pf['fri_bucket'] = pf['friday_ret'].apply(label)

    buckets = []
    for b in ['weak-Fri', 'mid-Fri', 'strong-Fri']:
        sub = pf[pf['fri_bucket'] == b]
        buckets.append(fmt_bucket(b, sub))

    # walk-forward H1/H2 on the best bucket
    best = max(buckets, key=lambda r: r['delta'] if r['delta'] is not None else -1e9)
    wf = None
    if best['n'] >= WALK_FORWARD_MIN_N:
        sub_best = pf[pf['fri_bucket'] == best['name']]
        h1, h2 = walk_forward_split(sub_best)
        wf = {
            'best_bucket': best['name'],
            'h1': fmt_bucket('H1 ' + best['name'], h1),
            'h2': fmt_bucket('H2 ' + best['name'], h2),
        }

    return {
        'pocket_n': len(pf),
        'p40_friday_ret': float(p40),
        'p60_friday_ret': float(p60),
        'buckets': buckets,
        'walkforward': wf,
        'detail': pf,
    }


# ---------------------------------------------------------------------------
# D2: Days since last validated bounce (cooldown effect)
# ---------------------------------------------------------------------------

def d2_cooldown(events: pd.DataFrame) -> dict:
    pocket = events[
        (events['dow'] == 0)
        & (events['direction'] == 'down')
        & (events['abs_node_gex'] <= GEX_FLOOR)
    ].sort_values('event_ts').reset_index(drop=True).copy()

    # days since prior event in same pocket
    pocket['prior_event_ts'] = pocket['event_ts'].shift(1)
    pocket['days_since_prior'] = (
        (pocket['event_ts'] - pocket['prior_event_ts']).dt.total_seconds() / 86400.0
    )

    rows = pocket.dropna(subset=['days_since_prior']).copy()
    if rows.empty:
        return {'pocket_n': 0, 'buckets': [], 'walkforward': None, 'detail': rows}

    rows['cd_bucket'] = rows['days_since_prior'].apply(lambda x: '<4d' if x < 4 else '>=4d')

    buckets = []
    for b in ['<4d', '>=4d']:
        sub = rows[rows['cd_bucket'] == b]
        buckets.append(fmt_bucket(b, sub))

    best = max(buckets, key=lambda r: r['delta'] if r['delta'] is not None else -1e9)
    wf = None
    if best['n'] >= WALK_FORWARD_MIN_N:
        sub_best = rows[rows['cd_bucket'] == best['name']]
        h1, h2 = walk_forward_split(sub_best)
        wf = {
            'best_bucket': best['name'],
            'h1': fmt_bucket('H1 ' + best['name'], h1),
            'h2': fmt_bucket('H2 ' + best['name'], h2),
        }

    return {
        'pocket_n': len(rows),
        'buckets': buckets,
        'walkforward': wf,
        'detail': rows,
    }


# ---------------------------------------------------------------------------
# D3: Pre-market gap direction & magnitude
# ---------------------------------------------------------------------------

def d3_gap(events: pd.DataFrame, daily: pd.DataFrame) -> dict:
    daily_idx = daily.set_index('date')

    def gap_for(d):
        if d in daily_idx.index:
            v = daily_idx.loc[d, 'open_gap']
            return float(v) if pd.notna(v) else np.nan
        return np.nan

    ev = events.copy()
    ev['open_gap'] = ev['event_date'].apply(gap_for)
    ev = ev.dropna(subset=['open_gap'])

    def gap_bucket(g):
        if g <= -0.001:
            return 'gap-down'
        if g >= 0.001:
            return 'gap-up'
        return 'flat'

    ev['gap_bucket'] = ev['open_gap'].apply(gap_bucket)

    # Two regime tests using the same chop pocket constraint (small-gex)
    down_pocket = ev[(ev['direction'] == 'down') & (ev['abs_node_gex'] <= GEX_FLOOR)].copy()
    up_pocket = ev[(ev['direction'] == 'up') & (ev['abs_node_gex'] <= GEX_FLOOR)].copy()

    def buckets_for(df_: pd.DataFrame, order=('gap-down', 'flat', 'gap-up')) -> list[dict]:
        out = []
        for b in order:
            sub = df_[df_['gap_bucket'] == b]
            out.append(fmt_bucket(b, sub))
        return out

    down_buckets = buckets_for(down_pocket)
    up_buckets = buckets_for(up_pocket)

    # walk-forward best down-wick bucket
    def best_wf(df_, buckets_):
        if not buckets_:
            return None
        best = max(buckets_, key=lambda r: r['delta'] if r['delta'] is not None else -1e9)
        if best['n'] < WALK_FORWARD_MIN_N:
            return None
        sub_best = df_[df_['gap_bucket'] == best['name']]
        h1, h2 = walk_forward_split(sub_best)
        return {
            'best_bucket': best['name'],
            'h1': fmt_bucket('H1 ' + best['name'], h1),
            'h2': fmt_bucket('H2 ' + best['name'], h2),
        }

    return {
        'down_pocket_n': len(down_pocket),
        'up_pocket_n': len(up_pocket),
        'down_buckets': down_buckets,
        'up_buckets': up_buckets,
        'down_walkforward': best_wf(down_pocket, down_buckets),
        'up_walkforward': best_wf(up_pocket, up_buckets),
    }


# ---------------------------------------------------------------------------
# Render markdown
# ---------------------------------------------------------------------------

def render(d1: dict, d2: dict, d3: dict, per_monday: pd.DataFrame) -> str:
    lines = []
    lines.append('# Category D — Macro / Context Brainstorm Findings')
    lines.append('')
    lines.append('**Date:** 2026-05-21')
    lines.append(
        f'**Universe:** master CSV v4 (n=544 events). Chop pocket = Monday + direction=down + |node_gex|<= {GEX_FLOOR:.0f}.'
    )
    lines.append('**Stat test:** paired t-test on `ret_30m` vs `control_ret_30m`. Δ = mean(event − control).')
    lines.append('')
    lines.append('### Caveat — chop-pocket Monday breakdown')
    lines.append(
        f'Pocket spans only {len(per_monday)} unique Mondays; '
        f'event-level n is dominated by clustered intraday fires on the same date.'
    )
    lines.append('')
    lines.append('| Monday | n events | mean event ret_30m | mean control ret_30m | Δ |')
    lines.append('|---|---:|---:|---:|---:|')
    for d, row in per_monday.iterrows():
        lines.append(
            f"| {d} | {int(row['n'])} | {row['mean_event']:+.2f} | {row['mean_ctrl']:+.2f} | {row['mean_event']-row['mean_ctrl']:+.2f} |"
        )
    lines.append('')

    # ---- D1 ----
    lines.append('## D1 — Friday close strength → Monday setup quality')
    lines.append(f'Pocket n = {d1["pocket_n"]}.')
    if d1['pocket_n']:
        lines.append(
            f"Friday-return bucket cuts: p40 = {d1['p40_friday_ret']:+.4%}, p60 = {d1['p60_friday_ret']:+.4%}."
        )
        lines.append('')
        lines.append(bucket_rows(d1['buckets']))
        if d1['walkforward']:
            wf = d1['walkforward']
            lines.append('')
            lines.append(f"**Walk-forward** best bucket = `{wf['best_bucket']}`")
            lines.append(bucket_rows([wf['h1'], wf['h2']]))
    lines.append('')

    # ---- D2 ----
    lines.append('## D2 — Days since prior chop-pocket fire (cooldown)')
    lines.append(f'Pocket n (events with a prior) = {d2["pocket_n"]}.')
    if d2['pocket_n']:
        lines.append('')
        lines.append(bucket_rows(d2['buckets']))
        if d2['walkforward']:
            wf = d2['walkforward']
            lines.append('')
            lines.append(f"**Walk-forward** best bucket = `{wf['best_bucket']}`")
            lines.append(bucket_rows([wf['h1'], wf['h2']]))
    lines.append('')

    # ---- D3 ----
    lines.append('## D3 — Pre-market gap direction')
    lines.append(
        f"Down-wick + small-gex pocket n = {d3['down_pocket_n']}; "
        f"Up-wick + small-gex pocket n = {d3['up_pocket_n']}."
    )
    lines.append('')
    lines.append('### Down-wicks by gap direction')
    lines.append(bucket_rows(d3['down_buckets']))
    if d3['down_walkforward']:
        wf = d3['down_walkforward']
        lines.append('')
        lines.append(f"**Walk-forward** best down-wick bucket = `{wf['best_bucket']}`")
        lines.append(bucket_rows([wf['h1'], wf['h2']]))
    lines.append('')
    lines.append('### Up-wicks by gap direction')
    lines.append(bucket_rows(d3['up_buckets']))
    if d3['up_walkforward']:
        wf = d3['up_walkforward']
        lines.append('')
        lines.append(f"**Walk-forward** best up-wick bucket = `{wf['best_bucket']}`")
        lines.append(bucket_rows([wf['h1'], wf['h2']]))
    lines.append('')

    return '\n'.join(lines)


def main():
    events = load_events()
    daily = load_daily_spx()
    print(f'Loaded {len(events)} events; {len(daily)} daily SPX rows.')

    # Per-Monday breakdown of the chop pocket (caveat table)
    pocket = events[
        (events['dow'] == 0)
        & (events['direction'] == 'down')
        & (events['abs_node_gex'] <= GEX_FLOOR)
    ]
    per_monday = pocket.groupby('event_date').agg(
        n=('event_ts', 'count'),
        mean_event=('ret_30m', 'mean'),
        mean_ctrl=('control_ret_30m', 'mean'),
    )

    d1 = d1_friday_to_monday(events, daily)
    d2 = d2_cooldown(events)
    d3 = d3_gap(events, daily)

    md = render(d1, d2, d3, per_monday)
    OUT_PATH.write_text(md)
    print(md)
    print(f'\nWrote {OUT_PATH}')


if __name__ == '__main__':
    main()
