"""Phase 30 — attach macro context features to RE-LOAD fires + re-run discriminator.

Loads:
  - outputs/p28_reload_with_features.csv (783 RE-LOAD fires)
  - outputs/macro_flow.csv (Market Tide, ETF Tide, per-ticker flow)
  - outputs/macro_spot_gex.csv (SPX spot exposures)
  - outputs/macro_strike_gex.csv (per-strike GEX with bid/ask vol for SPX/NDX/SPY/QQQ)

For each fire, attaches as of `trigger_time_ct`:
  POINT-IN-TIME (latest record at or before fire time):
    - market_tide_ncp, market_tide_npp, market_tide_net_call_minus_put
    - market_tide_otm_ncp, market_tide_otm_npp
    - spx_flow_ncp, spx_flow_npp
    - spy_etf_tide_ncp, spy_etf_tide_npp
    - qqq_etf_tide_ncp, qqq_etf_tide_npp
    - zero_dte_greek_flow_ncp, _npp
    - spx_spot_gamma_oi, spx_spot_gamma_vol, spx_spot_charm, spx_spot_vanna
  PER-STRIKE (only when alert ticker in [SPX, NDX, SPY, QQQ]):
    - strike_gex_call_minus_put_oi (sign of dealer gamma at the strike)
    - strike_gex_ask_minus_bid_call (call gamma being added by lifters vs hitters)
    - strike_gex_ask_minus_bid_put

Then runs lottery-discriminator analysis with these new features.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[1] / 'outputs'

INDEX_TICKERS = {'SPX', 'NDX', 'SPY', 'QQQ', 'SPXW', 'NDXP'}


def load_macro_flow():
    df = pd.read_csv(OUT / 'macro_flow.csv', parse_dates=['date', 'timestamp'])
    df['timestamp'] = df['timestamp'].dt.tz_convert('America/Chicago')
    return df


def load_macro_spot_gex():
    df = pd.read_csv(OUT / 'macro_spot_gex.csv', parse_dates=['date', 'timestamp'])
    df['timestamp'] = df['timestamp'].dt.tz_convert('America/Chicago')
    return df


def load_macro_strike_gex():
    df = pd.read_csv(OUT / 'macro_strike_gex.csv', parse_dates=['date', 'timestamp', 'expiry'])
    df['timestamp'] = df['timestamp'].dt.tz_convert('America/Chicago')
    return df


def asof_lookup(target_ts: pd.Timestamp, source_df: pd.DataFrame, ts_col: str = 'timestamp'):
    """Return latest source row at or before target_ts. Source must be sorted on ts_col."""
    arr = source_df[ts_col].values
    if len(arr) == 0:
        return None
    idx = np.searchsorted(arr, np.datetime64(target_ts), side='right') - 1
    if idx < 0:
        return None
    return source_df.iloc[idx]


def main():
    print('Loading inputs...')
    fires = pd.read_csv(OUT / 'p28_reload_with_features.csv',
                        parse_dates=['date_str'])
    # p28 dropped trigger_time_ct — merge it back from p14
    p14 = pd.read_csv(OUT / 'p14_event_triggers.csv',
                      parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    p14['date_str'] = p14['date'].dt.strftime('%Y-%m-%d')
    fires['date_str_match'] = fires['date_str'].dt.strftime('%Y-%m-%d')
    fires = fires.merge(
        p14[['option_chain_id', 'date_str', 'alert_seq', 'trigger_time_ct', 'entry_time_ct']],
        left_on=['option_chain_id', 'date_str_match', 'alert_seq'],
        right_on=['option_chain_id', 'date_str', 'alert_seq'],
        how='left',
        suffixes=('', '_p14'),
    ).drop(columns=['date_str_match', 'date_str_p14'])
    fires['trigger_time_ct'] = pd.to_datetime(fires['trigger_time_ct'])
    if fires['trigger_time_ct'].dt.tz is None:
        fires['trigger_time_ct'] = fires['trigger_time_ct'].dt.tz_localize('America/Chicago')
    else:
        fires['trigger_time_ct'] = fires['trigger_time_ct'].dt.tz_convert('America/Chicago')
    print(f'  {len(fires)} RE-LOAD fires (with trigger_time_ct merged)')
    n_missing = fires['trigger_time_ct'].isna().sum()
    if n_missing > 0:
        print(f'  ⚠️  {n_missing} fires missing trigger_time_ct after merge — dropping')
        fires = fires.dropna(subset=['trigger_time_ct'])

    flow = load_macro_flow()
    spot = load_macro_spot_gex()
    strike = load_macro_strike_gex()
    print(f'  {len(flow)} flow rows, {len(spot)} spot_gex rows, {len(strike)} strike_gex rows')

    # Pre-split flow_data by source for fast asof
    flow_by_source = {
        src: flow.loc[flow['source'] == src].sort_values('timestamp').reset_index(drop=True)
        for src in flow['source'].unique()
    }
    spot_sorted = spot.sort_values('timestamp').reset_index(drop=True)

    # For per-strike: build (ticker, expiry, strike) → time-sorted slice
    # Only build for tickers we care about; lazy lookup at fire-time
    strike_groups: dict[tuple[str, pd.Timestamp, float], pd.DataFrame] = {}

    print('\nAttaching macro features...')
    out_rows = []
    for i, fire in fires.iterrows():
        if i % 100 == 0:
            print(f'  {i}/{len(fires)}', flush=True)
        ts = pd.Timestamp(fire['trigger_time_ct'])
        rec = fire.to_dict()

        # ── Macro flow features ──
        for src, prefix in [
            ('market_tide', 'mkt_tide'),
            ('market_tide_otm', 'mkt_tide_otm'),
            ('spx_flow', 'spx_flow'),
            ('spy_flow', 'spy_flow'),
            ('qqq_flow', 'qqq_flow'),
            ('spy_etf_tide', 'spy_etf'),
            ('qqq_etf_tide', 'qqq_etf'),
            ('zero_dte_greek_flow', 'zero_dte'),
        ]:
            row = asof_lookup(ts, flow_by_source.get(src, pd.DataFrame()))
            if row is not None:
                ncp = float(row['ncp']) if pd.notna(row['ncp']) else 0.0
                npp = float(row['npp']) if pd.notna(row['npp']) else 0.0
                rec[f'{prefix}_ncp'] = ncp
                rec[f'{prefix}_npp'] = npp
                rec[f'{prefix}_diff'] = ncp - npp  # +ve = net call premium dominant
                rec[f'{prefix}_net_volume'] = row['net_volume'] if pd.notna(row['net_volume']) else 0
            else:
                rec[f'{prefix}_ncp'] = np.nan
                rec[f'{prefix}_npp'] = np.nan
                rec[f'{prefix}_diff'] = np.nan
                rec[f'{prefix}_net_volume'] = np.nan

        # ── SPX spot GEX (regime feature, applies to all tickers) ──
        spot_row = asof_lookup(ts, spot_sorted)
        if spot_row is not None:
            for c in ['price', 'gamma_oi', 'gamma_vol', 'gamma_dir',
                      'charm_oi', 'vanna_oi']:
                rec[f'spx_spot_{c}'] = float(spot_row[c]) if pd.notna(spot_row[c]) else np.nan
        else:
            for c in ['price', 'gamma_oi', 'gamma_vol', 'gamma_dir',
                      'charm_oi', 'vanna_oi']:
                rec[f'spx_spot_{c}'] = np.nan

        # ── Per-strike GEX (only for index/ETF tickers) ──
        sym = fire['underlying_symbol']
        # Map SPXW → SPX, NDXP → NDX for GEX lookup
        gex_ticker = {'SPXW': 'SPX', 'NDXP': 'NDX'}.get(sym, sym)
        if gex_ticker in INDEX_TICKERS:
            # Find the closest available strike (alert strike might be a 5-pt SPX, GEX has many)
            strike_target = float(fire['strike'])
            chain_id = fire.get('option_chain_id', '')
            # Heuristic: derive expiry from date — for 0DTE, expiry == date
            # For DTE 1-3, it's the chain's expiry. Without expiry parsing, take the
            # nearest strike on the SAME date (strike snapshots are date-only).
            same_day = strike.loc[
                (strike['ticker'] == gex_ticker)
                & (strike['date'].dt.date == ts.date())
            ]
            if len(same_day) > 0:
                # Find closest strike at the latest timestamp ≤ ts
                latest_ts_mask = same_day['timestamp'] <= ts
                if latest_ts_mask.any():
                    latest_ts = same_day.loc[latest_ts_mask, 'timestamp'].max()
                    snap = same_day.loc[same_day['timestamp'] == latest_ts]
                    if len(snap) > 0:
                        # Find row with strike closest to alert strike
                        snap = snap.iloc[(snap['strike'] - strike_target).abs().argsort()].head(1)
                        if len(snap) > 0:
                            r = snap.iloc[0]
                            call_gex = float(r['call_gamma_oi']) if pd.notna(r['call_gamma_oi']) else 0
                            put_gex = float(r['put_gamma_oi']) if pd.notna(r['put_gamma_oi']) else 0
                            rec['gex_strike_call_minus_put_oi'] = call_gex - put_gex
                            rec['gex_strike_net'] = call_gex + put_gex  # signed already
                            ca = float(r['call_gamma_ask']) if pd.notna(r['call_gamma_ask']) else 0
                            cb = float(r['call_gamma_bid']) if pd.notna(r['call_gamma_bid']) else 0
                            pa = float(r['put_gamma_ask']) if pd.notna(r['put_gamma_ask']) else 0
                            pb = float(r['put_gamma_bid']) if pd.notna(r['put_gamma_bid']) else 0
                            rec['gex_strike_call_ask_minus_bid'] = ca - cb
                            rec['gex_strike_put_ask_minus_bid'] = pa - pb
                            rec['gex_strike_actual_strike'] = float(r['strike'])
                            rec['gex_strike_underlying_price'] = float(r['price']) if pd.notna(r['price']) else np.nan

        out_rows.append(rec)

    out = pd.DataFrame(out_rows)
    out.to_csv(OUT / 'p30_reload_with_macro.csv', index=False)
    print(f'\nSaved → outputs/p30_reload_with_macro.csv ({len(out)} rows)')

    # ── Coverage diagnostic ──
    macro_cols = [c for c in out.columns if c.startswith(('mkt_tide', 'spx_flow', 'spy_flow',
                                                            'qqq_flow', 'spy_etf', 'qqq_etf',
                                                            'zero_dte', 'spx_spot', 'gex_strike'))]
    print(f'\nMacro feature attached to {len(out)} fires.')
    print(f'Total macro columns: {len(macro_cols)}')
    print(f'Per-strike GEX coverage (only index/ETF alerts): '
          f'{out["gex_strike_call_minus_put_oi"].notna().sum()} / {len(out)}')

    # ============================================================
    # DISCRIMINATOR ANALYSIS — what macro features predict lottery?
    # ============================================================
    print('\n' + '=' * 90)
    print('DISCRIMINATOR — does any macro feature predict lottery (≥+200% EoD peak)?')
    print('=' * 90)
    out['lottery'] = (out['hold_to_eod'] >= 200).astype(int)
    out['big_lottery'] = (out['hold_to_eod'] >= 500).astype(int)
    base = out['lottery'].mean() * 100
    base_big = out['big_lottery'].mean() * 100
    print(f'Baseline lottery rate: {base:.1f}%  big lottery: {base_big:.1f}%\n')

    print('--- Univariate quintile sweeps ---')
    candidate_features = [
        'mkt_tide_diff', 'mkt_tide_otm_diff', 'mkt_tide_net_volume',
        'spx_flow_diff', 'spy_flow_diff', 'qqq_flow_diff',
        'spy_etf_diff', 'qqq_etf_diff',
        'zero_dte_diff',
        'spx_spot_gamma_oi', 'spx_spot_gamma_vol', 'spx_spot_charm_oi', 'spx_spot_vanna_oi',
        'gex_strike_call_minus_put_oi', 'gex_strike_net',
        'gex_strike_call_ask_minus_bid', 'gex_strike_put_ask_minus_bid',
    ]
    for c in candidate_features:
        if c not in out.columns:
            continue
        s = out.dropna(subset=[c])
        if len(s) < 50:
            continue
        try:
            s = s.copy()
            s['_q'] = pd.qcut(s[c].rank(method='first'), 5, labels=['Q1','Q2','Q3','Q4','Q5'])
        except ValueError:
            continue
        agg = s.groupby('_q', observed=True).agg(
            n=('lottery', 'size'),
            median_val=(c, 'median'),
            lottery_pct=('lottery', lambda x: x.mean() * 100),
            big_lot_pct=('big_lottery', lambda x: x.mean() * 100),
            median_eod=('hold_to_eod', 'median'),
        )
        q5_lift = agg.loc['Q5', 'lottery_pct'] / base if base > 0 else 0
        q1_lift = agg.loc['Q1', 'lottery_pct'] / base if base > 0 else 0
        max_lift = max(q5_lift, q1_lift)
        flag = ' ★' if max_lift >= 1.8 else ''
        print(f'\n{c} (n={len(s)}, Q1 lift {q1_lift:.1f}x, Q5 lift {q5_lift:.1f}x){flag}')
        print(agg.round(2).to_string())

    # ── Combined call-side bullish-regime AND-rule ──
    print('\n' + '=' * 90)
    print('AND-RULES combining macro regime with cheap-call-PM filter')
    print('=' * 90)
    # Build core filter
    is_call_pm_cheap = ((out['option_type'] == 'call')
                         & (out['tod'] == 'PM')
                         & (out['entry_price'] < 1))
    # Bullish-regime variants
    bullish_thresh_options = [0, 100, 250, 500]
    rules = {
        'baseline (all RE-LOAD)': pd.Series(True, index=out.index),
        'cheap-call-PM (no macro)': is_call_pm_cheap,
    }
    for thresh in bullish_thresh_options:
        rules[f'cheap-call-PM AND mkt_tide_diff > {thresh}'] = (
            is_call_pm_cheap & (out['mkt_tide_diff'].fillna(-1e9) > thresh)
        )
        rules[f'cheap-call-PM AND mkt_tide_otm_diff > {thresh}'] = (
            is_call_pm_cheap & (out['mkt_tide_otm_diff'].fillna(-1e9) > thresh)
        )
    # SPX-flow-aligned rules
    rules['cheap-call-PM AND spx_flow_diff > 0'] = (
        is_call_pm_cheap & (out['spx_flow_diff'].fillna(-1e9) > 0)
    )
    rules['cheap-call-PM AND zero_dte_diff > 0'] = (
        is_call_pm_cheap & (out['zero_dte_diff'].fillna(-1e9) > 0)
    )
    rules['cheap-call-PM AND ALL of (mkt_tide, spx_flow, zero_dte) > 0'] = (
        is_call_pm_cheap
        & (out['mkt_tide_diff'].fillna(-1e9) > 0)
        & (out['spx_flow_diff'].fillna(-1e9) > 0)
        & (out['zero_dte_diff'].fillna(-1e9) > 0)
    )

    print(f'\n{"rule":<60s} {"n":>5s} {"lot %":>8s} {"big_lot %":>10s} {"lift":>6s} '
          f'{"med_eod%":>10s} {"mean_eod%":>11s}')
    for name, mask in rules.items():
        g = out.loc[mask.fillna(False)]
        if len(g) < 5:
            continue
        lot = g['lottery'].mean() * 100
        big_lot = g['big_lottery'].mean() * 100
        lift = lot / base if base > 0 else 0
        med = g['hold_to_eod'].median()
        mean = g['hold_to_eod'].mean()
        flag = ' ★' if lift >= 2 else ''
        print(f'{name:<60s} {len(g):>5d} {lot:>7.1f}% {big_lot:>9.1f}% '
              f'{lift:>5.1f}x {med:>+9.1f}% {mean:>+10.1f}%{flag}')

    # ── Realistic-trader test on the best new rule ──
    print('\n' + '=' * 90)
    print('REALISTIC-TRADER TEST: best new rule, top-N/day cherry-pick')
    print('=' * 90)
    best_macro_rule = (
        is_call_pm_cheap
        & (out['mkt_tide_diff'].fillna(-1e9) > 0)
        & (out['spx_flow_diff'].fillna(-1e9) > 0)
        & (out['zero_dte_diff'].fillna(-1e9) > 0)
    )
    g = out.loc[best_macro_rule].copy()
    g['date_only'] = g['date_str'].dt.strftime('%Y-%m-%d')
    print(f'Trades qualifying for best macro AND-rule: {len(g)} ({len(g)/15:.1f}/day avg)')
    if len(g) >= 5:
        for top_n in [1, 2, 3, 5]:
            cherry = g.sort_values(['date_only', 'entry_price']).groupby('date_only').head(top_n)
            for policy in ['act30_trail10', 'hard_30m', 'tier_50_holdEod', 'hold_to_eod']:
                s = cherry[policy]
                tot = s.sum()
                med = s.median()
                win = (s > 0).mean() * 100
                print(f'  top-{top_n} ({len(cherry):>3d} trades) {policy:<22s}: '
                      f'total ${tot:>+7.0f} median {med:>+6.1f}% win% {win:>5.1f}%')


if __name__ == '__main__':
    main()
