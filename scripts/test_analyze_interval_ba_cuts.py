"""scripts/analyze_interval_ba_cuts.py: the five cuts, from the table, the replay snapshot or the
replay day files.

The alerts are 200 SPXW alerts (100 calls, 100 puts, four fired hours, a spread of ratios, a
third of them sweeps, a fifth floor prints) with a forward path each but every 17th. The same
alerts are given to the script as table rows (psycopg2.connect returns a fake cursor), as a
replay snapshot parquet and as a day file (real DuckDB over a local file), so the sources can be
held to the same tables. A run on the snapshot or the day files never opens the database:
psycopg2.connect raises there.

The boundaries are patched (R3): `fulltape_connection` returns a local DuckDB connection,
`export_url` the local file's path, `load_env` does nothing and `OUT_DIR` is a folder in tmp_path.
The day files go through a `DayWorld` (scripts/_ba_test_support.py), which patches the R2 listing,
the day files' URLs and the tool's `write_replay_days`. The fake S3 of _ba_test_support serves the
over-s3:// test.

Run from the repo root with the ml venv:

    ml/.venv/Scripts/python -m pytest scripts/test_analyze_interval_ba_cuts.py -q
"""

from __future__ import annotations

import csv
import re
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock

import duckdb
import psycopg2
import pyarrow as pa
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _interval_ba_days as days
import analyze_interval_ba_cuts as cuts  # noqa: E402
import enrich_interval_ba_outcomes as eio  # noqa: E402
from _ba_test_support import (  # noqa: E402
    DAY,
    DAY_ISO,
    EXPORT_SCHEMA,
    DayWorld,
    at,
    export_row,
    fake_s3,  # noqa: F401  (a fixture: pytest finds it by name)
    local_connection,
    s3_connection,
    write_export,
)

N_ALERTS = 200
EXPORT_KEY = f'research/interval-ba/replay-{DAY_ISO}.parquet'


# --- the alerts -------------------------------------------------------------------------------


def make_alerts() -> list[dict]:
    """200 SPXW alerts: a call and a put at each step, fired 08:00-11:59 CT (14-17 UTC)."""
    alerts = []
    for i in range(N_ALERTS):
        cp = 'C' if i % 2 == 0 else 'P'
        fired = at(f'{14 + (i // 2) % 4:02d}:{(i * 7) % 60:02d}:{(i * 13) % 60:02d}')
        alerts.append(
            {
                'n': i,
                'id': i + 1,  # the table's id
                'chain': f'SPXW261117{cp}{(6000 + i) * 1000:08d}',
                'option_type': cp,
                'fired_at': fired,
                'ratio_pct': Decimal(70) + Decimal((i * 37) % 2999) / 100,
                'total_premium': Decimal(250_000 + i * 1_000),
                'is_sweep': i % 3 == 0,
                'is_floor': i % 5 == 0,
                'has_path': i % 17 != 16,
            }
        )
    return alerts


def export_id(alert: dict) -> str:
    """The id the outcomes CSV carries for an export alert: <chain>@<bucket_start epoch s>."""
    return f'{alert["chain"]}@{int(alert["fired_at"].timestamp()) // 300 * 300}'


def table_rows(alerts: list[dict]) -> list[tuple]:
    """interval_ba_alerts rows as load_alert_meta selects them."""
    return [
        (
            a['id'],
            a['chain'],
            a['option_type'],
            a['fired_at'],
            a['ratio_pct'],
            a['total_premium'],
            a['is_sweep'],
            a['is_floor'],
        )
        for a in alerts
    ]


def export_rows(alerts: list[dict]) -> list[dict]:
    return [
        export_row(
            a['chain'],
            a['fired_at'].strftime('%H:%M:%S'),
            None,
            total=str(a['total_premium']),
            ratio_pct=a['ratio_pct'],
            top_trade_is_sweep=a['is_sweep'],
            top_trade_is_floor=a['is_floor'],
        )
        for a in alerts
    ]


