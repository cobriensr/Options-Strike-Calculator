"""
26-day forensic on the Wonce pattern.

Pattern: Periscope gamma magnitude jump (top-1% per day) at an OTM strike,
counter-trend spot move in prior 10 min, concurrent ask-side flow at the
event strike. Outcome: forward returns at OTM lottery strikes (event_strike
+ 25/50/75/100 pts) over 15/30/60 min and EOD.

For each parquet day in ~/Desktop/Bot-Eod-parquet/ (26 days, 2026-04-13 ->
2026-05-18):
  1. Load periscope_snapshots gamma for that expiry, compute per-strike
     slice-over-slice deltas, threshold at top-1% of day's |delta|.
  2. Load SPX 1m candles, compute 10-min spot direction at each event time.
  3. Load SPXW 0DTE call parquet within strike range, bucket per 5-min.
  4. Cross-reference: at each event, capture concurrent flow at strike +
     lottery-zone flow + spot-direction context.
  5. Compute forward returns at trade strikes event_strike + {25, 50, 75,
     100} for horizons {15, 30, 60} min and EOD.
  6. Compare to random control sample.

Outputs (docs/tmp/forensic-multi-day/):
  events.csv          per-event row with all features + forward returns
  events_summary.csv  aggregate by day, by spot-direction class, by strike OTM
  control.csv         random matched sample for base-rate comparison
  findings.md         narrative writeup
  plots/              charts
"""
from __future__ import annotations

import gc
import os
import warnings
from datetime import date, timedelta
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2
import pyarrow.parquet as pq
from dotenv import load_dotenv

warnings.filterwarnings('ignore')
load_dotenv('.env.local')

PARQUET_DIR = Path('/Users/charlesobrien/Desktop/Bot-Eod-parquet')
OUT = Path('docs/tmp/forensic-multi-day')
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'plots').mkdir(parents=True, exist_ok=True)

DB_URL = os.environ['DATABASE_URL_UNPOOLED']

# Thresholds (parameters we may sweep later)
TOP_PCT_PER_DAY = 0.01     # event = top-1% of day's |delta gamma|
COUNTER_TREND_MIN_PTS = 2.0  # spot must move >= 2 pts opposite event side
TRADE_OTM_OFFSETS = [25, 50, 75, 100]  # entry strikes relative to event
HOLD_MIN = [15, 30, 60]    # min horizons for max-realized
RNG = np.random.default_rng(20260518)


# --------------------------- I/O HELPERS ----------------------------------


def db_query(sql: str, params: tuple | None = None) -> pd.DataFrame:
    with psycopg2.connect(DB_URL) as conn:
        return pd.read_sql(sql, conn, params=params)


def load_periscope_day(d: date) -> pd.DataFrame:
    df = db_query(
        """
        SELECT captured_at, strike, value
        FROM periscope_snapshots
        WHERE expiry = %s AND panel = 'gamma'
        ORDER BY strike, captured_at
        """,
        (d.isoformat(),),
    )
    if df.empty:
        return df
    df['captured_at'] = pd.to_datetime(df['captured_at'], utc=True)
    df['strike'] = df['strike'].astype(float)
    df['value'] = df['value'].astype(float)
    return df


def load_spot_day(d: date) -> pd.DataFrame:
    df = db_query(
        """
        SELECT timestamp, open, high, low, close
        FROM index_candles_1m
        WHERE symbol='SPX' AND timestamp >= %s AND timestamp < %s
        ORDER BY timestamp
        """,
        (d.isoformat(), (d + timedelta(days=1)).isoformat()),
    )
    if df.empty:
        return df
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    for c in ['open', 'high', 'low', 'close']:
        df[c] = df[c].astype(float)
    return df.set_index('timestamp')


