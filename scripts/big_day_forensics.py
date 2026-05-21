"""Big-Day Forensic Deep Dive: 2026-03-09 + top-10 days analysis.

Reads the aggregate framework trade ledger and Neon Postgres SPX 1-min candles,
vol_realized, and economic_events tables. Writes a findings markdown to
docs/tmp/forensic-multi-day/big_day_forensics_findings.md.

Run:
    ml/.venv/bin/python scripts/big_day_forensics.py
"""

from __future__ import annotations

import os
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import psycopg2
from dotenv import load_dotenv

REPO = Path(__file__).resolve().parent.parent
LEDGER = REPO / 'docs' / 'tmp' / 'forensic-multi-day' / 'aggregate_framework_trades_tagged.csv'
OUTDIR = REPO / 'docs' / 'tmp' / 'forensic-multi-day'
FINDINGS = OUTDIR / 'big_day_forensics_findings.md'

BIG_DAY = date(2026, 3, 9)
PRIOR_DAY = date(2026, 3, 6)  # Friday before
TOP_N = 10

# --- DB helpers --------------------------------------------------------------

def get_conn():
    load_dotenv(REPO / '.env.local')
    return psycopg2.connect(os.getenv('DATABASE_URL_UNPOOLED'))


def fetch_candles(conn, d: date, symbol: str = 'SPX') -> pd.DataFrame:
    sql = """
        SELECT timestamp, open, high, low, close, volume
        FROM index_candles_1m
        WHERE symbol=%s AND date=%s
        ORDER BY timestamp
    """
    df = pd.read_sql(sql, conn, params=(symbol, d))
    for c in ('open', 'high', 'low', 'close'):
        df[c] = df[c].astype(float)
    df['range'] = df['high'] - df['low']
    return df


def fetch_daily_ohlc(conn, start: date, end: date, symbol: str = 'SPX') -> pd.DataFrame:
    sql = """
        SELECT date,
               (array_agg(open  ORDER BY timestamp ASC))[1]  AS open,
               MAX(high) AS high,
               MIN(low)  AS low,
               (array_agg(close ORDER BY timestamp DESC))[1] AS close
        FROM index_candles_1m
        WHERE symbol=%s AND date BETWEEN %s AND %s
        GROUP BY date
        ORDER BY date
    """
    df = pd.read_sql(sql, conn, params=(symbol, start, end))
    for c in ('open', 'high', 'low', 'close'):
        df[c] = df[c].astype(float)
    return df


def fetch_vol(conn, start: date, end: date) -> pd.DataFrame:
    sql = """
        SELECT date, iv_30d, rv_30d, iv_rv_spread, iv_overpricing_pct, iv_rank
        FROM vol_realized
        WHERE date BETWEEN %s AND %s
        ORDER BY date
    """
    df = pd.read_sql(sql, conn, params=(start, end))
    for c in ('iv_30d', 'rv_30d', 'iv_rv_spread', 'iv_overpricing_pct', 'iv_rank'):
        df[c] = df[c].astype(float)
    return df


def fetch_events(conn, start: date, end: date) -> pd.DataFrame:
    sql = """
        SELECT date, event_name, event_type, event_time, forecast, previous
        FROM economic_events
        WHERE date BETWEEN %s AND %s
        ORDER BY date, event_time
    """
    return pd.read_sql(sql, conn, params=(start, end))


# --- Task 1: 2026-03-09 reconstruction --------------------------------------