def write_outcomes(path: Path, alerts: list[dict], *, export: bool) -> Path:
    """The CSV enrich_interval_ba_outcomes.py writes: five steps per alert that has a path."""
    with path.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(
            [
                'alert_id', 'option_chain', 'option_type', 'severity', 'fired_at',
                't_minutes', 'ts_utc', 'spx_price', 'pct_change',
            ]  # fmt: skip
        )
        for a in alerts:
            if not a['has_path']:
                continue
            for t in (0, 5, 30, 60, 75):
                pct = ((a['n'] * 7) % 19 - 9) * 0.07 + t * 0.002
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


# --- the run ----------------------------------------------------------------------------------


@pytest.fixture
def run(monkeypatch, tmp_path):
    """main() with the boundaries patched. Returns tmp_path: the export, the outcomes CSVs and
    the output folder (`out`) live there. psycopg2.connect starts out raising."""
    opened: list[duckdb.DuckDBPyConnection] = []

    def connect(**_limits):
        db = local_connection()
        opened.append(db)
        return db

    (tmp_path / 'out').mkdir()
    monkeypatch.setattr(cuts, 'load_env', lambda: None)
    monkeypatch.setattr(cuts, 'OUT_DIR', tmp_path / 'out')
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


def use_table(monkeypatch, rows: list[tuple]) -> None:
    """psycopg2.connect returns a connection whose cursor hands back the table rows."""
    cur = MagicMock()
    cur.fetchall.return_value = rows
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    monkeypatch.setattr(psycopg2, 'connect', MagicMock(return_value=conn))
    monkeypatch.setenv('DATABASE_URL', 'postgresql://fake.invalid/none')


def analysis_md(out: Path, *, export: bool = False, days: bool = False, slug: str = '') -> Path:
    kind = '-days' if days else '-export' if export else ''
    (path,) = out.glob(f'interval-ba-analysis{kind}{slug}-2*.md')
    return path


def tables_of(md_text: str) -> str:
    """The text from the first cut on: the header lines name the source and the CSV."""
    return md_text[md_text.index('## 1. Hit rate') :]


def stamp_free(md_text: str) -> str:
    return re.sub(r'\(\d{8}-\d{6}\)', '(STAMP)', md_text)


@pytest.fixture
def both_sources(run, monkeypatch):
    """The same alerts as an export, a table, and the two outcomes CSVs."""
    alerts = make_alerts()
    write_export(run, export_rows(alerts))
    write_outcomes(run / 'out' / 'interval-ba-outcomes-20261126-100000.csv', alerts, export=False)
    write_outcomes(
        run / 'out' / 'interval-ba-outcomes-export-20261126-110000.csv', alerts, export=True
    )
    return alerts


TABLE_CSV = 'interval-ba-outcomes-20261126-100000.csv'
EXPORT_CSV = 'interval-ba-outcomes-export-20261126-110000.csv'
DAYS_CSV = 'interval-ba-outcomes-days-20261126-120000.csv'

