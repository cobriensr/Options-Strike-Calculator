"""Category B brainstorm: at-event signals for gamma-node-rejection v4.

Tests 6 features computed at the wick minute itself.
Down-wick events only (where the bounce thesis applies).

Outputs:
  docs/tmp/forensic-multi-day/category_b_brainstorm_findings.md
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from scipy import stats

ROOT = Path(__file__).resolve().parent.parent
MASTER_CSV = (
    ROOT / 'docs/tmp/forensic-multi-day/gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
)
OUT_MD = ROOT / 'docs/tmp/forensic-multi-day/category_b_brainstorm_findings.md'

load_dotenv(ROOT / '.env.local')
DSN = os.environ['DATABASE_URL_UNPOOLED']


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def paired_test(events: pd.DataFrame) -> dict:
    """Paired t-test on ret_30m vs control_ret_30m within a subset."""
    sub = events.dropna(subset=['ret_30m', 'control_ret_30m'])
    n = len(sub)
    if n < 5:
        return {'n': n, 'event_mean': np.nan, 'ctrl_mean': np.nan,
                'delta': np.nan, 'p': np.nan, 't': np.nan}
    t, p = stats.ttest_rel(sub['ret_30m'], sub['control_ret_30m'])
    return {
        'n': n,
        'event_mean': float(sub['ret_30m'].mean()),
        'ctrl_mean': float(sub['control_ret_30m'].mean()),
        'delta': float((sub['ret_30m'] - sub['control_ret_30m']).mean()),
        'p': float(p),
        't': float(t),
    }


def walkforward(events: pd.DataFrame) -> tuple[dict, dict]:
    """Split into H1/H2 by event_ts median; return paired stats per half."""
    sub = events.dropna(subset=['ret_30m', 'control_ret_30m']).copy()
    if len(sub) < 20:
        return {}, {}
    sub = sub.sort_values('event_ts')
    mid = len(sub) // 2
    return paired_test(sub.iloc[:mid]), paired_test(sub.iloc[mid:])


def fmt(d: dict) -> str:
    if not d or pd.isna(d.get('delta', np.nan)):
        return f"n={d.get('n', 0)} INSUFFICIENT"
    return (
        f"n={d['n']} event={d['event_mean']:+.2f} ctrl={d['ctrl_mean']:+.2f} "
        f"Δ={d['delta']:+.2f} p={d['p']:.4f}"
    )


# ---------------------------------------------------------------------------
# Load master CSV - down-wick events only
# ---------------------------------------------------------------------------

print('Loading master CSV ...')
df_all = pd.read_csv(MASTER_CSV)
df_all['event_ts'] = pd.to_datetime(df_all['event_ts'], utc=True)
df_all['control_ts'] = pd.to_datetime(df_all['control_ts'], utc=True)
down = df_all[df_all['direction'] == 'down'].copy().reset_index(drop=True)
print(f'  down-wick events: {len(down)}')

# Truncate event_ts to minute for DB lookups
down['event_min'] = down['event_ts'].dt.floor('min')

# ---------------------------------------------------------------------------
# DB connection
# ---------------------------------------------------------------------------

conn = psycopg2.connect(DSN)
cur = conn.cursor()

findings: list[str] = []
findings.append('# Category B brainstorm findings\n')
findings.append('Generated 2026-05-21. At-event signals for gamma-node-rejection v4 (down-wicks only).\n')
findings.append(f'**Pool**: {len(down)} down-wick events from {MASTER_CSV.name}.\n')


# ---------------------------------------------------------------------------
# B1. ES futures basis at wick
# ---------------------------------------------------------------------------

print('\n=== B1. ES futures basis ===')

def fetch_es_close(ts_list: list[pd.Timestamp]) -> dict:
    """Fetch ES close at exact minute. Returns {minute_ts -> close}."""
    if not ts_list:
        return {}
    ts_sql = ','.join(f"'{t.isoformat()}'" for t in ts_list)
    cur.execute(
        f"SELECT ts, close FROM futures_bars WHERE symbol='ES' AND ts IN ({ts_sql})"
    )
    return {r[0]: float(r[1]) for r in cur.fetchall()}


def fetch_spx_close(ts_list: list[pd.Timestamp]) -> dict:
    if not ts_list:
        return {}
    ts_sql = ','.join(f"'{t.isoformat()}'" for t in ts_list)
    cur.execute(
        f"SELECT timestamp, close FROM index_candles_1m WHERE symbol='SPX' AND timestamp IN ({ts_sql})"
    )
    return {r[0]: float(r[1]) for r in cur.fetchall()}


need_ts = sorted({t for t in down['event_min']} | {t - pd.Timedelta(minutes=5) for t in down['event_min']})
es_close = fetch_es_close(need_ts)
spx_close = fetch_spx_close(need_ts)
print(f'  ES bars hit: {sum(1 for t in need_ts if t in es_close)}/{len(need_ts)}')
print(f'  SPX bars hit: {sum(1 for t in need_ts if t in spx_close)}/{len(need_ts)}')


def lookup(d: dict, t: pd.Timestamp):
    return d.get(t, np.nan)


down['es_t0'] = down['event_min'].map(lambda t: lookup(es_close, t))
down['es_t5b'] = down['event_min'].map(lambda t: lookup(es_close, t - pd.Timedelta(minutes=5)))
down['spx_t0'] = down['event_min'].map(lambda t: lookup(spx_close, t))
down['spx_t5b'] = down['event_min'].map(lambda t: lookup(spx_close, t - pd.Timedelta(minutes=5)))
down['basis_t0'] = down['es_t0'] - down['spx_t0']
down['basis_t5b'] = down['es_t5b'] - down['spx_t5b']
down['dbasis'] = down['basis_t0'] - down['basis_t5b']

b1_sub = down.dropna(subset=['dbasis']).copy()
print(f'  B1 usable events: {len(b1_sub)}')

findings.append('\n## B1. ES futures basis change (5-min window into wick)\n')
findings.append(
    f'Basis = ES_close - SPX_close; Δbasis = basis(event_min) - basis(event_min - 5).\n'
    f'Usable events: **{len(b1_sub)}**.\n\n'
)

if len(b1_sub) >= 20:
    b1_sub['dbasis_q'] = pd.qcut(b1_sub['dbasis'], 4, labels=['Q1_worst', 'Q2', 'Q3', 'Q4_best'], duplicates='drop')
    findings.append('| Bucket | Δbasis range | ' + ' | '.join(['n', 'event_ret_30m', 'ctrl_ret_30m', 'Δ', 'p']) + ' |\n')
    findings.append('|---|---|---|---|---|---|---|\n')
    for q, grp in b1_sub.groupby('dbasis_q', observed=True):
        res = paired_test(grp)
        rng = f"[{grp['dbasis'].min():+.2f}, {grp['dbasis'].max():+.2f}]"
        findings.append(
            f"| {q} | {rng} | {res['n']} | {res['event_mean']:+.2f} | "
            f"{res['ctrl_mean']:+.2f} | {res['delta']:+.2f} | {res['p']:.4f} |\n"
        )

    # Hypothesis test: basis HOLDING UP (top quartile = least negative / most positive)
    best = b1_sub[b1_sub['dbasis_q'] == 'Q4_best']
    res_best = paired_test(best)
    findings.append(f"\n**Best bucket (basis holding up, Q4)**: {fmt(res_best)}\n")
    if res_best['n'] >= 20:
        h1, h2 = walkforward(best)
        findings.append(f"  - Walk-forward H1: {fmt(h1)}\n")
        findings.append(f"  - Walk-forward H2: {fmt(h2)}\n")

    # Overall paired test (does basis change correlate with forward returns?)
    rho, prho = stats.pearsonr(b1_sub['dbasis'], b1_sub['ret_30m'] - b1_sub['control_ret_30m'])
    findings.append(
        f"\nPearson ρ(Δbasis, ret_30m - ctrl_ret_30m) = {rho:.3f} (p={prho:.4f}, n={len(b1_sub)}).\n"
    )
else:
    findings.append('INSUFFICIENT DATA.\n')


# ---------------------------------------------------------------------------
# B2. NDX cross-index wick depth
# ---------------------------------------------------------------------------

print('\n=== B2. NDX cross-index ===')

def fetch_ndx_bar(ts_list: list[pd.Timestamp]) -> dict:
    if not ts_list:
        return {}
    ts_sql = ','.join(f"'{t.isoformat()}'" for t in ts_list)
    cur.execute(
        f"SELECT timestamp, open, high, low, close FROM index_candles_1m "
        f"WHERE symbol='NDX' AND timestamp IN ({ts_sql})"
    )
    return {r[0]: (float(r[1]), float(r[2]), float(r[3]), float(r[4])) for r in cur.fetchall()}


ndx_bars = fetch_ndx_bar(sorted(set(down['event_min'])))
print(f'  NDX bars hit: {sum(1 for t in down["event_min"] if t in ndx_bars)}/{len(down)}')


def ndx_wick_depth(t):
    b = ndx_bars.get(t)
    if not b:
        return np.nan
    o, h, l, c = b
    if c == 0:
        return np.nan
    return (h - l) / c


down['ndx_wick'] = down['event_min'].map(ndx_wick_depth)

b2_sub = down.dropna(subset=['ndx_wick']).copy()
print(f'  B2 usable events: {len(b2_sub)}')

findings.append('\n## B2. NDX concurrent wick depth\n')
findings.append(
    f'For each SPX down-wick event, compute NDX 1-min wick depth = (high-low)/close at same minute.\n'
    f'Usable events: **{len(b2_sub)}**.\n\n'
)

if len(b2_sub) >= 20:
    b2_sub['ndx_q'] = pd.qcut(b2_sub['ndx_wick'], 4, labels=['Q1_low', 'Q2', 'Q3', 'Q4_high'], duplicates='drop')
    findings.append('| NDX wick bucket | n | event_ret_30m | ctrl_ret_30m | Δ | p |\n')
    findings.append('|---|---|---|---|---|---|\n')
    for q, grp in b2_sub.groupby('ndx_q', observed=True):
        res = paired_test(grp)
        findings.append(
            f"| {q} | {res['n']} | {res['event_mean']:+.2f} | {res['ctrl_mean']:+.2f} | "
            f"{res['delta']:+.2f} | {res['p']:.4f} |\n"
        )

    # Hypothesis: NDX ALSO had a large wick (top quartile) => co-capitulation
    big_q = b2_sub[b2_sub['ndx_q'] == 'Q4_high']
    small_q = b2_sub[b2_sub['ndx_q'] == 'Q1_low']
    res_big = paired_test(big_q)
    res_small = paired_test(small_q)
    findings.append(f"\n**Q4 (NDX also big wick)**: {fmt(res_big)}\n")
    findings.append(f"**Q1 (NDX steady)**: {fmt(res_small)}\n")
    if res_big['n'] >= 20:
        h1, h2 = walkforward(big_q)
        findings.append(f"  Q4 Walk-forward H1: {fmt(h1)}\n")
        findings.append(f"  Q4 Walk-forward H2: {fmt(h2)}\n")
else:
    findings.append('INSUFFICIENT DATA.\n')


# ---------------------------------------------------------------------------
# B3. Market internals divergence ($ADD / $TICK)
# ---------------------------------------------------------------------------

print('\n=== B3. Market internals divergence ===')

# Pull all $ADD between event range
cur.execute("""
SELECT ts, symbol, close FROM market_internals
WHERE symbol IN ('$ADD','$TICK','$TRIN')
ORDER BY ts
""")
mi_rows = cur.fetchall()
mi_df = pd.DataFrame(mi_rows, columns=['ts', 'symbol', 'close'])
mi_df['ts'] = pd.to_datetime(mi_df['ts'], utc=True)
mi_df['close'] = mi_df['close'].astype(float)
print(f'  market_internals rows: {len(mi_df)}')
add_df = mi_df[mi_df.symbol == '$ADD'].sort_values('ts').reset_index(drop=True)
print(f'  $ADD rows: {len(add_df)}')


def add_at(t: pd.Timestamp, window_min: int = 5):
    # nearest-prior $ADD reading within `window_min` minutes
    cutoff_lo = t - pd.Timedelta(minutes=window_min)
    sub = add_df[(add_df.ts <= t) & (add_df.ts >= cutoff_lo)]
    if len(sub) == 0:
        return np.nan
    return sub.iloc[-1]['close']


down['add_t0'] = down['event_min'].map(lambda t: add_at(t, 5))
down['add_t10b'] = down['event_min'].map(lambda t: add_at(t - pd.Timedelta(minutes=10), 5))
down['add_delta'] = down['add_t0'] - down['add_t10b']

b3_sub = down.dropna(subset=['add_delta']).copy()
print(f'  B3 usable events: {len(b3_sub)}')

findings.append('\n## B3. $ADD (advance-decline) divergence\n')
findings.append(
    f'Δ$ADD = $ADD(event_min) - $ADD(event_min - 10). Positive Δ during SPX down-wick = positive divergence.\n'
    f'Usable events: **{len(b3_sub)}**.\n\n'
)

if len(b3_sub) >= 20:
    b3_sub['add_q'] = pd.qcut(b3_sub['add_delta'], 4, labels=['Q1_worst', 'Q2', 'Q3', 'Q4_div+'], duplicates='drop')
    findings.append('| Δ$ADD bucket | n | event_ret_30m | ctrl_ret_30m | Δ | p |\n')
    findings.append('|---|---|---|---|---|---|\n')
    for q, grp in b3_sub.groupby('add_q', observed=True):
        res = paired_test(grp)
        findings.append(
            f"| {q} | {res['n']} | {res['event_mean']:+.2f} | {res['ctrl_mean']:+.2f} | "
            f"{res['delta']:+.2f} | {res['p']:.4f} |\n"
        )

    div = b3_sub[b3_sub['add_q'] == 'Q4_div+']
    res_div = paired_test(div)
    findings.append(f"\n**Q4 (positive divergence)**: {fmt(res_div)}\n")
    if res_div['n'] >= 20:
        h1, h2 = walkforward(div)
        findings.append(f"  Walk-forward H1: {fmt(h1)}\n")
        findings.append(f"  Walk-forward H2: {fmt(h2)}\n")
else:
    findings.append('INSUFFICIENT DATA.\n')


# ---------------------------------------------------------------------------
# B4. Interval B/A alert flip
# ---------------------------------------------------------------------------

print('\n=== B4. Interval B/A alerts ===')

# Pull all interval_ba_alerts in event window
cur.execute("""
SELECT fired_at, option_type, ratio_pct
FROM interval_ba_alerts
WHERE ticker = 'SPXW' OR ticker = 'SPX'
ORDER BY fired_at
""")
iba_rows = cur.fetchall()
iba_df = pd.DataFrame(iba_rows, columns=['fired_at', 'option_type', 'ratio_pct'])
iba_df['fired_at'] = pd.to_datetime(iba_df['fired_at'], utc=True)
iba_df['ratio_pct'] = iba_df['ratio_pct'].astype(float)
print(f'  SPX/SPXW interval_ba_alerts rows: {len(iba_df)}')


def iba_features(t: pd.Timestamp):
    # 10-min bucket boundaries
    lo = t - pd.Timedelta(minutes=10)
    hi = t + pd.Timedelta(minutes=10)
    sub = iba_df[(iba_df['fired_at'] >= lo) & (iba_df['fired_at'] <= hi)]
    if len(sub) == 0:
        return (np.nan, np.nan, 0)
    # Average ask_share for puts (selling pressure into the wick)
    puts = sub[sub['option_type'] == 'P']
    calls = sub[sub['option_type'] == 'C']
    p_mean = puts['ratio_pct'].mean() if len(puts) else np.nan
    c_mean = calls['ratio_pct'].mean() if len(calls) else np.nan
    return (p_mean, c_mean, len(sub))


down['iba_put_ask'], down['iba_call_ask'], down['iba_count'] = zip(
    *down['event_min'].map(iba_features)
)

b4_sub = down.dropna(subset=['iba_put_ask']).copy()
print(f'  B4 usable events (put-side alert nearby): {len(b4_sub)}')

findings.append('\n## B4. Interval B/A alert ratio (SPX/SPXW puts)\n')
findings.append(
    'Avg ratio_pct of put-side B/A alerts fired in ±10 min window around event.\n'
    'High ratio_pct = ask-heavy (selling continues); low = bid-heavy (selling exhausted).\n'
    f'Usable events: **{len(b4_sub)}**.\n\n'
)

if len(b4_sub) >= 20:
    b4_sub['iba_q'] = pd.qcut(b4_sub['iba_put_ask'], 3, labels=['low', 'mid', 'high'], duplicates='drop')
    findings.append('| Put ask% bucket | n | event_ret_30m | ctrl_ret_30m | Δ | p |\n')
    findings.append('|---|---|---|---|---|---|\n')
    for q, grp in b4_sub.groupby('iba_q', observed=True):
        res = paired_test(grp)
        findings.append(
            f"| {q} | {res['n']} | {res['event_mean']:+.2f} | {res['ctrl_mean']:+.2f} | "
            f"{res['delta']:+.2f} | {res['p']:.4f} |\n"
        )

    # Hypothesis: LOW put-ask% = put selling done = bounce
    low_ask = b4_sub[b4_sub['iba_q'] == 'low']
    res_low = paired_test(low_ask)
    findings.append(f"\n**Low put-ask% (selling exhausted)**: {fmt(res_low)}\n")
    if res_low['n'] >= 20:
        h1, h2 = walkforward(low_ask)
        findings.append(f"  Walk-forward H1: {fmt(h1)}\n")
        findings.append(f"  Walk-forward H2: {fmt(h2)}\n")
else:
    findings.append('INSUFFICIENT DATA.\n')


# ---------------------------------------------------------------------------
# B5. Wick bar SPX volume
# ---------------------------------------------------------------------------

print('\n=== B5. Wick bar volume ===')

cur.execute("""
SELECT timestamp, volume FROM index_candles_1m WHERE symbol='SPX'
""")
spx_vol_rows = cur.fetchall()
spx_vol = {r[0]: int(r[1]) if r[1] is not None else None for r in spx_vol_rows}
print(f'  SPX 1m vol rows: {len(spx_vol)}')

down['wick_vol'] = down['event_min'].map(lambda t: spx_vol.get(t))
down['wick_vol'] = pd.to_numeric(down['wick_vol'], errors='coerce')

b5_sub = down.dropna(subset=['wick_vol']).copy()
b5_sub = b5_sub[b5_sub['wick_vol'] > 0]  # drop zero-vol bars
print(f'  B5 usable events (vol > 0): {len(b5_sub)}')

findings.append('\n## B5. SPX wick-bar volume (capitulation proxy)\n')
findings.append(
    'Volume on the wick minute itself, quartiled across all down-wick events.\n'
    f'Usable events (vol > 0): **{len(b5_sub)}**.\n\n'
)

if len(b5_sub) >= 20:
    b5_sub['vol_q'] = pd.qcut(b5_sub['wick_vol'], 4, labels=['Q1_low', 'Q2', 'Q3', 'Q4_high'], duplicates='drop')
    findings.append('| Vol bucket | n | event_ret_30m | ctrl_ret_30m | Δ | p |\n')
    findings.append('|---|---|---|---|---|---|\n')
    for q, grp in b5_sub.groupby('vol_q', observed=True):
        res = paired_test(grp)
        findings.append(
            f"| {q} | {res['n']} | {res['event_mean']:+.2f} | {res['ctrl_mean']:+.2f} | "
            f"{res['delta']:+.2f} | {res['p']:.4f} |\n"
        )

    high = b5_sub[b5_sub['vol_q'] == 'Q4_high']
    res_h = paired_test(high)
    findings.append(f"\n**Q4 (high-vol capitulation wick)**: {fmt(res_h)}\n")
    if res_h['n'] >= 20:
        h1, h2 = walkforward(high)
        findings.append(f"  Walk-forward H1: {fmt(h1)}\n")
        findings.append(f"  Walk-forward H2: {fmt(h2)}\n")

    low = b5_sub[b5_sub['vol_q'] == 'Q1_low']
    res_l = paired_test(low)
    findings.append(f"**Q1 (low-vol drift wick)**: {fmt(res_l)}\n")
else:
    findings.append('INSUFFICIENT DATA.\n')


# ---------------------------------------------------------------------------
# B6. SPX volatility contraction (iv_monitor.volatility)
# ---------------------------------------------------------------------------

print('\n=== B6. iv_monitor delta ===')

cur.execute("""
SELECT timestamp, volatility FROM iv_monitor ORDER BY timestamp
""")
iv_rows = cur.fetchall()
iv_df = pd.DataFrame(iv_rows, columns=['ts', 'vol'])
iv_df['ts'] = pd.to_datetime(iv_df['ts'], utc=True)
iv_df['vol'] = iv_df['vol'].astype(float)
iv_df = iv_df.sort_values('ts').reset_index(drop=True)
print(f'  iv_monitor rows: {len(iv_df)} (range: {iv_df.ts.min()} -> {iv_df.ts.max()})')


def iv_at(t: pd.Timestamp, window_min: int = 30):
    cutoff_lo = t - pd.Timedelta(minutes=window_min)
    sub = iv_df[(iv_df.ts <= t) & (iv_df.ts >= cutoff_lo)]
    if len(sub) == 0:
        return np.nan
    return sub.iloc[-1]['vol']


down['iv_t0'] = down['event_min'].map(lambda t: iv_at(t, 30))
down['iv_t15b'] = down['event_min'].map(lambda t: iv_at(t - pd.Timedelta(minutes=15), 30))
down['div'] = down['iv_t0'] - down['iv_t15b']

b6_sub = down.dropna(subset=['div']).copy()
print(f'  B6 usable events: {len(b6_sub)}')

findings.append('\n## B6. SPX implied-vol delta (iv_monitor)\n')
findings.append(
    'Δvol = iv_monitor.volatility(event_min) - iv_monitor.volatility(event_min - 15).\n'
    'Negative Δ during down-wick = vol contracting = exhaustion.\n'
    f'Usable events: **{len(b6_sub)}**.\n'
    f'NOTE: iv_monitor coverage ends 2026-04-29; later events drop out.\n\n'
)

if len(b6_sub) >= 20:
    b6_sub['div_q'] = pd.qcut(b6_sub['div'], 3, labels=['contracting', 'flat', 'expanding'], duplicates='drop')
    findings.append('| Δvol bucket | n | event_ret_30m | ctrl_ret_30m | Δ | p |\n')
    findings.append('|---|---|---|---|---|---|\n')
    for q, grp in b6_sub.groupby('div_q', observed=True):
        res = paired_test(grp)
        findings.append(
            f"| {q} | {res['n']} | {res['event_mean']:+.2f} | {res['ctrl_mean']:+.2f} | "
            f"{res['delta']:+.2f} | {res['p']:.4f} |\n"
        )

    contr = b6_sub[b6_sub['div_q'] == 'contracting']
    res_c = paired_test(contr)
    findings.append(f"\n**Vol contracting**: {fmt(res_c)}\n")
    if res_c['n'] >= 20:
        h1, h2 = walkforward(contr)
        findings.append(f"  Walk-forward H1: {fmt(h1)}\n")
        findings.append(f"  Walk-forward H2: {fmt(h2)}\n")

    exp = b6_sub[b6_sub['div_q'] == 'expanding']
    res_e = paired_test(exp)
    findings.append(f"**Vol expanding**: {fmt(res_e)}\n")
else:
    findings.append('INSUFFICIENT DATA.\n')


# ---------------------------------------------------------------------------
# Combo: pair best B-signal with Monday + |gex|≤500k filter
# ---------------------------------------------------------------------------

findings.append('\n## Bonus. Combo with shipped Monday + |gex|≤500k filter\n')
findings.append(
    'For each B-signal best bucket, intersect with the shipped Monday + |gex|≤500k filter '
    'and report n and Δ. Only useful if base n stays viable.\n\n'
)

# Recompute Monday + |gex|≤500k mask on the down sub-frame
down['weekday'] = down['event_ts'].dt.dayofweek  # 0 = Mon
down['mon_lowgex'] = (down['weekday'] == 0) & (down['node_gex'].abs() <= 500)

combo_rows = []
for label, mask_col in [
    ('B1 Q4 (basis hold)', 'b1_best'),
    ('B2 Q4 (NDX big wick)', 'b2_q4'),
    ('B3 Q4 (+div)', 'b3_q4'),
    ('B5 Q4 (high vol)', 'b5_q4'),
    ('B6 contracting', 'b6_contracting'),
]:
    pass  # placeholder; recompute below with consistent masks

# Build consistent masks (re-quartile each feature on `down`)
try:
    down['b1_q'] = pd.qcut(down['dbasis'], 4, labels=False, duplicates='drop')
    down['b1_best'] = down['b1_q'] == 3
except Exception:
    down['b1_best'] = False
try:
    down['b2_q'] = pd.qcut(down['ndx_wick'], 4, labels=False, duplicates='drop')
    down['b2_q4'] = down['b2_q'] == 3
except Exception:
    down['b2_q4'] = False
try:
    down['b3_q'] = pd.qcut(down['add_delta'], 4, labels=False, duplicates='drop')
    down['b3_q4'] = down['b3_q'] == 3
except Exception:
    down['b3_q4'] = False
try:
    down['b5_q'] = pd.qcut(down['wick_vol'], 4, labels=False, duplicates='drop')
    down['b5_q4'] = down['b5_q'] == 3
except Exception:
    down['b5_q4'] = False
try:
    down['b6_q'] = pd.qcut(down['div'], 3, labels=False, duplicates='drop')
    down['b6_contracting'] = down['b6_q'] == 0
except Exception:
    down['b6_contracting'] = False


findings.append('| Combo (B-signal AND Monday+|gex|≤500k) | n | Δ | p |\n')
findings.append('|---|---|---|---|\n')
for label, mask_col in [
    ('B1 Q4 basis-hold', 'b1_best'),
    ('B2 Q4 NDX big wick', 'b2_q4'),
    ('B3 Q4 +divergence', 'b3_q4'),
    ('B5 Q4 high vol', 'b5_q4'),
    ('B6 vol contracting', 'b6_contracting'),
]:
    if mask_col not in down.columns:
        continue
    combo = down[down[mask_col] & down['mon_lowgex']]
    res = paired_test(combo)
    findings.append(f"| {label} | {res['n']} | {res['delta']:+.2f} | {res['p']:.4f} |\n")

# Also: each B-signal best bucket vs ALL events (not just Mon+lowGEX)
findings.append('\n### Each B-signal best bucket on the full down-wick pool\n')
findings.append('| Best bucket | n | event | ctrl | Δ | p |\n')
findings.append('|---|---|---|---|---|---|\n')
for label, mask_col in [
    ('B1 Q4 basis-hold', 'b1_best'),
    ('B2 Q4 NDX big wick', 'b2_q4'),
    ('B3 Q4 +divergence', 'b3_q4'),
    ('B5 Q4 high vol', 'b5_q4'),
    ('B6 vol contracting', 'b6_contracting'),
]:
    if mask_col not in down.columns:
        continue
    sub = down[down[mask_col]]
    res = paired_test(sub)
    findings.append(
        f"| {label} | {res['n']} | {res['event_mean']:+.2f} | "
        f"{res['ctrl_mean']:+.2f} | {res['delta']:+.2f} | {res['p']:.4f} |\n"
    )

# ---------------------------------------------------------------------------
# Persist
# ---------------------------------------------------------------------------

OUT_MD.parent.mkdir(parents=True, exist_ok=True)
OUT_MD.write_text(''.join(findings))
print(f'\nWrote {OUT_MD}')

conn.close()
