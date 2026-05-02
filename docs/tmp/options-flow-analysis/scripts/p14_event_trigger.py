"""Phase 14 — v4 event-based trigger detector.

Replaces the v3 "first trigger only" + cumulative vol/OI design with an
event-based detector that fires every time fresh flow re-accelerates on a
chain. Captures continuation/re-accumulation moves like SNDK 1175C 5/1
(13:45 re-entry that v3 missed because v3 already fired on the same chain
at 08:58).

Methodology vs v3 (explicit — see feedback_no_silent_methodology_changes):
  * v3: cumulative vol/OI (running sum / OI) + first trigger per chain only
  * v4: WINDOWED vol/OI (last 5 min size sum / OI ≥ 0.05) AND cumulative
        vol/OI ≥ 0.10 as a context filter (chain has been active today),
        with a 5-min per-chain cooldown between fires
  * v3: same trigger criteria for IV, delta, ask% applied
  * v4: NO AM/lunch window filter (full session 08:30–15:00 CT)
  * v4: each fire tagged with alert_seq (1st, 2nd, 3rd... on this chain
        on this day) and minutes_since_prev_fire

Forward outcomes captured per fire:
  * future_max_30min      — peak price within 30 min of entry
  * future_max_to_eod     — peak price to end of session
  * realized_multiple_30  — future_max_30min / entry
  * realized_multiple_eod — future_max_to_eod / entry
  * minutes_to_peak_eod   — minutes from entry to future_max_to_eod
  * eod_price             — last print of session
  * eod_return_pct        — (eod_price - entry) / entry * 100

Output: outputs/p14_event_triggers.csv (one row per fire)
"""
from __future__ import annotations

import glob
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'
OUT = Path(__file__).resolve().parents[1]

SPEC_V4 = {
    'vol_to_oi_window_min': 0.05,   # 5% of OI in last 5 min (windowed)
    'vol_to_oi_cum_min': 0.10,      # chain context: ≥10% of OI today
    'iv_min': 0.35,
    'abs_delta_min': 0.13,
    'ask_pct_min': 0.52,
    'dte_max': 7,
    'cnt_window_min': 5,            # ≥5 prints in last 5 min
    'cooldown_min': 5,              # min minutes between fires on same chain
}
WINDOW_MIN = 5  # tighter window for event detection (vs v3's 10-min)
MIN_PRINTS = 100  # same as v3 for comparability
COLS = [
    'executed_at', 'underlying_symbol', 'option_chain_id', 'side',
    'option_type', 'expiry', 'strike', 'underlying_price', 'price', 'size',
    'open_interest', 'implied_volatility', 'delta', 'canceled',
]


def _coerce_canceled(s):
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def scan_chain_v4(g: pd.DataFrame, oi: float, dte: int) -> list[dict]:
    """Return all fires (with cooldown) for one chain on one day."""
    if dte > SPEC_V4['dte_max'] or oi <= 0:
        return []
    if len(g) < SPEC_V4['cnt_window_min']:
        return []

    g = g.sort_values('ts_ct').reset_index(drop=True)
    g = g.set_index('ts_ct', drop=False)

    is_ask = (g['side'] == 'ask').astype('int32')
    is_bid = (g['side'] == 'bid').astype('int32')

    win = f'{WINDOW_MIN}min'
    ask_sum = is_ask.rolling(win).sum()
    bid_sum = is_bid.rolling(win).sum()
    ab_sum = ask_sum + bid_sum
    ask_pct_w = ask_sum / ab_sum.where(ab_sum > 0, 1)
    iv_mean_w = g['implied_volatility'].rolling(win).mean()
    delta_mean_w = g['delta'].rolling(win).mean()
    cnt_w = g['price'].rolling(win).count()

    # Windowed vol (last 5 min size sum)
    vol_w = g['size'].rolling(win).sum()
    vol_to_oi_w = vol_w / oi

    # Cumulative as context
    cum_vol = g['size'].cumsum()
    vol_to_oi_cum = cum_vol / oi

    trigger = (
        (cnt_w >= SPEC_V4['cnt_window_min'])
        & (vol_to_oi_w >= SPEC_V4['vol_to_oi_window_min'])
        & (vol_to_oi_cum >= SPEC_V4['vol_to_oi_cum_min'])
        & (iv_mean_w >= SPEC_V4['iv_min'])
        & (delta_mean_w.abs() >= SPEC_V4['abs_delta_min'])
        & (ask_pct_w >= SPEC_V4['ask_pct_min'])
    )
    if not trigger.any():
        return []

    # Walk fires with cooldown
    fires = []
    last_fire_ts = None
    cooldown = pd.Timedelta(minutes=SPEC_V4['cooldown_min'])

    # Pre-compute the full-day forward max once (for to-eod outcomes)
    n = len(g)
    prices = g['price'].values
    timestamps = g['ts_ct'].values
    sizes = g['size'].values

    # Suffix max: max price from position i to end (vectorized)
    import numpy as np
    suffix_max = np.maximum.accumulate(prices[::-1])[::-1]

    for i in range(n):
        if not bool(trigger.iloc[i]):
            continue
        ts = pd.Timestamp(timestamps[i])
        if last_fire_ts is not None and (ts - last_fire_ts) < cooldown:
            continue

        # Entry = next print
        entry_pos = min(i + 1, n - 1)
        entry_price = float(prices[entry_pos])
        entry_time = pd.Timestamp(timestamps[entry_pos])
        if entry_price <= 0:
            continue

        # Forward windows
        # 30-min window: positions where ts <= entry_time + 30min
        end_30 = entry_time + pd.Timedelta(minutes=30)
        post_idx = entry_pos
        # find last index <= end_30 (linear is fine, n usually small per chain)
        max_30_pos = post_idx
        for j in range(entry_pos, n):
            if pd.Timestamp(timestamps[j]) > end_30:
                break
            if prices[j] > prices[max_30_pos]:
                max_30_pos = j
        future_max_30 = float(prices[max_30_pos])

        # To EoD
        future_max_eod = float(suffix_max[entry_pos])
        # Find time of EoD peak
        peak_eod_pos = entry_pos + int(prices[entry_pos:].argmax())
        peak_eod_time = pd.Timestamp(timestamps[peak_eod_pos])
        minutes_to_peak_eod = (peak_eod_time - entry_time).total_seconds() / 60

        # EoD price = last print of session
        eod_price = float(prices[-1])

        fires.append({
            'trigger_time_ct': pd.Timestamp(timestamps[i]),
            'entry_time_ct': entry_time,
            'entry_price': entry_price,
            'future_max_30min': future_max_30,
            'future_max_to_eod': future_max_eod,
            'realized_multiple_30': future_max_30 / max(entry_price, 0.01),
            'realized_multiple_eod': future_max_eod / max(entry_price, 0.01),
            'minutes_to_peak_eod': minutes_to_peak_eod,
            'eod_price': eod_price,
            'eod_return_pct': (eod_price - entry_price) / max(entry_price, 0.01) * 100,
            'trigger_vol_to_oi_window': float(vol_to_oi_w.iloc[i]),
            'trigger_vol_to_oi_cum': float(vol_to_oi_cum.iloc[i]),
            'trigger_iv': float(iv_mean_w.iloc[i]),
            'trigger_delta': float(delta_mean_w.iloc[i]),
            'trigger_ask_pct': float(ask_pct_w.iloc[i]),
            'trigger_window_prints': int(cnt_w.iloc[i]),
            'trigger_window_size': float(vol_w.iloc[i]),
        })
        last_fire_ts = ts

    # Tag alert_seq + minutes_since_prev_fire
    for k, fire in enumerate(fires):
        fire['alert_seq'] = k + 1
        fire['minutes_since_prev_fire'] = (
            (fire['trigger_time_ct'] - fires[k - 1]['trigger_time_ct']).total_seconds() / 60
            if k > 0 else 0.0
        )
    return fires


