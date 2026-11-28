"""scripts/analyze_confluence_vs_solo.py: SPXW alerts with partners vs without, from the table, the
replay snapshot or the replay day files.

The alerts are 240 SPXW alerts a call and a put in turn, 70 s apart. Every 4th has an SPY partner
30 s before it (a 2way), every 8th also a QQQ partner 20 s before it (a 3way), the rest are solo.
The partners all come before their alert, so the table output is the same under the old rule (a
partner within 90 s either side) and the new one (90 s back to the alert, inclusive). The same
alerts are given to the script as table rows (psycopg2.connect returns a fake cursor), as a
replay snapshot parquet and as a day file (real DuckDB over a local file), so the sources can be
held to the same tables. A run on the snapshot or the day files never opens the database:
psycopg2.connect raises there.

The boundaries are patched (R3): `fulltape_connection` returns a local DuckDB connection,
`export_url` the local file's path, `load_env` does nothing and `OUT_DIR` is a folder in tmp_path.
The day files go through a `DayWorld` (scripts/_ba_test_support.py), which patches the R2 listing,
the day files' URLs and the tool's `write_replay_days`.

The outcomes CSV it takes by default: the newest SPXW one of the source's kind. The SPY and QQQ
files and the other sources' files sort above it by name ("-spy-", "-export-", "-days-"), and a
bare newest-first glob took them and died on `int('SPXW...@epoch')`.

Run from the repo root with the ml venv:

    ml/.venv/Scripts/python -m pytest scripts/test_analyze_confluence_vs_solo.py -q
"""

from __future__ import annotations

import csv
import re
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import duckdb
import psycopg2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _interval_ba_days as days
import analyze_confluence_vs_solo as acs  # noqa: E402
import enrich_interval_ba_outcomes as eio  # noqa: E402
from _ba_test_support import (  # noqa: E402
    DAY,
    DAY_ISO,
    DayWorld,
    at,
    export_row,
    local_connection,
    write_export,
)

N_SPXW = 240
STEP = 70  # seconds between SPXW alerts: a same-type neighbour is 140 s away, past the window
EXPORT_KEY = f'research/interval-ba/replay-{DAY_ISO}.parquet'
TABLE_CSV = 'interval-ba-outcomes-20261126-100000.csv'
EXPORT_CSV = 'interval-ba-outcomes-export-20261126-110000.csv'
DAYS_CSV = 'interval-ba-outcomes-days-20261126-120000.csv'


def touch(folder: Path, *names: str) -> None:
    for name in names:
        (folder / name).write_text('x', encoding='utf-8')


# --- the alerts -------------------------------------------------------------------------------


def make_alerts(qqq_seconds_before: int = 20) -> list[dict]:
    """The SPXW alerts and their partners, in fired order with the table's ids. The QQQ partner
    of every 8th SPXW alert fired `qqq_seconds_before` it (negative: after it)."""
    base = at('14:30:00')
    rows: list[dict] = []

    def add(ticker: str, cp: str, fired, strike: int, **extra) -> None:
        chain = f'{ticker}261117{cp}{strike * 1000:08d}'
        row = {'ticker': ticker, 'option_type': cp, 'fired_at': fired, 'chain': chain}
        rows.append({**row, **extra})

    for i in range(N_SPXW):
        cp = 'C' if i % 2 == 0 else 'P'
        fired = base + timedelta(seconds=STEP * i)
        add('SPXW', cp, fired, 6000 + i, n=i, has_path=i % 50 != 49)
        if i % 4 == 0:
            add('SPY', cp, fired - timedelta(seconds=30), 600 + i)
        if i % 8 == 0:
            add('QQQ', cp, fired - timedelta(seconds=qqq_seconds_before), 500 + i)
    rows.sort(key=lambda r: r['fired_at'])
    for position, row in enumerate(rows):
        row['id'] = position + 1
    return rows


def export_id(alert: dict) -> str:
    """The id the outcomes CSV carries for an export alert: <chain>@<bucket_start epoch s>."""
    return f'{alert["chain"]}@{int(alert["fired_at"].timestamp()) // 300 * 300}'


def export_rows(alerts: list[dict]) -> list[dict]:
    return [
        export_row(a['chain'], a['fired_at'].strftime('%H:%M:%S'), None) for a in alerts
    ]


def write_outcomes(path: Path, alerts: list[dict], *, export: bool) -> Path:
    """The CSV enrich_interval_ba_outcomes.py writes for SPXW: four steps per SPXW alert."""
    with path.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(
            [
                'alert_id', 'option_chain', 'option_type', 'severity', 'fired_at',
                't_minutes', 'ts_utc', 'spx_price', 'pct_change',
            ]  # fmt: skip
        )
        for a in alerts:
            if a['ticker'] != 'SPXW' or not a.get('has_path', True):
                continue
            for t in (15, 30, 60, 75):
                pct = ((a.get('n', 0) * 7) % 19 - 9) * 0.07 + t * 0.002
                w.writerow(
                    [
                        export_id(a) if export else a['id'],
                        a['chain'],
                        a['option_type'],
                        'warning',
                        a['fired_at'].isoformat(),
                        t,
                        (a['fired_at'] + timedelta(minutes=t)).isoformat(),
                        '6700.00',
                        f'{pct:.4f}',
                    ]
                )
    return path


