"""
Forensic on the 2026-05-18 SPXW 7475C $0.05 -> $100 move.

Goal: characterize whether the pattern Wonce observed live (counter-trend MM
gamma reposition at one strike + concurrent lopsided BTO at OTM strikes) is
detectable in the historical scraped Periscope snapshots + UW Bot-Eod parquet
options tape. No production rules; exploratory only.

Inputs:
  - periscope_snapshots (Neon): 41 slices on 5/18, gamma/charm/vanna panels
  - index_candles_1m (Neon): SPX 1-min OHLC for the trading day
  - ~/Desktop/Bot-Eod-parquet/2026-05-18-trades.parquet: full options tape with
    UW-classified side (bid/ask/mid/no_side) and per-trade open_interest.

Outputs (docs/tmp/forensic-2026-05-18/):
  - periscope_events.csv: per-strike per-slice events (sign flips, mag jumps)
  - flow_per_strike_bucket.csv: 5-min bucketed flow per strike with side mix +
    OI delta + inferred BTO/STO/BTC/STC.
  - events_with_flow.csv: each Periscope event joined to concurrent strike
    flow and prior-window spot direction.
  - plot_01_spot_with_events.png: SPX 1m chart with sign-flip markers.
  - plot_02_gamma_heatmap.png: strike x time gamma surface.
  - plot_03_strike_flow_panels.png: per-strike flow side mix over the day.
  - plot_04_wonce_window.png: 18:00-19:30 UTC detailed multi-panel.
  - findings.md: narrative writeup.
"""
from __future__ import annotations

import os
from datetime import date
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2
import pyarrow.parquet as pq
from dotenv import load_dotenv

load_dotenv('.env.local')

OUT = Path('docs/tmp/forensic-2026-05-18')
OUT.mkdir(parents=True, exist_ok=True)
PARQUET = '/Users/charlesobrien/Desktop/Bot-Eod-parquet/2026-05-18-trades.parquet'
EXPIRY = date(2026, 5, 18)

# 18:00-19:30 UTC = 13:00-14:30 CT = Wonce's accumulation+rip window
WONCE_START = pd.Timestamp('2026-05-18 18:00', tz='UTC')
WONCE_END = pd.Timestamp('2026-05-18 19:30', tz='UTC')


def db():
    return psycopg2.connect(os.environ['DATABASE_URL_UNPOOLED'])


def load_periscope() -> pd.DataFrame:
    """All Periscope panels for expiry 2026-05-18, all slices, all strikes."""
    with db() as conn:
        df = pd.read_sql(
            """
            SELECT captured_at, panel, strike, value, timeframe
            FROM periscope_snapshots
            WHERE expiry = '2026-05-18'
            ORDER BY captured_at, panel, strike
            """,
            conn,
        )
    df['captured_at'] = pd.to_datetime(df['captured_at'], utc=True)
    df['strike'] = df['strike'].astype(float)
    df['value'] = df['value'].astype(float)
    return df


def load_spot() -> pd.DataFrame:
    with db() as conn:
        df = pd.read_sql(
            """
            SELECT timestamp, open, high, low, close
            FROM index_candles_1m
            WHERE symbol = 'SPX'
              AND timestamp >= '2026-05-18'
              AND timestamp < '2026-05-19'
            ORDER BY timestamp
            """,
            conn,
        )
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    for c in ['open', 'high', 'low', 'close']:
        df[c] = df[c].astype(float)
    return df.set_index('timestamp')


def load_flow(strike_lo=7300.0, strike_hi=7500.0) -> pd.DataFrame:
    tbl = pq.read_table(
        PARQUET,
        filters=[
            ('underlying_symbol', '=', 'SPXW'),
            ('expiry', '=', EXPIRY),
            ('option_type', '=', 'call'),
            ('strike', '>=', strike_lo),
            ('strike', '<=', strike_hi),
        ],
        columns=[
            'executed_at', 'option_chain_id', 'side', 'strike',
            'underlying_price', 'nbbo_bid', 'nbbo_ask', 'price', 'size',
            'premium', 'open_interest', 'delta', 'gamma', 'implied_volatility',
        ],
    )
    df = tbl.to_pandas().sort_values('executed_at').reset_index(drop=True)
    df['executed_at'] = pd.to_datetime(df['executed_at'], utc=True)
    return df


