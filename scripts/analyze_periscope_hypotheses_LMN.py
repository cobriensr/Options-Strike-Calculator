"""Test Hypotheses L / M / N — remaining open threads.

  L — Charm at below-spot strikes → OTM PUT lottery R outcomes.
      Hypothesis H found charm forecasts NEGATIVE forward returns. If real,
      below-spot charm events should produce tradeable put-lottery outcomes
      (the symmetric analog of Hypothesis A's call-lottery edge).

  M — Charm + gamma confluence. Are events where a same-strike same-slice
      charm AND gamma event coincide a sharper signal than either alone?

  N — Gamma "wall" structure. For each gamma event, sum |γ| across the
      ±15-pt strike band at the same slice. Test whether wall height (level
      of the structural exposure around the event strike) predicts R
      outcomes better than single-strike level (E).

Inputs:
  docs/tmp/forensic-multi-day/hypothesis_F_charm_vanna.csv (charm events)
  docs/tmp/forensic-multi-day/hypothesis_B_events.csv      (gamma events)
  docs/tmp/forensic-multi-day/hypothesis_B_control.csv     (controls)
  Neon: periscope_snapshots (all panels), index_candles_1m
  ~/Desktop/Bot-Eod-parquet/*.parquet (for L put-lottery R)

Outputs:
  hypothesis_L_charm_puts.csv
  hypothesis_M_confluence.csv
  hypothesis_N_wall.csv
  hypothesis_LMN_findings.md
"""
from __future__ import annotations

import os
import warnings
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
import pyarrow.parquet as pq
from dotenv import load_dotenv
from scipy import stats

warnings.filterwarnings('ignore')
load_dotenv('.env.local')

PARQUET_DIR = Path('/Users/charlesobrien/Desktop/Bot-Eod-parquet')
OUT = Path('docs/tmp/forensic-multi-day')
DB_URL = os.environ['DATABASE_URL_UNPOOLED']
HORIZONS_MIN = [30, 60]


# --------------------------- HELPERS --------------------------------------


def cohens_d(a: np.ndarray, b: np.ndarray) -> float:
    pooled = np.sqrt((np.var(a, ddof=1) + np.var(b, ddof=1)) / 2)
    return 0.0 if pooled == 0 else float((a.mean() - b.mean()) / pooled)


def db_query(sql: str) -> pd.DataFrame:
    with psycopg2.connect(DB_URL) as conn:
        return pd.read_sql(sql, conn)


def first_trade(parquet_path: Path, strike: float, option_type: str,
                expiry: date, ts_from: pd.Timestamp, ts_to: pd.Timestamp
                ) -> float | None:
    tbl = pq.read_table(
        parquet_path,
        filters=[
            ('underlying_symbol', '=', 'SPXW'),
            ('expiry', '=', expiry),
            ('option_type', '=', option_type),
            ('strike', '=', float(strike)),
            ('executed_at', '>=', ts_from.to_pydatetime()),
            ('executed_at', '<=', ts_to.to_pydatetime()),
        ],
        columns=['executed_at', 'price'],
    )
    if tbl.num_rows == 0:
        return None
    df = tbl.to_pandas().sort_values('executed_at')
    return float(df.iloc[0]['price'])


def max_trade(parquet_path: Path, strike: float, option_type: str,
              expiry: date, ts_from: pd.Timestamp, ts_to: pd.Timestamp
              ) -> float | None:
    tbl = pq.read_table(
        parquet_path,
        filters=[
            ('underlying_symbol', '=', 'SPXW'),
            ('expiry', '=', expiry),
            ('option_type', '=', option_type),
            ('strike', '=', float(strike)),
            ('executed_at', '>=', ts_from.to_pydatetime()),
            ('executed_at', '<=', ts_to.to_pydatetime()),
        ],
        columns=['price'],
    )
    if tbl.num_rows == 0:
        return None
    return float(tbl.to_pandas()['price'].max())


# --------------------------- HYPOTHESIS L --------------------------------


