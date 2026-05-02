"""Phase 12 — methodical per-minute exit curve for PUT alerts.

Pulls minute-by-minute post-trigger price trajectory for every PUT
alert in v3, computes realized return at each minute checkpoint,
and tests hard-time-stop / trailing-stop / hybrid exit policies.

Definitions (stated explicitly — see feedback_no_silent_methodology_changes):
- "Return at minute M" = (price_at_M - entry_price) / entry_price * 100
  Point-in-time, NOT peak. Price at M = last trade in that minute bucket.
- "Win rate at M" = % of trades with return > 0 at M (point-in-time)
- "Median realized return under policy P" = 50th percentile of the realized
  exit return P would have produced for each trade
- All metrics are per CONTRACT (no fractional sizing)
- Scope: 741 PUT alerts (put_ask=375, put_bid=234, put_mixed=132)

Outputs:
- p12_put_exit_curve.csv  — per-trade per-minute return matrix
- p12_put_exit_summary.csv — aggregated curve (median, win rate, percentiles)
- p12_put_policy_comparison.csv — exit policy comparison table
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = ['executed_at', 'option_chain_id', 'price', 'size', 'canceled']

CHECKPOINTS = [1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 45, 60, 75, 90, 120, 150, 180]


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def main():
    # === Load PUT alerts only ===
    p11 = pd.read_csv(OUT / 'outputs' / 'p11_flow_classified.csv',
                      parse_dates=['date', 'trigger_time_ct'])
    puts = p11.loc[p11['option_type'] == 'put'].copy()
    puts['date_str'] = puts['date'].dt.strftime('%Y-%m-%d')
    print(f'PUT alerts to analyze: {len(puts):,}')
    print(f'  put_ask:   {(puts["flow_quad"]=="put_ask").sum()}')
    print(f'  put_bid:   {(puts["flow_quad"]=="put_bid").sum()}')
    print(f'  put_mixed: {(puts["flow_quad"]=="put_mixed").sum()}')

    chains_by_day: dict[str, set[str]] = {}
    for d, ids in puts.groupby('date_str')['option_chain_id']:
        chains_by_day[d] = set(ids)

    # === Pull post-trigger price trajectories ===
    print('\nExtracting post-trigger trajectories from parquets...')
    rows = []  # list of dicts: option_chain_id, date_str, m, price

    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        date_str = Path(f).name.replace('-trades.parquet', '')
        if date_str not in chains_by_day:
            continue
        target_chains = chains_by_day[date_str]
        print(f'  {date_str}: {len(target_chains)} chains', flush=True)

        df = pq.read_table(f, columns=COLS).to_pandas()
        df['canceled'] = _coerce_canceled(df['canceled'])
        df = df.loc[~df['canceled'] & (df['price'] > 0)]
        df['option_chain_id'] = df['option_chain_id'].astype(str)
        df = df.loc[df['option_chain_id'].isin(target_chains)]
        df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')

        day = puts.loc[puts['date_str'] == date_str].set_index('option_chain_id')
        for ch_id, g in df.groupby('option_chain_id'):
            if ch_id not in day.index:
                continue
            row = day.loc[ch_id]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            trig_time = pd.Timestamp(row['trigger_time_ct'])
            entry_price = float(row['entry_price'])
            if entry_price <= 0:
                continue
            # post-trigger only
            post = g.loc[g['ts_ct'] >= trig_time].copy()
            if len(post) == 0:
                continue
            # minute-of-life since trigger (0 = trigger minute)
            post['m'] = ((post['ts_ct'] - trig_time).dt.total_seconds() / 60).astype(int)
            # last price per minute bucket
            mins = post.groupby('m').agg(price=('price', 'last')).reset_index()
            for _, r in mins.iterrows():
                rows.append({
                    'option_chain_id': ch_id,
                    'date_str': date_str,
                    'm': int(r['m']),
                    'price': float(r['price']),
                    'entry_price': entry_price,
                })

    minutes = pd.DataFrame(rows)
    print(f'\nTotal minute-bars collected: {len(minutes):,}')

    # === Build per-trade per-checkpoint return matrix ===
    print('\nBuilding per-trade checkpoint return matrix...')
    # For each trade, forward-fill last known price across CHECKPOINTS
    matrix_rows = []
    for (ch_id, date_str), g in minutes.groupby(['option_chain_id', 'date_str']):
        entry = g['entry_price'].iloc[0]
        g_sorted = g.sort_values('m')
        # build a minute -> price map filled forward
        ret_at = {}
        last_known_price = entry  # before any post-trigger trade, treat as entry
        gi = iter(g_sorted.itertuples())
        cur = next(gi, None)
        for cp in CHECKPOINTS:
            # advance through any trades at or before cp
            while cur is not None and cur.m <= cp:
                last_known_price = cur.price
                cur = next(gi, None)
            ret_at[cp] = (last_known_price - entry) / entry * 100
        # also peak return within 180 min (sanity check)
        within = g_sorted.loc[g_sorted['m'] <= max(CHECKPOINTS)]
        peak_within = ((within['price'].max() - entry) / entry * 100) if len(within) else np.nan
        matrix_rows.append({
            'option_chain_id': ch_id,
            'date_str': date_str,
            'peak_within_180': peak_within,
            **{f'ret_m{cp}': ret_at[cp] for cp in CHECKPOINTS},
        })

    mat = pd.DataFrame(matrix_rows)
    print(f'Per-trade matrix: {len(mat):,} rows × {len(CHECKPOINTS)} checkpoints')

    # Merge back classification
    mat = mat.merge(
        puts[['option_chain_id', 'date_str', 'flow_quad', 'tod',
              'underlying_symbol', 'entry_price']],
        on=['option_chain_id', 'date_str'], how='left',
    )
    mat.to_csv(OUT / 'outputs' / 'p12_put_exit_curve.csv', index=False)

    # === Aggregate exit curve (overall + per quad × tod) ===
    print('\n' + '=' * 90)
    print('=== EXIT CURVE — ALL PUTS (point-in-time return at each minute checkpoint) ===')
    print('=' * 90)
    print(f'{"min":>5} {"n":>5} {"win%":>7} {"p25":>8} {"median":>8} {"p75":>8} {"mean":>8}')
    summary_rows = []
    for cp in CHECKPOINTS:
        col = f'ret_m{cp}'
        s = mat[col].dropna()
        n = len(s)
        win = (s > 0).mean() * 100
        p25 = s.quantile(0.25)
        med = s.median()
        p75 = s.quantile(0.75)
        mean = s.mean()
        print(f'{cp:>5d} {n:>5d} {win:>6.1f}% {p25:>+7.1f}% {med:>+7.1f}% {p75:>+7.1f}% {mean:>+7.1f}%')
        summary_rows.append({
            'subset': 'ALL_PUTS', 'minute': cp, 'n': n, 'win_pct': win,
            'p25': p25, 'median': med, 'p75': p75, 'mean': mean,
        })

    print('\n' + '=' * 90)
    print('=== EXIT CURVE — by flow_quad × tod (subsets ≥30 trades only) ===')
    print('=' * 90)
    for (quad, tod), g in mat.groupby(['flow_quad', 'tod']):
        if len(g) < 30:
            continue
        print(f'\n--- {quad} | {tod} (n={len(g)}) ---')
        print(f'{"min":>5} {"win%":>7} {"p25":>8} {"median":>8} {"p75":>8}')
        for cp in CHECKPOINTS:
            col = f'ret_m{cp}'
            s = g[col].dropna()
            if len(s) < 5:
                continue
            win = (s > 0).mean() * 100
            print(f'{cp:>5d} {win:>6.1f}% {g[col].quantile(0.25):>+7.1f}% '
                  f'{g[col].median():>+7.1f}% {g[col].quantile(0.75):>+7.1f}%')
            summary_rows.append({
                'subset': f'{quad}_{tod}', 'minute': cp, 'n': len(g),
                'win_pct': win, 'p25': g[col].quantile(0.25),
                'median': g[col].median(), 'p75': g[col].quantile(0.75),
                'mean': g[col].mean(),
            })

    pd.DataFrame(summary_rows).to_csv(
        OUT / 'outputs' / 'p12_put_exit_summary.csv', index=False)

    # === Policy comparison ===
    print('\n' + '=' * 90)
    print('=== POLICY COMPARISON — realized exit return per trade ===')
    print('=' * 90)
    print('Each policy is applied to the SAME 741 trades. Reports median realized')
    print('return, win rate (>0), and full distribution.')
    print()

    def hard_stop(row, m):
        return row[f'ret_m{m}']

    def trailing(g_minutes, entry, activation_pct, trail_pct):
        """Walk minute by minute; activate trail once peak ≥ activation_pct;
        exit when return drops trail_pct below trailing peak."""
        # g_minutes is the minutes DataFrame for this trade, sorted
        if len(g_minutes) == 0:
            return 0.0
        peak_ret = -np.inf
        activated = False
        for _, r in g_minutes.iterrows():
            ret = (r['price'] - entry) / entry * 100
            if not activated and ret >= activation_pct:
                activated = True
                peak_ret = ret
            elif activated:
                if ret > peak_ret:
                    peak_ret = ret
                elif ret <= peak_ret - trail_pct:
                    return ret  # exited
        # never exited via trail — return last known price's return
        last_ret = (g_minutes['price'].iloc[-1] - entry) / entry * 100
        return last_ret if activated else last_ret  # if never activated, hold to last

    # Pre-compute minutes-by-trade for trailing sims
    print('Pre-computing per-trade minute series for trailing sims...')
    minutes_sorted = minutes.sort_values(['option_chain_id', 'date_str', 'm'])
    by_trade = {
        (ch, ds): grp.reset_index(drop=True)
        for (ch, ds), grp in minutes_sorted.groupby(['option_chain_id', 'date_str'])
    }

    policies = []

    # 1) Hard time stops
    for m in [5, 10, 15, 20, 25, 30, 45, 60, 90, 120]:
        col = f'ret_m{m}'
        s = mat[col].dropna()
        policies.append({
            'policy': f'hard_stop_m{m}',
            'n': len(s),
            'median_ret': s.median(),
            'mean_ret': s.mean(),
            'win_pct': (s > 0).mean() * 100,
            'pct_neg10': (s < -10).mean() * 100,
            'pct_neg25': (s < -25).mean() * 100,
            'pct_pos25': (s >= 25).mean() * 100,
            'pct_pos50': (s >= 50).mean() * 100,
        })

    # 2) Trailing stops
    for activation in [10, 20, 30, 50]:
        for trail in [10, 15, 25]:
            results = []
            for (ch_id, date_str, entry) in zip(mat['option_chain_id'],
                                                  mat['date_str'],
                                                  mat['entry_price']):
                g = by_trade.get((ch_id, date_str))
                if g is None or len(g) == 0:
                    continue
                results.append(trailing(g, entry, activation, trail))
            s = pd.Series(results)
            policies.append({
                'policy': f'trail_act{activation}_trail{trail}',
                'n': len(s),
                'median_ret': s.median(),
                'mean_ret': s.mean(),
                'win_pct': (s > 0).mean() * 100,
                'pct_neg10': (s < -10).mean() * 100,
                'pct_neg25': (s < -25).mean() * 100,
                'pct_pos25': (s >= 25).mean() * 100,
                'pct_pos50': (s >= 50).mean() * 100,
            })

    # 3) Baselines: hold to peak (within 180), hold to last (=180min hard stop ish)
    s = mat['peak_within_180'].dropna()
    policies.append({
        'policy': 'hold_to_peak_180',
        'n': len(s),
        'median_ret': s.median(),
        'mean_ret': s.mean(),
        'win_pct': (s > 0).mean() * 100,
        'pct_neg10': (s < -10).mean() * 100,
        'pct_neg25': (s < -25).mean() * 100,
        'pct_pos25': (s >= 25).mean() * 100,
        'pct_pos50': (s >= 50).mean() * 100,
    })

    pol_df = pd.DataFrame(policies).sort_values('median_ret', ascending=False)
    pol_df.to_csv(OUT / 'outputs' / 'p12_put_policy_comparison.csv', index=False)

    print(f'\n{"policy":<28s} {"n":>5s} {"median":>8s} {"mean":>8s} '
          f'{"win%":>6s} {"<-10%":>7s} {"<-25%":>7s} {"≥+25%":>7s} {"≥+50%":>7s}')
    for _, r in pol_df.iterrows():
        print(f'{r["policy"]:<28s} {int(r["n"]):>5d} {r["median_ret"]:>+7.1f}% '
              f'{r["mean_ret"]:>+7.1f}% {r["win_pct"]:>5.1f}% '
              f'{r["pct_neg10"]:>6.1f}% {r["pct_neg25"]:>6.1f}% '
              f'{r["pct_pos25"]:>6.1f}% {r["pct_pos50"]:>6.1f}%')

    print(f'\nSaved → outputs/p12_put_exit_curve.csv')
    print(f'Saved → outputs/p12_put_exit_summary.csv')
    print(f'Saved → outputs/p12_put_policy_comparison.csv')


if __name__ == '__main__':
    main()