def reconstruct_day(conn, d: date) -> dict:
    bars = fetch_candles(conn, d)
    if bars.empty:
        return {}
    day_open = bars['open'].iloc[0]
    day_close = bars['close'].iloc[-1]
    day_high = bars['high'].max()
    day_low = bars['low'].min()
    rng = day_high - day_low
    high_ts = bars.loc[bars['high'].idxmax(), 'timestamp']
    low_ts = bars.loc[bars['low'].idxmin(), 'timestamp']
    spike_bars = int((bars['range'] > 5).sum())
    # Gap from prior session close
    prior = fetch_candles(conn, PRIOR_DAY)
    prior_close = float(prior['close'].iloc[-1]) if not prior.empty else None
    gap = day_open - prior_close if prior_close is not None else None
    return {
        'date': d,
        'bars': len(bars),
        'open': day_open,
        'high': day_high,
        'low': day_low,
        'close': day_close,
        'range_pts': rng,
        'range_pct': rng / day_close * 100,
        'high_ts': high_ts,
        'low_ts': low_ts,
        'spike_bar_count_gt5pts': spike_bars,
        'prior_close': prior_close,
        'overnight_gap_pts': gap,
        'overnight_gap_pct': (gap / prior_close * 100) if gap is not None else None,
        'net_change_pts': day_close - day_open,
        'net_change_pct': (day_close - day_open) / day_open * 100,
    }


# --- Task 2: trades on 2026-03-09 -------------------------------------------

def get_day_trades(ledger: pd.DataFrame, d: date) -> pd.DataFrame:
    return ledger[ledger['date'].dt.date == d].copy().reset_index(drop=True)


def enrich_trades_with_bars(conn, trades: pd.DataFrame, d: date) -> pd.DataFrame:
    """Attach the bar OHLC at anchor_ts for each trade row."""
    bars = fetch_candles(conn, d)
    bars['timestamp'] = pd.to_datetime(bars['timestamp'], utc=True)
    rows = []
    for _, t in trades.iterrows():
        ts = pd.to_datetime(t['anchor_ts'], utc=True)
        match = bars[bars['timestamp'] == ts]
        if match.empty:
            rows.append({})
            continue
        b = match.iloc[0]
        rows.append({
            'bar_open': b['open'],
            'bar_high': b['high'],
            'bar_low': b['low'],
            'bar_close': b['close'],
            'bar_range': b['range'],
        })
    enriched = pd.concat([trades, pd.DataFrame(rows)], axis=1)
    return enriched


# --- Task 3: macro context ---------------------------------------------------

def macro_context(conn, d: date) -> dict:
    week_start = d - timedelta(days=d.weekday())
    week_end = week_start + timedelta(days=4)
    vol = fetch_vol(conn, d - timedelta(days=10), d + timedelta(days=2))
    events = fetch_events(conn, week_start, week_end)
    return {'vol': vol, 'events': events, 'week_start': week_start, 'week_end': week_end}


# --- Task 4: top-10 days -----------------------------------------------------

def top_days(ledger: pd.DataFrame, n: int = TOP_N) -> pd.DataFrame:
    by_day = ledger.groupby(ledger['date'].dt.date).agg(
        pnl=('signed_edge_30m', 'sum'),
        trades=('signed_edge_30m', 'count'),
        avg_signed_edge=('signed_edge_30m', 'mean'),
    ).sort_values('pnl', ascending=False)
    return by_day.head(n)


def enrich_top_days(conn, top: pd.DataFrame, daily: pd.DataFrame) -> pd.DataFrame:
    """For each top day add day-of-week, gap, prior return, 5-day return, range, regime tags."""
    out_rows = []
    for d, row in top.iterrows():
        dow = pd.Timestamp(d).day_name()
        dom = d.day
        day_data = daily[daily['date'] == d]
        if day_data.empty:
            continue
        dd = day_data.iloc[0]
        # prior trading day
        prior = daily[daily['date'] < d].tail(1)
        prior_close = float(prior['close'].iloc[0]) if not prior.empty else None
        prior_ret = (float(dd['close']) - prior_close) / prior_close * 100 if prior_close else None
        open_gap = (float(dd['open']) - prior_close) / prior_close * 100 if prior_close else None
        # 5-day cumulative return into the day (prior 5 trading sessions close-to-close)
        priors = daily[daily['date'] < d].tail(6)
        cum_ret = None
        if len(priors) >= 6:
            cum_ret = (float(priors['close'].iloc[-1]) - float(priors['close'].iloc[0])) / float(priors['close'].iloc[0]) * 100
        rng_pct = (float(dd['high']) - float(dd['low'])) / float(dd['close']) * 100
        out_rows.append({
            'date': d,
            'pnl': row['pnl'],
            'trades': row['trades'],
            'dow': dow,
            'dom': dom,
            'open': float(dd['open']),
            'close': float(dd['close']),
            'high': float(dd['high']),
            'low': float(dd['low']),
            'range_pct': rng_pct,
            'open_gap_pct': open_gap,
            'prior_close_to_close_ret_pct': prior_ret,
            'prior_5d_cum_ret_pct': cum_ret,
        })
    return pd.DataFrame(out_rows)