def put_lottery_R(parquet_path: Path, event_strike: float, expiry: date,
                  ts: pd.Timestamp, offsets: list[int] = [25, 50, 75, 100],
                  horizons: list[int] = HORIZONS_MIN) -> dict:
    """For a below-spot event at strike K, compute put-lottery R at strikes
    K-{25,50,75,100} (further below spot). R = (max - entry) / entry.
    """
    out: dict = {}
    for off in offsets:
        trade_k = event_strike - off
        entry_window = ts + pd.Timedelta(minutes=5)
        entry = first_trade(parquet_path, trade_k, 'put', expiry, ts,
                            entry_window)
        if entry is None or entry <= 0:
            for h in horizons:
                out[f'put_kmin{off}_R_{h}m'] = None
            continue
        for h in horizons:
            mx = max_trade(parquet_path, trade_k, 'put', expiry,
                           ts, ts + pd.Timedelta(minutes=h))
            out[f'put_kmin{off}_R_{h}m'] = (
                (mx - entry) / entry if mx is not None else None)
    return out


def run_L(charm_events: pd.DataFrame, control: pd.DataFrame) -> pd.DataFrame:
    """For each below-spot charm event, compute put-lottery R. Compare to
    random control sample (random strikes below spot at random times).
    """
    rows: list[dict] = []
    # Below-spot charm events (strike < spot_at_event)
    below = charm_events[charm_events['strike'] < charm_events['spot_at_event']].copy()
    below['captured_at'] = pd.to_datetime(below['captured_at'], utc=True,
                                            format='ISO8601')
    print(f'  L charm-below-spot candidates: {len(below)}')

    for _, ev in below.iterrows():
        d = date.fromisoformat(ev['day'])
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists():
            continue
        R = put_lottery_R(path, float(ev['strike']), d, ev['captured_at'])
        row = {'group': 'charm_below', 'day': ev['day'],
               'captured_at': ev['captured_at'], 'strike': ev['strike'],
               'spot_at_event': ev['spot_at_event']}
        row.update(R)
        rows.append(row)

    # Control: random samples on the same days, restrict strike to be
    # 25-100 below spot
    ctrl = control.copy()
    ctrl['captured_at'] = pd.to_datetime(ctrl['captured_at'], utc=True,
                                          format='ISO8601')
    # Take below-spot subset of controls
    ctrl_below = ctrl[(ctrl['event_otm_dir'] == 'below')
                       & ctrl['spot_at_event'].notna()].copy()
    n_ctrl = min(300, len(ctrl_below))
    print(f'  L control candidates: {n_ctrl}')
    ctrl_sample = ctrl_below.sample(n=n_ctrl, random_state=42)
    for _, ev in ctrl_sample.iterrows():
        d = date.fromisoformat(ev['day'])
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists():
            continue
        R = put_lottery_R(path, float(ev['strike']), d, ev['captured_at'])
        row = {'group': 'control_below', 'day': ev['day'],
               'captured_at': ev['captured_at'], 'strike': ev['strike'],
               'spot_at_event': ev['spot_at_event']}
        row.update(R)
        rows.append(row)
    return pd.DataFrame(rows)


# --------------------------- HYPOTHESIS M: CONFLUENCE --------------------