def detect_periscope_events(periscope: pd.DataFrame, panel: str,
                            mag_pct_of_day: float = 0.10) -> pd.DataFrame:
    """For a single panel, compute slice-over-slice deltas per strike and flag
    events. Returns one row per (strike, captured_at) where event fired.
    """
    sub = periscope[periscope['panel'] == panel].copy()
    day_max_abs = float(sub['value'].abs().max())
    threshold = mag_pct_of_day * day_max_abs

    events: list[dict] = []
    for strike, g in sub.groupby('strike'):
        g = g.sort_values('captured_at').reset_index(drop=True)
        g['prior'] = g['value'].shift(1)
        g['prior_ts'] = g['captured_at'].shift(1)
        g['delta'] = g['value'] - g['prior']
        # Sign flip = prior and current have opposite signs, both nonzero,
        # and current magnitude >= 10% of day max (avoids noise on tiny strikes).
        g['sign_flip'] = (
            g['prior'].notna()
            & (np.sign(g['value']) != np.sign(g['prior']))
            & (g['value'].abs() >= 0.10 * day_max_abs)
            & (g['prior'].abs() >= 0.10 * day_max_abs)
        )
        g['mag_jump'] = g['delta'].abs() >= threshold
        for _, row in g[g['sign_flip'] | g['mag_jump']].iterrows():
            events.append({
                'captured_at': row['captured_at'],
                'prior_ts': row['prior_ts'],
                'panel': panel,
                'strike': float(strike),
                'prior': float(row['prior']) if pd.notna(row['prior']) else None,
                'latest': float(row['value']),
                'delta': float(row['delta']) if pd.notna(row['delta']) else None,
                'sign_flip': bool(row['sign_flip']),
                'mag_jump': bool(row['mag_jump']),
                'day_max_abs': day_max_abs,
                'threshold_used': threshold,
            })
    return pd.DataFrame(events)


def spot_direction(spot: pd.DataFrame, ts: pd.Timestamp,
                   lookback_min: int = 10) -> dict:
    """Return spot direction over the (ts - lookback, ts) window."""
    start = ts - pd.Timedelta(minutes=lookback_min)
    win = spot.loc[start:ts]
    if len(win) < 2:
        return {'spot_start': None, 'spot_end': None, 'spot_delta': None,
                'spot_dir': None}
    s, e = float(win['close'].iloc[0]), float(win['close'].iloc[-1])
    d = e - s
    return {'spot_start': s, 'spot_end': e, 'spot_delta': d,
            'spot_dir': 'up' if d > 0 else 'down' if d < 0 else 'flat'}