def partner_case(partner_ticker: str, partner_type: str, seconds_before: int) -> list[dict]:
    """One SPXW call and one partner `seconds_before` it (negative: after it). Table ids in
    fired order; a partner at the same instant sorts after the SPXW alert."""
    spxw = {
        'id': 0, 'ticker': 'SPXW', 'option_type': 'C', 'chain': 'SPXW261117C06700000',
        'fired_at': at('15:00:00'),
    }  # fmt: skip
    partner = {
        'id': 0, 'ticker': partner_ticker, 'option_type': partner_type,
        'chain': f'{partner_ticker}261117{partner_type}00600000',
        'fired_at': at('15:00:00') - timedelta(seconds=seconds_before),
    }  # fmt: skip
    alerts = sorted([spxw, partner], key=lambda a: a['fired_at'])
    for position, a in enumerate(alerts):
        a['id'] = position + 1
    return alerts


# --- the run ----------------------------------------------------------------------------------


@pytest.fixture
def run(monkeypatch, tmp_path):
    """main() with the boundaries patched. Returns tmp_path: the export and the output folder
    (`out`) live there. psycopg2.connect starts out raising."""
    opened: list[duckdb.DuckDBPyConnection] = []

    def connect(**_limits):
        db = local_connection()
        opened.append(db)
        return db

    (tmp_path / 'out').mkdir()
    monkeypatch.setattr(acs, 'load_env', lambda: None)
    monkeypatch.setattr(acs, 'OUT_DIR', tmp_path / 'out')
    monkeypatch.setattr(eio, 'fulltape_connection', connect)
    monkeypatch.setattr(
        eio, 'export_url', lambda end: (tmp_path / f'replay-{end}.parquet').as_posix()
    )
    monkeypatch.setattr(
        psycopg2, 'connect', MagicMock(side_effect=AssertionError('the database was opened'))
    )
    yield tmp_path
    for db in opened:
        db.close()


def use_table(monkeypatch, alerts: list[dict]) -> None:
    """psycopg2.connect returns a connection whose cursor hands back the table rows."""
    names = ('id', 'ticker', 'option_type', 'fired_at')
    cur = MagicMock()
    cur.description = [SimpleNamespace(name=n) for n in names]
    cur.fetchall.return_value = [tuple(a[n] for n in names) for a in alerts]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    monkeypatch.setattr(psycopg2, 'connect', MagicMock(return_value=conn))
    monkeypatch.setenv('DATABASE_URL', 'postgresql://fake.invalid/none')


def report(out: Path, *, export: bool = False, days: bool = False) -> str:
    kind = '-days' if days else '-export' if export else ''
    (path,) = out.glob(f'interval-ba-confluence-vs-solo{kind}-2*.md')
    return path.read_text('utf-8')


def counts_of(text: str) -> dict[str, int]:
    """The cohort counts table: {'3way': n, '2way': n, 'solo': n}."""
    found = re.findall(r'^\| (\dway|solo) \| ([\d,]+) \|$', text, re.M)
    return {cohort: int(n.replace(',', '')) for cohort, n in found}


def stamp_free(text: str) -> str:
    return re.sub(r'\(\d{8}-\d{6}\)', '(STAMP)', text)


def tables_of(text: str) -> str:
    """The text from the cohort counts on: the header lines name the source and the CSV."""
    return text[text.index('## Cohort counts') :]


@pytest.fixture
def both_sources(run):
    """The same alerts, as an export and as the two outcomes CSVs."""
    alerts = make_alerts()
    write_export(run, export_rows(alerts))
    write_outcomes(run / 'out' / TABLE_CSV, alerts, export=False)
    write_outcomes(run / 'out' / EXPORT_CSV, alerts, export=True)
    return alerts


# What the script wrote for these alerts from the table before the export source existed: the
# output of the version at 8c2e33f56 over this fixture, with the stamp replaced. The tables are
# that version's byte for byte (every partner here comes before its alert, so the backward-only
# rule tags them as the old +-90 s rule did); only the method banner and the window sentence of
# the header are new. The banner is spelled out here on purpose: a change to the rebuild's
# methodology has to change this text too.
TABLE_GOLDEN = '''# SPXW confluence vs solo — SPX forward-return comparison (STAMP)

> **Method change (2026-11-26, the Interval B/A rebuild).** These numbers follow the rebuilt method and are not comparable with reports from before it:
>
> - (a) t=0 is the root's last print at or before `fired_at`.
> - (b) The forward steps are `fired_at` + 5k min.
> - (c) The default source is the replay day files, not the live table.
> - (d) Confluence looks backward only, and a partner at the same instant counts.
> - (e) Half-day paths end at the early close.

_Joined 240 SPXW alerts against the forward-return paths in `interval-ba-outcomes-20261126-100000.csv` (236 of 240 SPXW alerts joined a path). Confluence-window = 90s before each SPXW fired_at (inclusive; a partner that fired after the alert does not count). All cohorts 0DTE × 0DTE × 0DTE._

## Cohort counts

| cohort | n SPXW alerts |
|---|--:|
| 3way | 30 |
| 2way | 30 |
| solo | 180 |

## Hit rate by cohort (SPX direction matches option_type)

| cohort | type | n | T+15 hit | T+30 hit | T+60 hit | EOD hit |
|---|---|--:|--:|--:|--:|--:|
| 3way | C | 30 | 66.7% | 66.7% | 70.0% | 73.3% |
| 2way | C | 30 | 40.0% | 40.0% | 46.7% | 53.3% |
| solo | C | 60 | 53.3% | 53.3% | 58.3% | 63.3% |
| solo | P | 116 | 48.3% | 48.3% | 43.1% | 37.1% |

## Median EOD % change by cohort

| cohort | type | n | median EOD | mean EOD | P75 | P90 | max |
|---|---|--:|--:|--:|--:|--:|--:|
| 3way | C | 30 | +0.290% | +0.234% | +0.552% | +0.710% | +0.780% |
| 2way | C | 30 | +0.010% | +0.066% | +0.342% | +0.647% | +0.780% |
| solo | C | 60 | +0.150% | +0.155% | +0.500% | +0.647% | +0.780% |
| solo | P | 116 | +0.150% | +0.145% | +0.500% | +0.640% | +0.780% |

## Magnitude conditional on direction (EOD)

_For each cohort, when the bet works (CALL → up, PUT → down), how big is the move? Comparing the WINNERS across cohorts._

| cohort | type | n_right | median | mean | P75 | P90 |
|---|---|--:|--:|--:|--:|--:|
| 3way | C | 22 | +0.430% | +0.427% | +0.623% | +0.710% |
| solo | C | 38 | +0.430% | +0.399% | +0.570% | +0.710% |
| solo | P | 43 | +0.270% | +0.272% | +0.410% | +0.480% |
'''