def run_M(gamma_events: pd.DataFrame) -> pd.DataFrame:
    """For each gamma event, check if there's a charm event at the same
    (day, strike) within ±1 Periscope slice. Sub-classify and compare R.
    """
    # Re-pull charm events from DB with same top-1% per-day filter
    print('  Loading all charm events for confluence join...')
    charm = db_query("""
        WITH t AS (
            SELECT captured_at, expiry::date AS day, strike, value,
                   LAG(value) OVER (PARTITION BY expiry, strike
                                    ORDER BY captured_at) AS prior_value
            FROM periscope_snapshots
            WHERE panel = 'charm'
              AND expiry BETWEEN '2026-04-13' AND '2026-05-18'
        )
        SELECT captured_at, day, strike, value, prior_value,
               value - prior_value AS delta
        FROM t WHERE prior_value IS NOT NULL
        ORDER BY day, strike, captured_at
    """)
    charm['captured_at'] = pd.to_datetime(charm['captured_at'], utc=True)
    # Per-day top-1% threshold
    charm_events: list[pd.DataFrame] = []
    for day, g in charm.groupby('day'):
        threshold = float(g['delta'].abs().quantile(0.99))
        charm_events.append(g[g['delta'].abs() >= threshold])
    charm_e = pd.concat(charm_events, ignore_index=True)
    print(f'  Charm events available for confluence: {len(charm_e)}')

    # For each gamma event, find nearest charm event at same (day, strike)
    ge = gamma_events.copy()
    ge['captured_at'] = pd.to_datetime(ge['captured_at'], utc=True,
                                         format='ISO8601')
    ge['day'] = ge['day'].astype(str)
    charm_e['day'] = charm_e['day'].astype(str)

    confluence_flag: list[bool] = []
    for _, e in ge.iterrows():
        same = charm_e[(charm_e['day'] == e['day'])
                       & (charm_e['strike'] == e['strike'])]
        if same.empty:
            confluence_flag.append(False)
            continue
        # Within ±15 min (about 1 slice spacing)
        near = same[
            (same['captured_at'].between(
                e['captured_at'] - pd.Timedelta(minutes=15),
                e['captured_at'] + pd.Timedelta(minutes=15)))
        ]
        confluence_flag.append(not near.empty)
    ge['has_charm_confluence'] = confluence_flag
    return ge


# --------------------------- HYPOTHESIS N: WALL --------------------------


def run_N(gamma_events: pd.DataFrame) -> pd.DataFrame:
    """For each gamma event, sum |γ| across ±15-pt strike band at the same
    captured_at. Stratify by wall_height decile.
    """
    print('  Loading full periscope gamma surface...')
    periscope = db_query("""
        SELECT captured_at, expiry::date AS day, strike, value
        FROM periscope_snapshots
        WHERE panel = 'gamma'
          AND expiry BETWEEN '2026-04-13' AND '2026-05-18'
    """)
    periscope['captured_at'] = pd.to_datetime(periscope['captured_at'], utc=True)
    periscope['strike'] = periscope['strike'].astype(float)
    periscope['value'] = periscope['value'].astype(float)
    periscope['day'] = periscope['day'].astype(str)

    ge = gamma_events.copy()
    ge['captured_at'] = pd.to_datetime(ge['captured_at'], utc=True,
                                         format='ISO8601')
    ge['day'] = ge['day'].astype(str)
    ge['strike'] = ge['strike'].astype(float)

    # Index periscope by (day, captured_at, strike)
    ps_by_day_slice = periscope.groupby(
        ['day', 'captured_at'], as_index=True)

    walls: list[float] = []
    same_sign_walls: list[float] = []
    for _, e in ge.iterrows():
        try:
            slice_df = ps_by_day_slice.get_group((e['day'], e['captured_at']))
        except KeyError:
            walls.append(np.nan)
            same_sign_walls.append(np.nan)
            continue
        band = slice_df[(slice_df['strike'] >= e['strike'] - 15)
                        & (slice_df['strike'] <= e['strike'] + 15)]
        if band.empty:
            walls.append(np.nan)
            same_sign_walls.append(np.nan)
            continue
        walls.append(float(band['value'].abs().sum()))
        # Same-sign wall: sum |γ| only for strikes with same sign as event
        sign = np.sign(e['gamma_post'])
        same_sign = band[np.sign(band['value']) == sign]
        same_sign_walls.append(
            float(same_sign['value'].abs().sum()) if not same_sign.empty else 0.0)
    ge['wall_height'] = walls
    ge['same_sign_wall'] = same_sign_walls
    return ge


# --------------------------- REPORT --------------------------------------