def load_flow_day(d: date, strike_lo: float, strike_hi: float) -> pd.DataFrame:
    path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
    if not path.exists():
        return pd.DataFrame()
    tbl = pq.read_table(
        path,
        filters=[
            ('underlying_symbol', '=', 'SPXW'),
            ('expiry', '=', d),
            ('option_type', '=', 'call'),
            ('strike', '>=', strike_lo),
            ('strike', '<=', strike_hi),
        ],
        columns=[
            'executed_at', 'side', 'strike', 'underlying_price',
            'nbbo_bid', 'nbbo_ask', 'price', 'size', 'premium',
        ],
    )
    if tbl.num_rows == 0:
        return pd.DataFrame()
    df = tbl.to_pandas().sort_values('executed_at').reset_index(drop=True)
    df['executed_at'] = pd.to_datetime(df['executed_at'], utc=True)
    return df


# --------------------------- ANALYTIC HELPERS -----------------------------


def compute_gamma_events(periscope: pd.DataFrame,
                         top_pct: float = TOP_PCT_PER_DAY) -> pd.DataFrame:
    """For a single day's gamma snapshots, compute per-strike slice deltas
    and flag events whose |delta| is in the top-N percentile of the day.
    """
    if periscope.empty:
        return periscope
    df = periscope.sort_values(['strike', 'captured_at']).copy()
    df['prior_value'] = df.groupby('strike')['value'].shift(1)
    df['prior_captured_at'] = df.groupby('strike')['captured_at'].shift(1)
    df['delta'] = df['value'] - df['prior_value']
    df = df.dropna(subset=['delta']).copy()
    threshold = float(df['delta'].abs().quantile(1.0 - top_pct))
    df['event'] = df['delta'].abs() >= threshold
    df['threshold'] = threshold
    df['day_max_abs_gamma'] = float(periscope['value'].abs().max())
    return df[df['event']].reset_index(drop=True)


def spot_direction(spot: pd.DataFrame, ts: pd.Timestamp,
                   lookback_min: int = 10) -> dict:
    if spot.empty:
        return {'spot_start': None, 'spot_end': None, 'spot_delta_pre': None,
                'spot_at_event': None}
    start = ts - pd.Timedelta(minutes=lookback_min)
    win = spot.loc[start:ts]
    if len(win) < 2:
        return {'spot_start': None, 'spot_end': None, 'spot_delta_pre': None,
                'spot_at_event': None}
    s = float(win['close'].iloc[0])
    e = float(win['close'].iloc[-1])
    return {'spot_start': s, 'spot_end': e, 'spot_delta_pre': e - s,
            'spot_at_event': e}


def bucket_flow(flow: pd.DataFrame, freq: str = '5min') -> pd.DataFrame:
    if flow.empty:
        return flow
    df = flow.copy()
    df['bucket'] = df['executed_at'].dt.floor(freq)

    side_agg = (
        df.groupby(['bucket', 'strike', 'side'])
        .agg(contracts=('size', 'sum'))
        .reset_index()
    )
    piv = side_agg.pivot_table(index=['bucket', 'strike'], columns='side',
                               values='contracts', fill_value=0).reset_index()
    for col in ['ask', 'bid', 'mid', 'no_side']:
        if col not in piv.columns:
            piv[col] = 0
    piv.rename(columns={'ask': 'c_ask', 'bid': 'c_bid', 'mid': 'c_mid',
                        'no_side': 'c_no'}, inplace=True)
    piv['total'] = piv[['c_ask', 'c_bid', 'c_mid', 'c_no']].sum(axis=1)
    piv['ask_pct'] = piv['c_ask'] / piv['total'].clip(lower=1)

    tot = (
        df.groupby(['bucket', 'strike'])
        .agg(spot_first=('underlying_price', 'first'),
             spot_last=('underlying_price', 'last'),
             px_first=('price', 'first'),
             px_last=('price', 'last'),
             px_min=('price', 'min'),
             px_max=('price', 'max'),
             premium=('premium', 'sum'),
             trades=('size', 'count'))
        .reset_index()
    )
    return piv.merge(tot, on=['bucket', 'strike']).sort_values(
        ['bucket', 'strike']).reset_index(drop=True)