def bucket_flow(flow: pd.DataFrame, freq: str = '5min') -> pd.DataFrame:
    """5-min buckets per strike with side mix + OI delta + inferred open/close."""
    df = flow.copy()
    df['bucket'] = df['executed_at'].dt.floor(freq)

    # Per (bucket, strike, side) aggregates
    side_agg = (
        df.groupby(['bucket', 'strike', 'side'])
        .agg(trades=('size', 'count'), contracts=('size', 'sum'),
             premium=('premium', 'sum'))
        .reset_index()
    )
    side_piv = side_agg.pivot_table(
        index=['bucket', 'strike'], columns='side',
        values=['contracts', 'premium'], fill_value=0,
    )
    side_piv.columns = [f'{a}_{b}' for a, b in side_piv.columns]
    side_piv = side_piv.reset_index()

    # Per (bucket, strike) totals + OI evolution + spot snapshot
    tot = (
        df.groupby(['bucket', 'strike'])
        .agg(
            total_trades=('size', 'count'),
            total_contracts=('size', 'sum'),
            total_premium=('premium', 'sum'),
            oi_first=('open_interest', 'first'),
            oi_last=('open_interest', 'last'),
            oi_min=('open_interest', 'min'),
            oi_max=('open_interest', 'max'),
            px_first=('price', 'first'),
            px_last=('price', 'last'),
            px_min=('price', 'min'),
            px_max=('price', 'max'),
            spot_first=('underlying_price', 'first'),
            spot_last=('underlying_price', 'last'),
            iv_mean=('implied_volatility', 'mean'),
            delta_mean=('delta', 'mean'),
            gamma_mean=('gamma', 'mean'),
        )
        .reset_index()
    )
    out = side_piv.merge(tot, on=['bucket', 'strike'])

    # Ensure all side columns exist
    for col in ['contracts_ask', 'contracts_bid', 'contracts_mid',
                'contracts_no_side', 'premium_ask', 'premium_bid',
                'premium_mid', 'premium_no_side']:
        if col not in out.columns:
            out[col] = 0

    out['ask_pct'] = out['contracts_ask'] / out['total_contracts'].clip(lower=1)
    out['bid_pct'] = out['contracts_bid'] / out['total_contracts'].clip(lower=1)
    out['mid_pct'] = out['contracts_mid'] / out['total_contracts'].clip(lower=1)
    out['oi_delta'] = out['oi_last'] - out['oi_first']

    # OI-delta-inferred open/close attribution:
    #   side=ask + OI up   -> BTO (aggressive buy opens)
    #   side=ask + OI down -> BTC (aggressive buy closes short)
    #   side=bid + OI up   -> STO (aggressive sell opens)
    #   side=bid + OI down -> STC (aggressive sell closes long)
    # When OI delta == 0 (snapshot didn't change), attribute by side only:
    #   side=ask -> BTO, side=bid -> STC (assume retail/dealer netting).
    oi_pos = out['oi_delta'] > 0
    oi_neg = out['oi_delta'] < 0
    out['bto'] = np.where(oi_pos | (out['oi_delta'] == 0),
                          out['contracts_ask'], 0)
    out['btc'] = np.where(oi_neg, out['contracts_ask'], 0)
    out['sto'] = np.where(oi_pos, out['contracts_bid'], 0)
    out['stc'] = np.where(oi_neg | (out['oi_delta'] == 0),
                          out['contracts_bid'], 0)
    out['net_open'] = out['bto'] + out['sto'] - out['btc'] - out['stc']

    return out.sort_values(['bucket', 'strike']).reset_index(drop=True)


def cross_reference(events: pd.DataFrame, flow_buckets: pd.DataFrame,
                    spot: pd.DataFrame, freq: str = '5min') -> pd.DataFrame:
    """Join each Periscope event to flow at the SAME strike in the matching
    5-min bucket, plus spot direction in the 10 min prior to the event.

    Also add: did flow accumulate at OTM strikes 20-100 pts beyond the event
    strike (the lottery zone) in the 30 min following the event?
    """
    rows: list[dict] = []
    for _, ev in events.iterrows():
        ts = ev['captured_at']
        bucket = ts.floor(freq)
        # Flow at the event strike during the same 5-min bucket
        at_strike = flow_buckets[(flow_buckets['bucket'] == bucket)
                                 & (flow_buckets['strike'] == ev['strike'])]
        sd = spot_direction(spot, ts, lookback_min=10)
        rec = ev.to_dict()
        rec.update(sd)
        if len(at_strike):
            r = at_strike.iloc[0]
            rec.update({
                'flow_contracts': int(r['total_contracts']),
                'flow_premium': float(r['total_premium']),
                'flow_ask_pct': float(r['ask_pct']),
                'flow_bid_pct': float(r['bid_pct']),
                'flow_mid_pct': float(r['mid_pct']),
                'flow_bto': int(r['bto']),
                'flow_stc': int(r['stc']),
                'flow_net_open': int(r['net_open']),
                'flow_oi_delta': int(r['oi_delta']),
                'px_first': float(r['px_first']),
                'px_last': float(r['px_last']),
                'spot_at_event': float(r['spot_last']),
            })
        else:
            rec.update({k: None for k in [
                'flow_contracts', 'flow_premium', 'flow_ask_pct',
                'flow_bid_pct', 'flow_mid_pct', 'flow_bto', 'flow_stc',
                'flow_net_open', 'flow_oi_delta', 'px_first', 'px_last',
                'spot_at_event',
            ]})

        # Lottery zone: was there BTO accumulation 20-100 pts above strike
        # in the 30 min following the event?
        next_30_end = ts + pd.Timedelta(minutes=30)
        lottery_band = flow_buckets[
            (flow_buckets['bucket'] >= bucket)
            & (flow_buckets['bucket'] <= next_30_end)
            & (flow_buckets['strike'] > ev['strike'] + 20)
            & (flow_buckets['strike'] <= ev['strike'] + 100)
        ]
        if len(lottery_band):
            rec.update({
                'lottery_zone_bto_total': int(lottery_band['bto'].sum()),
                'lottery_zone_stc_total': int(lottery_band['stc'].sum()),
                'lottery_zone_net_open': int(lottery_band['net_open'].sum()),
                'lottery_zone_contracts': int(
                    lottery_band['total_contracts'].sum()),
                'lottery_zone_premium': float(
                    lottery_band['total_premium'].sum()),
                'lottery_zone_max_px_top_strike': float(
                    lottery_band.groupby('strike')['px_max'].max().max()),
            })
        else:
            rec.update({k: None for k in [
                'lottery_zone_bto_total', 'lottery_zone_stc_total',
                'lottery_zone_net_open', 'lottery_zone_contracts',
                'lottery_zone_premium', 'lottery_zone_max_px_top_strike',
            ]})
        rows.append(rec)
    return pd.DataFrame(rows)


