#!/usr/bin/env python
"""Per-mode parameter tuning for the flow-inversion exit policy.

Searches a grid of (peak_prominence_ratio, slope_window_min,
neg_persist_min) per Mode (A_intraday_0DTE vs B_multi_day_DTE1_3) on
a train slice, picks the best combo by Sharpe, then validates on a
held-out test slice. Reports best params + train/test stability so we
can tell if a tuned combo is real edge vs overfit noise.

Read-only — does not modify the DB or production code.

Usage:
    ml/.venv/bin/python scripts/tune_flow_inversion.py
"""

from __future__ import annotations

import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Bot-Eod-parquet'

_CT_TZ = ZoneInfo('America/Chicago')

DEFAULT_PROM = 0.05
DEFAULT_WINDOW = 5
DEFAULT_PERSIST = 3

MODE_A_GRID = [
    (prom, win, per)
    for prom in [0.03, 0.05, 0.07, 0.10]
    for win in [3, 5, 7]
    for per in [2, 3, 4]
]
MODE_B_GRID = [
    (prom, win, per)
    for prom in [0.03, 0.05, 0.07, 0.10]
    for win in [5, 7, 10, 15]
    for per in [3, 5, 7]
]


# ============================================================
# Algorithm — parameterized port of simulate_flow_inversion
# ============================================================


def find_prominent_peaks(values, min_prominence):
    out = []
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


def simulate(minutes, flow, entry_price, trigger_ts, prom, window_min, persist_min):
    post = [m for m in minutes if m[0] > trigger_ts]
    if not post:
        return None

    ct_date = trigger_ts.astimezone(_CT_TZ).date()
    eod_ts = datetime(
        ct_date.year, ct_date.month, ct_date.day,
        15, 0, 0, tzinfo=_CT_TZ,
    ).astimezone(timezone.utc)
    flow_post = [f for f in flow if trigger_ts < f[0] <= eod_ts]
    if len(flow_post) < 5:
        return None

    cum = []
    running = 0.0
    for _, v in flow_post:
        running += v
        cum.append(running)
    rng = max(cum) - min(cum)
    if rng <= 0:
        return None

    peaks = find_prominent_peaks(cum, rng * prom)
    if not peaks:
        return None
    peak_idx = max(peaks, key=lambda p: p[1])[0]

    flow_after_peak = flow_post[peak_idx:]
    min_required = window_min + persist_min

    def exit_at_or_after(target_ts):
        for ts, mid in post:
            if ts >= target_ts:
                return ((mid - entry_price) / entry_price) * 100.0
        _, last_mid = post[-1]
        return ((last_mid - entry_price) / entry_price) * 100.0

    if len(flow_after_peak) < min_required:
        return exit_at_or_after(eod_ts)

    cum_after = []
    running = 0.0
    for _, v in flow_after_peak:
        running += v
        cum_after.append(running)

    neg_streak = 0
    inversion_idx = None
    for i in range(window_min, len(cum_after)):
        slope = (cum_after[i] - cum_after[i - window_min]) / window_min
        if slope < 0:
            neg_streak += 1
            if neg_streak >= persist_min:
                inversion_idx = i
                break
        else:
            neg_streak = 0

    if inversion_idx is None:
        return exit_at_or_after(eod_ts)

    inversion_ts = flow_after_peak[inversion_idx][0]
    return exit_at_or_after(inversion_ts)


# ============================================================
# Data loading
# ============================================================


def load_env():
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


def resample_minute_mid(chain_df):
    if 'nbbo_bid' not in chain_df.columns:
        return []
    valid = chain_df[
        (chain_df['nbbo_bid'] > 0) & (chain_df['nbbo_ask'] > 0)
    ]
    if valid.empty:
        return []
    mid = (valid['nbbo_bid'] + valid['nbbo_ask']) / 2.0
    sz = valid['size'].astype(float).clip(lower=1.0)
    df = pd.DataFrame({
        'ts': valid['executed_at'].dt.floor('min'),
        'wm': (mid * sz).values,
        'sz': sz.values,
    })
    grouped = df.groupby('ts', sort=True).agg(
        wm_sum=('wm', 'sum'), sz_sum=('sz', 'sum')
    )
    grouped['mid'] = grouped['wm_sum'] / grouped['sz_sum']
    return [(ts.to_pydatetime(), float(m)) for ts, m in grouped['mid'].items()]