def first_trade_after(flow: pd.DataFrame, ts: pd.Timestamp, strike: float,
                      lookahead_sec: int = 300) -> dict:
    """Find first trade at given strike at or after ts (within lookahead).
    Returns entry price + size + executed_at.
    """
    end = ts + pd.Timedelta(seconds=lookahead_sec)
    sub = flow[(flow['strike'] == strike)
               & (flow['executed_at'] >= ts)
               & (flow['executed_at'] <= end)]
    if sub.empty:
        return {'entry_price': None, 'entry_ts': None, 'entry_size': None}
    r = sub.iloc[0]
    return {'entry_price': float(r['price']), 'entry_ts': r['executed_at'],
            'entry_size': int(r['size'])}


def forward_max(flow: pd.DataFrame, ts: pd.Timestamp, strike: float,
                horizon_min: int) -> float | None:
    end = ts + pd.Timedelta(minutes=horizon_min)
    sub = flow[(flow['strike'] == strike)
               & (flow['executed_at'] >= ts)
               & (flow['executed_at'] <= end)]
    if sub.empty:
        return None
    return float(sub['price'].max())


def eod_close(flow: pd.DataFrame, strike: float) -> float | None:
    sub = flow[flow['strike'] == strike]
    if sub.empty:
        return None
    return float(sub.iloc[-1]['price'])


def compute_event_row(event: pd.Series, spot: pd.DataFrame,
                      flow: pd.DataFrame, flow_buckets: pd.DataFrame,
                      d: date) -> dict:
    """Build a comprehensive feature row + outcomes for one Periscope event."""
    ts = event['captured_at']
    bucket = ts.floor('5min')
    strike = float(event['strike'])

    sd = spot_direction(spot, ts, 10)
    sd_post = spot_direction(spot, ts + pd.Timedelta(minutes=30), 30)

    # Spot at event
    spot_at = sd['spot_at_event']

    # Event side: above or below spot
    event_otm_dir = ('above' if spot_at is not None and strike > spot_at
                     else 'below' if spot_at is not None and strike < spot_at
                     else 'ATM')

    # Gamma sign + change
    gamma_pre = float(event['prior_value'])
    gamma_post = float(event['value'])
    gamma_delta = float(event['delta'])
    deepened_negative = gamma_post < 0 and gamma_delta < 0
    deepened_positive = gamma_post > 0 and gamma_delta > 0
    flipped_to_negative = gamma_pre > 0 and gamma_post < 0
    flipped_to_positive = gamma_pre < 0 and gamma_post > 0

    # Counter-trend definition: spot moved AWAY from the strike that just
    # got more negative-gamma (i.e., dealer just got more short-gamma at a
    # strike that spot is leaving).
    is_counter_trend = False
    if sd['spot_delta_pre'] is not None and spot_at is not None:
        if deepened_negative and event_otm_dir == 'above':
            is_counter_trend = sd['spot_delta_pre'] <= -COUNTER_TREND_MIN_PTS
        elif deepened_negative and event_otm_dir == 'below':
            is_counter_trend = sd['spot_delta_pre'] >= COUNTER_TREND_MIN_PTS

    # Concurrent flow at the event strike
    at_strike = flow_buckets[(flow_buckets['bucket'] == bucket)
                             & (flow_buckets['strike'] == strike)]
    if len(at_strike):
        r = at_strike.iloc[0]
        flow_total = int(r['total'])
        flow_ask_pct = float(r['ask_pct'])
        flow_ask = int(r['c_ask'])
        flow_bid = int(r['c_bid'])
    else:
        flow_total = flow_ask_pct = flow_ask = flow_bid = None

    # Lottery zone: 20-100pt OTM beyond event strike (same direction)
    if event_otm_dir == 'above':
        band = flow_buckets[(flow_buckets['bucket'] == bucket)
                            & (flow_buckets['strike'] > strike + 20)
                            & (flow_buckets['strike'] <= strike + 100)]
    else:
        band = flow_buckets[(flow_buckets['bucket'] == bucket)
                            & (flow_buckets['strike'] < strike - 20)
                            & (flow_buckets['strike'] >= strike - 100)]
    if len(band):
        lott_total = int(band['total'].sum())
        lott_ask = int(band['c_ask'].sum())
        lott_ask_pct = lott_ask / max(lott_total, 1)
    else:
        lott_total = lott_ask = 0
        lott_ask_pct = 0.0

    # Forward returns at trade strikes (event_strike + offsets, same OTM dir)
    outcomes: dict = {}
    sign = 1 if event_otm_dir == 'above' else -1
    for off in TRADE_OTM_OFFSETS:
        trade_strike = strike + sign * off
        e = first_trade_after(flow, ts, trade_strike, 300)
        outcomes[f'k{off}_strike'] = trade_strike
        outcomes[f'k{off}_entry_px'] = e['entry_price']
        outcomes[f'k{off}_entry_ts'] = e['entry_ts']
        if e['entry_price'] is not None and e['entry_price'] > 0:
            ep = e['entry_price']
            for h in HOLD_MIN:
                m = forward_max(flow, e['entry_ts'], trade_strike, h)
                outcomes[f'k{off}_max_{h}m'] = m
                outcomes[f'k{off}_R_{h}m'] = (m - ep) / ep if m else None
            eod = eod_close(flow, trade_strike)
            outcomes[f'k{off}_eod_px'] = eod
            outcomes[f'k{off}_R_eod'] = (eod - ep) / ep if eod else None
        else:
            for h in HOLD_MIN:
                outcomes[f'k{off}_max_{h}m'] = None
                outcomes[f'k{off}_R_{h}m'] = None
            outcomes[f'k{off}_eod_px'] = None
            outcomes[f'k{off}_R_eod'] = None

    return {
        'day': d.isoformat(),
        'captured_at': ts,
        'strike': strike,
        'gamma_pre': gamma_pre,
        'gamma_post': gamma_post,
        'gamma_delta': gamma_delta,
        'day_max_abs_gamma': float(event['day_max_abs_gamma']),
        'threshold': float(event['threshold']),
        'deepened_negative': deepened_negative,
        'deepened_positive': deepened_positive,
        'flipped_to_negative': flipped_to_negative,
        'flipped_to_positive': flipped_to_positive,
        'spot_at_event': spot_at,
        'event_otm_dir': event_otm_dir,
        'spot_delta_pre10': sd['spot_delta_pre'],
        'spot_delta_post30': sd_post['spot_delta_pre'],
        'is_counter_trend': is_counter_trend,
        'flow_total': flow_total,
        'flow_ask_pct': flow_ask_pct,
        'flow_ask': flow_ask,
        'flow_bid': flow_bid,
        'lott_total': lott_total,
        'lott_ask': lott_ask,
        'lott_ask_pct': lott_ask_pct,
        **outcomes,
    }