# --- which outcomes CSV it takes --------------------------------------------------------------


def test_the_newest_spxw_table_csv_is_taken_over_every_other_kind_of_file(tmp_path):
    touch(
        tmp_path,
        'interval-ba-outcomes-20261120-100000.csv',
        'interval-ba-outcomes-20261126-101500.csv',  # the one to take
        'interval-ba-outcomes-export-20261126-120000.csv',  # export: alert_id is not an id
        'interval-ba-outcomes-export-spy-20261126-121000.csv',
        'interval-ba-outcomes-days-20261126-122000.csv',  # the day files': not the table's ids
        'interval-ba-outcomes-days-spy-20261126-123000.csv',
        'interval-ba-outcomes-spy-20261126-130000.csv',
        'interval-ba-outcomes-qqq-20261126-131000.csv',
        'interval-ba-outcomes-20261126-140000.csv.partial',  # a run that died
        'interval-ba-outcomes-summary-20261126-101500.md',
    )

    assert acs.newest_outcomes_csv(tmp_path, 'table').name == (
        'interval-ba-outcomes-20261126-101500.csv'
    )


def test_each_source_takes_the_outcomes_csv_of_its_own_kind(tmp_path):
    touch(
        tmp_path,
        'interval-ba-outcomes-20261126-101500.csv',
        'interval-ba-outcomes-20261126-160000.csv',  # the table's newest: not for the others
        'interval-ba-outcomes-export-20261126-120000.csv',  # the snapshot's one to take
        'interval-ba-outcomes-export-20261125-120000.csv',
        'interval-ba-outcomes-export-spy-20261126-170000.csv',
        'interval-ba-outcomes-days-20261126-130000.csv',  # the day files' one to take
        'interval-ba-outcomes-days-20261127-090000.csv.partial',
        'interval-ba-outcomes-days-spy-20261126-180000.csv',
        'interval-ba-outcomes-spy-20261126-171000.csv',
    )

    assert acs.newest_outcomes_csv(tmp_path, 'export').name == (
        'interval-ba-outcomes-export-20261126-120000.csv'
    )
    assert acs.newest_outcomes_csv(tmp_path, 'days').name == (
        'interval-ba-outcomes-days-20261126-130000.csv'
    )
    assert acs.newest_outcomes_csv(tmp_path, 'table').name == (
        'interval-ba-outcomes-20261126-160000.csv'
    )


@pytest.mark.parametrize(
    ('source', 'other_source', 'message'),
    [
        ('table', 'interval-ba-outcomes-export-20261126-140000.csv', 'No SPXW outcomes CSV'),
        ('export', 'interval-ba-outcomes-20261126-140000.csv', 'No SPXW export outcomes CSV'),
        ('days', 'interval-ba-outcomes-export-20261126-140000.csv', 'No SPXW days outcomes CSV'),
    ],
)
def test_with_only_other_kinds_of_file_it_exits_instead_of_taking_one(
    tmp_path, source, other_source, message
):
    touch(
        tmp_path,
        'interval-ba-outcomes-export-spy-20261126-120000.csv',
        'interval-ba-outcomes-spy-20261126-130000.csv',
        'interval-ba-outcomes-days-spy-20261126-135000.csv',
        other_source,
    )

    with pytest.raises(SystemExit, match=message):
        acs.newest_outcomes_csv(tmp_path, source)


@pytest.mark.parametrize(
    ('source', 'taken'),
    [
        ('table', 'interval-ba-outcomes-20261126-101500.csv'),
        ('export', 'interval-ba-outcomes-export-20261126-120000.csv'),
        ('days', 'interval-ba-outcomes-days-20261126-130000.csv'),
    ],
)
def test_main_loads_the_paths_from_the_csv_of_its_source(tmp_path, monkeypatch, source, taken):
    touch(
        tmp_path,
        'interval-ba-outcomes-20261126-101500.csv',
        'interval-ba-outcomes-export-20261126-120000.csv',
        'interval-ba-outcomes-days-20261126-130000.csv',
    )
    seen: list[tuple[Path, object]] = []

    class Stop(Exception):
        pass

    def load_paths(path: Path, key=int):
        seen.append((path, key))
        raise Stop

    monkeypatch.setattr(acs, 'OUT_DIR', tmp_path)
    monkeypatch.setattr(acs, 'load_env', lambda: None)
    monkeypatch.setattr(acs, 'load_paths', load_paths)

    with pytest.raises(Stop):
        acs.main(['--source', source])

    # The day files' and the snapshot's alert_id is the string `<chain>@<epoch>`, the table's an
    # integer id.
    [(path, key)] = seen
    assert path == tmp_path / taken
    if source == 'table':
        assert key('12') == 12
    else:
        assert key('SPXW261117C06700000@1790000000') == 'SPXW261117C06700000@1790000000'


# --- the sources ------------------------------------------------------------------------------


