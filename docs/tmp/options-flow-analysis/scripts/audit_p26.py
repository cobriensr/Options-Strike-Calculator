"""Audit p26 calculations against raw parquet data.

For a diverse sample of fires (winners/losers, different tickers/modes/setups),
re-derive every metric from scratch using ONLY the raw parquet + the trigger
metadata. Compare to the values stored in p26_per_trade_realized.csv. Print
any discrepancies.

Audited:
  1. peak_ceiling_pct = (max post-entry price - entry) / entry * 100
  2. realized_eod_pct = (last post-entry price - entry) / entry * 100
  3. realized_hard30m_pct = (price at last print ≤ +30 min - entry) / entry * 100
  4. realized_trail30_10_pct = activated trailing stop simulation
  5. RE-LOAD tag = (entry_drop ≤ -30% AND burst_ratio ≥ 2 vs prev fire)
  6. alert_seq monotonically increasing per (date, chain) starting at 1
  7. Per-ticker median realized_trail30_10_pct == p26_per_ticker_summary

Also sanity:
  - No null in critical columns
  - entry_price > 0
  - peak_ceiling_pct >= realized_eod_pct (peak should always >= EoD return,
    UNLESS chain only went down — then peak_ceiling = 0 and EoD < 0)
  - Total trade count matches what we expect from filters
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]
COLS = ['executed_at', 'option_chain_id', 'price', 'size', 'canceled']
TOL = 0.01  # 0.01% tolerance for floating-point comparisons


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def _trail_simulator(prices: np.ndarray, entry: float,
                      activation_pct: float = 30.0,
                      trail_pct: float = 10.0) -> float:
    """Independent re-implementation of the trail simulator (no shared code)
    to verify _metrics.realized_exit_trail."""
    if entry <= 0 or len(prices) == 0:
        return 0.0
    rets = (prices - entry) / entry * 100.0
    activated = False
    peak = -np.inf
    for r in rets:
        if not activated:
            if r >= activation_pct:
                activated = True
                peak = r
        else:
            if r > peak:
                peak = r
            elif r <= peak - trail_pct:
                return float(r)
    return float(rets[-1])


def fetch_chain_prices(date_str: str, chain_id: str) -> pd.DataFrame:
    f = f'{DATA_DIR}/{date_str}-trades.parquet'
    t = pq.read_table(f, columns=COLS)
    df = t.to_pandas()
    df['canceled'] = _coerce_canceled(df['canceled'])
    df = df.loc[~df['canceled'] & (df['price'] > 0)]
    df['option_chain_id'] = df['option_chain_id'].astype(str)
    df = df.loc[df['option_chain_id'] == chain_id]
    df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')
    return df.sort_values('ts_ct').reset_index(drop=True)


def main():
    p26 = pd.read_csv(OUT / 'outputs' / 'p26_per_trade_realized.csv',
                       parse_dates=['date_str'])
    p26['date_str'] = p26['date_str'].dt.strftime('%Y-%m-%d')
    p14 = pd.read_csv(OUT / 'outputs' / 'p14_event_triggers.csv',
                       parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    p14['date_str'] = p14['date'].dt.strftime('%Y-%m-%d')

    print('=' * 80)
    print('AUDIT 1: schema sanity')
    print('=' * 80)
    print(f'p26 rows: {len(p26):,}')
    print(f'p26 nulls per column:')
    nulls = p26.isnull().sum()
    print(nulls[nulls > 0].to_string() if (nulls > 0).any() else '  (none)')
    print(f'\nentry_price <= 0: {(p26["entry_price"] <= 0).sum()}')
    print(f'realized_trail30_10_pct out of [-100, 5000]: '
          f'{((p26["realized_trail30_10_pct"] < -100) | (p26["realized_trail30_10_pct"] > 5000)).sum()}')
    # Logical: peak ceiling should be >= each realized exit (peak is best-case)
    invariant_eod = (p26['peak_ceiling_pct'] >= p26['realized_eod_pct'] - 0.01).sum()
    invariant_hard = (p26['peak_ceiling_pct'] >= p26['realized_hard30m_pct'] - 0.01).sum()
    print(f'peak >= realized_eod (invariant should be 100%): '
          f'{invariant_eod}/{len(p26)} ({invariant_eod/len(p26)*100:.2f}%)')
    print(f'peak >= realized_hard30m: {invariant_hard}/{len(p26)} ({invariant_hard/len(p26)*100:.2f}%)')
    # Realized_eod_pct should match the original p14's eod_return_pct for the same fire
    # Sanity: median trailing return should be > median EoD (trail captures peaks)
    print(f'\nMedian realized_trail30_10_pct: {p26["realized_trail30_10_pct"].median():.2f}%')
    print(f'Median realized_hard30m_pct:    {p26["realized_hard30m_pct"].median():.2f}%')
    print(f'Median realized_eod_pct:        {p26["realized_eod_pct"].median():.2f}%')
    print(f'Median peak_ceiling_pct:        {p26["peak_ceiling_pct"].median():.2f}%')

    # ============================================================
    # AUDIT 2: Pick a diverse sample and verify against raw parquet
    # ============================================================
    print('\n' + '=' * 80)
    print('AUDIT 2: per-fire recomputation from raw parquet')
    print('=' * 80)

    # Diverse sample: winners, losers, different tickers/modes/scenarios
    samples = []
    # Famous SNDK 1175C fire #4 — the user's $0.30 → $14.25 trade (CT 14:48)
    samples.append(p26.loc[(p26['underlying_symbol']=='SNDK')
                            & (p26['date_str']=='2026-05-01')
                            & (p26['option_chain_id']=='SNDK260501C01175000')
                            & (p26['alert_seq']==4)])
    # SNDK 1170P 5/1 PM — total loss case from earlier sample
    samples.append(p26.loc[(p26['option_chain_id']=='SNDK260501P01170000')
                            & (p26['date_str']=='2026-05-01')
                            & (p26['alert_seq']==1)])
    # NDXP put_ask PM — known disaster cell
    ndxp = p26.loc[(p26['underlying_symbol']=='NDXP') & (p26['flow_quad']=='put_ask')
                   & (p26['tod']=='PM')]
    if len(ndxp) > 0:
        samples.append(ndxp.head(1))
    # AMZN call_mixed LUNCH — top realized cell
    amzn = p26.loc[(p26['underlying_symbol']=='AMZN') & (p26['flow_quad']=='call_mixed')
                   & (p26['tod']=='LUNCH')]
    if len(amzn) > 0:
        samples.append(amzn.head(1))
    # QQQ call_mixed AM — high-win cell
    qqq = p26.loc[(p26['underlying_symbol']=='QQQ') & (p26['flow_quad']=='call_mixed')
                   & (p26['tod']=='AM_open')]
    if len(qqq) > 0:
        samples.append(qqq.head(1))
    # IWM call_ask AM — known dud
    iwm = p26.loc[(p26['underlying_symbol']=='IWM') & (p26['flow_quad']=='call_ask')
                   & (p26['tod']=='AM_open')]
    if len(iwm) > 0:
        samples.append(iwm.head(1))
    # SOXL 129P 5/1 PM alert_seq 11 — large peak/EoD divergence example
    soxl = p26.loc[(p26['option_chain_id']=='SOXL260501P00129000')
                   & (p26['date_str']=='2026-05-01')
                   & (p26['alert_seq']==11)]
    if len(soxl) > 0:
        samples.append(soxl)
    # A RE-LOAD tagged fire
    rl = p26.loc[p26['reload']]
    if len(rl) > 0:
        samples.append(rl.head(1))

    discrepancies = []
    for sdf in samples:
        if len(sdf) == 0:
            continue
        for _, r in sdf.iterrows():
            chain = r['option_chain_id']
            date = r['date_str']
            entry = float(r['entry_price'])
            seq = int(r['alert_seq'])
            print(f'\n--- {chain} {date} fire #{seq} ---')
            print(f'  Stored: entry=${entry:.4f} '
                  f'trail30_10={r["realized_trail30_10_pct"]:+.4f}% '
                  f'hard30m={r["realized_hard30m_pct"]:+.4f}% '
                  f'eod={r["realized_eod_pct"]:+.4f}% '
                  f'peak={r["peak_ceiling_pct"]:+.4f}% '
                  f'reload={r["reload"]}')

            # Look up the trigger time from p14
            p14_row = p14.loc[(p14['option_chain_id']==chain) & (p14['date_str']==date)
                              & (p14['alert_seq']==seq)]
            if len(p14_row) == 0:
                print('  ! No matching p14 row — SKIP')
                continue
            entry_time_p14 = pd.Timestamp(p14_row['entry_time_ct'].iloc[0])

            # Pull raw chain prices
            chain_prices = fetch_chain_prices(date, chain)
            post = chain_prices.loc[chain_prices['ts_ct'] >= entry_time_p14].copy()
            if len(post) == 0:
                print('  ! No post-entry prints — SKIP')
                continue
            prices = post['price'].values

            # Recompute each metric
            peak = float((prices.max() - entry) / entry * 100)
            eod = float((prices[-1] - entry) / entry * 100)

            # Hard 30-min
            ts = post['ts_ct'].values
            mins_after = (ts - np.datetime64(entry_time_p14)).astype('timedelta64[s]').astype(float) / 60
            mask30 = mins_after <= 30
            if mask30.any():
                last30_idx = int(np.where(mask30)[0][-1])
                hard30 = float((prices[last30_idx] - entry) / entry * 100)
            else:
                hard30 = 0.0

            # Trail simulator
            trail = _trail_simulator(prices, entry, 30.0, 10.0)

            # RE-LOAD tag
            prev_fire = p14.loc[(p14['option_chain_id']==chain) & (p14['date_str']==date)
                                & (p14['alert_seq']==seq-1)]
            if len(prev_fire) > 0:
                prev_burst = float(prev_fire['trigger_window_size'].iloc[0])
                prev_entry = float(prev_fire['entry_price'].iloc[0])
                cur_burst = float(p14_row['trigger_window_size'].iloc[0])
                burst_ratio = cur_burst / prev_burst if prev_burst > 0 else float('nan')
                entry_drop = (entry - prev_entry) / prev_entry * 100 if prev_entry > 0 else float('nan')
                expected_reload = (burst_ratio >= 2) and (entry_drop <= -30)
            else:
                expected_reload = False
                burst_ratio = None
                entry_drop = None

            print(f'  Recomputed: trail={trail:+.4f}% hard30={hard30:+.4f}% '
                  f'eod={eod:+.4f}% peak={peak:+.4f}% reload={expected_reload}')
            if burst_ratio is not None:
                print(f'    (RE-LOAD inputs: burst_ratio={burst_ratio:.2f}, '
                      f'entry_drop={entry_drop:.2f}%)')

            # Diff
            diffs = []
            for label, stored, recomputed in [
                ('trail30_10', r['realized_trail30_10_pct'], trail),
                ('hard30m', r['realized_hard30m_pct'], hard30),
                ('eod', r['realized_eod_pct'], eod),
                ('peak', r['peak_ceiling_pct'], peak),
            ]:
                if abs(stored - recomputed) > TOL:
                    diffs.append(f'{label}: stored={stored:.4f} vs recomputed={recomputed:.4f} '
                                 f'(Δ={stored - recomputed:+.4f})')
            if r['reload'] != expected_reload:
                diffs.append(f'reload: stored={r["reload"]} vs recomputed={expected_reload}')
            if diffs:
                print(f'  ❌ DISCREPANCIES:')
                for d in diffs:
                    print(f'      {d}')
                discrepancies.append((chain, date, seq, diffs))
            else:
                print(f'  ✓ All match within tolerance ({TOL}%)')

    # ============================================================
    # AUDIT 3: Per-ticker aggregation cross-check
    # ============================================================
    print('\n' + '=' * 80)
    print('AUDIT 3: per-ticker median realized_trail vs p26_per_ticker_summary')
    print('=' * 80)
    ts = pd.read_csv(OUT / 'outputs' / 'p26_per_ticker_summary.csv')
    print(f'{"ticker":<8s} {"mode":<22s} {"stored_n":>8s} {"recomp_n":>8s} '
          f'{"stored_median":>13s} {"recomp_median":>13s} {"Δ":>10s}')
    bad = 0
    for _, r in ts.iterrows():
        recomp = p26.loc[(p26['underlying_symbol']==r['ticker']) & (p26['mode']==r['mode']),
                         'realized_trail30_10_pct']
        rn = len(recomp)
        rmed = recomp.median() if rn > 0 else 0.0
        diff = rmed - r['median_pct']
        flag = '❌' if (rn != r['n']) or (abs(diff) > TOL) else ' '
        if flag == '❌':
            bad += 1
        print(f'{r["ticker"]:<8s} {r["mode"]:<22s} {int(r["n"]):>8d} {rn:>8d} '
              f'{r["median_pct"]:>+12.4f}% {rmed:>+12.4f}% {diff:>+9.4f} {flag}')
    print(f'\nAggregation discrepancies: {bad}')

    # ============================================================
    # AUDIT 4: alert_seq monotonicity and continuity
    # ============================================================
    print('\n' + '=' * 80)
    print('AUDIT 4: alert_seq monotonicity per (date, chain)')
    print('=' * 80)
    seq_check = p26.sort_values(['date_str', 'option_chain_id', 'alert_seq'])
    bad_seq = 0
    for (d, ch), g in seq_check.groupby(['date_str', 'option_chain_id']):
        seqs = g['alert_seq'].values
        # Should start at 1 (some chains may be missing seq=1 if first fire was filtered out
        # by mode A vs B routing — fine — but within p26 they should still be monotonic)
        if not (np.diff(seqs) > 0).all():
            bad_seq += 1
    print(f'Chains with non-monotonic alert_seq in p26 subset: {bad_seq}')
    print('(Some chains may not start at 1 because filters dropped earlier fires — this is expected)')

    # ============================================================
    # SUMMARY
    # ============================================================
    print('\n' + '=' * 80)
    print('AUDIT SUMMARY')
    print('=' * 80)
    if discrepancies:
        print(f'❌ {len(discrepancies)} per-fire discrepancies found:')
        for chain, date, seq, diffs in discrepancies:
            print(f'  {chain} {date} fire {seq}: {len(diffs)} mismatched columns')
    else:
        print('✓ All per-fire spot checks match within tolerance')
    print(f'  Aggregation mismatches: {bad}')
    print(f'  Non-monotonic alert_seq chains: {bad_seq}')


if __name__ == '__main__':
    main()