def process_day(d: date) -> pd.DataFrame:
    """End-to-end pipeline for a single day. Returns event rows."""
    periscope = load_periscope_day(d)
    if periscope.empty:
        return pd.DataFrame()
    strike_lo = float(periscope['strike'].min()) - 50
    strike_hi = float(periscope['strike'].max()) + 50

    spot = load_spot_day(d)
    flow = load_flow_day(d, strike_lo, strike_hi)
    if flow.empty:
        return pd.DataFrame()

    events = compute_gamma_events(periscope, TOP_PCT_PER_DAY)
    if events.empty:
        return events

    flow_buckets = bucket_flow(flow, '5min')
    rows = [compute_event_row(events.iloc[i], spot, flow, flow_buckets, d)
            for i in range(len(events))]
    return pd.DataFrame(rows)


def build_controls(events_df: pd.DataFrame, n_per_day: int = 50) -> pd.DataFrame:
    """For each day in events_df, sample n_per_day random (timestamp, strike)
    points matched by time-of-day from valid bucketed flow. Compute forward
    returns at the same trade-strike offsets.
    """
    rows: list[dict] = []
    days = sorted(events_df['day'].unique())
    for ds in days:
        d = date.fromisoformat(ds)
        periscope = load_periscope_day(d)
        if periscope.empty:
            continue
        strike_lo = float(periscope['strike'].min()) - 50
        strike_hi = float(periscope['strike'].max()) + 50
        spot = load_spot_day(d)
        flow = load_flow_day(d, strike_lo, strike_hi)
        if flow.empty:
            continue

        # Sample random executed_at timestamps in 14:30-19:30 UTC (RTH minus
        # last 30 min); sample strikes from periscope strike grid.
        rth = flow[(flow['executed_at'] >= pd.Timestamp(f'{ds} 14:30', tz='UTC'))
                   & (flow['executed_at'] <= pd.Timestamp(f'{ds} 19:30', tz='UTC'))]
        if rth.empty:
            continue
        sample_ts = rth['executed_at'].sample(
            n=min(n_per_day, len(rth)),
            random_state=int(RNG.integers(0, 2**31 - 1)),
        ).reset_index(drop=True)
        sample_k = pd.Series(RNG.choice(periscope['strike'].unique(),
                                        size=len(sample_ts), replace=True))
        for ts, strike in zip(sample_ts, sample_k.values):
            # ts is a pandas Timestamp from a UTC-aware series.
            if ts.tzinfo is None:
                ts = ts.tz_localize('UTC')
            sd = spot_direction(spot, ts, 10)
            spot_at = sd['spot_at_event']
            otm_dir = ('above' if spot_at is not None and strike > spot_at
                       else 'below' if spot_at is not None and strike < spot_at
                       else 'ATM')
            sign = 1 if otm_dir == 'above' else -1
            row = {'day': ds, 'captured_at': ts, 'strike': strike,
                   'event_otm_dir': otm_dir, 'spot_at_event': spot_at}
            for off in TRADE_OTM_OFFSETS:
                k = strike + sign * off
                e = first_trade_after(flow, ts, k, 300)
                row[f'k{off}_entry_px'] = e['entry_price']
                if e['entry_price'] is not None and e['entry_price'] > 0:
                    ep = e['entry_price']
                    for h in HOLD_MIN:
                        m = forward_max(flow, e['entry_ts'], k, h)
                        row[f'k{off}_R_{h}m'] = (m - ep) / ep if m else None
                else:
                    for h in HOLD_MIN:
                        row[f'k{off}_R_{h}m'] = None
            rows.append(row)
    return pd.DataFrame(rows)