# --------------------------- PLOTS ----------------------------------------

def plot_spot_with_events(spot: pd.DataFrame, events: pd.DataFrame,
                          out_path: Path):
    fig, ax = plt.subplots(figsize=(15, 6))
    spot_rth = spot.loc['2026-05-18 13:30:00+00':'2026-05-18 20:05:00+00']
    ax.plot(spot_rth.index, spot_rth['close'], color='#222', lw=1.2,
            label='SPX 1m close')
    # Sign flips overlay
    flips = events[events['sign_flip'] & (events['panel'] == 'gamma')]
    for _, r in flips.iterrows():
        color = 'red' if r['prior'] is not None and r['prior'] > 0 else 'green'
        ax.axvline(r['captured_at'], color=color, alpha=0.20, lw=1)
    # Wonce window
    ax.axvspan(WONCE_START, WONCE_END, alpha=0.08, color='orange',
               label='Wonce 18:00-19:30 UTC')
    ax.set_title('SPX 1-min + Periscope gamma sign-flip overlays (2026-05-18)')
    ax.set_ylabel('SPX')
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%H:%M', tz='UTC'))
    ax.legend(loc='lower left')
    ax.grid(alpha=0.3)
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_gamma_heatmap(periscope: pd.DataFrame, out_path: Path):
    g = periscope[periscope['panel'] == 'gamma'].copy()
    piv = g.pivot_table(index='strike', columns='captured_at', values='value',
                        aggfunc='mean')
    # Only show strikes 7250-7500 for clarity
    piv = piv.loc[(piv.index >= 7250) & (piv.index <= 7500)]
    fig, ax = plt.subplots(figsize=(15, 8))
    vmax = float(piv.abs().max().max())
    im = ax.imshow(
        piv.values, aspect='auto', cmap='RdGy_r',
        vmin=-vmax, vmax=vmax,
        extent=[mdates.date2num(piv.columns.min().to_pydatetime()),
                mdates.date2num(piv.columns.max().to_pydatetime()),
                float(piv.index.min()), float(piv.index.max())],
        origin='lower',
    )
    ax.axhline(7380, color='blue', lw=0.7, ls='--', alpha=0.5,
               label='Wonce reposition strike (7380)')
    ax.axhline(7475, color='magenta', lw=0.7, ls='--', alpha=0.5,
               label='Lottery rip strike (7475)')
    ax.axvspan(mdates.date2num(WONCE_START.to_pydatetime()),
               mdates.date2num(WONCE_END.to_pydatetime()),
               alpha=0.10, color='orange')
    ax.xaxis_date()
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%H:%M', tz='UTC'))
    ax.set_title('Periscope gamma per strike across the day (2026-05-18)')
    ax.set_ylabel('Strike')
    ax.legend(loc='upper right')
    fig.colorbar(im, ax=ax, label='Gamma')
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_strike_flow_panels(flow_buckets: pd.DataFrame, strikes: list[float],
                            out_path: Path):
    n = len(strikes)
    fig, axes = plt.subplots(n, 1, figsize=(15, 2.8 * n), sharex=True)
    if n == 1:
        axes = [axes]
    for ax, k in zip(axes, strikes):
        sub = flow_buckets[flow_buckets['strike'] == k].copy()
        sub = sub.sort_values('bucket')
        x = sub['bucket'].dt.to_pydatetime()
        ax.bar(x, sub['contracts_ask'], width=0.003,
               color='#1f77b4', label='ask-side', align='edge')
        ax.bar(x, sub['contracts_bid'], width=0.003,
               bottom=sub['contracts_ask'], color='#ff7f0e',
               label='bid-side', align='edge')
        ax.bar(x, sub['contracts_mid'], width=0.003,
               bottom=sub['contracts_ask'] + sub['contracts_bid'],
               color='#888', label='mid', align='edge')
        ax.set_title(f'SPXW {int(k)}C 0DTE — 5-min vol by side')
        ax.set_ylabel('Contracts')
        ax.axvspan(WONCE_START.to_pydatetime(), WONCE_END.to_pydatetime(),
                   alpha=0.06, color='orange')
        ax.grid(alpha=0.3)
    axes[0].legend(loc='upper left')
    axes[-1].xaxis.set_major_formatter(mdates.DateFormatter('%H:%M', tz='UTC'))
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_wonce_window(periscope: pd.DataFrame, flow_buckets: pd.DataFrame,
                      spot: pd.DataFrame, out_path: Path):
    """4-panel zoom: SPX spot, gamma at 7375-7385, flow at 7400/7450/7475,
    OI delta at lottery strikes."""
    fig, axes = plt.subplots(4, 1, figsize=(14, 14), sharex=True)

    # 1. Spot
    win = spot.loc[WONCE_START:WONCE_END]
    axes[0].plot(win.index, win['close'], color='#222', lw=1.5)
    axes[0].set_title('SPX 1m close (18:00-19:30 UTC)')
    axes[0].set_ylabel('SPX')
    axes[0].grid(alpha=0.3)

    # 2. Gamma evolution at the reposition zone 7375-7385
    g = periscope[(periscope['panel'] == 'gamma')
                  & (periscope['captured_at'] >= WONCE_START
                     - pd.Timedelta(minutes=20))
                  & (periscope['captured_at'] <= WONCE_END
                     + pd.Timedelta(minutes=10))]
    for k in [7375, 7380, 7385, 7400, 7450, 7475]:
        gk = g[g['strike'] == k].sort_values('captured_at')
        if len(gk):
            axes[1].plot(gk['captured_at'], gk['value'], marker='o', lw=1.5,
                         label=f'{k}')
    axes[1].axhline(0, color='k', lw=0.5)
    axes[1].set_title('Periscope gamma per strike (zoom)')
    axes[1].set_ylabel('Gamma')
    axes[1].legend(loc='upper right', ncol=3)
    axes[1].grid(alpha=0.3)

    # 3. Per-strike flow: stacked bars by side for 7400, 7450, 7475
    for k, color in [(7400, '#1f77b4'), (7450, '#2ca02c'), (7475, '#d62728')]:
        sub = flow_buckets[(flow_buckets['strike'] == k)
                           & (flow_buckets['bucket'] >= WONCE_START)
                           & (flow_buckets['bucket'] <= WONCE_END)]
        if len(sub):
            axes[2].plot(sub['bucket'], sub['total_contracts'], marker='o',
                         lw=1.5, color=color, label=f'{int(k)}C vol')
    axes[2].set_title('Per-strike total vol per 5-min bucket')
    axes[2].set_ylabel('Contracts')
    axes[2].legend(loc='upper left')
    axes[2].grid(alpha=0.3)

    # 4. OI delta at lottery strikes
    for k, color in [(7400, '#1f77b4'), (7450, '#2ca02c'), (7475, '#d62728')]:
        sub = flow_buckets[(flow_buckets['strike'] == k)
                           & (flow_buckets['bucket'] >= WONCE_START)
                           & (flow_buckets['bucket'] <= WONCE_END)]
        if len(sub):
            axes[3].plot(sub['bucket'], sub['oi_delta'].cumsum(), marker='s',
                         lw=1.5, color=color, label=f'{int(k)}C cum OI delta')
    axes[3].set_title('Cumulative OI delta per strike (positive = net opens)')
    axes[3].set_ylabel('Cum OI delta')
    axes[3].axhline(0, color='k', lw=0.5)
    axes[3].legend(loc='upper left')
    axes[3].grid(alpha=0.3)

    axes[-1].xaxis.set_major_formatter(mdates.DateFormatter('%H:%M', tz='UTC'))
    fig.autofmt_xdate()
    fig.suptitle('Wonce window 18:00-19:30 UTC: spot, gamma, flow, OI deltas',
                 y=1.0)
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def write_findings(periscope_events: pd.DataFrame,
                   cross_ref: pd.DataFrame,
                   flow_buckets: pd.DataFrame,
                   spot: pd.DataFrame,
                   out_path: Path) -> None:
    lines: list[str] = []
    lines.append('# Forensic: 2026-05-18 7475C $0.05 -> $100 — pattern detectability\n')

    # Periscope summary
    g_events = periscope_events[periscope_events['panel'] == 'gamma']
    sf = g_events[g_events['sign_flip']]
    mj = g_events[g_events['mag_jump']]
    lines.append('## Periscope gamma events (whole day)\n')
    lines.append(f'- Total slices: {periscope_events["captured_at"].nunique()}')
    lines.append(f'- Distinct strikes with events: {g_events["strike"].nunique()}')
    lines.append(f'- Sign-flip events: {len(sf)}')
    lines.append(f'- Magnitude-jump events (>=10% of day max abs): {len(mj)}')
    if len(sf):
        sf_table = sf[['captured_at', 'strike', 'prior', 'latest']].head(20)
        lines.append('\n### First 20 sign flips:\n')
        lines.append(sf_table.to_string(index=False))

    # Wonce window
    wonce_events = g_events[(g_events['captured_at'] >= WONCE_START
                             - pd.Timedelta(minutes=20))
                            & (g_events['captured_at'] <= WONCE_END)]
    lines.append('\n## Events inside Wonce window (17:40-19:30 UTC)\n')
    lines.append(f'Count: {len(wonce_events)}')
    if len(wonce_events):
        cols = ['captured_at', 'strike', 'prior', 'latest',
                'sign_flip', 'mag_jump']
        lines.append(wonce_events[cols].to_string(index=False))

    # Cross-reference snapshot
    cr_w = cross_ref[(cross_ref['captured_at'] >= WONCE_START
                      - pd.Timedelta(minutes=20))
                     & (cross_ref['captured_at'] <= WONCE_END)
                     & (cross_ref['panel'] == 'gamma')]
    lines.append('\n## Cross-referenced events in Wonce window\n')
    lines.append('Columns: time | strike | sign_flip | mag_jump | '
                 'spot_dir | flow_contracts | flow_ask% | bto@strike | '
                 'lottery_zone_bto (20-100pt OTM, next 30min)\n')
    if len(cr_w):
        for _, r in cr_w.iterrows():
            ask_pct = (f"{r['flow_ask_pct']:.2f}"
                       if pd.notna(r['flow_ask_pct']) else 'na')
            spot_delta = (f"{r['spot_delta']:+.1f}"
                          if pd.notna(r['spot_delta']) else 'na')
            vol = (f"{int(r['flow_contracts'])}"
                   if pd.notna(r['flow_contracts']) else 'na')
            bto = (f"{int(r['flow_bto'])}"
                   if pd.notna(r['flow_bto']) else 'na')
            lzb = (f"{int(r['lottery_zone_bto_total'])}"
                   if pd.notna(r['lottery_zone_bto_total']) else 'na')
            lines.append(
                f"{r['captured_at']:%H:%M} | k={int(r['strike'])} | "
                f"flip={int(r['sign_flip'])} | jump={int(r['mag_jump'])} | "
                f"spot={r['spot_dir']} ({spot_delta}) | "
                f"vol={vol} | ask%={ask_pct} | "
                f"bto={bto} | lott_bto={lzb}")

    # Specific 7475C and 7380C rip-window breakdown
    lines.append('\n## 7475C SPXW 0DTE 18:00-19:30 UTC — the rip strike\n')
    rip = flow_buckets[(flow_buckets['strike'] == 7475)
                       & (flow_buckets['bucket'] >= WONCE_START)
                       & (flow_buckets['bucket'] <= WONCE_END)]
    if len(rip):
        cols = ['bucket', 'total_contracts', 'ask_pct', 'bid_pct', 'mid_pct',
                'oi_delta', 'bto', 'stc', 'net_open', 'px_first', 'px_last',
                'spot_first', 'spot_last']
        lines.append(rip[cols].to_string(index=False))

    lines.append('\n## 7380C SPXW 0DTE 18:00-19:30 UTC — the Periscope strike\n')
    rep = flow_buckets[(flow_buckets['strike'] == 7380)
                       & (flow_buckets['bucket'] >= WONCE_START)
                       & (flow_buckets['bucket'] <= WONCE_END)]
    if len(rep):
        cols = ['bucket', 'total_contracts', 'ask_pct', 'bid_pct', 'mid_pct',
                'oi_delta', 'bto', 'stc', 'net_open', 'px_first', 'px_last',
                'spot_first', 'spot_last']
        lines.append(rep[cols].to_string(index=False))

    out_path.write_text('\n'.join(lines))