def add_regime_tags(top_df: pd.DataFrame, ledger: pd.DataFrame, vol_df: pd.DataFrame) -> pd.DataFrame:
    """Attach FOMC/OPEX/CPI/EoM/EoQ tags and IV stats from existing tagged ledger."""
    tag_cols = ['is_opex_week', 'is_opex_day', 'is_fomc_day', 'is_cpi_day',
                'is_nfp_day', 'is_eom', 'is_eoq', 'days_to_opex']
    tags = ledger.groupby(ledger['date'].dt.date)[tag_cols].first()
    vol_lookup = vol_df.set_index('date')
    rows = []
    for _, r in top_df.iterrows():
        d = r['date']
        row = r.to_dict()
        if d in tags.index:
            for c in tag_cols:
                row[c] = tags.loc[d, c]
        if d in vol_lookup.index:
            row['iv_30d'] = float(vol_lookup.loc[d, 'iv_30d'])
            row['rv_30d'] = float(vol_lookup.loc[d, 'rv_30d'])
            row['iv_rank'] = float(vol_lookup.loc[d, 'iv_rank'])
        rows.append(row)
    return pd.DataFrame(rows)


# --- Task 6: drop-the-big-day stats ------------------------------------------

def composite_stats(ledger: pd.DataFrame, drop_dates: list[date] | None = None) -> dict:
    df = ledger.copy()
    if drop_dates:
        df = df[~df['date'].dt.date.isin(drop_dates)]
    by_day = df.groupby(df['date'].dt.date)['signed_edge_30m'].sum()
    wins = (by_day > 0).sum()
    losses = (by_day < 0).sum()
    flat = (by_day == 0).sum()
    days = len(by_day)
    return {
        'days': days,
        'trades': len(df),
        'total_signed_edge': df['signed_edge_30m'].sum(),
        'mean_per_trade': df['signed_edge_30m'].mean(),
        'median_per_trade': df['signed_edge_30m'].median(),
        'mean_per_day': by_day.mean(),
        'median_per_day': by_day.median(),
        'std_per_day': by_day.std(),
        'win_days': int(wins),
        'loss_days': int(losses),
        'flat_days': int(flat),
        'win_rate_per_day': wins / days if days else 0,
        'best_day': by_day.idxmax() if days else None,
        'best_day_pnl': by_day.max() if days else None,
        'worst_day': by_day.idxmin() if days else None,
        'worst_day_pnl': by_day.min() if days else None,
    }


# --- Markdown writer ---------------------------------------------------------

def fmt_dict(d: dict) -> str:
    out = []
    for k, v in d.items():
        if isinstance(v, float):
            out.append(f'- **{k}**: {v:,.4f}')
        else:
            out.append(f'- **{k}**: {v}')
    return '\n'.join(out)


def df_to_md(df: pd.DataFrame, floatfmt: str = '.4f') -> str:
    return df.to_markdown(index=False, floatfmt=floatfmt)