def build_fire_inputs():
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    conn = psycopg2.connect(db_url)
    print('[load] fetching fires…')
    fires = pd.read_sql(
        """
        SELECT id, date, option_chain_id, underlying_symbol, option_type,
               trigger_time_ct, entry_price, mode
        FROM lottery_finder_fires
        WHERE peak_ceiling_pct IS NOT NULL
        ORDER BY date, trigger_time_ct
        """,
        conn,
    )
    print(f'[load] {len(fires):,} fires across {fires["date"].nunique()} dates')

    inputs = []
    for d, sub in fires.groupby('date', sort=True):
        date_str = d.isoformat() if hasattr(d, 'isoformat') else str(d)[:10]
        path = PARQUET_DIR / f'{date_str}-trades.parquet'
        if not path.exists():
            print(f'  [{date_str}] parquet missing — skipping')
            continue
        chains = sub['option_chain_id'].unique().tolist()
        df = pd.read_parquet(
            path,
            columns=['executed_at', 'option_chain_id', 'price',
                     'canceled', 'nbbo_bid', 'nbbo_ask', 'size'],
            filters=[('option_chain_id', 'in', chains)],
        )
        if df['canceled'].dtype == bool:
            df = df[~df['canceled']]
        else:
            df = df[
                df['canceled'].astype(str).str.lower().isin(['f', 'false', '0', ''])
            ]
        df = df[df['price'] > 0]
        if df['executed_at'].dt.tz is None:
            df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
        df = df.sort_values(['option_chain_id', 'executed_at'], kind='stable')
        chain_idx = dict(iter(df.groupby('option_chain_id', sort=False)))

        minute_cache = {
            c: resample_minute_mid(g) for c, g in chain_idx.items()
        }

        flow_cache = {}
        cur = conn.cursor()
        for ticker in sub['underlying_symbol'].unique():
            for opt_type, col in [('C', 'net_call_prem'), ('P', 'net_put_prem')]:
                cur.execute(
                    f"""
                    SELECT ts, {col} FROM net_flow_per_ticker_history
                    WHERE ticker = %s
                      AND ts >= %s::timestamptz
                      AND ts <  %s::timestamptz + INTERVAL '1 day'
                    ORDER BY ts ASC
                    """,
                    (ticker, f'{date_str}T00:00:00Z', f'{date_str}T00:00:00Z'),
                )
                rows = []
                for ts, val in cur.fetchall():
                    if val is None:
                        continue
                    try:
                        v = float(val)
                    except (TypeError, ValueError):
                        continue
                    if np.isfinite(v):
                        rows.append((ts, v))
                flow_cache[(ticker, opt_type)] = rows

        cnt = 0
        for _, fire in sub.iterrows():
            chain_minutes = minute_cache.get(fire['option_chain_id'], [])
            if not chain_minutes:
                continue
            flow = flow_cache.get(
                (fire['underlying_symbol'], fire['option_type']), []
            )
            trigger_ts = fire['trigger_time_ct']
            if hasattr(trigger_ts, 'tz_localize') and trigger_ts.tz is None:
                trigger_ts = trigger_ts.tz_localize('UTC')
            if hasattr(trigger_ts, 'to_pydatetime'):
                trigger_ts = trigger_ts.to_pydatetime()
            inputs.append({
                'id': fire['id'],
                'date': date_str,
                'mode': fire['mode'],
                'minutes': chain_minutes,
                'flow': flow,
                'entry_price': float(fire['entry_price']),
                'trigger_ts': trigger_ts,
            })
            cnt += 1
        print(f'  [{date_str}] {len(sub):,} fires → {cnt:,} prepped')

    return pd.DataFrame(inputs)


# ============================================================
# Tuning
# ============================================================


def stats_for_returns(rs):
    rs = [r for r in rs if r is not None and np.isfinite(r)]
    n = len(rs)
    if n < 30:
        return n, np.nan, np.nan, np.nan, np.nan
    arr = np.array(rs)
    mean = arr.mean()
    med = float(np.median(arr))
    win = float((arr > 0).mean()) * 100
    std = arr.std(ddof=1) if n > 1 else 0.0
    sharpe = mean / std if std > 0 else 0.0
    return n, mean, med, win, sharpe


def evaluate_combo(inputs_subset, prom, win_min, per_min):
    rs = []
    for i in inputs_subset.itertuples(index=False):
        r = simulate(
            i.minutes, i.flow, i.entry_price, i.trigger_ts,
            prom, win_min, per_min,
        )
        rs.append(r)
    return rs, stats_for_returns(rs)


def latest_fire_date(conn) -> str:
    cur = conn.cursor()
    cur.execute(
        'SELECT MAX(date) FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL'
    )
    row = cur.fetchone()
    if row is None or row[0] is None:
        return 'unknown'
    return row[0].isoformat() if hasattr(row[0], 'isoformat') else str(row[0])[:10]