def write_findings(l_df: pd.DataFrame, m_df: pd.DataFrame, n_df: pd.DataFrame,
                   out_path: Path) -> None:
    lines: list[str] = []
    lines.append('# Hypotheses L / M / N — final open threads\n')

    # ---- L ----
    lines.append('## L — Charm at below-spot strikes → OTM put lottery R\n')
    if not l_df.empty:
        for grp in ['charm_below', 'control_below']:
            sub = l_df[l_df['group'] == grp]
            if sub.empty:
                continue
            lines.append(f'### {grp} (n={len(sub)})')
            for off in [25, 50, 75, 100]:
                for h in HORIZONS_MIN:
                    col = f'put_kmin{off}_R_{h}m'
                    if col not in sub.columns:
                        continue
                    R = sub[col].dropna().clip(lower=-1)
                    if len(R) < 5:
                        continue
                    lines.append(
                        f'  put_k-{off}, {h}m: n={len(R)}, '
                        f'mean_R={R.mean():.2f}, median_R={R.median():.2f}, '
                        f'hit_R2={(R >= 2).mean() * 100:.2f}%, '
                        f'hit_R5={(R >= 5).mean() * 100:.2f}%, '
                        f'hit_R10={(R >= 10).mean() * 100:.2f}%, '
                        f'max_R={R.max():.2f}'
                    )

        # Direct comparison at k-50, 30m
        lines.append('\n### Comparison at put_k-50, 30m')
        ev = l_df[l_df['group'] == 'charm_below']['put_kmin50_R_30m']
        ct = l_df[l_df['group'] == 'control_below']['put_kmin50_R_30m']
        if not ev.dropna().empty and not ct.dropna().empty:
            ev_a = ev.dropna().clip(lower=-1).to_numpy()
            ct_a = ct.dropna().clip(lower=-1).to_numpy()
            u, p = stats.mannwhitneyu(ev_a, ct_a, alternative='two-sided')
            d = cohens_d(ev_a, ct_a)
            lines.append(f'  Mann-Whitney: U={u:.0f}, p={p:.4f}, '
                          f'Cohen\'s d={d:+.2f}')

    # ---- M ----
    lines.append('\n## M — Charm + gamma confluence (same strike, ±15 min)\n')
    if not m_df.empty:
        conf = m_df[m_df['has_charm_confluence']]
        no_conf = m_df[~m_df['has_charm_confluence']]
        lines.append(f'Total gamma events: {len(m_df)}')
        lines.append(f'With charm confluence: {len(conf)} ({len(conf)/len(m_df)*100:.1f}%)')
        lines.append(f'Without: {len(no_conf)}\n')

        for label, sub in [('confluence', conf),
                           ('confluence ex-5/18',
                            conf[conf['day'] != '2026-05-18']),
                           ('no_confluence', no_conf),
                           ('no_confluence ex-5/18',
                            no_conf[no_conf['day'] != '2026-05-18'])]:
            R = sub['k50_R_30m'].dropna().clip(lower=-1)
            if len(R) < 3:
                continue
            lines.append(
                f'  {label}: n={len(sub)}, n_R={len(R)}, '
                f'mean_R={R.mean():.2f}, hit_R5={(R >= 5).mean() * 100:.1f}%, '
                f'max_R={R.max():.1f}'
            )

        # Within above-spot CT
        lines.append('\n### Within above-spot CT subset')
        for label, sub in [
            ('CT_above + confluence',
             m_df[(m_df['event_otm_dir'] == 'above')
                  & m_df['is_counter_trend']
                  & m_df['has_charm_confluence']]),
            ('CT_above no confluence',
             m_df[(m_df['event_otm_dir'] == 'above')
                  & m_df['is_counter_trend']
                  & ~m_df['has_charm_confluence']]),
            ('CT_above + confluence ex-5/18',
             m_df[(m_df['event_otm_dir'] == 'above')
                  & m_df['is_counter_trend']
                  & m_df['has_charm_confluence']
                  & (m_df['day'] != '2026-05-18')]),
        ]:
            R = sub['k50_R_30m'].dropna().clip(lower=-1)
            if len(R) < 3:
                continue
            lines.append(
                f'  {label}: n={len(sub)}, n_R={len(R)}, '
                f'mean_R={R.mean():.2f}, hit_R5={(R >= 5).mean() * 100:.1f}%, '
                f'max_R={R.max():.1f}'
            )

    # ---- N ----
    lines.append('\n## N — Gamma wall structure (±15-pt strike band)\n')
    if not n_df.empty and 'wall_height' in n_df.columns:
        n_df['wall_decile'] = pd.qcut(n_df['wall_height'].rank(method='first'),
                                       q=10, labels=False, duplicates='drop')
        lines.append('### Hit R5 at k+50/30m by wall_height decile (above-spot only)')
        above = n_df[n_df['event_otm_dir'] == 'above']
        for dec in range(10):
            sub = above[above['wall_decile'] == dec]
            if len(sub) < 5:
                continue
            R = sub['k50_R_30m'].dropna().clip(lower=-1)
            if len(R) < 3:
                continue
            lines.append(
                f'  decile {dec}: n={len(sub)}, n_R={len(R)}, '
                f'mean_R={R.mean():.2f}, hit_R5={(R >= 5).mean() * 100:.1f}%, '
                f'max_R={R.max():.1f}'
            )

        # Top-decile wall AND above-spot
        top_wall_above = n_df[(n_df['wall_decile'] == 9)
                               & (n_df['event_otm_dir'] == 'above')]
        ex_518 = top_wall_above[top_wall_above['day'] != '2026-05-18']
        lines.append('\n### Top-decile wall + above-spot')
        for label, sub in [('with 5/18', top_wall_above),
                            ('ex-5/18', ex_518)]:
            R = sub['k50_R_30m'].dropna().clip(lower=-1)
            if len(R) < 3:
                continue
            lines.append(
                f'  {label}: n={len(sub)}, n_R={len(R)}, '
                f'mean_R={R.mean():.2f}, hit_R5={(R >= 5).mean() * 100:.1f}%, '
                f'max_R={R.max():.1f}'
            )

        # Interaction with E (top-both axes)
        lines.append('\n### Interaction: top-decile wall + top-both axes + above-spot')
        # Need level + change deciles — re-merge from E csv
        e_df = pd.read_csv(OUT / 'hypothesis_E_level_vs_change.csv')
        e_df['captured_at'] = pd.to_datetime(e_df['captured_at'], utc=True,
                                              format='ISO8601')
        merged = above.merge(
            e_df[['day', 'captured_at', 'strike', 'level_decile',
                  'change_decile']],
            on=['day', 'captured_at', 'strike'], how='left')
        triple = merged[(merged['wall_decile'] == 9)
                        & (merged['level_decile'] == 9)
                        & (merged['change_decile'] == 9)]
        triple_ex = triple[triple['day'] != '2026-05-18']
        for label, sub in [('triple top (wall + level + change)', triple),
                            ('triple top ex-5/18', triple_ex)]:
            R = sub['k50_R_30m'].dropna().clip(lower=-1)
            if len(R) < 3:
                continue
            lines.append(
                f'  {label}: n={len(sub)}, n_R={len(R)}, '
                f'mean_R={R.mean():.2f}, hit_R5={(R >= 5).mean() * 100:.1f}%, '
                f'max_R={R.max():.1f}'
            )

    out_path.write_text('\n'.join(lines))