# What the script wrote for these alerts from the table before the export source existed: the
# output of the version at 60512f1ed over this fixture, with the stamp replaced, and the method
# banner the report opens with now. The banner is spelled out here on purpose: a change to the
# rebuild's methodology has to change this text too.
TABLE_GOLDEN = '''# SPXW Interval B/A — empirical edge analysis (STAMP)

> **Method change (2026-11-26, the Interval B/A rebuild).** These numbers follow the rebuilt method and are not comparable with reports from before it:
>
> - (a) t=0 is the root's last print at or before `fired_at`.
> - (b) The forward steps are `fired_at` + 5k min.
> - (c) The default source is the replay day files, not the live table.
> - (d) Confluence looks backward only, and a partner at the same instant counts.
> - (e) Half-day paths end at the early close.

_Joined 200 SPXW alerts against 189 forward-return paths from `interval-ba-outcomes-20261126-100000.csv` (189 of 200 alerts joined a path)._

## 1. Hit rate vs unconditional baseline

_"hit" = SPX direction matches the option_type bet (CALL → up, PUT → down). "baseline" = unconditional p(SPX up) across the same set of forward-path snapshots — sampled from the alert universe so day-mix and hour-mix wash out. Edge = hit% − baseline%, anything > +3pp is meaningful at this n._

| horizon | type | n | hit % | baseline % | edge (pp) |
|---|---|--:|--:|--:|--:|
| T+30min | C | 94 | 52.1% | 52.4% | -0.3 |
| T+30min | P | 95 | 47.4% | 47.6% | -0.3 |
| T+60min | C | 94 | 56.4% | 57.1% | -0.8 |
| T+60min | P | 95 | 42.1% | 42.9% | -0.8 |
| EOD | C | 94 | 61.7% | 63.0% | -1.3 |
| EOD | P | 95 | 35.8% | 37.0% | -1.2 |

## 2. Magnitude conditional on direction

_When the bet works (CALL → SPX up at EOD, PUT → SPX down at EOD), how big is the move? Median / mean / P90 / max in the "right" tail._

| type | dir | n_right | median | mean | P75 | P90 | P95 | max |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| C | RIGHT (up) | 58 | +0.430% | +0.400% | +0.570% | +0.710% | +0.780% | +0.780% |
| C | WRONG | 36 | -0.270% | -0.268% | -0.130% | -0.060% | -0.060% | -0.060% |
| P | RIGHT (down) | 34 | +0.270% | +0.272% | +0.410% | +0.480% | +0.480% | +0.480% |
| P | WRONG | 61 | -0.360% | -0.389% | -0.150% | -0.080% | -0.010% | -0.010% |

## 3. Hour-of-day (CT fired_at)

_Trading session is 08:30–15:00 CT. Bin alerts by the CT hour of fire. Median + hit % at EOD. Wide hour ranges combine to span the whole session; the first row of each option_type is the all-day baseline._

| type | CT hour | n | median EOD | mean EOD | hit % |
|---|---|--:|--:|--:|--:|
| C | ALL | 94 | +0.150% | +0.144% | 61.7% |
| C | 08:00 CT | 23 | +0.290% | +0.232% | 69.6% |
| C | 09:00 CT | 23 | +0.290% | +0.196% | 69.6% |
| C | 10:00 CT | 24 | +0.045% | +0.080% | 58.3% |
| C | 11:00 CT | 24 | -0.025% | +0.074% | 50.0% |
| P | ALL | 95 | +0.150% | +0.152% | 35.8% |
| P | 08:00 CT | 23 | +0.010% | +0.098% | 43.5% |
| P | 09:00 CT | 24 | +0.115% | +0.138% | 41.7% |
| P | 10:00 CT | 24 | +0.325% | +0.243% | 25.0% |
| P | 11:00 CT | 24 | +0.115% | +0.127% | 33.3% |

## 4. Ratio percentile (does higher ratio = bigger edge?)

_Buckets the alert universe by ratio_pct. Does 95%+ ASK ratio outperform 70-75%, or is 70% already past the saturation point?_

| type | ratio | n | median EOD | mean EOD | P90 | hit % |
|---|---|--:|--:|--:|--:|--:|
| C | 75-85% | 36 | +0.010% | +0.088% | +0.605% | 52.8% |
| C | 85-95% | 26 | +0.255% | +0.212% | +0.710% | 69.2% |
| P | 75-85% | 37 | +0.220% | +0.209% | +0.710% | 27.0% |
| P | 85-95% | 25 | +0.080% | +0.088% | +0.612% | 48.0% |

## 5. Sweep vs non-sweep top trade

_Splits by `top_trade_is_sweep`. A sweep means the dominant ASK print was a single-actor multi-exchange aggressive lift — stronger informed-flow signature than a routine block._

| type | top trade | n | median EOD | mean EOD | P90 | hit % |
|---|---|--:|--:|--:|--:|--:|
| C | sweep | 32 | +0.115% | +0.128% | +0.640% | 59.4% |
| C | non-sweep | 62 | +0.150% | +0.152% | +0.640% | 62.9% |
| P | sweep | 31 | +0.150% | +0.152% | +0.640% | 35.5% |
| P | non-sweep | 64 | +0.150% | +0.152% | +0.689% | 35.9% |
'''


