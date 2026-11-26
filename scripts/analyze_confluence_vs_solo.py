#!/usr/bin/env python
"""Compare SPX forward-return distribution for SPXW alerts that fired
in cross-symbol confluence vs. SPXW alerts that fired alone.

Premise: a 3-way (SPY + SPXW + QQQ) Interval B/A burst within ~90s is
a stronger informed-flow signature than a single-symbol SPXW alert.
If true, the confluence cohort should beat solo SPXW on hit-rate
and/or magnitude at the same forward horizons.

For every SPXW alert (SPY, SPXW and QQQ alerts are read for the partners), we tag it with the
strongest confluence it participated in within a 90s window:

  - 3way: confluence across SPY + SPXW + QQQ
  - 2way: SPXW + (SPY OR QQQ), same option_type
  - solo: no other-ticker alert within the window, same direction

Then we join against the SPX forward-return paths from the
enrich_interval_ba_outcomes CSV and compare distributions at T+15 /
T+30 / T+60 / EOD.

Sources (--source), the same two as enrich_interval_ba_outcomes.py, read through its reader:
  - export (default): the full-year replay in R2, research/interval-ba/replay-<end>.parquet
    (--export-end names one, else the newest). One rule all year and no live-feed gaps, so a
    partner the live feed missed is still there. The database is never opened. The forward
    paths come from the newest docs/tmp/interval-ba-outcomes-export-*.csv.
  - table: interval_ba_alerts (DB), the live record. On a gap day (live rows stay the record,
    and missed alerts are added only from 2026-10-29) a partner is missing, and an alert that
    had one counts as solo. Paths: the newest docs/tmp/interval-ba-outcomes-*.csv (SPXW).
The report is written to docs/tmp/interval-ba-confluence-vs-solo[-export]-{stamp}.md.

Note: every alert in interval_ba_alerts is 0DTE for its underlying
(backfill applies expiry == executed_at::CT date for SPY/SPXW/QQQ —
all three have daily expiries during this window). The comparison is
0DTE × 0DTE × 0DTE.

Usage:
    ml/.venv/Scripts/python scripts/analyze_confluence_vs_solo.py \\
        [--source export|table] [--export-end 2026-11-25] [--window-sec 90] [--csv PATH]
"""

from __future__ import annotations

import argparse
import csv
import os
import pathlib
import re
import statistics as st
import sys
from collections import defaultdict
from collections.abc import Callable, Sequence
from datetime import datetime

import psycopg2

# The export reader, the --source flags and the CSV names live in the outcome script, which
# writes the files this one reads. Run as a script, scripts/ is on sys.path.
import enrich_interval_ba_outcomes as eio

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
OUT_DIR = ROOT / 'docs' / 'tmp'


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'"),
                )


def median(xs: list[float]) -> float:
    return st.median(xs) if xs else float('nan')


def mean(xs: list[float]) -> float:
    return st.mean(xs) if xs else float('nan')


def quantile(xs: list[float], q: float) -> float:
    if not xs:
        return float('nan')
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def fmt(x: float) -> str:
    if x != x:
        return '—'
    return f'{x:+.3f}%'


