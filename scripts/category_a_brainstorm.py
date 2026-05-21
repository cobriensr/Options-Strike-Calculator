"""
Category A — Pre-event signals for v4 down-wick gamma-node rejections.

Tests 7 features that exist BEFORE the wick to see whether any predict
stronger forward returns (+30m) than the matched control.

Master CSV: docs/tmp/forensic-multi-day/gamma_node_rejection_2026-05-20_v4-vol-crush.csv
Down-wick subset only (n=295). Paired t-test on ret_30m vs control_ret_30m.

Run: ml/.venv/bin/python scripts/category_a_brainstorm.py
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import timedelta
from typing import Callable

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import RealDictCursor
from scipy import stats

# --------------------------------------------------------------------------- #
# Setup
# --------------------------------------------------------------------------- #

load_dotenv('.env.local')
DB_URL = os.environ['DATABASE_URL_UNPOOLED']

MASTER_CSV = (
    'docs/tmp/forensic-multi-day/gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
)
FINDINGS_MD = 'docs/tmp/forensic-multi-day/category_a_brainstorm_findings.md'


def load_events() -> pd.DataFrame:
    df = pd.read_csv(MASTER_CSV)
    df['event_ts'] = pd.to_datetime(df['event_ts'], utc=True)
    df['control_ts'] = pd.to_datetime(df['control_ts'], utc=True)
    df = df[df['direction'] == 'down'].reset_index(drop=True)
    # Drop any rows missing the returns we'll compare against.
    df = df.dropna(subset=['ret_30m', 'control_ret_30m']).reset_index(drop=True)
    return df


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


@dataclass
class TestResult:
    name: str
    n: int
    event_mean: float
    control_mean: float
    delta: float
    p_value: float
    notes: str = ''
    h1_delta: float | None = None
    h2_delta: float | None = None
    h1_p: float | None = None
    h2_p: float | None = None
    walkforward_n1: int | None = None
    walkforward_n2: int | None = None


def ts_to_ns(s: pd.Series) -> np.ndarray:
    """Convert a tz-aware datetime Series to int64 nanoseconds.

    Postgres returns timestamps as datetime64[us]; astype('int64') would give
    microseconds and silently mismatch with pd.Timestamp.value (always ns).
    """
    return s.dt.as_unit('ns').astype('int64').to_numpy()


def paired_test(event_vals: np.ndarray, control_vals: np.ndarray) -> tuple[float, float]:
    """Returns (delta_mean, p_value) for a paired t-test."""
    if len(event_vals) < 2:
        return float('nan'), float('nan')
    delta = float(np.mean(event_vals - control_vals))
    _, p = stats.ttest_rel(event_vals, control_vals)
    return delta, float(p)


def run_test(
    name: str,
    df: pd.DataFrame,
    feature_col: str,
    *,
    selector: Callable[[pd.DataFrame], pd.Series] | None = None,
    notes: str = '',
) -> TestResult:
    """Apply selector to filter rows, then paired-test event vs control returns."""
    sub = df.dropna(subset=[feature_col]).copy()
    if selector is not None:
        sub = sub[selector(sub)].copy()
    n = len(sub)
    if n == 0:
        return TestResult(name, 0, float('nan'), float('nan'), float('nan'), float('nan'),
                          notes=notes or 'no data')
    event_ret = sub['ret_30m'].to_numpy(dtype=float)
    ctrl_ret = sub['control_ret_30m'].to_numpy(dtype=float)
    delta, p = paired_test(event_ret, ctrl_ret)
    result = TestResult(
        name=name,
        n=n,
        event_mean=float(np.mean(event_ret)),
        control_mean=float(np.mean(ctrl_ret)),
        delta=delta,
        p_value=p,
        notes=notes,
    )
    if n >= 20:
        sub_sorted = sub.sort_values('event_ts').reset_index(drop=True)
        mid = len(sub_sorted) // 2
        h1 = sub_sorted.iloc[:mid]
        h2 = sub_sorted.iloc[mid:]
        d1, p1 = paired_test(h1['ret_30m'].to_numpy(float),
                             h1['control_ret_30m'].to_numpy(float))
        d2, p2 = paired_test(h2['ret_30m'].to_numpy(float),
                             h2['control_ret_30m'].to_numpy(float))
        result.h1_delta, result.h1_p = d1, p1
        result.h2_delta, result.h2_p = d2, p2
        result.walkforward_n1 = len(h1)
        result.walkforward_n2 = len(h2)
    return result


def format_result(r: TestResult) -> str:
    if r.n == 0:
        return f'**n=0** — {r.notes}'
    lines = [
        f'| metric | value |',
        f'| --- | --- |',
        f'| n | {r.n} |',
        f'| Event mean ret_30m | {r.event_mean:+.2f} |',
        f'| Control mean ret_30m | {r.control_mean:+.2f} |',
        f'| Δ (event − control) | {r.delta:+.2f} |',
        f'| p-value (paired t) | {r.p_value:.4f} |',
    ]
    if r.h1_delta is not None:
        lines.extend([
            f'| H1 Δ (n={r.walkforward_n1}) | {r.h1_delta:+.2f} (p={r.h1_p:.3f}) |',
            f'| H2 Δ (n={r.walkforward_n2}) | {r.h2_delta:+.2f} (p={r.h2_p:.3f}) |',
        ])
    if r.notes:
        lines.append(f'| notes | {r.notes} |')
    return '\n'.join(lines)


def verdict_line(r: TestResult, hypothesis_direction: str = 'positive') -> str:
    """hypothesis_direction='positive' → expect event > control (positive Δ)."""
    if r.n == 0:
        return '**Verdict:** no data, skip.'
    if not np.isfinite(r.p_value):
        return '**Verdict:** insufficient sample.'
    sig = r.p_value < 0.05
    sign_match = (r.delta > 0) if hypothesis_direction == 'positive' else (r.delta < 0)
    wf_ok = (
        r.h1_delta is not None
        and r.h2_delta is not None
        and ((r.h1_delta > 0 and r.h2_delta > 0) if hypothesis_direction == 'positive'
             else (r.h1_delta < 0 and r.h2_delta < 0))
    )
    if sig and sign_match and wf_ok:
        return '**Verdict:** SIGNAL — significant AND walk-forward consistent.'
    if sig and sign_match:
        return '**Verdict:** suggestive — significant in pool but walk-forward inconsistent.'
    if sign_match and r.p_value < 0.15:
        return '**Verdict:** weak directional hint, not significant.'
    return '**Verdict:** no signal.'


# --------------------------------------------------------------------------- #
# Feature builders (one query per table)
# --------------------------------------------------------------------------- #


def attach_a1_dp_concentration(df: pd.DataFrame, conn) -> pd.DataFrame:
    """A1: SPY dark-pool premium in (ts-30min, ts] AT OR BELOW node strike.
    SPX strike → SPY equivalent ≈ strike/10. Use a window around the SPY strike.
    """
    sql = """
        SELECT executed_at, price, size, premium
        FROM dark_pool_prints
        WHERE symbol = 'SPY'
          AND executed_at >= %s
          AND executed_at <= %s
    """
    t_min = (df[['event_ts', 'control_ts']].min().min() - timedelta(minutes=30)).to_pydatetime()
    t_max = df[['event_ts', 'control_ts']].max().max().to_pydatetime()
    dp = pd.read_sql(sql, conn, params=(t_min, t_max))
    dp['executed_at'] = pd.to_datetime(dp['executed_at'], utc=True)
    dp['price'] = dp['price'].astype(float)
    dp['premium'] = dp['premium'].astype(float)

    def sum_dp(ts: pd.Timestamp, spy_strike: float) -> float:
        start = ts - timedelta(minutes=30)
        mask = (
            (dp['executed_at'] > start)
            & (dp['executed_at'] <= ts)
            & (dp['price'] <= spy_strike)
        )
        return float(dp.loc[mask, 'premium'].fillna(0).sum())

    df['_spy_strike'] = df['node_strike'] / 10.0
    df['a1_event_dp_below'] = df.apply(
        lambda r: sum_dp(r['event_ts'], r['_spy_strike']), axis=1
    )
    df['a1_ctrl_dp_below'] = df.apply(
        lambda r: sum_dp(r['control_ts'], r['_spy_strike']), axis=1
    )
    df['a1_dp_below'] = df['a1_event_dp_below']  # for selector
    return df


def attach_a2_nope(df: pd.DataFrame, conn) -> pd.DataFrame:
    """A2: NOPE (SPY) closest to event_ts and control_ts within ±2 min."""
    sql = """
        SELECT timestamp, nope, nope_fill
        FROM nope_ticks
        WHERE ticker = 'SPY'
          AND timestamp >= %s
          AND timestamp <= %s
        ORDER BY timestamp
    """
    t_min = (df[['event_ts', 'control_ts']].min().min() - timedelta(minutes=5)).to_pydatetime()
    t_max = (df[['event_ts', 'control_ts']].max().max() + timedelta(minutes=5)).to_pydatetime()
    nope = pd.read_sql(sql, conn, params=(t_min, t_max))
    if nope.empty:
        df['a2_event_nope'] = np.nan
        df['a2_ctrl_nope'] = np.nan
        return df
    nope['timestamp'] = pd.to_datetime(nope['timestamp'], utc=True)
    nope = nope.sort_values('timestamp').reset_index(drop=True)
    # Convert to int64 nanoseconds (matches pd.Timestamp.value units).
    nope_ts = ts_to_ns(nope['timestamp'])
    nope_val = nope['nope'].astype(float).to_numpy()

    def closest(ts: pd.Timestamp) -> float:
        ts_i64 = ts.value
        idx = np.searchsorted(nope_ts, ts_i64)
        candidates = []
        for j in (idx - 1, idx):
            if 0 <= j < len(nope_ts):
                dt_sec = abs(nope_ts[j] - ts_i64) / 1e9
                if dt_sec <= 120:
                    candidates.append((dt_sec, nope_val[j]))
        if not candidates:
            return float('nan')
        candidates.sort()
        return candidates[0][1]

    df['a2_event_nope'] = df['event_ts'].apply(closest)
    df['a2_ctrl_nope'] = df['control_ts'].apply(closest)
    return df


def attach_a3_flow_ratio(df: pd.DataFrame, conn) -> pd.DataFrame:
    """A3: Cumulative put-flow / call-flow for SPXW up to event_ts (intraday)."""
    sql = """
        SELECT ts, net_call_prem, net_put_prem, call_volume, put_volume
        FROM net_flow_per_ticker_history
        WHERE ticker = 'SPXW'
          AND ts >= %s
          AND ts <= %s
        ORDER BY ts
    """
    t_min = pd.Timestamp(df['event_ts'].min()).floor('1D').to_pydatetime()
    t_max = df[['event_ts', 'control_ts']].max().max().to_pydatetime()
    flow = pd.read_sql(sql, conn, params=(t_min, t_max))
    if flow.empty:
        df['a3_event_putcall'] = np.nan
        df['a3_ctrl_putcall'] = np.nan
        return df
    flow['ts'] = pd.to_datetime(flow['ts'], utc=True)
    flow['session_date'] = flow['ts'].dt.tz_convert('UTC').dt.date
    flow = flow.sort_values('ts').reset_index(drop=True)
    # net_call_prem / net_put_prem are per-interval values; cumulate within session.
    flow['cum_call_prem'] = flow.groupby('session_date')['net_call_prem'].cumsum()
    flow['cum_put_prem'] = flow.groupby('session_date')['net_put_prem'].cumsum()

    def cum_ratio(ts: pd.Timestamp) -> float:
        d = ts.date()
        sub = flow[(flow['session_date'] == d) & (flow['ts'] <= ts)]
        if sub.empty:
            return float('nan')
        last = sub.iloc[-1]
        call_prem = float(last['cum_call_prem']) if last['cum_call_prem'] is not None else 0.0
        put_prem = float(last['cum_put_prem']) if last['cum_put_prem'] is not None else 0.0
        # Use absolute values; net_*_prem can be negative (net sell). We want
        # gross-side dominance: log(|put|/|call|).
        a = abs(put_prem)
        b = abs(call_prem)
        if a + b < 1e-6:
            return float('nan')
        return np.log((a + 1.0) / (b + 1.0))

    df['a3_event_putcall'] = df['event_ts'].apply(cum_ratio)
    df['a3_ctrl_putcall'] = df['control_ts'].apply(cum_ratio)
    return df


def attach_a4_dealer_delta(df: pd.DataFrame, conn) -> pd.DataFrame:
    """A4: Δdealer-delta per hour. Use SPX spot_exposures snapshot 'now' and 1h prior."""
    sql = """
        SELECT timestamp, gamma_dir, charm_dir, vanna_dir
        FROM spot_exposures
        WHERE ticker = 'SPX'
          AND timestamp >= %s
          AND timestamp <= %s
        ORDER BY timestamp
    """
    t_min = (df[['event_ts', 'control_ts']].min().min() - timedelta(hours=2)).to_pydatetime()
    t_max = df[['event_ts', 'control_ts']].max().max().to_pydatetime()
    se = pd.read_sql(sql, conn, params=(t_min, t_max))
    if se.empty:
        df['a4_event_ddelta'] = np.nan
        df['a4_ctrl_ddelta'] = np.nan
        return df
    se['timestamp'] = pd.to_datetime(se['timestamp'], utc=True)
    se = se.sort_values('timestamp').reset_index(drop=True)
    se_ts = ts_to_ns(se['timestamp'])
    se_val = se['gamma_dir'].astype(float).to_numpy()

    def last_at_or_before(ts: pd.Timestamp) -> float:
        idx = np.searchsorted(se_ts, ts.value, side='right') - 1
        if idx < 0:
            return float('nan')
        return float(se_val[idx])

    def ddelta(ts: pd.Timestamp) -> float:
        v_now = last_at_or_before(ts)
        v_prev = last_at_or_before(ts - timedelta(hours=1))
        if not (np.isfinite(v_now) and np.isfinite(v_prev)):
            return float('nan')
        return v_now - v_prev

    df['a4_event_ddelta'] = df['event_ts'].apply(ddelta)
    df['a4_ctrl_ddelta'] = df['control_ts'].apply(ddelta)
    return df


def attach_a5_strike_put_vol(df: pd.DataFrame, conn) -> pd.DataFrame:
    """A5: 0DTE put volume at node_strike as of event_ts (cumulative day)."""
    sql = """
        SELECT timestamp, strike, put_volume
        FROM volume_per_strike_0dte
        WHERE timestamp >= %s
          AND timestamp <= %s
        ORDER BY timestamp
    """
    t_min = (df[['event_ts', 'control_ts']].min().min() - timedelta(minutes=10)).to_pydatetime()
    t_max = df[['event_ts', 'control_ts']].max().max().to_pydatetime()
    vol = pd.read_sql(sql, conn, params=(t_min, t_max))
    if vol.empty:
        df['a5_event_putvol'] = np.nan
        df['a5_ctrl_putvol'] = np.nan
        return df
    vol['timestamp'] = pd.to_datetime(vol['timestamp'], utc=True)
    vol['strike'] = vol['strike'].astype(float)
    vol = vol.sort_values('timestamp').reset_index(drop=True)
    # Index by (timestamp, strike) for fast lookup; build a per-strike dict of
    # arrays.
    by_strike: dict[float, tuple[np.ndarray, np.ndarray]] = {}
    for strike, g in vol.groupby('strike'):
        ts_arr = ts_to_ns(g['timestamp'])
        pv_arr = g['put_volume'].astype(float).to_numpy()
        by_strike[float(strike)] = (ts_arr, pv_arr)

    def putvol(ts: pd.Timestamp, strike: float) -> float:
        s = float(strike)
        if s not in by_strike:
            return float('nan')
        ts_arr, pv_arr = by_strike[s]
        idx = np.searchsorted(ts_arr, ts.value, side='right') - 1
        if idx < 0:
            return float('nan')
        return float(pv_arr[idx])

    df['a5_event_putvol'] = df.apply(lambda r: putvol(r['event_ts'], r['node_strike']), axis=1)
    df['a5_ctrl_putvol'] = df.apply(lambda r: putvol(r['control_ts'], r['node_strike']), axis=1)
    return df


def attach_a6_charm(df: pd.DataFrame, conn) -> pd.DataFrame:
    """A6: Δcharm at node_strike, latest vs 30 min before (per snapshot)."""
    sql = """
        SELECT captured_at, strike, value
        FROM periscope_snapshots
        WHERE panel = 'charm'
          AND captured_at >= %s
          AND captured_at <= %s
        ORDER BY captured_at
    """
    t_min = (df[['event_ts', 'control_ts']].min().min() - timedelta(minutes=45)).to_pydatetime()
    t_max = df[['event_ts', 'control_ts']].max().max().to_pydatetime()
    ch = pd.read_sql(sql, conn, params=(t_min, t_max))
    if ch.empty:
        df['a6_event_dcharm'] = np.nan
        df['a6_ctrl_dcharm'] = np.nan
        return df
    ch['captured_at'] = pd.to_datetime(ch['captured_at'], utc=True)
    ch['strike'] = ch['strike'].astype(float)
    ch['value'] = ch['value'].astype(float)
    by_strike: dict[float, tuple[np.ndarray, np.ndarray]] = {}
    for strike, g in ch.groupby('strike'):
        by_strike[float(strike)] = (
            ts_to_ns(g['captured_at']),
            g['value'].astype(float).to_numpy(),
        )

    def charm_at(ts: pd.Timestamp, strike: float) -> float:
        s = float(strike)
        if s not in by_strike:
            return float('nan')
        ts_arr, val_arr = by_strike[s]
        idx = np.searchsorted(ts_arr, ts.value, side='right') - 1
        if idx < 0:
            return float('nan')
        return float(val_arr[idx])

    def dcharm(ts: pd.Timestamp, strike: float) -> float:
        v_now = charm_at(ts, strike)
        v_prev = charm_at(ts - timedelta(minutes=30), strike)
        if not (np.isfinite(v_now) and np.isfinite(v_prev)):
            return float('nan')
        return v_now - v_prev

    df['a6_event_dcharm'] = df.apply(
        lambda r: dcharm(r['event_ts'], r['node_strike']), axis=1
    )
    df['a6_ctrl_dcharm'] = df.apply(
        lambda r: dcharm(r['control_ts'], r['node_strike']), axis=1
    )
    return df


def attach_a7_spring(df: pd.DataFrame, conn) -> pd.DataFrame:
    """A7: Failed breakdown — bar.low sets new running session low, then within
    1-3 bars closes ABOVE the prior running low (i.e., the breakdown is
    reclaimed)."""
    sql = """
        SELECT timestamp, low, close
        FROM index_candles_1m
        WHERE symbol = 'SPX'
          AND timestamp >= %s
          AND timestamp <= %s
        ORDER BY timestamp
    """
    t_min = pd.Timestamp(df['event_ts'].min()).floor('1D').to_pydatetime()
    t_max = (df['event_ts'].max() + timedelta(minutes=10)).to_pydatetime()
    bars = pd.read_sql(sql, conn, params=(t_min, t_max))
    bars['timestamp'] = pd.to_datetime(bars['timestamp'], utc=True)
    bars['low'] = bars['low'].astype(float)
    bars['close'] = bars['close'].astype(float)
    bars['session_date'] = bars['timestamp'].dt.date
    # Running session low up to (but not including) each bar.
    bars = bars.sort_values(['session_date', 'timestamp']).reset_index(drop=True)
    bars['prev_running_low'] = (
        bars.groupby('session_date')['low'].cummin().shift(1)
    )

    def is_spring(ts: pd.Timestamp) -> float:
        d = ts.date()
        day = bars[bars['session_date'] == d].reset_index(drop=True)
        if day.empty:
            return float('nan')
        # Find the event bar; v4 wicks are aggregated 10-min bars in some
        # earlier scripts but the master csv has 10-min event_ts (e.g. 14:30).
        # Use the 1-min bar that opens at event_ts and the 9 minutes that
        # follow as the "event bar" window.
        win = day[(day['timestamp'] >= ts) & (day['timestamp'] < ts + timedelta(minutes=10))]
        if win.empty:
            return float('nan')
        event_low = float(win['low'].min())
        # Was a new session low set during the event window?
        prior = day[day['timestamp'] < ts]
        prior_low = float(prior['low'].min()) if not prior.empty else float('inf')
        if not (event_low < prior_low):
            return 0.0  # No new low → not a spring candidate.
        # Within next 1-3 bars (i.e. up to 30 min after event_ts ends), did the
        # close reclaim above prior_low?
        nxt = day[
            (day['timestamp'] >= ts + timedelta(minutes=10))
            & (day['timestamp'] < ts + timedelta(minutes=40))
        ]
        if nxt.empty:
            return 0.0
        return 1.0 if (nxt['close'] > prior_low).any() else 0.0

    df['a7_spring'] = df['event_ts'].apply(is_spring)
    return df


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main() -> None:
    df = load_events()
    print(f'Loaded {len(df)} down-wick events.')

    conn = psycopg2.connect(DB_URL)
    conn.set_session(readonly=True)

    print('A1: dark pool concentration...')
    df = attach_a1_dp_concentration(df, conn)
    print('A2: NOPE extreme...')
    df = attach_a2_nope(df, conn)
    print('A3: cumulative put/call flow ratio...')
    df = attach_a3_flow_ratio(df, conn)
    print('A4: dealer delta change rate...')
    df = attach_a4_dealer_delta(df, conn)
    print('A5: 0DTE strike put volume...')
    df = attach_a5_strike_put_vol(df, conn)
    print('A6: charm Δ at strike...')
    df = attach_a6_charm(df, conn)
    print('A7: spring / failed breakdown...')
    df = attach_a7_spring(df, conn)
    conn.close()

    # Persist enriched frame for follow-ups.
    enriched_path = 'docs/tmp/forensic-multi-day/category_a_enriched.csv'
    df.to_csv(enriched_path, index=False)
    print(f'Enriched frame written to {enriched_path}')

    # --------------------------------------------------------------------- #
    # Tests
    # --------------------------------------------------------------------- #

    results: list[tuple[TestResult, str, str]] = []  # (result, direction, explanation)

    # A1 — Heavy DP buying below strike in prior 30 min → bounce more likely.
    # Compare event-ret vs control-ret only on events where DP-below premium
    # is in the top quartile of all events.
    df['a1_top_q'] = df['a1_event_dp_below'] > df['a1_event_dp_below'].quantile(0.75)
    r1 = run_test(
        'A1: top-quartile DP premium below node, prior 30m',
        df, 'a1_event_dp_below',
        selector=lambda d: d['a1_top_q'],
        notes='SPY DP, price ≤ node/10, premium in (event_ts-30m, event_ts]',
    )
    results.append((r1, 'positive', 'Heavy DP buying near floor → bounce ↑'))

    # A2 — Strong negative NOPE = put-buying dominance → exhaustion → bounce.
    # Bottom quartile (most negative).
    r2 = run_test(
        'A2: bottom-quartile NOPE (most put-heavy)',
        df, 'a2_event_nope',
        selector=lambda d: d['a2_event_nope'] <= d['a2_event_nope'].quantile(0.25),
        notes='SPY NOPE within ±2 min of event_ts; bottom 25%',
    )
    results.append((r2, 'positive', 'Negative NOPE = exhaustion → bounce ↑'))

    # A3 — Top quartile (put-flow dominant).
    r3 = run_test(
        'A3: top-quartile cumulative put/call flow ratio',
        df, 'a3_event_putcall',
        selector=lambda d: d['a3_event_putcall'] >= d['a3_event_putcall'].quantile(0.75),
        notes='log(|put_prem|/|call_prem|) cumulative through event_ts; SPXW',
    )
    results.append((r3, 'positive', 'Put-heavy flow → exhaustion → bounce ↑'))

    # A4 — Most-negative Δdealer-delta (dealers got short fast) → strongest bounce.
    r4 = run_test(
        'A4: bottom-quartile Δdealer gamma_dir (1h)',
        df, 'a4_event_ddelta',
        selector=lambda d: d['a4_event_ddelta'] <= d['a4_event_ddelta'].quantile(0.25),
        notes='spot_exposures.gamma_dir Δ over 1h prior to event_ts',
    )
    results.append((r4, 'positive', 'Dealers got short fast → bounce ↑'))

    # A5 — Top quartile of 0DTE put volume at node_strike.
    r5 = run_test(
        'A5: top-quartile 0DTE put volume at node_strike',
        df, 'a5_event_putvol',
        selector=lambda d: d['a5_event_putvol'] >= d['a5_event_putvol'].quantile(0.75),
        notes='volume_per_strike_0dte cumulative put_volume at node_strike',
    )
    results.append((r5, 'positive', 'Heavy strike put vol → dealers defend ↑'))

    # A6 — Accelerating positive charm at strike (top quartile of Δcharm).
    r6 = run_test(
        'A6: top-quartile Δcharm at node_strike (30m)',
        df, 'a6_event_dcharm',
        selector=lambda d: d['a6_event_dcharm'] >= d['a6_event_dcharm'].quantile(0.75),
        notes='periscope_snapshots panel=charm at node_strike; Δ over 30m',
    )
    results.append((r6, 'positive', 'Accelerating + charm → pin ↑ → bounce ↑'))

    # A7 — Spring (binary): split by a7_spring.
    df_spring = df.dropna(subset=['a7_spring']).copy()
    spring_rows = df_spring[df_spring['a7_spring'] == 1.0]
    nonspring_rows = df_spring[df_spring['a7_spring'] == 0.0]

    if len(spring_rows) >= 2:
        d_spring, p_spring = paired_test(
            spring_rows['ret_30m'].to_numpy(float),
            spring_rows['control_ret_30m'].to_numpy(float),
        )
    else:
        d_spring, p_spring = float('nan'), float('nan')
    if len(nonspring_rows) >= 2:
        d_non, p_non = paired_test(
            nonspring_rows['ret_30m'].to_numpy(float),
            nonspring_rows['control_ret_30m'].to_numpy(float),
        )
    else:
        d_non, p_non = float('nan'), float('nan')

    r7 = TestResult(
        name='A7: spring (new-low reclaimed in 1-3 bars)',
        n=len(spring_rows),
        event_mean=float(spring_rows['ret_30m'].mean()) if len(spring_rows) else float('nan'),
        control_mean=float(spring_rows['control_ret_30m'].mean()) if len(spring_rows) else float('nan'),
        delta=d_spring,
        p_value=p_spring,
        notes=(
            f'spring n={len(spring_rows)} (Δ={d_spring:+.2f}, p={p_spring:.3f}); '
            f'non-spring n={len(nonspring_rows)} (Δ={d_non:+.2f}, p={p_non:.3f})'
        ),
    )
    if r7.n >= 20:
        spring_sorted = spring_rows.sort_values('event_ts').reset_index(drop=True)
        mid = len(spring_sorted) // 2
        h1, h2 = spring_sorted.iloc[:mid], spring_sorted.iloc[mid:]
        d1, p1 = paired_test(h1['ret_30m'].to_numpy(float),
                             h1['control_ret_30m'].to_numpy(float))
        d2, p2 = paired_test(h2['ret_30m'].to_numpy(float),
                             h2['control_ret_30m'].to_numpy(float))
        r7.h1_delta, r7.h1_p = d1, p1
        r7.h2_delta, r7.h2_p = d2, p2
        r7.walkforward_n1, r7.walkforward_n2 = len(h1), len(h2)
    results.append((r7, 'positive', 'Failed breakdown reclaimed → bounce ↑'))

    # --------------------------------------------------------------------- #
    # Print + write markdown
    # --------------------------------------------------------------------- #

    md_lines = [
        '# Category A — Pre-event Signals Brainstorm',
        '',
        '**Dataset:** `gamma_node_rejection_2026-05-20_v4-vol-crush.csv`, down-wick subset (n=295).',
        '',
        '**Test:** Paired t-test on `ret_30m` vs `control_ret_30m` within the selected sub-cohort. '
        'Where n≥20 the cohort is also split chronologically (H1/H2) for walk-forward sanity.',
        '',
        '**Comparison logic:** A1-A6 each define a sub-cohort by feature extremity (typically top or '
        'bottom 25%) and ask whether the event return inside that sub-cohort exceeds its own matched '
        'controls. A7 is a binary spring / non-spring partition.',
        '',
    ]
    print()
    print('=' * 78)
    for r, direction, expl in results:
        header = f'## {r.name}'
        md_lines.append(header)
        md_lines.append('')
        md_lines.append(f'_Hypothesis:_ {expl}')
        md_lines.append('')
        md_lines.append(format_result(r))
        md_lines.append('')
        md_lines.append(verdict_line(r, direction))
        md_lines.append('')
        # Console echo
        print(header)
        print(f'  n={r.n}  event={r.event_mean:+.2f}  ctrl={r.control_mean:+.2f}  '
              f'Δ={r.delta:+.2f}  p={r.p_value:.4f}')
        if r.h1_delta is not None:
            print(f'  WF: H1 Δ={r.h1_delta:+.2f} (p={r.h1_p:.3f}, n={r.walkforward_n1})  '
                  f'H2 Δ={r.h2_delta:+.2f} (p={r.h2_p:.3f}, n={r.walkforward_n2})')
        print(f'  {verdict_line(r, direction)}')
        print()

    with open(FINDINGS_MD, 'w') as f:
        f.write('\n'.join(md_lines))
    print(f'Findings written to {FINDINGS_MD}')


if __name__ == '__main__':
    main()