def main():
    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    out_path = (
        ROOT / 'docs' / 'tmp'
        / f'flow-inversion-tuning-{latest_fire_date(psycopg2.connect(db_url))}.md'
    )
    inputs = build_fire_inputs()
    print(f'\n[tune] {len(inputs):,} fire-inputs ready')

    dates_sorted = sorted(inputs['date'].unique())
    split_idx = int(len(dates_sorted) * 0.70)
    train_dates = set(dates_sorted[:split_idx])
    test_dates = set(dates_sorted[split_idx:])
    print(f'[tune] train: {sorted(train_dates)}')
    print(f'[tune] test:  {sorted(test_dates)}')

    inputs['split'] = inputs['date'].apply(
        lambda d: 'train' if d in train_dates else 'test'
    )

    lines = []
    lines.append('# Flow-inversion per-mode parameter tuning\n')
    lines.append(f'Dataset: {len(inputs):,} fires '
                 f'({len(train_dates)} train days, {len(test_dates)} test days)\n')
    lines.append(f'Frozen defaults: prom={DEFAULT_PROM}, '
                 f'window={DEFAULT_WINDOW}min, persist={DEFAULT_PERSIST}min\n')

    for mode, grid in [('A_intraday_0DTE', MODE_A_GRID),
                       ('B_multi_day_DTE1_3', MODE_B_GRID)]:
        lines.append(f'\n## {mode}\n')
        train_set = inputs[(inputs['mode'] == mode) & (inputs['split'] == 'train')]
        test_set = inputs[(inputs['mode'] == mode) & (inputs['split'] == 'test')]
        lines.append(f'Train n={len(train_set):,}  Test n={len(test_set):,}\n')

        _, def_train = evaluate_combo(train_set, DEFAULT_PROM, DEFAULT_WINDOW, DEFAULT_PERSIST)
        _, def_test = evaluate_combo(test_set, DEFAULT_PROM, DEFAULT_WINDOW, DEFAULT_PERSIST)
        lines.append(f'**Default** (prom={DEFAULT_PROM}, win={DEFAULT_WINDOW}, per={DEFAULT_PERSIST}):')
        lines.append(f'  train: n={def_train[0]:,} mean={def_train[1]:+.2f}% '
                     f'med={def_train[2]:+.2f}% win={def_train[3]:.1f}% '
                     f'Sharpe={def_train[4]:+.4f}')
        lines.append(f'  test:  n={def_test[0]:,} mean={def_test[1]:+.2f}% '
                     f'med={def_test[2]:+.2f}% win={def_test[3]:.1f}% '
                     f'Sharpe={def_test[4]:+.4f}')

        t0 = time.time()
        results = []
        for prom, win_min, per_min in grid:
            _, train_st = evaluate_combo(train_set, prom, win_min, per_min)
            results.append((prom, win_min, per_min, train_st))
        results.sort(key=lambda r: -r[3][4] if not np.isnan(r[3][4]) else 1)
        lines.append(f'\n{len(grid)} combos searched in {time.time() - t0:.1f}s. '
                     f'Top 10 by train Sharpe:\n')
        lines.append(f'    {"prom":>4} {"win":>3} {"per":>3}    {"n":>5} {"mean%":>7} {"med%":>7} {"win%":>5} {"Sharpe":>8}')
        for prom, w, p, st in results[:10]:
            lines.append(f'    {prom:>4} {w:>3} {p:>3}    {st[0]:>5,} {st[1]:>+6.2f}% {st[2]:>+6.2f}% {st[3]:>4.1f}% {st[4]:>+8.4f}')

        lines.append('\n**Held-out test (top-3 train picks):**\n')
        lines.append(f'    {"prom":>4} {"win":>3} {"per":>3}  | {"train Sharpe":>13} | {"test n":>6} {"test mean%":>10} {"test Sharpe":>11}')
        for prom, w, p, train_st in results[:3]:
            _, test_st = evaluate_combo(test_set, prom, w, p)
            lines.append(f'    {prom:>4} {w:>3} {p:>3}  | {train_st[4]:>+13.4f} | {test_st[0]:>6,} {test_st[1]:>+9.2f}% {test_st[4]:>+11.4f}')

        best = results[0]
        _, best_test = evaluate_combo(test_set, best[0], best[1], best[2])
        stable = abs(best[3][4] - best_test[4]) < 0.05
        lines.append(f'\nBest combo: prom={best[0]}, window={best[1]}, persist={best[2]}')
        lines.append(f'  Train Sharpe: {best[3][4]:+.4f}')
        lines.append(f'  Test  Sharpe: {best_test[4]:+.4f}')
        lines.append(f'  Default test Sharpe: {def_test[4]:+.4f}')
        lines.append(f'  Test mean lift over default: {best_test[1] - def_test[1]:+.2f}pp')
        lines.append(f'  Stable (|train−test| < 0.05)? {"YES" if stable else "NO — likely overfit"}')

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(lines))
    print('\n'.join(lines))
    print(f'\n[tune] report → {out_path}')


if __name__ == '__main__':
    main()