# --------------------------- ANALYSIS & PLOTS -----------------------------


def hit_rate(series: pd.Series, threshold: float) -> float:
    s = series.dropna()
    return float((s >= threshold).mean()) if len(s) else float('nan')


def aggregate_events(df: pd.DataFrame) -> pd.DataFrame:
    """Hit rates at multiple R thresholds + sample counts."""
    out_rows: list[dict] = []
    for label, sub in [('all_events', df),
                       ('counter_trend', df[df['is_counter_trend']]),
                       ('above_spot', df[df['event_otm_dir'] == 'above']),
                       ('above_spot_ct', df[(df['event_otm_dir'] == 'above')
                                           & df['is_counter_trend']]),
                       ('above_spot_ct_flow', df[(df['event_otm_dir'] == 'above')
                                                  & df['is_counter_trend']
                                                  & (df['flow_ask_pct'].fillna(0) >= 0.50)])]:
        n = len(sub)
        row = {'group': label, 'n': n}
        for off in TRADE_OTM_OFFSETS:
            for h in HOLD_MIN:
                col = f'k{off}_R_{h}m'
                if col not in sub.columns:
                    continue
                for tag, thresh in [('R2', 2), ('R5', 5), ('R10', 10),
                                    ('R50', 50)]:
                    row[f'{off}p_{h}m_hit_{tag}'] = hit_rate(sub[col], thresh)
                row[f'{off}p_{h}m_median_R'] = float(sub[col].median()) \
                    if sub[col].dropna().size else float('nan')
                row[f'{off}p_{h}m_p90_R'] = float(sub[col].quantile(0.90)) \
                    if sub[col].dropna().size else float('nan')
        out_rows.append(row)
    return pd.DataFrame(out_rows)