# --- the sources ------------------------------------------------------------------------------


def test_cuts_table_source_output_is_unchanged(run, monkeypatch, both_sources):
    use_table(monkeypatch, table_rows(both_sources))

    assert cuts.main(['--source', 'table', '--csv', str(run / 'out' / TABLE_CSV)]) == 0

    assert stamp_free(analysis_md(run / 'out').read_text('utf-8')) == TABLE_GOLDEN


def test_cuts_export_source_reads_the_replay_and_never_the_database(run, both_sources):
    assert cuts.main(['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)]) == 0

    psycopg2.connect.assert_not_called()
    text = analysis_md(run / 'out', export=True).read_text('utf-8')
    # The same 200 alerts, so the same five tables as from the table.
    assert tables_of(text) == tables_of(TABLE_GOLDEN)
    assert (
        f'_Joined 200 SPXW alerts against 189 forward-return paths from `{EXPORT_CSV}`'
        f' (189 of 200 alerts joined a path). Alerts from the replay export `{EXPORT_KEY}`._'
    ) in text


def test_the_snapshot_source_takes_the_newest_replay_object_and_its_newest_csv(
    run, both_sources, capsys
):
    """No --export-end or --csv: the newest replay object and the newest export CSV."""
    write_export(run, export_rows(both_sources[:50]), end='2026-11-16')  # an older replay
    # Decoys that sort above the right CSV: other tickers', the table's newer one, and the day
    # files' (which carry the same id format, and are told apart by their name).
    for name in (
        'interval-ba-outcomes-export-spy-20261126-130000.csv',
        'interval-ba-outcomes-spy-20261126-130000.csv',
        'interval-ba-outcomes-20261126-150000.csv',
        'interval-ba-outcomes-days-20261126-160000.csv',
    ):
        (run / 'out' / name).write_text('alert_id,t_minutes,pct_change\n', encoding='utf-8')

    assert cuts.main(['--source', 'export']) == 0

    out = capsys.readouterr().out
    assert f'Export: {EXPORT_KEY} (the newest)' in out
    text = analysis_md(run / 'out', export=True).read_text('utf-8')
    assert f'from `{EXPORT_CSV}` (' in text
    assert f'Alerts from the replay export `{EXPORT_KEY}`.' in text
    assert '_Joined 200 SPXW alerts' in text  # the newest replay has all 200, not the older 50


def test_export_mode_takes_the_export_outcomes_csv_and_table_mode_skips_it(
    run, monkeypatch, both_sources
):
    (run / 'out' / 'interval-ba-outcomes-export-spy-20261126-130000.csv').write_text(
        'alert_id,t_minutes,pct_change\n', encoding='utf-8'
    )
    (run / 'out' / 'interval-ba-outcomes-spy-20261126-130000.csv').write_text(
        'alert_id,t_minutes,pct_change\n', encoding='utf-8'
    )

    cuts.main(['--export-end', DAY_ISO])
    use_table(monkeypatch, table_rows(both_sources))
    cuts.main(['--source', 'table'])

    assert f'from `{EXPORT_CSV}`' in analysis_md(run / 'out', export=True).read_text('utf-8')
    assert f'from `{TABLE_CSV}`' in analysis_md(run / 'out').read_text('utf-8')


def test_a_table_csv_with_the_export_source_names_the_mistake(run, both_sources):
    """The old habit `--csv <table csv>` under the new default: the CSV holds integer table ids,
    the export's are `<chain>@<epoch>`. It says so, instead of reporting a join of nothing."""
    with pytest.raises(SystemExit) as stopped:
        cuts.main(['--export-end', DAY_ISO, '--csv', str(run / 'out' / TABLE_CSV)])

    message = str(stopped.value)
    assert message.startswith(f'{TABLE_CSV} holds table alert ids')
    assert '--source table' in message
    assert not list((run / 'out').glob('interval-ba-analysis*'))
    psycopg2.connect.assert_not_called()


def test_an_export_csv_with_the_table_source_names_the_mistake(run, monkeypatch, both_sources):
    """The other way: not a raw ValueError from int('SPXW...@epoch')."""
    use_table(monkeypatch, table_rows(both_sources))

    with pytest.raises(SystemExit) as stopped:
        cuts.main(['--source', 'table', '--csv', str(run / 'out' / EXPORT_CSV)])

    message = str(stopped.value)
    assert message.startswith(f'{EXPORT_CSV} holds export alert ids')
    assert 'SPXW' in message  # the first id it met
    assert '--source export' in message
    assert not list((run / 'out').glob('interval-ba-analysis*'))


def test_an_export_csv_of_other_alerts_joins_nothing_and_exits(run, both_sources):
    """Export-looking ids that match no alert in this export (another replay, another ticker)."""
    other = [{**a, 'chain': a['chain'].replace('261117', '261001')} for a in both_sources]
    write_outcomes(run / 'out' / EXPORT_CSV, other, export=True)

    with pytest.raises(SystemExit) as stopped:
        cuts.main(['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)])

    message = str(stopped.value)
    assert message.startswith('No alert joined a path: 200 alerts from the export source')
    assert EXPORT_CSV in message
    assert '--csv' in message
    assert '--source' in message
    assert not list((run / 'out').glob('interval-ba-analysis*'))
    psycopg2.connect.assert_not_called()


def test_a_table_csv_of_other_alerts_joins_nothing_and_exits(run, monkeypatch, both_sources):
    use_table(monkeypatch, table_rows(both_sources))
    other = [{**a, 'id': a['id'] + 10_000} for a in both_sources]
    write_outcomes(run / 'out' / TABLE_CSV, other, export=False)

    with pytest.raises(SystemExit) as stopped:
        cuts.main(['--source', 'table', '--csv', str(run / 'out' / TABLE_CSV)])

    message = str(stopped.value)
    assert message.startswith('No alert joined a path: 200 alerts from the table source')
    assert TABLE_CSV in message
    assert not list((run / 'out').glob('interval-ba-analysis*'))


@pytest.mark.parametrize('source', ['export', 'table'])
def test_an_outcomes_csv_with_no_rows_exits(run, monkeypatch, both_sources, source):
    """No exceptions: nothing joined is nothing joined, whatever the reason."""
    header = (run / 'out' / EXPORT_CSV).read_text('utf-8').splitlines()[0] + '\n'
    (run / 'out' / EXPORT_CSV).write_text(header, encoding='utf-8')
    (run / 'out' / TABLE_CSV).write_text(header, encoding='utf-8')
    if source == 'table':
        use_table(monkeypatch, table_rows(both_sources))
        argv = ['--source', 'table', '--csv', str(run / 'out' / TABLE_CSV)]
    else:
        argv = ['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)]

    with pytest.raises(SystemExit, match=f'No alert joined a path: 200 alerts from the {source}'):
        cuts.main(argv)

    assert not list((run / 'out').glob('interval-ba-analysis*'))


@pytest.mark.parametrize('source', ['export', 'table'])
def test_an_empty_alert_set_exits(run, monkeypatch, both_sources, source):
    """No alert of the ticker at all: an analysis of zero alerts is never what the run meant."""
    if source == 'table':
        use_table(monkeypatch, [])
        argv = ['--source', 'table', '--csv', str(run / 'out' / TABLE_CSV)]
    else:
        argv = ['--ticker', 'qqq', '--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)]

    with pytest.raises(SystemExit, match=f'No alert joined a path: 0 alerts from the {source}'):
        cuts.main(argv)

    assert not list((run / 'out').glob('interval-ba-analysis*'))


def test_the_cuts_header_and_output_say_how_many_alerts_joined_a_path(run, capsys, both_sources):
    cuts.main(['--export-end', DAY_ISO, '--csv', str(run / 'out' / EXPORT_CSV)])

    assert '189 of 200 alerts joined a path' in capsys.readouterr().out
    assert '(189 of 200 alerts joined a path)' in (
        analysis_md(run / 'out', export=True).read_text('utf-8')
    )


def test_a_stale_export_csv_that_covers_some_alerts_still_runs(run, both_sources):
    """A CSV from another run: paths for 113 of the 200 alerts, and for five that are not in
    this export. A partial join is not an empty one: the header counts the alerts that joined
    (113), not the paths (118)."""
    csv_path = write_outcomes(run / 'out' / EXPORT_CSV, both_sources[:120], export=True)
    with csv_path.open('a', encoding='utf-8') as f:
        for n in range(5):
            f.write(f'SPXW261001C0600000{n}@1790000000,x,C,warning,x,30,x,6700.00,0.1000\n')

    assert cuts.main(['--export-end', DAY_ISO]) == 0

    text = analysis_md(run / 'out', export=True).read_text('utf-8')
    assert 'against 118 forward-return paths' in text
    assert '(113 of 200 alerts joined a path)' in text


def test_the_export_analysis_file_name_carries_export_and_the_ticker(run):
    spy = [{**a, 'chain': a['chain'].replace('SPXW', 'SPY')} for a in make_alerts()]
    write_export(run, export_rows(spy))
    write_outcomes(
        run / 'out' / 'interval-ba-outcomes-export-spy-20261126-110000.csv', spy, export=True
    )

    cuts.main(['--ticker', 'spy', '--source', 'export'])

    text = analysis_md(run / 'out', export=True, slug='-spy').read_text('utf-8')
    assert text.startswith('# SPY Interval B/A')
    assert '_Joined 200 SPY alerts against 189 forward-return paths' in text


def test_no_replay_object_exits_with_a_message(run):
    write_outcomes(run / 'out' / EXPORT_CSV, make_alerts(), export=True)

    with pytest.raises(SystemExit, match=r'No replay object under research/interval-ba/ in R2'):
        cuts.main(['--source', 'export'])

    psycopg2.connect.assert_not_called()
    assert not list((run / 'out').glob('interval-ba-analysis*'))


@pytest.mark.parametrize('source', ['days', 'export', 'table'])
def test_no_outcomes_csv_exits_with_a_message_naming_the_source_and_the_ticker(
    run, monkeypatch, source
):
    kind = '' if source == 'table' else f'{source} '
    with pytest.raises(
        SystemExit, match=f'No {kind}outcomes CSV found under docs/tmp/ for ticker=SPXW'
    ):
        cuts.main(['--source', source])


def test_export_end_with_table_source_exits_2(run):
    with pytest.raises(SystemExit) as stopped:
        cuts.main(['--source', 'table', '--export-end', DAY_ISO])

    assert stopped.value.code == 2
    psycopg2.connect.assert_not_called()


def test_an_export_without_top_trade_is_floor_names_it(run, both_sources):
    narrow = pa.schema([f for f in EXPORT_SCHEMA if f.name != 'top_trade_is_floor'])
    rows = [{k: v for k, v in r.items() if k in narrow.names} for r in export_rows(both_sources)]
    write_export(run, rows, narrow)

    with pytest.raises(SystemExit, match='lacks column.*top_trade_is_floor'):
        cuts.main(['--export-end', DAY_ISO])


def test_over_s3_the_newest_replay_object_is_listed_and_read(monkeypatch, tmp_path, fake_s3):
    alerts = make_alerts()
    older = write_export(tmp_path, export_rows(alerts[:50]), end='2026-11-16')
    newer = write_export(tmp_path, export_rows(alerts))
    fake_s3.objects['/bucket/research/interval-ba/replay-2026-11-16.parquet'] = Path(
        older
    ).read_bytes()
    fake_s3.objects[f'/bucket/{EXPORT_KEY}'] = Path(newer).read_bytes()
    out = tmp_path / 'out'
    out.mkdir()
    write_outcomes(out / EXPORT_CSV, alerts, export=True)
    opened: list[duckdb.DuckDBPyConnection] = []

    def connect(**_limits):
        db = s3_connection(fake_s3)
        opened.append(db)
        return db

    monkeypatch.setenv('R2_BUCKET_FULLTAPE', 'bucket')
    monkeypatch.setattr(cuts, 'load_env', lambda: None)
    monkeypatch.setattr(cuts, 'OUT_DIR', out)
    monkeypatch.setattr(eio, 'fulltape_connection', connect)
    monkeypatch.setattr(psycopg2, 'connect', MagicMock(side_effect=AssertionError('database')))
    try:
        assert cuts.main(['--source', 'export']) == 0
    finally:
        for db in opened:
            db.close()

    text = analysis_md(out, export=True).read_text('utf-8')
    assert f'Alerts from the replay export `{EXPORT_KEY}`.' in text
    assert '_Joined 200 SPXW alerts' in text


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
    assert cuts.main([]) == 0  # no --source, --export-end or --csv

    psycopg2.connect.assert_not_called()
    text = analysis_md(run / 'out', days=True).read_text('utf-8')
    # The same 200 alerts, so the same five tables as from the table; the header names its source.
    assert tables_of(text) == tables_of(TABLE_GOLDEN)
    assert (
        f'_Joined 200 SPXW alerts against 189 forward-return paths from `{DAYS_CSV}`'
        ' (189 of 200 alerts joined a path). Alerts from the replay day files in '
        '`research/interval-ba/replay/` (1 day, 2026-11-17 to 2026-11-17; replay version'
    ) in text
    assert day_world.write.call_count == 0
    assert 'Reading SPXW alerts from the day files' in capsys.readouterr().out


def test_day_file_outcomes_are_named_days_and_analyze_takes_its_own_source(
    run, day_files, day_world
):
    # The snapshot's and the table's CSVs sit beside it, newer by name: neither is taken.
    write_outcomes(run / 'out' / 'interval-ba-outcomes-export-20261127-110000.csv', day_files, export=True)
    write_outcomes(run / 'out' / 'interval-ba-outcomes-20261127-100000.csv', day_files, export=False)

    cuts.main([])

    assert f'from `{DAYS_CSV}`' in analysis_md(run / 'out', days=True).read_text('utf-8')
    assert not list((run / 'out').glob('interval-ba-analysis-export-*'))


def test_the_report_opens_with_the_method_banner_naming_each_change(run, day_files):
    cuts.main([])

    text = analysis_md(run / 'out', days=True).read_text('utf-8')
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

    assert cuts.main([]) == 0

    assert day_world.write.call_count == 0
    text = analysis_md(run / 'out', days=True).read_text('utf-8')
    assert '_Joined 200 SPXW alerts' in text  # not 201


def test_a_missing_day_is_repaired_and_then_read_and_the_header_says_so(
    run, day_files, day_world, capsys
):
    (day_world.dir / f'{DAY_ISO}.parquet').unlink()
    del day_world.client.objects[f'research/interval-ba/replay/{DAY_ISO}.parquet']
    day_world.alerts[DAY] = export_rows(day_files)

    assert cuts.main([]) == 0

    assert day_world.written == [DAY]
    text = analysis_md(run / 'out', days=True).read_text('utf-8')
    assert tables_of(text) == tables_of(TABLE_GOLDEN)
    assert 'This run repaired 2026-11-17: the nightly should have written them' in text
    assert 'the nightly should have written it; check the interval-ba-tape step' in (
        capsys.readouterr().out
    )


def test_dry_run_lists_the_days_to_repair_and_writes_no_analysis(run, day_files, day_world):
    (day_world.dir / f'{DAY_ISO}.parquet').unlink()
    del day_world.client.objects[f'research/interval-ba/replay/{DAY_ISO}.parquet']

    with pytest.raises(SystemExit) as stopped:
        cuts.main(['--dry-run'])

    assert str(stopped.value).startswith('--dry-run: nothing was written.')
    assert '2026-11-17  missing' in str(stopped.value)
    assert day_world.write.call_count == 0
    assert not list((run / 'out').glob('interval-ba-analysis*'))


def test_dry_run_with_nothing_to_repair_is_a_check_that_reads_no_alert(
    run, day_files, monkeypatch, capsys
):
    """It stops after the day-file check: no alert is read and no report is built."""
    read = MagicMock(side_effect=AssertionError('an alert was read'))
    monkeypatch.setattr(days, 'read_day_alerts', read)

    assert cuts.main(['--dry-run']) == 0

    read.assert_not_called()
    assert not list((run / 'out').glob('interval-ba-analysis*'))
    out = capsys.readouterr().out
    assert '--dry-run: the 1 day file, 2026-11-17 to 2026-11-17, is present and current' in out
    assert '## 1. Hit rate' not in out


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

    cuts.main([])

    assert note in analysis_md(run / 'out', days=True).read_text('utf-8')
    assert f'NOTE: {note}' in capsys.readouterr().out


def test_an_analysis_that_repaired_nothing_has_no_such_note(run, day_files):
    cuts.main([])

    assert 'Rewritten after' not in analysis_md(run / 'out', days=True).read_text('utf-8')


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

    cuts.main([])

    assert day_world.write.call_count == 0  # the file was not repaired by this run
    assert note in analysis_md(run / 'out', days=True).read_text('utf-8')
    out = capsys.readouterr().out
    assert f'NOTE: {note}' in out
    assert 'no outcomes summary with a day-files stamp' not in out


def test_an_analysis_of_a_csv_priced_from_the_files_as_they_are_says_nothing(
    run, day_files, day_world, capsys
):
    write_priced_summary(run, day_world.landed(DAY) + timedelta(hours=1))  # the file's own time

    cuts.main([])

    assert 'Rewritten after' not in analysis_md(run / 'out', days=True).read_text('utf-8')
    out = capsys.readouterr().out
    assert 'Rewritten after' not in out
    assert 'no outcomes summary with a day-files stamp' not in out


def test_an_analysis_with_no_stamp_beside_its_csv_says_it_cannot_check(run, day_files, capsys):
    cuts.main([])  # day_files writes the CSV and no summary

    assert (
        f'NOTE: {DAYS_CSV} has no outcomes summary with a day-files stamp beside it, so it '
        'cannot be checked whether a day file was rewritten after it was priced.'
    ) in capsys.readouterr().out
    assert 'cannot be checked' not in analysis_md(run / 'out', days=True).read_text('utf-8')


def test_a_snapshot_csv_with_the_day_files_names_the_mistake(run, day_files):
    write_outcomes(run / 'out' / EXPORT_CSV, day_files, export=True)

    with pytest.raises(SystemExit) as stopped:
        cuts.main(['--csv', str(run / 'out' / EXPORT_CSV)])

    assert str(stopped.value).startswith(f'{EXPORT_CSV} was written for --source export')
    assert not list((run / 'out').glob('interval-ba-analysis*'))


def test_a_repaired_day_that_holds_no_alerts_runs_no_analysis(run, day_files, day_world):
    (day_world.dir / f'{DAY_ISO}.parquet').unlink()
    del day_world.client.objects[f'research/interval-ba/replay/{DAY_ISO}.parquet']
    day_world.alerts[DAY] = []

    with pytest.raises(SystemExit, match='The repair wrote a day file with no alerts for 2026-11-17'):
        cuts.main([])

    assert not list((run / 'out').glob('interval-ba-analysis*'))


def test_a_day_files_outcomes_csv_with_no_rows_has_no_days_to_read(run, day_files):
    header = (run / 'out' / DAYS_CSV).read_text('utf-8').splitlines()[0] + '\n'
    (run / 'out' / DAYS_CSV).write_text(header, encoding='utf-8')

    with pytest.raises(SystemExit, match='has no rows, so there are no days to read'):
        cuts.main([])

    assert not list((run / 'out').glob('interval-ba-analysis*'))