def main():
    print('Loading periscope_snapshots...')
    periscope = load_periscope()
    print(f'  {len(periscope):,} rows; '
          f'{periscope["captured_at"].nunique()} distinct slices')

    print('Loading SPX spot...')
    spot = load_spot()
    print(f'  {len(spot):,} 1-min bars')

    print('Loading SPXW 0DTE call flow (strikes 7300-7500)...')
    flow = load_flow(7300.0, 7500.0)
    print(f'  {len(flow):,} trades')

    print('Computing Periscope events (sign flips + magnitude jumps)...')
    gamma_events = detect_periscope_events(periscope, 'gamma', 0.10)
    charm_events = detect_periscope_events(periscope, 'charm', 0.10)
    vanna_events = detect_periscope_events(periscope, 'vanna', 0.10)
    all_events = pd.concat([gamma_events, charm_events, vanna_events],
                           ignore_index=True)
    all_events.to_csv(OUT / 'periscope_events.csv', index=False)
    print(f'  gamma events: {len(gamma_events)} | '
          f'charm: {len(charm_events)} | vanna: {len(vanna_events)}')

    print('Bucketing flow into 5-min windows per strike...')
    flow_buckets = bucket_flow(flow, '5min')
    flow_buckets.to_csv(OUT / 'flow_per_strike_bucket.csv', index=False)
    print(f'  {len(flow_buckets):,} (bucket,strike) rows')

    print('Cross-referencing events with flow + spot direction...')
    cross_ref = cross_reference(all_events, flow_buckets, spot, '5min')
    cross_ref.to_csv(OUT / 'events_with_flow.csv', index=False)

    print('Generating plots...')
    plot_spot_with_events(spot, all_events, OUT / 'plot_01_spot_with_events.png')
    plot_gamma_heatmap(periscope, OUT / 'plot_02_gamma_heatmap.png')
    plot_strike_flow_panels(
        flow_buckets, [7380.0, 7400.0, 7450.0, 7475.0],
        OUT / 'plot_03_strike_flow_panels.png')
    plot_wonce_window(periscope, flow_buckets, spot,
                      OUT / 'plot_04_wonce_window.png')

    print('Writing findings.md...')
    write_findings(all_events, cross_ref, flow_buckets, spot,
                   OUT / 'findings.md')
    print(f'\nAll outputs -> {OUT}/')


if __name__ == '__main__':
    main()
