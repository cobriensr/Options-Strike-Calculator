"""Phase 26 — canonical realized-exit re-run (replaces peak-ceiling tables).

PRIMARY METRIC for v5: realized return under trail_act30_trail10
  (activate trailing stop when peak ≥ +30%, exit when it drops 10% off peak)

Peak ceiling metrics are shown as a secondary "best-case" reference but
are explicitly labeled as such — NEVER as the primary win rate.

Scope: v3-style v4 set (DTE=0, V3 ticker list) AND extended-DTE set
(DTE ≤ 3, extended ticker list). Per-ticker, per-flow_quad, per-RE-LOAD
breakdowns under the canonical exit policy.

Outputs:
  outputs/p26_per_trade_realized.csv       — realized return per fire
  outputs/p26_per_ticker_summary.csv       — per-ticker realized table
  outputs/p26_per_setup_summary.csv        — per-setup (ticker × tod × side) table
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

# Local import — canonical metrics
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _metrics import (  # noqa: E402
    realized_exit_trail, realized_exit_hold_to_eod, realized_exit_hard_time_stop,
    peak_ceiling_pct, realized_summary, peak_summary,
)

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = ['executed_at', 'option_chain_id', 'price', 'size', 'canceled']

V3 = ['USAR', 'WMT', 'STX', 'SOUN', 'RIVN', 'TSM', 'SNDK', 'XOM', 'WDC', 'SQQQ',
      'NDXP', 'USO', 'TNA', 'RDDT', 'SMCI', 'TSLL', 'SNOW', 'TEAM', 'RKLB', 'SOFI',
      'RUTW', 'TSLA', 'SOXS', 'WULF', 'SLV', 'SMH', 'UBER', 'MSTR', 'TQQQ', 'RIOT',
      'SOXL', 'UNH', 'QQQ', 'RBLX']
EXTENDED = ['SPY', 'IWM', 'MU', 'META', 'AMD', 'NVDA', 'INTC', 'MSFT', 'AMZN',
            'PLTR', 'AVGO', 'GOOGL', 'GOOG', 'COIN', 'MSTR', 'HOOD', 'MRVL',
            'ORCL', 'AAPL']
ALL_TARGETS = sorted(set(V3 + EXTENDED))


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def main():
    df = pd.read_csv(OUT / 'outputs' / 'p14_event_triggers.csv',
                     parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    print(f'Loaded {len(df):,} v4 fires')

    # === Build the analysis universe ===
    # Mode A (intraday scalp, 0DTE): V3 list + SPY + IWM
    # Mode B (multi-day trend, DTE 1-3 + |moneyness|≤10%): EXTENDED stocks
    df['strike_pct_of_spot'] = (df['strike'] / df['spot_at_first'] - 1) * 100
    df['in_play'] = df['strike_pct_of_spot'].abs() <= 10
    df['hour'] = df['trigger_time_ct'].dt.hour + df['trigger_time_ct'].dt.minute / 60

    mode_a = df.loc[
        (df['underlying_symbol'].isin(V3 + ['SPY', 'IWM']))
        & (df['dte'] == 0)
        & (df['trigger_ask_pct'] >= 0.52)
    ].copy()
    mode_a['mode'] = 'A_intraday_0DTE'

    mode_b = df.loc[
        df['underlying_symbol'].isin([t for t in EXTENDED if t not in ('SPY', 'IWM')])
        & (df['dte'] <= 3) & (df['dte'] > 0)
        & (df['trigger_ask_pct'] >= 0.52)
        & df['in_play']
    ].copy()
    mode_b['mode'] = 'B_multi_day_DTE1_3'

    fires = pd.concat([mode_a, mode_b], ignore_index=True)
    fires = fires.sort_values(['date', 'option_chain_id', 'alert_seq']).reset_index(drop=True)
    print(f'Mode A (0DTE intraday): {len(mode_a):,}')
    print(f'Mode B (DTE 1-3 trend): {len(mode_b):,}')
    print(f'Combined fire universe: {len(fires):,}')

    # === RE-LOAD tag ===
    grp = fires.groupby(['date', 'option_chain_id'])
    fires['prev_window_size'] = grp['trigger_window_size'].shift(1)
    fires['prev_entry_price'] = grp['entry_price'].shift(1)
    fires['burst_ratio_vs_prev'] = fires['trigger_window_size'] / fires['prev_window_size']
    fires['entry_drop_pct_vs_prev'] = (
        (fires['entry_price'] - fires['prev_entry_price']) / fires['prev_entry_price'] * 100
    )
    fires['reload'] = ((fires['burst_ratio_vs_prev'] >= 2)
                      & (fires['entry_drop_pct_vs_prev'] <= -30)).fillna(False)
    fires['tod'] = fires['hour'].apply(lambda h:
        'AM_open' if h < 9.5 else 'MID' if h < 11.5 else 'LUNCH' if h < 12.5 else 'PM')
    fires['date_str'] = fires['date'].dt.strftime('%Y-%m-%d')

    # flow_quad
    def side(p):
        if p >= 0.60:
            return 'ask'
        if p <= 0.40:
            return 'bid'
        return 'mixed'
    fires['dominant_side'] = fires['trigger_ask_pct'].apply(side)
    fires['flow_quad'] = fires['option_type'] + '_' + fires['dominant_side']

    # === Pull per-minute prices ===
    print('\nPulling per-minute prices for all fires...')
    chains_by_day: dict[str, set[str]] = {}
    for d, ids in fires.groupby('date_str')['option_chain_id']:
        chains_by_day[d] = set(ids)

    prices_by_chain: dict[tuple[str, str], pd.DataFrame] = {}
    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        date_str = Path(f).name.replace('-trades.parquet', '')
        if date_str not in chains_by_day:
            continue
        target_chains = chains_by_day[date_str]
        print(f'  {date_str}: {len(target_chains)} chains', flush=True)
        df_p = pq.read_table(f, columns=COLS).to_pandas()
        df_p['canceled'] = _coerce_canceled(df_p['canceled'])
        df_p = df_p.loc[~df_p['canceled'] & (df_p['price'] > 0)]
        df_p['option_chain_id'] = df_p['option_chain_id'].astype(str)
        df_p = df_p.loc[df_p['option_chain_id'].isin(target_chains)]
        df_p['ts_ct'] = df_p['executed_at'].dt.tz_convert('America/Chicago')
        for ch_id, g in df_p.groupby('option_chain_id'):
            g_sorted = g[['ts_ct', 'price']].sort_values('ts_ct').reset_index(drop=True)
            prices_by_chain[(ch_id, date_str)] = g_sorted

    print(f'Loaded prices for {len(prices_by_chain):,} (chain, day) pairs')

    # === Compute realized exits for each fire ===
    print('\nComputing realized exits per fire...')
    rows = []
    for i, fire in fires.iterrows():
        if i % 5000 == 0:
            print(f'  {i:,} / {len(fires):,}', flush=True)
        key = (fire['option_chain_id'], fire['date_str'])
        ch_prices = prices_by_chain.get(key)
        if ch_prices is None:
            continue
        entry_time = pd.Timestamp(fire['entry_time_ct'])
        post = ch_prices.loc[ch_prices['ts_ct'] >= entry_time]
        if len(post) == 0:
            continue
        prices = post['price'].values
        ts_minutes = (post['ts_ct'].values - np.datetime64(entry_time)).astype(
            'timedelta64[s]').astype(float) / 60.0

        entry = float(fire['entry_price'])
        peak_pct = peak_ceiling_pct(prices, entry)
        # CANONICAL realized
        realized_trail = realized_exit_trail(prices, entry, 30.0, 10.0)
        realized_eod = realized_exit_hold_to_eod(prices, entry)
        realized_hard30 = realized_exit_hard_time_stop(prices, entry, ts_minutes, 30)

        rows.append({
            'date_str': fire['date_str'],
            'option_chain_id': fire['option_chain_id'],
            'underlying_symbol': fire['underlying_symbol'],
            'option_type': fire['option_type'],
            'flow_quad': fire['flow_quad'],
            'tod': fire['tod'],
            'mode': fire['mode'],
            'reload': bool(fire['reload']),
            'alert_seq': int(fire['alert_seq']),
            'entry_price': entry,
            'trigger_window_size': float(fire['trigger_window_size']),
            'realized_trail30_10_pct': realized_trail,
            'realized_hard30m_pct': realized_hard30,
            'realized_eod_pct': realized_eod,
            'peak_ceiling_pct': peak_pct,
        })

    out = pd.DataFrame(rows)
    out.to_csv(OUT / 'outputs' / 'p26_per_trade_realized.csv', index=False)
    print(f'Saved per-trade matrix: {len(out):,} rows')

    # === PRIMARY: per-ticker realized exit table ===
    print('\n' + '=' * 110)
    print('=== PER-TICKER REALIZED EXIT (trail_act30_trail10) — PRIMARY METRIC ===')
    print('=' * 110)
    print('Definition: realized return after activating trail at +30%, trailing 10% off peak.')
    print('"win%>0" = % positive realized exit. Peak ceiling shown for reference (NOT win rate).')
    print()
    print(f'{"ticker":<8s} {"mode":<22s} {"n":>5s} {"median%":>9s} {"mean%":>8s} '
          f'{"win%>0":>8s} {"≥+25%":>7s} {"≥+50%":>7s} {"<-25%":>7s} '
          f'{"peak≥2× [ceiling]":>20s}')
    summary_rows = []
    for (sym, mode), g in out.groupby(['underlying_symbol', 'mode']):
        if len(g) < 30:
            continue
        rs = realized_summary(g['realized_trail30_10_pct'], f'{sym}_{mode}')
        peak_ge_2x = (g['peak_ceiling_pct'] >= 100).mean() * 100
        peak_ge_5x = (g['peak_ceiling_pct'] >= 400).mean() * 100
        rs['peak_ge_2x'] = peak_ge_2x
        rs['peak_ge_5x'] = peak_ge_5x
        rs['ticker'] = sym
        rs['mode'] = mode
        summary_rows.append(rs)
        print(f'{sym:<8s} {mode:<22s} {rs["n"]:>5d} '
              f'{rs["median_pct"]:>+8.1f}% {rs["mean_pct"]:>+7.1f}% '
              f'{rs["win_pct_above_0"]:>7.1f}% '
              f'{rs["win_pct_above_25"]:>6.1f}% {rs["win_pct_above_50"]:>6.1f}% '
              f'{rs["loss_pct_below_neg25"]:>6.1f}% '
              f'{peak_ge_2x:>19.1f}%')

    sumdf = pd.DataFrame(summary_rows).sort_values('median_pct', ascending=False)
    sumdf.to_csv(OUT / 'outputs' / 'p26_per_ticker_summary.csv', index=False)

    # === Per-setup: ticker × side × tod, realized exit ===
    print('\n' + '=' * 110)
    print('=== PER-SETUP (ticker × flow_quad × tod) — REALIZED EXIT trail_act30_trail10 ===')
    print('=' * 110)
    print('Subsets ≥30 only. Sorted within ticker by median realized return.')
    setup_rows = []
    for (sym, fq, tod), g in out.groupby(['underlying_symbol', 'flow_quad', 'tod']):
        if len(g) < 30:
            continue
        rs = realized_summary(g['realized_trail30_10_pct'])
        rs['ticker'] = sym
        rs['flow_quad'] = fq
        rs['tod'] = tod
        rs['peak_ge_2x'] = (g['peak_ceiling_pct'] >= 100).mean() * 100
        setup_rows.append(rs)
    setup = pd.DataFrame(setup_rows)
    setup = setup.sort_values(['ticker', 'median_pct'], ascending=[True, False])
    setup.to_csv(OUT / 'outputs' / 'p26_per_setup_summary.csv', index=False)
    # Print only the top 5 setups per ticker
    print(f'\n{"ticker":<8s} {"flow_quad":<14s} {"tod":<10s} {"n":>5s} {"median%":>9s} '
          f'{"win%>0":>8s} {"≥+25%":>7s} {"≥+50%":>7s} {"<-25%":>7s} {"peak≥2×":>10s}')
    for sym, gs in setup.groupby('ticker'):
        for _, r in gs.head(5).iterrows():
            print(f'{r["ticker"]:<8s} {r["flow_quad"]:<14s} {r["tod"]:<10s} '
                  f'{int(r["n"]):>5d} {r["median_pct"]:>+8.1f}% '
                  f'{r["win_pct_above_0"]:>7.1f}% '
                  f'{r["win_pct_above_25"]:>6.1f}% {r["win_pct_above_50"]:>6.1f}% '
                  f'{r["loss_pct_below_neg25"]:>6.1f}% {r["peak_ge_2x"]:>9.1f}%')

    # === RE-LOAD impact under realized exit ===
    print('\n' + '=' * 110)
    print('=== RE-LOAD vs not — REALIZED EXIT trail_act30_trail10 ===')
    print('=' * 110)
    print(f'{"reload":<10s} {"n":>5s} {"median%":>9s} {"mean%":>8s} {"win%>0":>8s} '
          f'{"≥+25%":>7s} {"≥+50%":>7s} {"<-25%":>7s}')
    for tag, g in out.groupby('reload'):
        rs = realized_summary(g['realized_trail30_10_pct'])
        print(f'{"YES" if tag else "no":<10s} {rs["n"]:>5d} '
              f'{rs["median_pct"]:>+8.1f}% {rs["mean_pct"]:>+7.1f}% '
              f'{rs["win_pct_above_0"]:>7.1f}% '
              f'{rs["win_pct_above_25"]:>6.1f}% {rs["win_pct_above_50"]:>6.1f}% '
              f'{rs["loss_pct_below_neg25"]:>6.1f}%')

    # Per-mode RE-LOAD
    print('\n--- RE-LOAD × mode ---')
    print(f'{"reload":<10s} {"mode":<22s} {"n":>5s} {"median%":>9s} {"win%>0":>8s} '
          f'{"≥+25%":>7s} {"≥+50%":>7s}')
    for (tag, mode), g in out.groupby(['reload', 'mode']):
        rs = realized_summary(g['realized_trail30_10_pct'])
        print(f'{"YES" if tag else "no":<10s} {mode:<22s} {rs["n"]:>5d} '
              f'{rs["median_pct"]:>+8.1f}% {rs["win_pct_above_0"]:>7.1f}% '
              f'{rs["win_pct_above_25"]:>6.1f}% {rs["win_pct_above_50"]:>6.1f}%')

    print(f'\nSaved → outputs/p26_per_trade_realized.csv')
    print(f'Saved → outputs/p26_per_ticker_summary.csv')
    print(f'Saved → outputs/p26_per_setup_summary.csv')


if __name__ == '__main__':
    main()
