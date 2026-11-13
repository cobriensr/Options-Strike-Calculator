"""Calendar context analysis for E1, E5, and PCS Monday signals.

For each event/trade, tags calendar context (OPEX week, OPEX day, FOMC,
CPI/NFP, EoM, EoQ, day-of-month bucket), then measures whether each
context flag amplifies, dampens, or reverses signal edge (Δ-of-Δ vs
control).

Inputs:
  - docs/tmp/forensic-multi-day/gamma_node_rejection_2026-05-20_v4-vol-crush.csv
  - docs/tmp/forensic-multi-day/aggregate_framework_trades.csv
  - FOMC days: the Fed schedule in ml/src/options_features/calendar.py
  - CPI and NFP days: FRED's release dates (release 10 and release 50), read
    with FRED_API_KEY from the repo root's .env; a FRED failure stops the
    script

Outputs:
  - docs/tmp/forensic-multi-day/calendar_context_findings.md
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from http.client import HTTPException
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

import pandas as pd

from _cli_paths import load_env_file

ROOT = Path(__file__).resolve().parents[1]

# FRED release IDs for CPI and the Employment Situation (NFP). They must match
# TRACKED_RELEASES in api/_lib/market-events.ts; the test
# test_release_ids_match_tracked_releases_in_the_app fails when they drift.
FRED_CPI_RELEASE_ID = 10
FRED_NFP_RELEASE_ID = 50
FRED_RELEASE_DATES_URL = 'https://api.stlouisfed.org/fred/release/dates'
FRED_TIMEOUT_SEC = 30

# Appended, not inserted first: ml/src has its own enrich_lottery_outcomes.py,
# which would shadow scripts/enrich_lottery_outcomes.py for later imports.
ML_SRC = ROOT / 'ml' / 'src'
if str(ML_SRC) not in sys.path:
    sys.path.append(str(ML_SRC))

from options_features.calendar import FOMC_DATES  # noqa: E402

TMP_DIR = ROOT / 'docs' / 'tmp' / 'forensic-multi-day'
MASTER_CSV = TMP_DIR / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
TRADES_CSV = TMP_DIR / 'aggregate_framework_trades.csv'
FINDINGS_MD = TMP_DIR / 'calendar_context_findings.md'


# ----- Calendar primitives -----

def third_friday(year: int, month: int) -> date:
    """Return the third Friday of a given month."""
    first = date(year, month, 1)
    # Friday = 4
    first_fri = first + timedelta(days=(4 - first.weekday()) % 7)
    return first_fri + timedelta(days=14)


def opex_dates_in_range(start: date, end: date) -> list[date]:
    out: list[date] = []
    y, m = start.year, start.month
    while date(y, m, 1) <= end:
        d = third_friday(y, m)
        if start <= d <= end:
            out.append(d)
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def is_last_business_day_of_month(d: date, n: int = 2) -> bool:
    """True if d is one of the last n business days of its month."""
    # find last day of month
    if d.month == 12:
        first_next = date(d.year + 1, 1, 1)
    else:
        first_next = date(d.year, d.month + 1, 1)
    last = first_next - timedelta(days=1)
    # walk back collecting weekdays (Mon-Fri = 0..4); ignores holidays — close enough
    biz: list[date] = []
    cur = last
    while len(biz) < n and cur.month == d.month:
        if cur.weekday() < 5:
            biz.append(cur)
        cur -= timedelta(days=1)
    return d in biz


def fetch_release_dates(release_id: int, api_key: str) -> set[date]:
    """Every date FRED lists for one release, past and scheduled.

    No realtime_start is sent, so FRED defaults to 1776-07-04 and answers the
    whole history; limit is the largest page it allows, and with asc order a
    short page would cut off the newest dates. Any failure stops the script
    with the cause in the message (the exception type, never the URL: it
    carries the api_key).
    """
    query = urlencode(
        {
            'release_id': release_id,
            'api_key': api_key,
            'file_type': 'json',
            'include_release_dates_with_no_data': 'true',
            'sort_order': 'asc',
            'limit': 10000,
        }
    )
    url = f'{FRED_RELEASE_DATES_URL}?{query}'
    try:
        with urlopen(url, timeout=FRED_TIMEOUT_SEC) as resp:
            if resp.status != 200:
                raise HTTPException(f'HTTP {resp.status}')
            payload = json.loads(resp.read())
        entries = payload.get('release_dates') if isinstance(payload, dict) else None
        if not isinstance(entries, list):
            raise ValueError('payload has no release_dates list')
        days = {date.fromisoformat(entry['date']) for entry in entries}
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            f'FRED release dates failed: release {release_id}: '
            f'{type(exc).__name__}: {exc}'
        ) from exc

    count = payload.get('count')
    if isinstance(count, int) and count > len(entries):
        raise SystemExit(
            f'FRED release dates failed: release {release_id} truncated: '
            f'{len(entries)} of {count} dates'
        )
    if not days:
        raise SystemExit(
            f'FRED release dates failed: release {release_id} has no dates'
        )
    return days


def load_calendar_events() -> dict[str, set[date]]:
    """FOMC days from the Fed schedule, CPI and NFP days from FRED.

    FOMC comes from the schedule (owner decision 2026-11-06: is_fomc is the
    schedule). CPI and NFP come from FRED's release dates for releases 10 and
    50, the app's own source for them. The economic_events table is not used:
    it starts 2026-03-25 and holds no August 2026 rows, so CPI on 03-12 and in
    August, and NFP on 03-06, 08-07 and 09-04, were missing from it.

    A missing key, a FRED failure, a payload without dates or an empty list
    stops the script: findings built from a calendar with missing days are
    silently wrong.
    """
    # FRED_API_KEY is in the repo root's .env, not .env.local.
    load_env_file(ROOT / '.env')
    api_key = os.environ.get('FRED_API_KEY', '').strip()
    if not api_key:
        raise SystemExit(
            'FRED release dates failed: FRED_API_KEY is not set '
            '(add it to .env at the repo root)'
        )

    return {
        'fomc': set(FOMC_DATES),
        'cpi': fetch_release_dates(FRED_CPI_RELEASE_ID, api_key),
        'nfp': fetch_release_dates(FRED_NFP_RELEASE_ID, api_key),
    }


def tag_calendar(d: date, opex_set: set[date], cal: dict[str, set[date]]) -> dict[str, object]:
    """Return calendar context flags for a given trading date."""
    # next OPEX (3rd Fri) ≥ d
    future_opex = [x for x in sorted(opex_set) if x >= d]
    next_opex = future_opex[0] if future_opex else None
    days_to_opex = (next_opex - d).days if next_opex else None

    # OPEX week = Mon..Fri containing the 3rd Friday
    is_opex_week = False
    if next_opex is not None:
        week_start = next_opex - timedelta(days=next_opex.weekday())  # Monday of that week
        week_end = week_start + timedelta(days=4)
        if week_start <= d <= week_end:
            is_opex_week = True

    is_opex_day = d in opex_set
    is_eoq = d in (date(2026, 3, 31), date(2026, 6, 30), date(2026, 9, 30), date(2026, 12, 31))
    is_eom = is_last_business_day_of_month(d, n=2)

    return {
        'days_to_opex': days_to_opex,
        'is_opex_week': is_opex_week,
        'is_opex_day': is_opex_day,
        'is_fomc_day': d in cal['fomc'],
        'is_cpi_day': d in cal['cpi'],
        'is_nfp_day': d in cal['nfp'],
        'is_eom': is_eom,
        'is_eoq': is_eoq,
        'dom': d.day,
        'dow': d.weekday(),
    }


# ----- Edge computation -----

def signed_edge_e1(row: pd.Series, horizon: str) -> float:
    """E1 long-call breakthrough: edge = event_ret - control_ret on long-call P&L (up direction)."""
    # For a long call breakthrough setup, we want SPX UP -> profit.
    return float(row[f'ret_{horizon}']) - float(row[f'control_ret_{horizon}'])


def signed_edge_e5(row: pd.Series, horizon: str) -> float:
    """E5 long-put failed-reversal: edge = -(event_ret - control_ret) since we want DOWN."""
    return -(float(row[f'ret_{horizon}']) - float(row[f'control_ret_{horizon}']))


def signed_edge_pcs(row: pd.Series, horizon: str) -> float:
    """PCS Monday pocket: bullish put-credit-spread; we want SPX flat-to-up."""
    return float(row[f'ret_{horizon}']) - float(row[f'control_ret_{horizon}'])


SIGNED_EDGE = {
    'long_call_e1': signed_edge_e1,
    'long_put_e5': signed_edge_e5,
    'pcs_monday': signed_edge_pcs,
}


def cohort_stats(df: pd.DataFrame, flag_col: str, horizon: str, fn) -> dict[str, object]:
    """Compute n / mean edge / hit-rate inside vs outside a boolean flag column."""
    inside = df[df[flag_col]]
    outside = df[~df[flag_col]]
    out: dict[str, object] = {}
    for label, sub in (('in', inside), ('out', outside)):
        if len(sub) == 0:
            out[f'{label}_n'] = 0
            out[f'{label}_edge'] = float('nan')
            out[f'{label}_hit'] = float('nan')
            continue
        edges = sub.apply(lambda r: fn(r, horizon), axis=1)
        out[f'{label}_n'] = int(len(sub))
        out[f'{label}_edge'] = float(edges.mean())
        out[f'{label}_hit'] = float((edges > 0).mean())
    if out['in_n'] and out['out_n']:
        out['delta_of_delta'] = float(out['in_edge']) - float(out['out_edge'])  # type: ignore[arg-type]
    else:
        out['delta_of_delta'] = float('nan')
    return out


# ----- Main -----

def main() -> None:
    if not TRADES_CSV.exists():
        print(f'missing: {TRADES_CSV}')
        return
    trades = pd.read_csv(TRADES_CSV)
    trades['anchor_dt'] = pd.to_datetime(trades['anchor_ts'], utc=True)
    trades['date'] = trades['anchor_dt'].dt.date

    sample_start = trades['date'].min()
    sample_end = trades['date'].max()
    print(f'sample window: {sample_start} → {sample_end}')

    opex_list = opex_dates_in_range(sample_start - timedelta(days=10), sample_end + timedelta(days=40))
    opex_set = set(opex_list)
    cal = load_calendar_events()
    # FRED lists a release's whole history; the printout and the findings show
    # only the days inside the sample window. The tags use the full sets.
    in_window = {
        name: sorted(d for d in days if sample_start <= d <= sample_end)
        for name, days in cal.items()
    }
    print(f'OPEX in window: {opex_list}')
    print(f'FOMC: {in_window["fomc"]}')
    print(f'CPI: {in_window["cpi"]}')
    print(f'NFP: {in_window["nfp"]}')

    # Tag every trade
    flags_df = trades['date'].apply(lambda d: pd.Series(tag_calendar(d, opex_set, cal)))
    trades = pd.concat([trades, flags_df], axis=1)

    # DOM bucket
    def dom_bucket(d: int) -> str:
        if d <= 5:
            return '01-05'
        if d <= 10:
            return '06-10'
        if d <= 15:
            return '11-15'
        if d <= 20:
            return '16-20'
        if d <= 25:
            return '21-25'
        return '26-31'

    trades['dom_bucket'] = trades['dom'].apply(dom_bucket)

    # Trade-type breakdown
    print()
    print('--- trade counts ---')
    print(trades['trade_type'].value_counts())
    print()

    # Build findings
    lines: list[str] = []
    lines.append('# Calendar Context Findings — E1, E5, PCS Monday')
    lines.append('')
    lines.append(f'**Generated:** 2026-05-21  ')
    lines.append(f'**Sample window:** {sample_start} → {sample_end}  ')
    lines.append(f'**Total trades:** {len(trades)} (E1={int((trades.trade_type=="long_call_e1").sum())}, E5={int((trades.trade_type=="long_put_e5").sum())}, PCS={int((trades.trade_type=="pcs_monday").sum())})  ')
    lines.append('')
    lines.append('Edge metric: signed (event_ret − control_ret) at horizon, oriented in the direction the trade wants (E1=up, E5=down, PCS=up).  ')
    lines.append('Δ-of-Δ = edge_inside_flag − edge_outside_flag. Positive Δ-of-Δ means the flag *amplifies* the signal.  ')
    lines.append('')
    lines.append('Calendar inputs:')
    lines.append(f'- OPEX (3rd Friday): {", ".join(d.isoformat() for d in opex_list)}')
    lines.append(f'- FOMC decision days: {", ".join(d.isoformat() for d in in_window["fomc"])}')
    lines.append(f'- CPI release days: {", ".join(d.isoformat() for d in in_window["cpi"])}')
    lines.append(f'- NFP release days: {", ".join(d.isoformat() for d in in_window["nfp"])}')
    lines.append('')

    flags = [
        ('is_opex_week', 'OPEX week (Mon-Fri containing 3rd Fri)'),
        ('is_opex_day', 'OPEX day (3rd Fri itself)'),
        ('is_fomc_day', 'FOMC decision day'),
        ('is_cpi_day', 'CPI release day'),
        ('is_nfp_day', 'NFP release day'),
        ('is_eom', 'EoM (last 2 biz days of month)'),
        ('is_eoq', 'EoQ (2026-03-31)'),
    ]

    for trade_type, fn in SIGNED_EDGE.items():
        sub = trades[trades['trade_type'] == trade_type].copy()
        if sub.empty:
            continue
        lines.append(f'## {trade_type}  (n={len(sub)})')
        lines.append('')
        for horizon in ('15m', '30m', '60m'):
            lines.append(f'### Horizon: ret_{horizon}')
            lines.append('')
            lines.append('| Flag | n_in | n_out | edge_in (pts) | edge_out (pts) | Δ-of-Δ | hit_in | hit_out |')
            lines.append('|---|---:|---:|---:|---:|---:|---:|---:|')
            for col, label in flags:
                s = cohort_stats(sub, col, horizon, fn)
                if s['in_n'] == 0:
                    continue
                lines.append(
                    f'| {label} | {s["in_n"]} | {s["out_n"]} | {s["in_edge"]:+.2f} | {s["out_edge"]:+.2f} '
                    f'| {s["delta_of_delta"]:+.2f} | {s["in_hit"]:.0%} | {s["out_hit"]:.0%} |'
                )
            lines.append('')

            # DOM bucket scan
            lines.append('**DOM buckets:**')
            lines.append('')
            lines.append('| DOM | n | edge (pts) | hit |')
            lines.append('|---|---:|---:|---:|')
            for bucket, grp in sub.groupby('dom_bucket'):
                edges = grp.apply(lambda r: fn(r, horizon), axis=1)
                lines.append(f'| {bucket} | {len(grp)} | {edges.mean():+.2f} | {(edges>0).mean():.0%} |')
            lines.append('')

            # days_to_opex bucket
            lines.append('**days_to_opex buckets:**')
            lines.append('')
            lines.append('| DTE_to_OPEX | n | edge (pts) | hit |')
            lines.append('|---|---:|---:|---:|')

            def dte_bucket(d: object) -> str:
                if d is None or (isinstance(d, float) and pd.isna(d)):
                    return 'n/a'
                d_int = int(d)
                if d_int == 0:
                    return '0 (OPEX day)'
                if d_int <= 4:
                    return '1-4'
                if d_int <= 9:
                    return '5-9'
                if d_int <= 14:
                    return '10-14'
                if d_int <= 21:
                    return '15-21'
                return '22+'

            sub2 = sub.copy()
            sub2['dte_bucket'] = sub2['days_to_opex'].apply(dte_bucket)
            for bucket, grp in sub2.groupby('dte_bucket'):
                edges = grp.apply(lambda r: fn(r, horizon), axis=1)
                lines.append(f'| {bucket} | {len(grp)} | {edges.mean():+.2f} | {(edges>0).mean():.0%} |')
            lines.append('')

        lines.append('')

    # Worst-5 days aggregate (sum signed edge across all 3 signals at 30m)
    lines.append('## KILL-Day Scan — Worst 5 Days by Aggregate Δ-loss (30m)')
    lines.append('')
    trades['signed_edge_30m'] = trades.apply(
        lambda r: SIGNED_EDGE[r['trade_type']](r, '30m'), axis=1
    )
    by_day = trades.groupby('date').agg(
        n=('signed_edge_30m', 'size'),
        agg_edge=('signed_edge_30m', 'sum'),
        mean_edge=('signed_edge_30m', 'mean'),
    ).sort_values('agg_edge').head(5)
    lines.append('| Date | n | aggregate Δ (pts) | mean Δ (pts) | calendar tags |')
    lines.append('|---|---:|---:|---:|---|')
    for d, row in by_day.iterrows():
        tags = tag_calendar(d, opex_set, cal)
        active = [k.replace('is_', '') for k, v in tags.items() if isinstance(v, bool) and v]
        dow_str = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][int(tags['dow'])]
        active.insert(0, dow_str)
        active.append(f'dom={tags["dom"]}')
        if tags['days_to_opex'] is not None:
            active.append(f'dte_opex={tags["days_to_opex"]}')
        lines.append(
            f'| {d} | {int(row["n"])} | {row["agg_edge"]:+.2f} | {row["mean_edge"]:+.2f} | {", ".join(active)} |'
        )
    lines.append('')

    # Best-5 days
    lines.append('## BEST Days — Top 5 Days by Aggregate Δ-gain (30m)')
    lines.append('')
    top = trades.groupby('date').agg(
        n=('signed_edge_30m', 'size'),
        agg_edge=('signed_edge_30m', 'sum'),
        mean_edge=('signed_edge_30m', 'mean'),
    ).sort_values('agg_edge', ascending=False).head(5)
    lines.append('| Date | n | aggregate Δ (pts) | mean Δ (pts) | calendar tags |')
    lines.append('|---|---:|---:|---:|---|')
    for d, row in top.iterrows():
        tags = tag_calendar(d, opex_set, cal)
        active = [k.replace('is_', '') for k, v in tags.items() if isinstance(v, bool) and v]
        dow_str = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][int(tags['dow'])]
        active.insert(0, dow_str)
        active.append(f'dom={tags["dom"]}')
        if tags['days_to_opex'] is not None:
            active.append(f'dte_opex={tags["days_to_opex"]}')
        lines.append(
            f'| {d} | {int(row["n"])} | {row["agg_edge"]:+.2f} | {row["mean_edge"]:+.2f} | {", ".join(active)} |'
        )
    lines.append('')

    # OPEX-week deep dive — per-signal in/out comparison summary
    lines.append('## OPEX-Week Deep Dive')
    lines.append('')
    lines.append('| Signal | n_OPEX_wk | edge_OPEX_wk (30m) | n_non | edge_non (30m) | Δ-of-Δ | OPEX-day n | OPEX-day edge (30m) |')
    lines.append('|---|---:|---:|---:|---:|---:|---:|---:|')
    for trade_type, fn in SIGNED_EDGE.items():
        sub = trades[trades['trade_type'] == trade_type].copy()
        if sub.empty:
            continue
        ow = sub[sub['is_opex_week']]
        nw = sub[~sub['is_opex_week']]
        od = sub[sub['is_opex_day']]
        edge_ow = ow.apply(lambda r: fn(r, '30m'), axis=1).mean() if len(ow) else float('nan')
        edge_nw = nw.apply(lambda r: fn(r, '30m'), axis=1).mean() if len(nw) else float('nan')
        edge_od = od.apply(lambda r: fn(r, '30m'), axis=1).mean() if len(od) else float('nan')
        dod = edge_ow - edge_nw if len(ow) and len(nw) else float('nan')
        lines.append(
            f'| {trade_type} | {len(ow)} | {edge_ow:+.2f} | {len(nw)} | {edge_nw:+.2f} '
            f'| {dod:+.2f} | {len(od)} | {edge_od:+.2f} |'
        )
    lines.append('')

    # Synthesis section template
    lines.append('## Synthesis')
    lines.append('')
    lines.append('See main agent summary for amplifiers / anti-filters / sample-size caveats.')
    lines.append('')

    FINDINGS_MD.write_text('\n'.join(lines))
    print(f'wrote: {FINDINGS_MD}')

    # Also dump the tagged frame for inspection
    out_csv = TMP_DIR / 'aggregate_framework_trades_tagged.csv'
    trades.to_csv(out_csv, index=False)
    print(f'wrote: {out_csv}')


if __name__ == '__main__':
    main()