def plot_summary(events_df: pd.DataFrame, controls_df: pd.DataFrame,
                 out_dir: Path) -> None:
    # 1. Events per day
    fig, ax = plt.subplots(figsize=(14, 5))
    by_day = events_df.groupby('day').size()
    by_day.plot.bar(ax=ax, color='#1f77b4')
    ax.set_title('Gamma magnitude-jump events per day (top-1% per-day threshold)')
    ax.set_xlabel('day')
    ax.set_ylabel('events')
    fig.tight_layout()
    fig.savefig(out_dir / '01_events_per_day.png', dpi=120)
    plt.close(fig)

    # 2. Hit rate comparison: pattern vs control at +50pt OTM, 30min horizon
    if 'k50_R_30m' in events_df.columns:
        thresholds = [1, 2, 5, 10, 20, 50, 100]
        rates = []
        ev_filt = events_df[(events_df['event_otm_dir'] == 'above')
                            & events_df['is_counter_trend']
                            & (events_df['flow_ask_pct'].fillna(0) >= 0.50)]
        for t in thresholds:
            rates.append({
                'R': t,
                'pattern (k+50, 30m)': hit_rate(ev_filt['k50_R_30m'], t),
                'control (k+50, 30m)': hit_rate(controls_df['k50_R_30m'], t) \
                    if 'k50_R_30m' in controls_df.columns else float('nan'),
            })
        rdf = pd.DataFrame(rates).set_index('R')
        fig, ax = plt.subplots(figsize=(10, 5))
        rdf.plot.bar(ax=ax)
        ax.set_title('Hit rate at +50pt OTM, 30-min horizon: pattern vs control')
        ax.set_ylabel('hit rate')
        ax.set_xlabel('R threshold')
        ax.grid(alpha=0.3)
        fig.tight_layout()
        fig.savefig(out_dir / '02_hit_rate_vs_control.png', dpi=120)
        plt.close(fig)

    # 3. R distribution histogram at k+50, 30min
    ev_filt = events_df[(events_df['event_otm_dir'] == 'above')
                        & events_df['is_counter_trend']]
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    if 'k50_R_30m' in ev_filt.columns:
        ev_R = ev_filt['k50_R_30m'].dropna()
        ev_R = ev_R[ev_R < 200]  # clip extreme outliers for vis
        axes[0].hist(ev_R, bins=50, color='#1f77b4', alpha=0.7)
        axes[0].set_title(f'Pattern R at +50pt OTM, 30m (n={len(ev_R)})')
        axes[0].set_xlabel('Realized R')
        axes[0].axvline(0, color='k', lw=0.5)
        axes[0].grid(alpha=0.3)
    if 'k50_R_30m' in controls_df.columns:
        c_R = controls_df['k50_R_30m'].dropna()
        c_R = c_R[c_R < 200]
        axes[1].hist(c_R, bins=50, color='#888', alpha=0.7)
        axes[1].set_title(f'Control R at +50pt OTM, 30m (n={len(c_R)})')
        axes[1].set_xlabel('Realized R')
        axes[1].axvline(0, color='k', lw=0.5)
        axes[1].grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out_dir / '03_R_distribution.png', dpi=120)
    plt.close(fig)

    # 4. Time-of-day distribution
    fig, ax = plt.subplots(figsize=(12, 5))
    events_df['hour_utc'] = events_df['captured_at'].dt.hour
    by_hour = events_df.groupby('hour_utc').size()
    by_hour.plot.bar(ax=ax, color='#2ca02c')
    ax.set_title('Events by hour (UTC)')
    ax.set_xlabel('Hour UTC (13=8:00 AM CT, 19=2:00 PM CT)')
    fig.tight_layout()
    fig.savefig(out_dir / '04_events_by_hour.png', dpi=120)
    plt.close(fig)