# --------------------------- DRIVER --------------------------------------


def main() -> None:
    print('Loading artifacts...')
    charm = pd.read_csv(OUT / 'hypothesis_F_charm_vanna.csv')
    charm = charm[charm['panel'] == 'charm'].copy()
    events_b = pd.read_csv(OUT / 'hypothesis_B_events.csv')
    control_b = pd.read_csv(OUT / 'hypothesis_B_control.csv')
    print(f'  charm events: {len(charm)}, gamma events: {len(events_b)}')

    print('\n=== L: Charm × OTM put lottery (parquet scans, will take a few min) ===')
    l_df = run_L(charm, control_b)
    l_df.to_csv(OUT / 'hypothesis_L_charm_puts.csv', index=False)
    print(f'  L rows: {len(l_df)}')

    print('\n=== M: Charm + gamma confluence ===')
    m_df = run_M(events_b)
    m_df.to_csv(OUT / 'hypothesis_M_confluence.csv', index=False)

    print('\n=== N: Gamma wall structure ===')
    n_df = run_N(events_b)
    n_df.to_csv(OUT / 'hypothesis_N_wall.csv', index=False)

    print('\nWriting findings...')
    write_findings(l_df, m_df, n_df, OUT / 'hypothesis_LMN_findings.md')
    print(f'\nOutputs -> {OUT}/')


if __name__ == '__main__':
    main()
