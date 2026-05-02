"""Phase 27 — wider-grid + two-tier exit policy comparison.

Audit of p26 showed that the canonical trail_act30_trail10 captured only
+19.23% on the SNDK 1175C fire #4 (the +996% peak winner), because the
trail's 10pp drawdown rule trips on the first pullback.

Test wider grids and tiered exits to see if any policy can capture more
of the lottery upside without blowing up the loss tail.

Definitions (no silent metric drift):
  All policies are REALIZED EXIT RETURNS — % return at the exit point
  (or at last known price if no exit triggers).

  ABSOLUTE-pp trail variants (exit when current ≤ peak − N pp):
    a) act20_trail10  (loose activation, tight trail)
    b) act30_trail10  (CANONICAL — for reference)
    c) act30_trail15
    d) act30_trail25
    e) act50_trail15
    f) act50_trail25
    g) act100_trail50

  PERCENTAGE-of-peak trail variants (exit when current ≤ peak × (1 − P)):
    h) act30_pct_trail25  (exit when current < peak × 0.75)
    i) act50_pct_trail25
    j) act100_pct_trail33  (exit when current < peak × 0.67)

  GRACE-PERIOD variants (no trail-check for first N min after activation):
    k) act30_trail10_grace5  (5-min grace after activation)
    l) act30_trail15_grace5
    m) act50_trail25_grace5

  TWO-TIER variants (exit half size at first condition, second half at second):
    n) two_tier_25_thenTrail50_25  (50% off at +25%, 50% on act50/trail25)
    o) two_tier_25_thenHoldEoD     (50% off at +25%, 50% hold to EoD)
    p) two_tier_50_thenHoldEoD     (50% off at +50%, 50% hold to EoD)

  HARD STOPS (for context):
    q) hard_30m
    r) hold_to_eod

Slices: RE-LOAD vs not, mode A vs mode B.

Output: outputs/p27_policy_grid.csv (per-fire matrix)
        outputs/p27_policy_summary.csv (per-policy aggregates)
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


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


# ============================================================
# Policy implementations — each takes (prices, entry, ts_minutes)
# returns realized return % (e.g. +25.5)
# ============================================================
def trail_pp(prices: np.ndarray, entry: float, act: float, drop_pp: float) -> float:
    """Activate at +act%, exit when current drops drop_pp percentage points
    below running peak."""
    if entry <= 0 or len(prices) == 0:
        return 0.0
    rets = (prices - entry) / entry * 100.0
    activated = False
    peak = -np.inf
    for r in rets:
        if not activated:
            if r >= act:
                activated = True
                peak = r
        else:
            if r > peak:
                peak = r
            elif r <= peak - drop_pp:
                return float(r)
    return float(rets[-1])


def trail_pct(prices: np.ndarray, entry: float, act: float, drop_pct: float) -> float:
    """Activate at +act%, exit when current drops below peak × (1 − drop_pct/100).
    Note: this is multiplicative; needs prices not returns for the comparison."""
    if entry <= 0 or len(prices) == 0:
        return 0.0
    rets = (prices - entry) / entry * 100.0
    activated = False
    peak_ret = -np.inf
    peak_price = -np.inf
    threshold = (1 - drop_pct / 100.0)
    for i, r in enumerate(rets):
        if not activated:
            if r >= act:
                activated = True
                peak_ret = r
                peak_price = prices[i]
        else:
            if prices[i] > peak_price:
                peak_price = prices[i]
                peak_ret = r
            elif prices[i] <= peak_price * threshold:
                return float(r)
    return float(rets[-1])


def trail_pp_grace(prices: np.ndarray, entry: float, ts_min: np.ndarray,
                    act: float, drop_pp: float, grace_min: float) -> float:
    """Like trail_pp but suppress trail-exit for grace_min minutes after activation."""
    if entry <= 0 or len(prices) == 0:
        return 0.0
    rets = (prices - entry) / entry * 100.0
    activated = False
    peak = -np.inf
    activation_time = None
    for i, r in enumerate(rets):
        if not activated:
            if r >= act:
                activated = True
                peak = r
                activation_time = ts_min[i]
        else:
            if r > peak:
                peak = r
            elif r <= peak - drop_pp:
                # check grace
                if ts_min[i] - activation_time < grace_min:
                    continue  # don't exit yet
                return float(r)
    return float(rets[-1])


def two_tier(prices: np.ndarray, entry: float, ts_min: np.ndarray,
              tier1_pct: float, tier2_policy: str) -> float:
    """Exit 50% size at +tier1_pct% (first time threshold is hit).
    Exit remaining 50% under tier2_policy.
    Combined realized = (tier1_ret + tier2_ret) / 2 (equal sizing).

    tier2_policy can be:
      - 'hold_eod'         : hold remaining to last price
      - 'trail50_25_pp'    : trail with act 50, drop 25 pp
      - 'trail100_50_pp'   : trail with act 100, drop 50 pp"""
    if entry <= 0 or len(prices) == 0:
        return 0.0
    rets = (prices - entry) / entry * 100.0
    tier1_done = False
    tier1_ret = 0.0
    tier1_idx = -1
    for i, r in enumerate(rets):
        if r >= tier1_pct:
            tier1_done = True
            tier1_ret = float(r)
            tier1_idx = i
            break
    if not tier1_done:
        # neither tier filled → both halves ride to last price
        last_ret = float(rets[-1])
        return last_ret
    # second half: apply tier2 policy starting from tier1_idx
    rest_prices = prices[tier1_idx:]
    rest_ts = ts_min[tier1_idx:]
    if tier2_policy == 'hold_eod':
        tier2_ret = float(rets[-1])
    elif tier2_policy == 'trail50_25_pp':
        tier2_ret = trail_pp(rest_prices, entry, 50.0, 25.0)
    elif tier2_policy == 'trail100_50_pp':
        tier2_ret = trail_pp(rest_prices, entry, 100.0, 50.0)
    else:
        raise ValueError(f'unknown tier2 policy {tier2_policy}')
    return (tier1_ret + tier2_ret) / 2.0


def hard_time_stop(prices: np.ndarray, entry: float, ts_min: np.ndarray, stop_min: int) -> float:
    if entry <= 0 or len(prices) == 0:
        return 0.0
    mask = ts_min <= stop_min
    if not mask.any():
        return 0.0
    last_in = int(np.where(mask)[0][-1])
    return float((prices[last_in] - entry) / entry * 100.0)


def hold_to_eod(prices: np.ndarray, entry: float) -> float:
    if entry <= 0 or len(prices) == 0:
        return 0.0
    return float((prices[-1] - entry) / entry * 100.0)


def main():
    p26 = pd.read_csv(OUT / 'outputs' / 'p26_per_trade_realized.csv')
    p14 = pd.read_csv(OUT / 'outputs' / 'p14_event_triggers.csv',
                       parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    p14['date_str'] = p14['date'].dt.strftime('%Y-%m-%d')

    # Build lookup: (chain, date, alert_seq) -> entry_time
    p14_idx = p14.set_index(['option_chain_id', 'date_str', 'alert_seq'])
    print(f'Loaded {len(p26):,} fires from p26')

    # === Pull per-minute prices once, share across all policies ===
    print('\nPulling per-minute prices...')
    chains_by_day: dict[str, set[str]] = {}
    for d, ids in p26.groupby('date_str')['option_chain_id']:
        chains_by_day[d] = set(ids)

    prices_by_chain: dict[tuple[str, str], pd.DataFrame] = {}
    for f in sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet')):
        date_str = Path(f).name.replace('-trades.parquet', '')
        if date_str not in chains_by_day:
            continue
        target = chains_by_day[date_str]
        print(f'  {date_str}: {len(target)} chains', flush=True)
        df_p = pq.read_table(f, columns=COLS).to_pandas()
        df_p['canceled'] = _coerce_canceled(df_p['canceled'])
        df_p = df_p.loc[~df_p['canceled'] & (df_p['price'] > 0)]
        df_p['option_chain_id'] = df_p['option_chain_id'].astype(str)
        df_p = df_p.loc[df_p['option_chain_id'].isin(target)]
        df_p['ts_ct'] = df_p['executed_at'].dt.tz_convert('America/Chicago')
        for ch_id, g in df_p.groupby('option_chain_id'):
            prices_by_chain[(ch_id, date_str)] = g[['ts_ct', 'price']].sort_values('ts_ct').reset_index(drop=True)
    print(f'Loaded prices for {len(prices_by_chain):,} chain-days')

    # === Compute all policies per fire ===
    print('\nComputing policies per fire...')
    rows = []
    for i, fire in p26.iterrows():
        if i % 5000 == 0:
            print(f'  {i:,}/{len(p26):,}', flush=True)
        key = (fire['option_chain_id'], fire['date_str'])
        ch = prices_by_chain.get(key)
        if ch is None:
            continue
        try:
            p14_row = p14_idx.loc[(fire['option_chain_id'], fire['date_str'], int(fire['alert_seq']))]
        except KeyError:
            continue
        entry_time = pd.Timestamp(p14_row['entry_time_ct'])
        post = ch.loc[ch['ts_ct'] >= entry_time]
        if len(post) == 0:
            continue
        prices = post['price'].values
        entry = float(fire['entry_price'])
        ts_min = (post['ts_ct'].values - np.datetime64(entry_time)).astype('timedelta64[s]').astype(float) / 60.0

        rec = {
            'date_str': fire['date_str'],
            'option_chain_id': fire['option_chain_id'],
            'underlying_symbol': fire['underlying_symbol'],
            'mode': fire['mode'],
            'reload': bool(fire['reload']),
            'flow_quad': fire['flow_quad'],
            'tod': fire['tod'],
            'entry_price': entry,
            # Absolute-pp trails
            'act20_trail10': trail_pp(prices, entry, 20, 10),
            'act30_trail10': trail_pp(prices, entry, 30, 10),
            'act30_trail15': trail_pp(prices, entry, 30, 15),
            'act30_trail25': trail_pp(prices, entry, 30, 25),
            'act50_trail15': trail_pp(prices, entry, 50, 15),
            'act50_trail25': trail_pp(prices, entry, 50, 25),
            'act100_trail50': trail_pp(prices, entry, 100, 50),
            # Percentage-of-peak trails
            'act30_pct25': trail_pct(prices, entry, 30, 25),
            'act50_pct25': trail_pct(prices, entry, 50, 25),
            'act100_pct33': trail_pct(prices, entry, 100, 33),
            # Grace-period
            'act30_trail10_grace5': trail_pp_grace(prices, entry, ts_min, 30, 10, 5),
            'act30_trail15_grace5': trail_pp_grace(prices, entry, ts_min, 30, 15, 5),
            'act50_trail25_grace5': trail_pp_grace(prices, entry, ts_min, 50, 25, 5),
            # Two-tier
            'tier_25_holdEod': two_tier(prices, entry, ts_min, 25, 'hold_eod'),
            'tier_50_holdEod': two_tier(prices, entry, ts_min, 50, 'hold_eod'),
            'tier_25_then_t50_25': two_tier(prices, entry, ts_min, 25, 'trail50_25_pp'),
            'tier_25_then_t100_50': two_tier(prices, entry, ts_min, 25, 'trail100_50_pp'),
            # Hard
            'hard_30m': hard_time_stop(prices, entry, ts_min, 30),
            'hold_to_eod': hold_to_eod(prices, entry),
            # Peak ceiling for reference
            'peak_ceiling': float((prices.max() - entry) / entry * 100.0),
        }
        rows.append(rec)

    grid = pd.DataFrame(rows)
    grid.to_csv(OUT / 'outputs' / 'p27_policy_grid.csv', index=False)
    print(f'\nSaved per-fire grid: {len(grid):,}')

    # === Aggregate per policy, sliced by RE-LOAD ===
    policies = [
        'act20_trail10', 'act30_trail10', 'act30_trail15', 'act30_trail25',
        'act50_trail15', 'act50_trail25', 'act100_trail50',
        'act30_pct25', 'act50_pct25', 'act100_pct33',
        'act30_trail10_grace5', 'act30_trail15_grace5', 'act50_trail25_grace5',
        'tier_25_holdEod', 'tier_50_holdEod',
        'tier_25_then_t50_25', 'tier_25_then_t100_50',
        'hard_30m', 'hold_to_eod',
    ]

    def summary(s: pd.Series) -> dict:
        return {
            'n': len(s),
            'median': float(s.median()),
            'mean': float(s.mean()),
            'win_pct_above_0': float((s > 0).mean() * 100),
            'win_pct_above_25': float((s > 25).mean() * 100),
            'win_pct_above_50': float((s > 50).mean() * 100),
            'win_pct_above_100': float((s > 100).mean() * 100),
            'loss_pct_below_neg25': float((s < -25).mean() * 100),
            'loss_pct_below_neg50': float((s < -50).mean() * 100),
        }

    print('\n' + '=' * 130)
    print('=== POLICY COMPARISON — ALL TRADES ===')
    print('=' * 130)
    print(f'{"policy":<24s} {"n":>6s} {"median":>9s} {"mean":>9s} {"win>0":>8s} '
          f'{"≥+25%":>8s} {"≥+50%":>8s} {"≥+100%":>8s} {"<-25%":>8s} {"<-50%":>8s}')
    summary_rows = []
    for p in policies:
        s = grid[p]
        d = summary(s)
        d['policy'] = p
        d['slice'] = 'all'
        summary_rows.append(d)
        print(f'{p:<24s} {d["n"]:>6d} {d["median"]:>+8.1f}% {d["mean"]:>+8.1f}% '
              f'{d["win_pct_above_0"]:>7.1f}% {d["win_pct_above_25"]:>7.1f}% '
              f'{d["win_pct_above_50"]:>7.1f}% {d["win_pct_above_100"]:>7.1f}% '
              f'{d["loss_pct_below_neg25"]:>7.1f}% {d["loss_pct_below_neg50"]:>7.1f}%')

    print('\n' + '=' * 130)
    print('=== POLICY COMPARISON — RE-LOAD only (the lottery profile) ===')
    print('=' * 130)
    rl = grid.loc[grid['reload']]
    print(f'(n={len(rl):,} RE-LOAD trades)')
    print(f'{"policy":<24s} {"n":>6s} {"median":>9s} {"mean":>9s} {"win>0":>8s} '
          f'{"≥+25%":>8s} {"≥+50%":>8s} {"≥+100%":>8s} {"<-25%":>8s} {"<-50%":>8s}')
    for p in policies:
        s = rl[p]
        d = summary(s)
        d['policy'] = p
        d['slice'] = 'reload'
        summary_rows.append(d)
        print(f'{p:<24s} {d["n"]:>6d} {d["median"]:>+8.1f}% {d["mean"]:>+8.1f}% '
              f'{d["win_pct_above_0"]:>7.1f}% {d["win_pct_above_25"]:>7.1f}% '
              f'{d["win_pct_above_50"]:>7.1f}% {d["win_pct_above_100"]:>7.1f}% '
              f'{d["loss_pct_below_neg25"]:>7.1f}% {d["loss_pct_below_neg50"]:>7.1f}%')

    print('\n' + '=' * 130)
    print('=== POLICY COMPARISON — Mode A (0DTE intraday) ===')
    print('=' * 130)
    ma = grid.loc[grid['mode'] == 'A_intraday_0DTE']
    print(f'(n={len(ma):,})')
    print(f'{"policy":<24s} {"n":>6s} {"median":>9s} {"mean":>9s} {"win>0":>8s} '
          f'{"≥+25%":>8s} {"≥+50%":>8s} {"≥+100%":>8s} {"<-25%":>8s} {"<-50%":>8s}')
    for p in policies:
        s = ma[p]
        d = summary(s)
        d['policy'] = p
        d['slice'] = 'mode_A'
        summary_rows.append(d)
        print(f'{p:<24s} {d["n"]:>6d} {d["median"]:>+8.1f}% {d["mean"]:>+8.1f}% '
              f'{d["win_pct_above_0"]:>7.1f}% {d["win_pct_above_25"]:>7.1f}% '
              f'{d["win_pct_above_50"]:>7.1f}% {d["win_pct_above_100"]:>7.1f}% '
              f'{d["loss_pct_below_neg25"]:>7.1f}% {d["loss_pct_below_neg50"]:>7.1f}%')

    print('\n' + '=' * 130)
    print('=== POLICY COMPARISON — Mode B (DTE 1-3 stocks) ===')
    print('=' * 130)
    mb = grid.loc[grid['mode'] == 'B_multi_day_DTE1_3']
    print(f'(n={len(mb):,})')
    print(f'{"policy":<24s} {"n":>6s} {"median":>9s} {"mean":>9s} {"win>0":>8s} '
          f'{"≥+25%":>8s} {"≥+50%":>8s} {"≥+100%":>8s} {"<-25%":>8s} {"<-50%":>8s}')
    for p in policies:
        s = mb[p]
        d = summary(s)
        d['policy'] = p
        d['slice'] = 'mode_B'
        summary_rows.append(d)
        print(f'{p:<24s} {d["n"]:>6d} {d["median"]:>+8.1f}% {d["mean"]:>+8.1f}% '
              f'{d["win_pct_above_0"]:>7.1f}% {d["win_pct_above_25"]:>7.1f}% '
              f'{d["win_pct_above_50"]:>7.1f}% {d["win_pct_above_100"]:>7.1f}% '
              f'{d["loss_pct_below_neg25"]:>7.1f}% {d["loss_pct_below_neg50"]:>7.1f}%')

    # === Save summary ===
    sumdf = pd.DataFrame(summary_rows)
    sumdf.to_csv(OUT / 'outputs' / 'p27_policy_summary.csv', index=False)

    # === Spot check SNDK fire #4 with each policy ===
    print('\n' + '=' * 100)
    print('=== SNDK 1175C fire #4 spot check across policies ===')
    print('=' * 100)
    sndk = grid.loc[(grid['option_chain_id'] == 'SNDK260501C01175000')
                     & (grid['date_str'] == '2026-05-01')]
    if len(sndk) > 0:
        # Can't filter by alert_seq from grid — try first match for that chain on that day
        for p in policies + ['peak_ceiling']:
            print(f'  {p:<26s}: {sndk[p].iloc[0]:+.2f}%')


if __name__ == '__main__':
    main()