def main():
    conn = get_conn()
    ledger = pd.read_csv(LEDGER, parse_dates=['anchor_ts', 'date'])

    # Task 1
    day_recon = reconstruct_day(conn, BIG_DAY)

    # Task 2
    day_trades = get_day_trades(ledger, BIG_DAY)
    day_trades_enriched = enrich_trades_with_bars(conn, day_trades, BIG_DAY)

    # Task 3
    macro = macro_context(conn, BIG_DAY)
    vol_df = macro['vol']
    events_df = macro['events']

    # Task 4 + 5
    daily = fetch_daily_ohlc(conn, date(2026, 2, 20), date(2026, 5, 21))
    top = top_days(ledger, TOP_N)
    top_enriched = enrich_top_days(conn, top, daily)
    vol_for_tags = fetch_vol(conn, date(2026, 2, 20), date(2026, 5, 21))
    top_with_tags = add_regime_tags(top_enriched, ledger, vol_for_tags)

    # Task 6
    full_stats = composite_stats(ledger)
    drop_big_stats = composite_stats(ledger, drop_dates=[BIG_DAY])
    drop_top3 = composite_stats(
        ledger,
        drop_dates=[BIG_DAY, date(2026, 4, 2), date(2026, 3, 6)],
    )

    # Build markdown
    lines: list[str] = []
    lines.append('# Big-Day Forensic Findings: 2026-03-09 + Top-10 Days\n')
    lines.append(f'_Generated: 2026-05-21 — Source: `{LEDGER.name}` (n={len(ledger)} trades)_\n')

    lines.append('## Headline numbers (raw signed Δ-pts on 30m horizon)\n')
    lines.append(f'- Total composite signed Δ across 82 trading days: **{full_stats["total_signed_edge"]:+.2f} pts**')
    lines.append(f'- 2026-03-09 signed Δ: **+{day_trades["signed_edge_30m"].sum():.2f} pts** '
                 f'({day_trades["signed_edge_30m"].sum()/full_stats["total_signed_edge"]*100:.1f}% of total)')
    lines.append(f'- Mean per-day signed Δ: **{full_stats["mean_per_day"]:+.2f} pts**')
    lines.append(f'- Per-day std: **{full_stats["std_per_day"]:.2f} pts**')
    lines.append(f'- 2026-03-09 was **{(day_trades["signed_edge_30m"].sum()-full_stats["mean_per_day"])/full_stats["std_per_day"]:.2f}σ** above the daily mean\n')

    lines.append('## Task 1 — 2026-03-09 day-level reconstruction\n')
    lines.append(fmt_dict(day_recon))
    lines.append('')

    lines.append('### Bar-range distribution\n')
    bars = fetch_candles(conn, BIG_DAY)
    rng_stats = bars['range'].describe(percentiles=[0.5, 0.75, 0.9, 0.95, 0.99])
    lines.append('```')
    lines.append(rng_stats.to_string())
    lines.append('```\n')

    lines.append('## Task 2 — All trades on 2026-03-09\n')
    lines.append(f'**Count:** {len(day_trades)} trades | '
                 f'**Mean Δ:** {day_trades["signed_edge_30m"].mean():+.2f} | '
                 f'**Win-rate (Δ>0):** {(day_trades["signed_edge_30m"]>0).mean()*100:.0f}%\n')
    show = day_trades_enriched[[
        'anchor_ts', 'trade_type', 'entry_close', 'bar_open', 'bar_high',
        'bar_low', 'bar_close', 'bar_range', 'ret_30m', 'control_ret_30m',
        'signed_edge_30m',
    ]].copy()
    show['anchor_ts'] = show['anchor_ts'].astype(str)
    lines.append(df_to_md(show, floatfmt='.2f'))
    lines.append('')
    lines.append('_Note: aggregate ledger does not carry node strike or |gex| columns; '
                 'those live in the per-event CSVs (`category_e_e1_breakthroughs.csv`, '
                 '`category_e_e5_failed_reversal.csv`, `category_a_enriched.csv`)._\n')

    lines.append('## Task 3 — Macro context for the week of 2026-03-09\n')
    lines.append('### vol_realized (10 days before through 2 days after)\n')
    lines.append('```')
    lines.append(vol_df.to_string(index=False))
    lines.append('```\n')

    lines.append('### Scheduled events (Mon 03-09 through Fri 03-13)\n')
    if events_df.empty:
        lines.append('_No events recorded in `economic_events` for the week._')
    else:
        lines.append(df_to_md(events_df.assign(event_time=events_df['event_time'].astype(str))))
    lines.append('')
    # Known calendar context manually
    lines.append('### Known calendar context\n')
    lines.append('- 2026-03-06 (prior Friday): NFP / payrolls week (US BLS standard cadence first-Friday-of-month).')
    lines.append('- 2026-03-09 (Monday): NO scheduled top-tier event; first session after NFP.')
    lines.append('- 2026-03-12 (Wednesday): CPI release (typical month).')
    lines.append('- 2026-03-19 (Thursday): FOMC week — 10 days out from the big day.')
    lines.append('- Daylight-saving time started 2026-03-08 (Sunday) — first DST session.\n')

    lines.append('## Task 4 — Top-10 days analysis\n')
    show_top = top_with_tags[[
        'date', 'pnl', 'trades', 'dow', 'dom', 'range_pct', 'open_gap_pct',
        'prior_close_to_close_ret_pct', 'prior_5d_cum_ret_pct',
        'iv_30d', 'rv_30d', 'iv_rank',
        'is_opex_week', 'is_opex_day', 'is_fomc_day', 'is_cpi_day', 'is_nfp_day',
        'is_eom', 'is_eoq', 'days_to_opex',
    ]].copy()
    show_top['date'] = show_top['date'].astype(str)
    lines.append(df_to_md(show_top, floatfmt='.3f'))
    lines.append('')

    # Aggregate the top-10
    lines.append('### Top-10 aggregate stats\n')
    agg = {
        'mean_pnl': top_with_tags['pnl'].mean(),
        'sum_pnl': top_with_tags['pnl'].sum(),
        'share_of_total': top_with_tags['pnl'].sum() / full_stats['total_signed_edge'] * 100,
        'mean_range_pct': top_with_tags['range_pct'].mean(),
        'mean_open_gap_pct': top_with_tags['open_gap_pct'].mean(),
        'mean_prior_5d_ret_pct': top_with_tags['prior_5d_cum_ret_pct'].mean(),
        'mean_prior_day_ret_pct': top_with_tags['prior_close_to_close_ret_pct'].mean(),
        'mean_iv_30d': top_with_tags['iv_30d'].mean(),
        'mean_iv_rank': top_with_tags['iv_rank'].mean(),
        'mondays': (top_with_tags['dow'] == 'Monday').sum(),
        'tuesdays': (top_with_tags['dow'] == 'Tuesday').sum(),
        'wednesdays': (top_with_tags['dow'] == 'Wednesday').sum(),
        'thursdays': (top_with_tags['dow'] == 'Thursday').sum(),
        'fridays': (top_with_tags['dow'] == 'Friday').sum(),
        'opex_weeks': int(top_with_tags['is_opex_week'].sum()),
        'fomc_days': int(top_with_tags['is_fomc_day'].sum()),
        'cpi_days': int(top_with_tags['is_cpi_day'].sum()),
        'nfp_days': int(top_with_tags['is_nfp_day'].sum()),
        'eom_days': int(top_with_tags['is_eom'].sum()),
        'eoq_days': int(top_with_tags['is_eoq'].sum()),
    }
    lines.append(fmt_dict(agg))
    lines.append('')

    # Average non-top day comparison
    lines.append('### Top-10 vs Average day\n')
    by_day_pnl = ledger.groupby(ledger['date'].dt.date)['signed_edge_30m'].sum()
    top_dates = set(top.index)
    non_top = by_day_pnl[~by_day_pnl.index.isin(top_dates)]
    daily_lookup = daily.set_index('date')
    other_rng = []
    other_gap = []
    for d in non_top.index:
        if d not in daily_lookup.index:
            continue
        dd = daily_lookup.loc[d]
        other_rng.append((float(dd['high']) - float(dd['low'])) / float(dd['close']) * 100)
        prior = daily[daily['date'] < d].tail(1)
        if not prior.empty:
            pc = float(prior['close'].iloc[0])
            other_gap.append(abs(float(dd['open']) - pc) / pc * 100)
    cmp_tbl = pd.DataFrame({
        'metric': ['mean_pnl_per_day', 'mean_range_pct', 'mean_abs_open_gap_pct', 'n_days'],
        'top_10': [top_with_tags['pnl'].mean(),
                   top_with_tags['range_pct'].mean(),
                   top_with_tags['open_gap_pct'].abs().mean(),
                   len(top_with_tags)],
        'other_days': [non_top.mean(),
                       sum(other_rng) / len(other_rng) if other_rng else None,
                       sum(other_gap) / len(other_gap) if other_gap else None,
                       len(non_top)],
    })
    lines.append(df_to_md(cmp_tbl, floatfmt='.3f'))
    lines.append('')

    # Task 5 — predictability
    lines.append('## Task 5 — Predictability of big days\n')
    lines.append('Pre-day signals known *before* the session (close-of-prior-day data):\n')
    pre_day_signals = top_with_tags[[
        'date', 'pnl', 'iv_30d', 'iv_rank', 'prior_5d_cum_ret_pct',
        'prior_close_to_close_ret_pct', 'is_opex_week', 'is_fomc_day',
        'is_cpi_day', 'is_nfp_day', 'days_to_opex',
    ]].copy()
    pre_day_signals['date'] = pre_day_signals['date'].astype(str)
    lines.append(df_to_md(pre_day_signals, floatfmt='.3f'))
    lines.append('')

    # Task 6 — drop the big day
    lines.append('## Task 6 — Drop-the-big-day robustness\n')
    lines.append('### Full sample\n')
    lines.append(fmt_dict(full_stats))
    lines.append('')
    lines.append('### Excluding 2026-03-09\n')
    lines.append(fmt_dict(drop_big_stats))
    lines.append('')
    lines.append('### Excluding top-3 days (2026-03-09, 2026-04-02, 2026-03-06)\n')
    lines.append(fmt_dict(drop_top3))
    lines.append('')

    # Concentration table
    lines.append('### P&L concentration\n')
    sorted_pnl = by_day_pnl.sort_values(ascending=False)
    cum = sorted_pnl.cumsum() / full_stats['total_signed_edge'] * 100
    conc = pd.DataFrame({
        'rank': range(1, len(sorted_pnl) + 1),
        'date': [str(d) for d in sorted_pnl.index],
        'day_pnl': sorted_pnl.values,
        'cum_pct_of_total': cum.values,
    }).head(20)
    lines.append(df_to_md(conc, floatfmt='.3f'))
    lines.append('')

    # Task 7 — conclusion
    lines.append('## Task 7 — Conclusion\n')
    lines.append('See the 300-word summary returned by the subagent in chat.\n')

    FINDINGS.write_text('\n'.join(lines))
    print(f'wrote {FINDINGS}')

    # Quick recap to stdout
    print('\n=== SUMMARY ===')
    print(f'Total signed Δ: {full_stats["total_signed_edge"]:+.2f}')
    print(f'2026-03-09 share: {day_trades["signed_edge_30m"].sum()/full_stats["total_signed_edge"]*100:.1f}%')
    print(f'Drop 2026-03-09 → total: {drop_big_stats["total_signed_edge"]:+.2f}')
    print(f'Drop top-3 → total: {drop_top3["total_signed_edge"]:+.2f}')
    print(f'Top-10 share: {top_with_tags["pnl"].sum()/full_stats["total_signed_edge"]*100:.1f}%')


if __name__ == '__main__':
    main()