def load_alerts(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, ticker, option_type, fired_at
            FROM interval_ba_alerts
            WHERE ticker IN ('SPY', 'SPXW', 'QQQ')
              AND fired_at IS NOT NULL
            ORDER BY fired_at ASC
            """,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]


def tag_spxw_alerts_by_confluence(
    alerts: list[dict],
    window_sec: int,
) -> dict[int | str, str]:
    """Return {spxw_alert_id: 'solo' | '2way' | '3way'}.

    For each SPXW alert, scans the ±window_sec band of alerts for
    same-direction OTHER-ticker alerts. The tag reflects the maximum
    cross-ticker coverage seen in that band:
      - 3way: at least one SPY AND at least one QQQ
      - 2way: at least one SPY OR QQQ (not both)
      - solo: neither SPY nor QQQ within the window
    """
    out: dict[int | str, str] = {}
    n = len(alerts)
    # Index alerts by their epoch for binary-search style scan, but at
    # this scale (~18k alerts) a linear sweep is fine.
    epochs = [a['fired_at'].timestamp() for a in alerts]

    for i, a in enumerate(alerts):
        if a['ticker'] != 'SPXW':
            continue
        t = epochs[i]
        opt = a['option_type']
        has_spy = False
        has_qqq = False
        # Scan backwards
        j = i - 1
        while j >= 0 and t - epochs[j] <= window_sec:
            b = alerts[j]
            if b['option_type'] == opt and b['ticker'] != 'SPXW':
                if b['ticker'] == 'SPY':
                    has_spy = True
                elif b['ticker'] == 'QQQ':
                    has_qqq = True
            j -= 1
        # Scan forwards
        j = i + 1
        while j < n and epochs[j] - t <= window_sec:
            b = alerts[j]
            if b['option_type'] == opt and b['ticker'] != 'SPXW':
                if b['ticker'] == 'SPY':
                    has_spy = True
                elif b['ticker'] == 'QQQ':
                    has_qqq = True
            j += 1
        if has_spy and has_qqq:
            out[a['id']] = '3way'
        elif has_spy or has_qqq:
            out[a['id']] = '2way'
        else:
            out[a['id']] = 'solo'
    return out


def load_paths(
    csv_path: pathlib.Path,
    key: Callable[[str], int | str] = int,
) -> dict[int | str, dict[int, float]]:
    """{alert_id: {t_minutes: pct_change}}. `key` reads the CSV's alert_id: the table's integer
    id (the default), or str for the export's `<chain>@<bucket epoch>`."""
    paths: dict[int | str, dict[int, float]] = defaultdict(dict)
    with csv_path.open() as f:
        r = csv.DictReader(f)
        for row in r:
            paths[key(row['alert_id'])][int(row['t_minutes'])] = float(
                row['pct_change']
            )
    return paths


def eod(path: dict[int, float]) -> float | None:
    return path[max(path)] if path else None


def newest_outcomes_csv(out_dir: pathlib.Path, export: bool = False) -> pathlib.Path:
    """The newest SPXW outcomes CSV of the source's kind: the table's, or the export's.

    The names carry a digit stamp right after the prefix ("interval-ba-outcomes-20261126-...csv",
    "interval-ba-outcomes-export-20261126-...csv"). The SPY and QQQ files ("-spy-") and the
    other source's files sort above them, so the bare glob took one of those. The same filter as
    analyze_interval_ba_cuts.py, shared through the outcome script that writes the names.
    """
    found = eio.newest_outcomes_csv(out_dir, 'SPXW', export)
    if found is None:
        sys.exit(f'No SPXW {"export " if export else ""}outcomes CSV found under {out_dir}')
    return found


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    eio.add_source_arguments(parser)
    parser.add_argument('--window-sec', type=int, default=90)
    parser.add_argument('--csv', type=str, default=None)
    args = parser.parse_args(argv)
    eio.check_source_arguments(parser, args)
    export = args.source == 'export'
    load_env()

    csv_path = (
        pathlib.Path(args.csv) if args.csv else newest_outcomes_csv(OUT_DIR, export)
    )
    print(f'Loading paths from {csv_path.name}…')
    # The CSV's alert_id is the table's integer id, or the export's `<chain>@<epoch>` string.
    paths = load_paths(csv_path, key=str if export else int)
    print(f'  {len(paths)} alerts with forward path')

    source_note = ''
    if export:
        con = eio.open_connection()
        try:
            end = eio.resolve_export_end(con, args.export_end)
            # Every ticker: SPXW alerts are tagged by their SPY and QQQ partners.
            alerts = eio.read_export_alerts(con, end, None)
        finally:
            con.close()
        source_note = f' Alerts from the replay export `{eio.export_key(end)}`.'
    else:
        conn = psycopg2.connect(os.environ['DATABASE_URL'])
        try:
            alerts = load_alerts(conn)
        finally:
            conn.close()
    print(f'Loaded {len(alerts)} alerts across all three tickers')

    spxw_tags = tag_spxw_alerts_by_confluence(alerts, args.window_sec)
    print(f'Tagged {len(spxw_tags)} SPXW alerts:')
    counts: dict[str, int] = defaultdict(int)
    for t in spxw_tags.values():
        counts[t] += 1
    for k in ('3way', '2way', 'solo'):
        print(f'  {k}: {counts.get(k, 0):,}')

    # Group SPXW alerts by tag, also by option_type
    by_cohort: dict[tuple[str, str, int], list[float]] = defaultdict(list)
    eod_by_cohort: dict[tuple[str, str], list[float]] = defaultdict(list)
    option_type_of = {a['id']: a['option_type'] for a in alerts}
    for alert_id, tag in spxw_tags.items():
        path = paths.get(alert_id)
        if not path:
            continue
        opt = option_type_of.get(alert_id)
        if opt is None:
            continue
        for t in (15, 30, 60):
            v = path.get(t)
            if v is not None:
                by_cohort[(tag, opt, t)].append(v)
        v_eod = eod(path)
        if v_eod is not None:
            eod_by_cohort[(tag, opt)].append(v_eod)

    # Build markdown
    md: list[str] = []
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    md.append(f'# SPXW confluence vs solo — SPX forward-return comparison ({stamp})\n')
    md.append(
        f'_Joined {len(spxw_tags)} SPXW alerts against the forward-return '
        f'paths in `{csv_path.name}`.{source_note} Confluence-window = {args.window_sec}s '
        f'around each SPXW fired_at moment. All cohorts 0DTE × 0DTE × 0DTE._\n',
    )
    md.append('## Cohort counts\n')
    md.append('| cohort | n SPXW alerts |')
    md.append('|---|--:|')
    for k in ('3way', '2way', 'solo'):
        md.append(f'| {k} | {counts.get(k, 0):,} |')
    md.append('')

    def hit_pct(xs: list[float], opt: str) -> float:
        if not xs:
            return float('nan')
        if opt == 'C':
            return sum(1 for x in xs if x > 0) / len(xs) * 100
        return sum(1 for x in xs if x < 0) / len(xs) * 100

    md.append('## Hit rate by cohort (SPX direction matches option_type)\n')
    md.append('| cohort | type | n | T+15 hit | T+30 hit | T+60 hit | EOD hit |')
    md.append('|---|---|--:|--:|--:|--:|--:|')
    for tag in ('3way', '2way', 'solo'):
        for opt in ('C', 'P'):
            row = [tag, opt]
            xs_eod = eod_by_cohort.get((tag, opt), [])
            n = len(xs_eod)
            if n < 30:
                continue
            row.append(str(n))
            for t in (15, 30, 60):
                xs = by_cohort.get((tag, opt, t), [])
                row.append(f'{hit_pct(xs, opt):.1f}%' if xs else '—')
            row.append(f'{hit_pct(xs_eod, opt):.1f}%')
            md.append('| ' + ' | '.join(row) + ' |')
    md.append('')

    md.append('## Median EOD % change by cohort\n')
    md.append('| cohort | type | n | median EOD | mean EOD | P75 | P90 | max |')
    md.append('|---|---|--:|--:|--:|--:|--:|--:|')
    for tag in ('3way', '2way', 'solo'):
        for opt in ('C', 'P'):
            xs = eod_by_cohort.get((tag, opt), [])
            if len(xs) < 30:
                continue
            md.append(
                f'| {tag} | {opt} | {len(xs)} | '
                f'{fmt(median(xs))} | {fmt(mean(xs))} | '
                f'{fmt(quantile(xs, 0.75))} | {fmt(quantile(xs, 0.90))} | '
                f'{fmt(max(xs))} |',
            )
    md.append('')

    md.append('## Magnitude conditional on direction (EOD)\n')
    md.append(
        '_For each cohort, when the bet works (CALL → up, PUT → down), '
        'how big is the move? Comparing the WINNERS across cohorts._\n',
    )
    md.append('| cohort | type | n_right | median | mean | P75 | P90 |')
    md.append('|---|---|--:|--:|--:|--:|--:|')
    for tag in ('3way', '2way', 'solo'):
        for opt in ('C', 'P'):
            xs_eod = eod_by_cohort.get((tag, opt), [])
            if opt == 'C':
                right = [x for x in xs_eod if x > 0]
            else:
                right = [-x for x in xs_eod if x < 0]
            if len(right) < 20:
                continue
            md.append(
                f'| {tag} | {opt} | {len(right)} | '
                f'{fmt(median(right))} | {fmt(mean(right))} | '
                f'{fmt(quantile(right, 0.75))} | '
                f'{fmt(quantile(right, 0.90))} |',
            )
    md.append('')

    text = '\n'.join(md)
    kind = '-export' if export else ''
    out_path = OUT_DIR / f'interval-ba-confluence-vs-solo{kind}-{stamp}.md'
    out_path.write_text(text, encoding='utf-8')
    print(f'\nwrote {out_path}')
    print('\n' + text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
