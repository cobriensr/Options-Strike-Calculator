#!/usr/bin/env python
"""Per-mode parameter tuning for the flow-inversion exit policy.

Searches a grid of (peak_prominence_ratio, slope_window_min,
neg_persist_min) per Mode (A_intraday_0DTE vs B_multi_day_DTE1_3) on
a train slice, picks the best combo by Sharpe, then validates on a
held-out test slice. Reports best params + train/test stability so we
can tell if a tuned combo is real edge vs overfit noise.

Read-only — does not modify the DB or production code.

A day whose archive file is missing is skipped with one line naming it, and
the skipped days are listed at the end. When no day had a file, the run says
so and exits 0; a run that read days but prepared no fire still exits
non-zero.

Usage:
    ml/.venv/Scripts/python scripts/tune_flow_inversion.py --parquet-dir <bot-eod-dir>

--parquet-dir is the Bot-EOD archive, the directory of
{date}-trades.parquet files (`make tune` passes the Makefile's PARQUET_DIR).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'

# Read each day's flow with the enrichment script's own loader, so the window
# is the one its values are written from (the tuning variants below stay here).
sys.path.insert(0, str(ROOT / 'scripts'))
from _cli_paths import (  # noqa: E402
    existing_dir,
    format_dates,
    warn_missing_archive,
)
from enrich_lottery_outcomes import load_matched_flow  # noqa: E402

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


def build_fire_inputs(
    parquet_dir: Path,
) -> tuple[pd.DataFrame, int, list[str]]:
    """The tuning inputs for every enriched fire whose day file is in
    `parquet_dir`, as (inputs, days_read, missing): the days with no file are
    skipped, each named on stdout and stderr, and listed in `missing`."""
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
    missing: list[str] = []
    days_read = 0
    for d, sub in fires.groupby('date', sort=True):
        date_str = d.isoformat() if hasattr(d, 'isoformat') else str(d)[:10]
        path = parquet_dir / f'{date_str}-trades.parquet'
        if not path.exists():
            warn_missing_archive(
                '[load]', date_str, path, f'{len(sub):,} fires not prepped'
            )
            missing.append(date_str)
            continue
        days_read += 1
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
        for ticker in sub['underlying_symbol'].unique():
            for opt_type in ('C', 'P'):
                flow_cache[(ticker, opt_type)] = load_matched_flow(
                    conn, date_str, ticker, opt_type
                )

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

    print(
        f'[load] {days_read} day(s) read, {len(missing)} day(s) skipped '
        'for a missing archive'
    )
    if missing:
        line = f'[load] skipped (archive missing): {format_dates(missing)}'
        print(line)
        print(line, file=sys.stderr)
    return pd.DataFrame(inputs), days_read, missing


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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--parquet-dir',
        type=existing_dir,
        required=True,
        help='Bot-EOD archive: the directory of {date}-trades.parquet files.',
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    out_path = (
        ROOT / 'docs' / 'tmp'
        / f'flow-inversion-tuning-{latest_fire_date(psycopg2.connect(db_url))}.md'
    )
    inputs, days_read, missing = build_fire_inputs(args.parquet_dir)
    if inputs.empty:
        if days_read == 0 and missing:
            # Missing archives are a skip, not a failure (owner rule
            # 2026-10-29): say so and let the caller carry on.
            print('[tune] no archive day to read — no report written')
            return
        sys.exit('[tune] no fire-inputs prepared — nothing to tune')
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
    if missing:
        lines.append(
            f'{len(missing)} day(s) skipped (archive missing): '
            f'{format_dates(missing)}. Their fires are not tuned on.\n'
        )
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