def write_findings(events_df: pd.DataFrame, agg: pd.DataFrame,
                   controls_df: pd.DataFrame, out_path: Path) -> None:
    lines: list[str] = []
    lines.append('# Multi-day forensic: Wonce gamma reposition + lottery pattern\n')
    lines.append(f'Days scanned: {events_df["day"].nunique()}')
    lines.append(f'Total events (top-1% magnitude jump per day): {len(events_df)}')
    lines.append(f'Mean events/day: {len(events_df) / events_df["day"].nunique():.1f}\n')

    counts = events_df.groupby('event_otm_dir').size().to_dict()
    lines.append(f'Events by OTM direction: {counts}\n')

    n_ct = int(events_df['is_counter_trend'].sum())
    lines.append(f'Counter-trend events: {n_ct} ({n_ct / len(events_df) * 100:.1f}%)\n')

    lines.append('## Aggregate hit rates by filter group\n')
    lines.append('Columns: group, n, then k{off}p_{h}m_hit_R{level}.')
    lines.append('Higher group filter = stricter pattern definition.\n')
    cols = ['group', 'n']
    for off in [50]:
        for h in [15, 30, 60]:
            cols.extend([f'{off}p_{h}m_hit_R2', f'{off}p_{h}m_hit_R5',
                         f'{off}p_{h}m_hit_R10', f'{off}p_{h}m_hit_R50',
                         f'{off}p_{h}m_median_R', f'{off}p_{h}m_p90_R'])
    show = agg[cols].copy()
    for c in show.columns:
        if c not in ('group', 'n'):
            show[c] = show[c].apply(
                lambda x: 'na' if pd.isna(x) else f'{x:.2%}' if 'hit' in c
                else f'{x:.2f}')
    lines.append(show.to_string(index=False))

    # Control comparison
    lines.append('\n## Control sample (random time/strike, no filter)\n')
    for off in TRADE_OTM_OFFSETS:
        for h in [30]:
            col = f'k{off}_R_{h}m'
            if col in controls_df.columns:
                s = controls_df[col].dropna()
                lines.append(
                    f'  k+{off}p, {h}m: n={len(s)}, hit R2={hit_rate(s,2):.2%}, '
                    f'R5={hit_rate(s,5):.2%}, R10={hit_rate(s,10):.2%}, '
                    f'median R={s.median():.2f}, p90={s.quantile(0.90):.2f}'
                )

    # Headline events (largest realized R at k+50, 30m)
    if 'k50_R_30m' in events_df.columns:
        big = events_df[
            (events_df['event_otm_dir'] == 'above')
            & events_df['is_counter_trend']
        ].nlargest(20, 'k50_R_30m')
        lines.append('\n## Top-20 counter-trend events by realized R at +50pt OTM, 30min\n')
        keep = ['day', 'captured_at', 'strike', 'spot_at_event', 'gamma_pre',
                'gamma_post', 'gamma_delta', 'spot_delta_pre10', 'flow_total',
                'flow_ask_pct', 'lott_total', 'lott_ask_pct',
                'k25_R_30m', 'k50_R_30m', 'k75_R_30m', 'k100_R_30m']
        lines.append(big[keep].to_string(index=False))

    out_path.write_text('\n'.join(lines))


# --------------------------- DRIVER ---------------------------------------


def main() -> None:
    parquet_days = sorted([
        date.fromisoformat(p.stem.replace('-trades', ''))
        for p in PARQUET_DIR.glob('*-trades.parquet')
    ])
    print(f'Days to process: {len(parquet_days)} '
          f'({parquet_days[0]} -> {parquet_days[-1]})')

    all_events: list[pd.DataFrame] = []
    for i, d in enumerate(parquet_days):
        print(f'[{i + 1:>2}/{len(parquet_days)}] {d} ...', end=' ', flush=True)
        try:
            df = process_day(d)
            print(f'{len(df)} events')
            if len(df):
                all_events.append(df)
        except Exception as e:
            print(f'ERROR: {e}')
        gc.collect()

    events_df = pd.concat(all_events, ignore_index=True) if all_events else pd.DataFrame()
    events_df.to_csv(OUT / 'events.csv', index=False)
    print(f'\nTotal events: {len(events_df)}')

    print('Aggregating...')
    agg = aggregate_events(events_df)
    agg.to_csv(OUT / 'events_summary.csv', index=False)

    print('Building random control sample...')
    controls_df = build_controls(events_df, n_per_day=50)
    controls_df.to_csv(OUT / 'control.csv', index=False)
    print(f'Controls: {len(controls_df)} samples')

    print('Plotting...')
    plot_summary(events_df, controls_df, OUT / 'plots')

    print('Writing findings...')
    write_findings(events_df, agg, controls_df, OUT / 'findings.md')
    print(f'\nAll outputs -> {OUT}/')


if __name__ == '__main__':
    main()