def process_day(f: str) -> pd.DataFrame:
    name = Path(f).name
    print(f'  {name}: loading...', flush=True)
    t = pq.read_table(f, columns=COLS)
    df = t.to_pandas()
    df['canceled'] = _coerce_canceled(df['canceled'])
    df = df.loc[~df['canceled'] & (df['price'] > 0)]
    for c in ['underlying_symbol', 'side', 'option_type', 'option_chain_id']:
        df[c] = df[c].astype(str)
    df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')
    df['date'] = df['ts_ct'].dt.date
    df['hour_min'] = df['ts_ct'].dt.hour * 60 + df['ts_ct'].dt.minute
    df = df.loc[(df['hour_min'] >= 510) & (df['hour_min'] < 900)]  # 08:30–15:00 CT
    if len(df) == 0:
        return pd.DataFrame()

    cnt = df.groupby('option_chain_id').size()
    keep = cnt.loc[cnt >= MIN_PRINTS].index
    df = df.loc[df['option_chain_id'].isin(keep)]
    if len(df) == 0:
        return pd.DataFrame()

    day = df['date'].iloc[0]
    print(f'  {name}: scanning {df["option_chain_id"].nunique():,} chains', flush=True)

    rows = []
    expiry_to_dte = {}
    for chain_id, g in df.groupby('option_chain_id'):
        oi = float(g['open_interest'].max())
        if pd.isna(oi):
            continue
        expiry = pd.Timestamp(g['expiry'].iloc[0]).date()
        if expiry not in expiry_to_dte:
            expiry_to_dte[expiry] = (expiry - day).days
        dte = expiry_to_dte[expiry]

        fires = scan_chain_v4(g, oi, dte)
        if not fires:
            continue
        meta = {
            'date': day,
            'option_chain_id': chain_id,
            'underlying_symbol': str(g['underlying_symbol'].iloc[0]),
            'option_type': str(g['option_type'].iloc[0]),
            'strike': float(g['strike'].iloc[0]),
            'expiry': expiry,
            'dte': dte,
            'open_interest': oi,
            'spot_at_first': float(g['underlying_price'].iloc[0]),
        }
        for fire in fires:
            rows.append({**meta, **fire})

    return pd.DataFrame(rows)


def main():
    files = sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet'))
    print(f'Processing {len(files)} parquet files...')
    parts = []
    for f in files:
        d = process_day(f)
        if not d.empty:
            parts.append(d)

    out = pd.concat(parts, ignore_index=True)
    out.to_csv(OUT / 'outputs' / 'p14_event_triggers.csv', index=False)
    print(f'\n=== Saved {len(out):,} fires across {out["option_chain_id"].nunique():,} chains ===')
    print(f'Output: outputs/p14_event_triggers.csv')

    # Quick descriptive summary
    print('\n=== Fires per chain distribution ===')
    fires_per_chain = out.groupby(['date', 'option_chain_id']).size()
    print(fires_per_chain.describe())
    print(f'\nFires per alert_seq (1=first fire on chain, 2=second, etc):')
    print(out['alert_seq'].value_counts().sort_index().head(15))


if __name__ == '__main__':
    main()