def test_confluence_table_source_output_is_unchanged(run, monkeypatch, both_sources):
    use_table(monkeypatch, both_sources)

    assert acs.main(['--source', 'table', '--csv', str(run / 'out' / TABLE_CSV)]) == 0

    assert stamp_free(report(run / 'out')) == TABLE_GOLDEN


def test_confluence_export_source_gives_the_same_tables_and_never_opens_the_database(
    run, both_sources
):
    assert acs.main(['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)]) == 0

    psycopg2.connect.assert_not_called()
    text = report(run / 'out', export=True)
    # The same alerts, so the same tables: the string ids of the CSV join the export's alerts.
    assert tables_of(text) == tables_of(TABLE_GOLDEN)
    assert (
        f'paths in `{EXPORT_CSV}` (236 of 240 SPXW alerts joined a path). '
        f'Alerts from the replay export `{EXPORT_KEY}`. Confluence-window = 90s'
    ) in text


@pytest.mark.parametrize(
    ('partner', 'cohort', 'spxw_alerts'),
    [
        pytest.param(('SPY', 'C', 30), '2way', 1, id='spy_30s_before'),
        pytest.param(('QQQ', 'C', 30), '2way', 1, id='qqq_30s_before'),
        pytest.param(None, 'solo', 1, id='no_partner'),
        # A put partner of a call alert: a different option type, so it is no partner.
        pytest.param(('SPY', 'P', 30), 'solo', 1, id='other_option_type'),
        pytest.param(('SPY', 'C', 90), '2way', 1, id='90s_before_is_the_edge_and_counts'),
        pytest.param(('SPY', 'C', 91), 'solo', 1, id='91s_before_is_past_the_edge'),
        # Another SPXW alert is no partner (it is solo too).
        pytest.param(('SPXW', 'C', 30), 'solo', 2, id='another_spxw_alert'),
    ],
)
def test_confluence_export_source_tags_partners_from_the_replay(
    run, partner, cohort, spxw_alerts
):
    spxw = {
        'ticker': 'SPXW', 'option_type': 'C', 'chain': 'SPXW261117C06700000',
        'fired_at': at('15:00:00'),
    }  # fmt: skip
    alerts = [spxw]
    if partner:
        ticker, cp, seconds = partner
        alerts.append(
            {
                'ticker': ticker, 'option_type': cp,
                'chain': f'{ticker}261117{cp}00600000',
                'fired_at': at('15:00:00') - timedelta(seconds=seconds),
            }  # fmt: skip
        )
    write_export(run, export_rows(alerts))
    write_outcomes(run / 'out' / EXPORT_CSV, alerts, export=True)

    acs.main(['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)])

    assert counts_of(report(run / 'out', export=True)) == {
        '3way': 0,
        '2way': spxw_alerts if cohort == '2way' else 0,
        'solo': spxw_alerts if cohort == 'solo' else 0,
    }


def test_confluence_an_spy_and_a_qqq_partner_make_a_3way(run):
    alerts = partner_case('SPY', 'C', 30)
    qqq = {**alerts[0], 'ticker': 'QQQ', 'chain': 'QQQ261117C00500000', 'fired_at': at('14:59:40')}
    alerts.append(qqq)
    write_export(run, export_rows(alerts))
    write_outcomes(run / 'out' / EXPORT_CSV, alerts, export=True)

    acs.main(['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)])

    assert counts_of(report(run / 'out', export=True)) == {'3way': 1, '2way': 0, 'solo': 0}


def _partner_alerts(partners: list[tuple[str, str, int]]) -> list[dict]:
    """One SPXW call at 15:00:00 and a partner for each (ticker, type, seconds before it); a
    negative number is after it. Table ids in fired order, the SPXW alert first on a tie."""
    spxw = {
        'id': 0, 'ticker': 'SPXW', 'option_type': 'C', 'chain': 'SPXW261117C06700000',
        'fired_at': at('15:00:00'),
    }  # fmt: skip
    others = [
        {
            'id': 0, 'ticker': ticker, 'option_type': cp,
            'chain': f'{ticker}261117{cp}00600000',
            'fired_at': at('15:00:00') - timedelta(seconds=seconds),
        }  # fmt: skip
        for ticker, cp, seconds in partners
    ]
    alerts = sorted([spxw, *others], key=lambda a: a['fired_at'])
    for position, a in enumerate(alerts):
        a['id'] = position + 1
    return alerts


@pytest.mark.parametrize('source', ['export', 'table'])
@pytest.mark.parametrize(
    ('partners', 'cohort'),
    [
        pytest.param([('SPY', 'C', 30)], '2way', id='30s_before_counts'),
        # 30 s after does not: counting it would be look-ahead.
        pytest.param([('SPY', 'C', -30)], 'solo', id='30s_after_does_not'),
        pytest.param([('SPY', 'C', 90)], '2way', id='exactly_90s_before_counts'),
        pytest.param([('SPY', 'C', 91)], 'solo', id='91s_before_does_not'),
        pytest.param([('SPY', 'C', 0)], '2way', id='the_same_instant_counts'),
        # The old +-90 s rule counted this one.
        pytest.param([('SPY', 'C', -90)], 'solo', id='90s_after_does_not'),
        pytest.param(
            [('SPY', 'C', 30), ('QQQ', 'C', -30)], '2way', id='a_qqq_after_makes_no_3way'
        ),
        pytest.param([('SPY', 'C', 30), ('QQQ', 'C', 60)], '3way', id='spy_and_qqq_before'),
    ],
)
def test_confluence_counts_only_partners_at_or_before_the_alert(
    run, monkeypatch, source, partners, cohort
):
    alerts = _partner_alerts(partners)
    write_outcomes(run / 'out' / TABLE_CSV, alerts, export=False)
    write_outcomes(run / 'out' / EXPORT_CSV, alerts, export=True)
    if source == 'export':
        write_export(run, export_rows(alerts))
        argv = ['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)]
    else:
        use_table(monkeypatch, alerts)
        argv = ['--source', 'table', '--csv', str(run / 'out' / TABLE_CSV)]

    acs.main(argv)

    expected = {'3way': 0, '2way': 0, 'solo': 0}
    expected[cohort] = 1
    assert counts_of(report(run / 'out', export=source == 'export')) == expected


@pytest.mark.parametrize('partner_first', [False, True])
def test_a_partner_at_the_same_instant_counts_whichever_sorts_first(partner_first):
    alerts = _partner_alerts([('SPY', 'C', 0)])  # the SPXW alert sorts first on the tie
    if partner_first:
        alerts.reverse()

    assert acs.tag_spxw_alerts_by_confluence(alerts, 90) == {
        next(a['id'] for a in alerts if a['ticker'] == 'SPXW'): '2way'
    }


def test_confluence_tags_match_the_exports_column_at_90_s(run):
    """A SPXW alert is `solo` exactly when the export's confluence_tickers is empty, `3way` when
    it holds SPY and QQQ, and `2way` otherwise. The column is the replay's own `_confluence`
    (nightly/src/interval_ba_replay.py, imported read-only here), so this holds the script's
    rule to the replay's and the live detector's, edges and ties included."""
    import interval_ba_tape  # noqa: F401  (it loads the replay module and registers it)

    replay = sys.modules['interval_ba_replay']
    groups = [  # (SPXW type, partners as (ticker, type, seconds before); negative: after)
        ('C', [('SPY', 'C', 90), ('QQQ', 'C', 30)]),  # both, one on the 90 s edge: 3way
        ('P', [('SPY', 'P', 91)]),  # a second past the edge: solo
        ('C', [('SPY', 'C', -30)]),  # after the alert only: solo
        ('P', [('QQQ', 'P', 90)]),  # the edge: 2way
        ('C', [('SPY', 'C', 0)]),  # the same instant: 2way
        ('P', [('SPY', 'C', 30)]),  # a call partner of a put alert: another option type, solo
        ('C', [('SPY', 'C', 30), ('QQQ', 'C', -30)]),  # SPY before, QQQ after: 2way
        ('C', []),  # no partner at all: solo
    ]
    base = at('14:30:00')
    alerts: list[dict] = []
    for g, (spxw_type, partners) in enumerate(groups):
        t = base + timedelta(minutes=10 * g)
        alerts.append(
            {'ticker': 'SPXW', 'option_type': spxw_type, 'fired_at': t,
             'chain': f'SPXW261117{spxw_type}{(6000 + g) * 1000:08d}'}  # fmt: skip
        )
        for ticker, cp, seconds in partners:
            alerts.append(
                {'ticker': ticker, 'option_type': cp, 'fired_at': t - timedelta(seconds=seconds),
                 'chain': f'{ticker}261117{cp}{(600 + g) * 1000:08d}'}  # fmt: skip
            )
    alerts.sort(key=lambda a: a['fired_at'])
    column = replay._confluence([(a['fired_at'], a['ticker'], a['option_type']) for a in alerts])
    rows = [
        export_row(a['chain'], a['fired_at'].strftime('%H:%M:%S'), None, confluence_tickers=list(c))
        for a, c in zip(alerts, column, strict=True)
    ]
    path = write_export(run, rows)

    con = local_connection()
    try:
        sql = 'SELECT option_chain, confluence_tickers FROM read_parquet($p)'
        in_export = dict(con.execute(sql, {'p': path}).fetchall())
        read = eio.read_export_alerts(con, DAY_ISO, None)
    finally:
        con.close()
    tags = acs.tag_spxw_alerts_by_confluence(read, 90)

    def from_column(partners: list[str]) -> str:
        if not partners:
            return 'solo'
        return '3way' if {'SPY', 'QQQ'} <= set(partners) else '2way'

    by_chain = {a['option_chain']: tags[a['id']] for a in read if a['id'] in tags}
    assert by_chain == {
        a['chain']: from_column(in_export[a['chain']]) for a in alerts if a['ticker'] == 'SPXW'
    }
    assert set(by_chain.values()) == {'solo', '2way', '3way'}  # the groups cover every tag


def test_the_cohort_counts_change_by_design_when_a_partner_comes_after_the_alert(run):
    """Under the old +-90 s rule the 240-alert fixture had 30 3way, 30 2way and 180 solo: the
    QQQ partner of every 8th alert fired 20 s AFTER it, and counted. Backward only, that QQQ
    does not count, so those 30 are 2way (their SPY partner is before them): 0, 60, 180."""
    alerts = make_alerts(qqq_seconds_before=-20)
    write_export(run, export_rows(alerts))
    write_outcomes(run / 'out' / EXPORT_CSV, alerts, export=True)

    acs.main(['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)])

    assert counts_of(report(run / 'out', export=True)) == {'3way': 0, '2way': 60, 'solo': 180}


def test_a_table_csv_with_the_export_source_names_the_mistake(run, both_sources):
    """The old habit `--csv <table csv>` under the new default: the CSV holds integer table ids,
    the export's are `<chain>@<epoch>`. It says so, instead of reporting a join of nothing."""
    with pytest.raises(SystemExit) as stopped:
        acs.main(['--export-end', DAY_ISO, '--csv', str(run / 'out' / TABLE_CSV)])

    message = str(stopped.value)
    assert message.startswith(f'{TABLE_CSV} holds table alert ids')
    assert '--source table' in message
    assert not list((run / 'out').glob('interval-ba-confluence*'))
    psycopg2.connect.assert_not_called()


def test_an_export_csv_with_the_table_source_names_the_mistake(run, monkeypatch, both_sources):
    """The other way: not a raw ValueError from int('SPXW...@epoch')."""
    use_table(monkeypatch, both_sources)

    with pytest.raises(SystemExit) as stopped:
        acs.main(['--source', 'table', '--csv', str(run / 'out' / EXPORT_CSV)])

    message = str(stopped.value)
    assert message.startswith(f'{EXPORT_CSV} holds export alert ids')
    assert 'SPXW' in message  # the first id it met
    assert '--source export' in message
    assert not list((run / 'out').glob('interval-ba-confluence*'))


def test_an_export_csv_of_other_alerts_joins_nothing_and_exits(run, both_sources):
    """Export-looking ids that match no alert in this export (another replay, another ticker)."""
    other = [{**a, 'chain': a['chain'].replace('261117', '261001')} for a in both_sources]
    write_outcomes(run / 'out' / EXPORT_CSV, other, export=True)

    with pytest.raises(SystemExit) as stopped:
        acs.main(['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)])

    message = str(stopped.value)
    assert message.startswith('No alert joined a path: 240 alerts from the export source')
    assert EXPORT_CSV in message
    assert '--csv' in message
    assert '--source' in message
    assert not list((run / 'out').glob('interval-ba-confluence*'))
    psycopg2.connect.assert_not_called()


def test_a_table_csv_of_other_alerts_joins_nothing_and_exits(run, monkeypatch, both_sources):
    use_table(monkeypatch, both_sources)
    other = [{**a, 'id': a['id'] + 10_000} for a in both_sources]
    write_outcomes(run / 'out' / TABLE_CSV, other, export=False)

    with pytest.raises(SystemExit) as stopped:
        acs.main(['--source', 'table', '--csv', str(run / 'out' / TABLE_CSV)])

    message = str(stopped.value)
    assert message.startswith('No alert joined a path: 240 alerts from the table source')
    assert TABLE_CSV in message
    assert not list((run / 'out').glob('interval-ba-confluence*'))


@pytest.mark.parametrize('source', ['export', 'table'])
def test_an_outcomes_csv_with_no_rows_exits(run, monkeypatch, both_sources, source):
    """No exceptions: nothing joined is nothing joined, whatever the reason."""
    header = (run / 'out' / EXPORT_CSV).read_text('utf-8').splitlines()[0] + '\n'
    (run / 'out' / EXPORT_CSV).write_text(header, encoding='utf-8')
    (run / 'out' / TABLE_CSV).write_text(header, encoding='utf-8')
    if source == 'table':
        use_table(monkeypatch, both_sources)
        argv = ['--source', 'table', '--csv', str(run / 'out' / TABLE_CSV)]
    else:
        argv = ['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)]

    with pytest.raises(SystemExit, match=f'No alert joined a path: 240 alerts from the {source}'):
        acs.main(argv)

    assert not list((run / 'out').glob('interval-ba-confluence*'))


@pytest.mark.parametrize('source', ['export', 'table'])
def test_an_empty_alert_set_exits(run, monkeypatch, both_sources, source):
    """No SPXW alert at all (only SPY and QQQ ones, or none): an analysis of zero alerts."""
    partners = [a for a in both_sources if a['ticker'] != 'SPXW']
    if source == 'table':
        use_table(monkeypatch, partners)
        argv = ['--source', 'table', '--csv', str(run / 'out' / TABLE_CSV)]
    else:
        write_export(run, export_rows(partners))
        argv = ['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)]

    with pytest.raises(SystemExit, match=f'No alert joined a path: 0 alerts from the {source}'):
        acs.main(argv)

    assert not list((run / 'out').glob('interval-ba-confluence*'))


def test_paths_of_alerts_not_in_the_export_do_not_count_as_joined(run, both_sources):
    """A CSV from another run: paths for some of the SPXW alerts and for five that are not in
    this export. A partial join runs, and the report counts the alerts that joined."""
    first = both_sources[:100]
    csv_path = write_outcomes(run / 'out' / EXPORT_CSV, first, export=True)
    with csv_path.open('a', encoding='utf-8') as f:
        for n in range(5):
            f.write(f'SPXW261001C0600000{n}@1790000000,x,C,warning,x,30,x,6700.00,0.1000\n')
    joined = sum(1 for a in first if a['ticker'] == 'SPXW' and a.get('has_path', True))

    assert acs.main(['--export-end', DAY_ISO]) == 0

    text = report(run / 'out', export=True)
    assert f'({joined} of 240 SPXW alerts joined a path)' in text
    assert joined < 240


def test_the_report_and_output_say_how_many_spxw_alerts_joined_a_path(
    run, capsys, both_sources
):
    acs.main(['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)])

    assert '236 of 240 SPXW alerts joined a path' in capsys.readouterr().out
    assert '(236 of 240 SPXW alerts joined a path)' in report(run / 'out', export=True)


def test_a_live_gap_makes_a_partnered_alert_solo_from_the_table_and_2way_from_the_export(
    run, monkeypatch
):
    """The point of reading the export: the live feed missed the SPY partner on a gap day, so the
    table has the SPXW alert alone. The replay has the partner."""
    alerts = partner_case('SPY', 'C', 30)
    write_export(run, export_rows(alerts))
    write_outcomes(run / 'out' / TABLE_CSV, alerts, export=False)
    write_outcomes(run / 'out' / EXPORT_CSV, alerts, export=True)
    use_table(monkeypatch, [a for a in alerts if a['ticker'] == 'SPXW'])

    acs.main(['--source', 'table', '--csv', str(run / 'out' / TABLE_CSV)])
    acs.main(
        ['--source', 'export', '--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)]
    )

    assert counts_of(report(run / 'out')) == {'3way': 0, '2way': 0, 'solo': 1}
    assert counts_of(report(run / 'out', export=True)) == {'3way': 0, '2way': 1, 'solo': 0}


def test_the_snapshot_source_takes_the_newest_replay_object_when_none_is_named(run, capsys):
    older = partner_case('SPXW', 'C', 30)  # no SPY partner in the older replay: solo
    newer = partner_case('SPY', 'C', 30)
    write_export(run, export_rows(older), end='2026-11-16')
    write_export(run, export_rows(newer), end='2026-11-17')
    write_outcomes(run / 'out' / EXPORT_CSV, newer, export=True)

    assert acs.main(['--source', 'export']) == 0  # no --export-end or --csv

    assert f'Export: {EXPORT_KEY} (the newest)' in capsys.readouterr().out
    text = report(run / 'out', export=True)
    assert counts_of(text) == {'3way': 0, '2way': 1, 'solo': 0}
    assert f'Alerts from the replay export `{EXPORT_KEY}`.' in text
    assert f'paths in `{EXPORT_CSV}` (' in text


def test_export_end_still_reads_the_snapshot(run):
    """The date alone is enough, as it was before the day files were the default."""
    alerts = partner_case('SPY', 'C', 30)
    write_export(run, export_rows(alerts))
    write_outcomes(run / 'out' / EXPORT_CSV, alerts, export=True)
    write_outcomes(run / 'out' / DAYS_CSV, alerts, export=True)  # the day files' CSV: not taken

    assert acs.main(['--export-end', DAY_ISO]) == 0

    text = report(run / 'out', export=True)
    assert counts_of(text) == {'3way': 0, '2way': 1, 'solo': 0}
    assert f'paths in `{EXPORT_CSV}` (' in text
    assert not list((run / 'out').glob('interval-ba-confluence-vs-solo-days-*'))
    psycopg2.connect.assert_not_called()


def test_no_replay_object_exits_with_a_message(run):
    touch(run / 'out', EXPORT_CSV)

    with pytest.raises(SystemExit, match=r'No replay object under research/interval-ba/ in R2'):
        acs.main(['--source', 'export'])

    psycopg2.connect.assert_not_called()
    assert not list((run / 'out').glob('interval-ba-confluence*'))


def test_export_end_with_table_source_exits_2(run):
    with pytest.raises(SystemExit) as stopped:
        acs.main(['--source', 'table', '--export-end', DAY_ISO])

    assert stopped.value.code == 2
    psycopg2.connect.assert_not_called()


# --- the day files ----------------------------------------------------------------------------


@pytest.fixture
def day_world(tmp_path, monkeypatch) -> DayWorld:
    return DayWorld(tmp_path / 'days', monkeypatch)


@pytest.fixture
def day_files(run, day_world):
    """The same alerts as DAY's file, its tape landed, and the day files' outcomes CSV."""
    alerts = make_alerts()
    day_world.tape(DAY)
    day_world.file(DAY, export_rows(alerts))
    write_outcomes(run / 'out' / DAYS_CSV, alerts, export=True)
    return alerts


def test_readers_default_to_the_day_files(run, day_files, day_world, capsys):
    assert acs.main([]) == 0  # no --source, --export-end or --csv

    psycopg2.connect.assert_not_called()
    text = report(run / 'out', days=True)
    # The same alerts as the table's, so the same tables, and the header names its source.
    assert tables_of(text) == tables_of(TABLE_GOLDEN)
    assert f'paths in `{DAYS_CSV}` (236 of 240 SPXW alerts joined a path). Alerts from the' in text
    assert 'the replay day files in `research/interval-ba/replay/` (1 day, 2026-11-17 to' in text
    assert day_world.write.call_count == 0
    assert 'Day files: the replay day files' in capsys.readouterr().out


def test_the_report_opens_with_the_method_banner_naming_each_change(run, day_files):
    acs.main([])

    text = report(run / 'out', days=True)
    banner = text[text.index('> **Method change') : text.index('_Joined')]
    assert 'not comparable with reports from before it' in banner
    for change in ('(a) t=0', '(b) The forward steps', '(c) The default source', '(d) Confluence'):
        assert change in banner
    assert '(e) Half-day paths end at the early close.' in banner


def test_analyze_reads_only_the_days_its_csv_covers(run, day_files, day_world):
    """Its CSV is DAY's. A day before it with a tape and no file would be a repair, and a day
    after it with a file would add alerts the CSV never priced: neither is touched."""
    before, after = DAY - timedelta(days=1), DAY + timedelta(days=1)
    day_world.tape(before)  # landed, never written: a repair, if it were needed
    day_world.tape(after)
    day_world.file(after, [export_row('SPXW261118C06700000', '15:00:00', None, expiry=after)])

    assert acs.main([]) == 0

    assert day_world.write.call_count == 0
    assert counts_of(report(run / 'out', days=True)) == {'3way': 30, '2way': 30, 'solo': 180}


def test_a_missing_day_is_repaired_and_then_read_and_the_header_says_so(
    run, day_files, day_world, capsys
):
    alerts = day_files
    (day_world.dir / f'{DAY_ISO}.parquet').unlink()
    del day_world.client.objects[f'research/interval-ba/replay/{DAY_ISO}.parquet']
    day_world.alerts[DAY] = export_rows(alerts)

    assert acs.main([]) == 0

    assert day_world.written == [DAY]
    text = report(run / 'out', days=True)
    assert counts_of(text) == {'3way': 30, '2way': 30, 'solo': 180}
    assert 'This run repaired 2026-11-17: the nightly should have written them' in text
    assert 'the nightly should have written it; check the interval-ba-tape step' in (
        capsys.readouterr().out
    )


def test_dry_run_lists_the_days_to_repair_and_writes_no_report(run, day_files, day_world):
    (day_world.dir / f'{DAY_ISO}.parquet').unlink()
    del day_world.client.objects[f'research/interval-ba/replay/{DAY_ISO}.parquet']

    with pytest.raises(SystemExit) as stopped:
        acs.main(['--dry-run'])

    assert str(stopped.value).startswith('--dry-run: nothing was written.')
    assert '2026-11-17  missing' in str(stopped.value)
    assert day_world.write.call_count == 0
    assert not list((run / 'out').glob('interval-ba-confluence*'))


def test_dry_run_with_nothing_to_repair_is_a_check_that_reads_no_alert(
    run, day_files, monkeypatch, capsys
):
    """It stops after the day-file check: no alert is read and no report is built."""
    read = MagicMock(side_effect=AssertionError('an alert was read'))
    monkeypatch.setattr(days, 'read_day_alerts', read)

    assert acs.main(['--dry-run']) == 0

    read.assert_not_called()
    assert not list((run / 'out').glob('interval-ba-confluence*'))
    out = capsys.readouterr().out
    assert '--dry-run: the 1 day file, 2026-11-17 to 2026-11-17, is present and current' in out
    assert '## Cohort counts' not in out


def test_an_analysis_that_repaired_a_day_says_its_outcomes_csv_was_priced_before(
    run, day_files, day_world, capsys
):
    (day_world.dir / f'{DAY_ISO}.parquet').unlink()
    del day_world.client.objects[f'research/interval-ba/replay/{DAY_ISO}.parquet']
    day_world.alerts[DAY] = export_rows(day_files)
    note = (
        'Rewritten after the outcomes CSV was priced: 2026-11-17. Re-run '
        'enrich_interval_ba_outcomes.py for those days.'
    )

    acs.main([])

    assert note in report(run / 'out', days=True)
    assert f'NOTE: {note}' in capsys.readouterr().out


def test_an_analysis_that_repaired_nothing_has_no_such_note(run, day_files):
    acs.main([])

    assert 'Rewritten after' not in report(run / 'out', days=True)


def write_priced_summary(run, stamp: datetime) -> None:
    """The summary enrich writes beside DAYS_CSV, with its day-files stamp."""
    files = days.DayFiles(
        days=(DAY,), urls=('u',), repaired=(), unavailable=(), replay_version='1',
        modified={DAY: stamp},
    )  # fmt: skip
    summary = run / 'out' / DAYS_CSV.replace('outcomes-', 'outcomes-summary-').replace('.csv', '.md')
    summary.write_text(f'# Interval B/A\n\n{files.priced_line()}\n', encoding='utf-8')


def test_an_analysis_names_a_day_file_the_nightly_rewrote_after_the_csv_was_priced(
    run, day_files, day_world, capsys
):
    """The day's file is from 11-18 08:45Z; enrich priced the CSV from the file as it was on
    11-17 12:00Z. Changed ids would just not join, and show only as a lower count."""
    write_priced_summary(run, datetime(2026, 11, 17, 12, 0, tzinfo=UTC))
    note = (
        'Rewritten after the outcomes CSV was priced: 2026-11-17. Re-run '
        'enrich_interval_ba_outcomes.py for those days.'
    )

    acs.main([])

    assert day_world.write.call_count == 0  # the file was not repaired by this run
    assert note in report(run / 'out', days=True)
    out = capsys.readouterr().out
    assert f'NOTE: {note}' in out
    assert 'no outcomes summary with a day-files stamp' not in out


def test_an_analysis_of_a_csv_priced_from_the_files_as_they_are_says_nothing(
    run, day_files, day_world, capsys
):
    write_priced_summary(run, day_world.landed(DAY) + timedelta(hours=1))  # the file's own time

    acs.main([])

    assert 'Rewritten after' not in report(run / 'out', days=True)
    out = capsys.readouterr().out
    assert 'Rewritten after' not in out
    assert 'no outcomes summary with a day-files stamp' not in out


def test_an_analysis_with_no_stamp_beside_its_csv_says_it_cannot_check(run, day_files, capsys):
    acs.main([])  # day_files writes the CSV and no summary

    assert (
        f'NOTE: {DAYS_CSV} has no outcomes summary with a day-files stamp beside it, so it '
        'cannot be checked whether a day file was rewritten after it was priced.'
    ) in capsys.readouterr().out
    assert 'cannot be checked' not in report(run / 'out', days=True)


def test_a_snapshot_csv_with_the_day_files_names_the_mistake(run, day_files):
    write_outcomes(run / 'out' / EXPORT_CSV, day_files, export=True)

    with pytest.raises(SystemExit) as stopped:
        acs.main(['--csv', str(run / 'out' / EXPORT_CSV)])

    assert str(stopped.value).startswith(f'{EXPORT_CSV} was written for --source export')
    assert not list((run / 'out').glob('interval-ba-confluence*'))


def test_a_repaired_day_that_holds_no_alerts_runs_no_study(run, day_files, day_world):
    (day_world.dir / f'{DAY_ISO}.parquet').unlink()
    del day_world.client.objects[f'research/interval-ba/replay/{DAY_ISO}.parquet']
    day_world.alerts[DAY] = []

    with pytest.raises(SystemExit, match='The repair wrote a day file with no alerts for 2026-11-17'):
        acs.main([])

    assert not list((run / 'out').glob('interval-ba-confluence*'))
