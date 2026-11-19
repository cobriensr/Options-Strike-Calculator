"""The four Neon-only lottery research reports take a destination and a session date.

feature_audit.py, daily_tracker.py, mine_outcome_patterns.py and
score_lineage_audit.py each gain `main(argv)` so the nightly can run them as
subprocesses against a fixed session. What is pinned here:

* `--out-dir` (feature_audit, mining, lineage) and `--csv` (tracker) pick where
  the output goes; with neither, it lands in the default (`docs/tmp` under the
  repo root) and a run never writes anywhere else.
* `--as-of YYYY-MM-DD` (mining, lineage) anchors the SQL window to that day, not
  to the database's CURRENT_DATE, and names the report. Without it the day is
  today.
* The env file is optional (the nightly service has none) and the reports write
  UTF-8.
* A failed database call, or a bad `--as-of`, ends the run before anything is
  written.

Neon is faked at the module boundary: `psycopg2.connect` and
`pandas.read_sql` / `read_sql_query`. No test reaches a database. The scripts
still read the frozen weights JSON (the next task moves that to the store), so
the weights read is pointed at a temporary file or stubbed. Run:

    ml/.venv/Scripts/python -m pytest -q scripts/test_report_cli.py
"""

from __future__ import annotations

import csv
import json
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import psycopg2
import pytest

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import daily_tracker  # noqa: E402
import feature_audit  # noqa: E402
import mine_outcome_patterns as mining  # noqa: E402
import score_lineage_audit as lineage  # noqa: E402

SESSION = date(2026, 11, 4)
FAKE_URL = 'postgresql://fake/db'

MODULES = {
    'feature_audit': feature_audit,
    'tracker': daily_tracker,
    'mining': mining,
    'lineage': lineage,
}
# Read before any fixture patches them.
SHIPPED_DESTINATIONS = {
    'feature_audit': feature_audit.REPORT_DIR,
    'tracker': daily_tracker.CSV_PATH,
    'mining': mining.REPORT_DIR,
    'lineage': lineage.REPORT_DIR,
}


# ── fakes at the module boundary ─────────────────────────────────────────────


class FakeCursor:
    def __init__(self, latest: date) -> None:
        self._latest = latest

    def execute(self, sql: str, params: Any = None) -> None:
        pass

    def fetchone(self) -> tuple[date]:
        return (self._latest,)


class FakeConnection:
    """The two things the scripts use of a psycopg2 connection."""

    def __init__(self, latest: date) -> None:
        self._latest = latest

    def cursor(self) -> FakeCursor:
        return FakeCursor(self._latest)

    def close(self) -> None:
        pass


def _fake_database(monkeypatch) -> list[str]:
    """Patch psycopg2.connect; return the DSNs it was called with."""
    monkeypatch.setenv('DATABASE_URL', FAKE_URL)
    urls: list[str] = []

    def connect(url, *args, **kwargs):
        urls.append(url)
        return FakeConnection(SESSION)

    monkeypatch.setattr(psycopg2, 'connect', connect)
    return urls


def _serve(monkeypatch, reader: str, frame: pd.DataFrame) -> list[tuple[str, Any]]:
    """Patch pandas' `reader`; return the (sql, params) pairs it was given."""
    queries: list[tuple[str, Any]] = []

    def read(sql, con, params=None, **kwargs):
        queries.append((sql, params))
        return frame.copy()

    monkeypatch.setattr(pd, reader, read)
    return queries


def _snapshot(directory: Path) -> dict[str, tuple[int, int]]:
    """Name -> (size, mtime) of what a directory holds; empty when it is absent."""
    if not directory.is_dir():
        return {}
    return {
        p.name: (p.stat().st_size, p.stat().st_mtime_ns)
        for p in sorted(directory.iterdir())
    }


@pytest.fixture(autouse=True)
def default_dir(tmp_path, monkeypatch) -> Path:
    """Where a run with no destination argument lands, and no env file.

    The shipped default is docs/tmp under the repo root; the tests aim it at a
    temporary directory so a missing guard cannot write into the repo.
    """
    decoy = tmp_path / 'default-docs-tmp'
    missing = tmp_path / 'no-such-dir' / '.env.local'
    for module in MODULES.values():
        monkeypatch.setattr(module, 'ENV_FILE', missing)
    monkeypatch.setattr(feature_audit, 'REPORT_DIR', decoy)
    monkeypatch.setattr(mining, 'REPORT_DIR', decoy)
    monkeypatch.setattr(lineage, 'REPORT_DIR', decoy)
    monkeypatch.setattr(daily_tracker, 'CSV_PATH', decoy / 'lottery-tracking.csv')
    return decoy


# ── one run per script ───────────────────────────────────────────────────────


@dataclass
class Run:
    main: Callable[[list[str] | None], None]
    argv: list[str]  # every argument, destination included
    bare_argv: list[str]  # without the destination: the default applies
    out_dir: Path  # the directory `argv` aims the output at
    output: Path  # the file `argv` makes (or rewrites)
    urls: list[str]  # DSNs psycopg2.connect got
    queries: list[tuple[str, Any]]  # (sql, params) the report read
    reader: str  # the pandas reader that served them


def _audit_frame(n: int = 300) -> pd.DataFrame:
    rng = np.random.default_rng(7)
    frame = pd.DataFrame(
        {
            'ticker': rng.choice(['SPY', 'QQQ', 'TSLA'], n),
            'mode': rng.choice(['A_intraday_0DTE', 'B_multi_day_DTE1_3'], n),
            'tod': rng.choice(['AM_open', 'MID', 'LUNCH', 'PM'], n),
            'option_type': rng.choice(['C', 'P'], n),
            'dte': rng.integers(0, 4, n),
            'score': rng.integers(5, 20, n).astype(float),
            'alert_seq': rng.integers(1, 30, n).astype(float),
            'reload_tagged': rng.choice([False, True], n),
            'cheap_call_pm_tagged': rng.choice([False, True], n),
            'combined_score': rng.integers(8, 20, n).astype(float),
            'direction_gated': False,
            'date': rng.choice(
                [date(2026, 10, d) for d in range(5, 30)] + [SESSION], n
            ),
            'inversion_quintile': rng.integers(3, 6, n),
            'flow_inv': rng.normal(5, 40, n),
        }
    )
    for column in (
        'burst_ratio_vs_prev', 'entry_drop_pct_vs_prev', 'entry_price',
        'trigger_iv', 'trigger_delta', 'trigger_ask_pct',
        'trigger_vol_to_oi_window', 'mkt_tide_diff', 'mkt_tide_otm_diff',
        'spx_flow_diff', 'spy_etf_diff', 'qqq_etf_diff', 'zero_dte_diff',
        'spx_spot_gamma_oi', 'spx_spot_gamma_vol', 'spx_spot_charm_oi',
        'spx_spot_vanna_oi', 'gex_strike_call_minus_put',
        'gex_strike_call_ask_minus_bid', 'gex_strike_put_ask_minus_bid',
    ):  # fmt: skip
        frame[column] = rng.normal(0, 1, n)
    return frame


def feature_audit_run(tmp_path, monkeypatch) -> Run:
    out_dir = tmp_path / 'audit' / 'nested'
    urls = _fake_database(monkeypatch)
    weights = tmp_path / 'weights.json'
    weights.write_text(
        json.dumps(
            {
                'model_version': 'v-test',
                'trained_at': '2026-11-01',
                'training_sample': {
                    'n': 1234,
                    'date_range': ['2026-05-01', '2026-11-04'],
                },
            }
        ),
        encoding='utf-8',
    )
    monkeypatch.setattr(feature_audit, 'WEIGHTS_JSON', weights)
    queries = _serve(monkeypatch, 'read_sql', _audit_frame())
    return Run(
        main=feature_audit.main,
        argv=['--out-dir', str(out_dir)],
        bare_argv=[],
        out_dir=out_dir,
        output=out_dir / 'lottery-feature-audit-2026-11-04.md',
        urls=urls,
        queries=queries,
        reader='read_sql',
    )


# A non-ASCII ticker: the CSV is UTF-8 whatever the host's default text
# encoding is (U+0141 is not in cp1252, and its UTF-8 byte 0x81 is not valid in it).
NON_ASCII_TICKER = 'SPŁ'


def _tracker_frame() -> pd.DataFrame:
    rng = np.random.default_rng(3)
    n = 240
    return pd.DataFrame(
        {
            'date': [date(2026, 11, 3)] * (n // 2) + [SESSION] * (n // 2),
            'mode': rng.choice(['A_intraday_0DTE', 'B_multi_day_DTE1_3'], n),
            'score': rng.integers(5, 20, n).astype(float),
            'peak': rng.uniform(0, 120, n),
            'flow_inv': rng.normal(5, 40, n),
            'ticker': np.tile(['SPY', NON_ASCII_TICKER], n // 2),
        }
    )


def _seed_tracking_csv(path: Path) -> None:
    """Two earlier rows: 11-03 (stays as is) and a stale 11-04 (to be replaced)."""
    with path.open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=daily_tracker.COLUMNS)
        writer.writeheader()
        writer.writerow(
            {'date': '2026-11-03', 'run_at': '2026-11-03T21:00:00+00:00',
             'n_fires_today': '77', 'top1_ticker': NON_ASCII_TICKER}
        )  # fmt: skip
        writer.writerow(
            {'date': '2026-11-04', 'run_at': 'stale', 'n_fires_today': '-1'}
        )


def _read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def tracker_run(tmp_path, monkeypatch) -> Run:
    repo = tmp_path / 'repo'
    weights = repo / 'ml' / 'output' / 'lottery_score_weights.json'
    weights.parent.mkdir(parents=True)
    weights.write_text(json.dumps({'cutoffs': {'t1': 16, 't2': 12}}), encoding='utf-8')
    monkeypatch.setattr(daily_tracker, 'ROOT', repo)
    state = tmp_path / 'state'
    state.mkdir()
    csv_path = state / 'lottery-tracking.csv'
    _seed_tracking_csv(csv_path)
    urls = _fake_database(monkeypatch)
    queries = _serve(monkeypatch, 'read_sql', _tracker_frame())
    return Run(
        main=daily_tracker.main,
        argv=['--csv', str(csv_path)],
        bare_argv=[],
        out_dir=state,
        output=csv_path,
        urls=urls,
        queries=queries,
        reader='read_sql',
    )


def _fetched_fires() -> pd.DataFrame:
    """What the mining and lineage queries return; only what fetch_fires reads."""
    return pd.DataFrame(
        {
            'date': [date(2026, 11, 2), date(2026, 11, 3), SESSION, SESSION],
            'realized_flow_inversion_pct': [60.0, -60.0, 10.0, None],
            'realized_eod_pct': [55.0, -70.0, 12.0, 0.0],
            'peak_ceiling_pct': [90.0, 5.0, 30.0, 20.0],
        }
    )


def mining_run(tmp_path, monkeypatch) -> Run:
    out_dir = tmp_path / 'mining'
    urls = _fake_database(monkeypatch)
    queries = _serve(monkeypatch, 'read_sql_query', _fetched_fires())
    monkeypatch.setattr(mining, 'load_weights', lambda: {'model_version': 'v-test'})
    features = pd.DataFrame(
        {key: ['x', 'y', 'x', 'y'] for key in mining.FEATURE_KEYS}
        | {'outcome_pct': [60.0, -60.0, 10.0, 0.0]}
    )
    monkeypatch.setattr(mining, 'build_feature_tuples', lambda df, weights: features)
    monkeypatch.setattr(mining, 'scan_combos', lambda *args, **kwargs: ([], 0, 0))
    return Run(
        main=mining.main,
        argv=['--as-of', '2026-11-04', '--out-dir', str(out_dir)],
        bare_argv=['--as-of', '2026-11-04'],
        out_dir=out_dir,
        output=out_dir / 'lottery-composite-candidates-2026-11-04.md',
        urls=urls,
        queries=queries,
        reader='read_sql_query',
    )


def lineage_run(tmp_path, monkeypatch) -> Run:
    out_dir = tmp_path / 'lineage'
    urls = _fake_database(monkeypatch)
    queries = _serve(monkeypatch, 'read_sql_query', _fetched_fires())
    monkeypatch.setattr(lineage, 'load_weights', lambda: {'model_version': 'v-test'})
    table = pd.DataFrame(
        [
            {
                'dow': 0, 'dow_name': 'Monday', 'component': 'tod', 'n_win': 30,
                'n_loss': 25, 'support': 55, 'win_mean': 1.0, 'loss_mean': 0.5,
                'gap': 0.5, 'flagged': False,
            }
        ]
    )  # fmt: skip
    monkeypatch.setattr(
        lineage, 'run_attribution', lambda df, weights: (table, table[table['flagged']])
    )
    return Run(
        main=lineage.main,
        argv=['--as-of', '2026-11-04', '--out-dir', str(out_dir)],
        bare_argv=['--as-of', '2026-11-04'],
        out_dir=out_dir,
        output=out_dir / 'lottery-score-lineage-2026-11-04.md',
        urls=urls,
        queries=queries,
        reader='read_sql_query',
    )


BUILDERS = {
    'feature_audit': feature_audit_run,
    'tracker': tracker_run,
    'mining': mining_run,
    'lineage': lineage_run,
}
AS_OF_REPORTS = ('mining', 'lineage')


# ── the destination ──────────────────────────────────────────────────────────


def test_feature_audit_writes_into_out_dir(tmp_path, monkeypatch, default_dir):
    run = feature_audit_run(tmp_path, monkeypatch)

    run.main(run.argv)

    assert [p.name for p in run.out_dir.iterdir()] == [
        'lottery-feature-audit-2026-11-04.md'
    ]
    text = run.output.read_text(encoding='utf-8')
    assert text.startswith('# Fire-row feature audit')
    assert 'Dataset: 300 fires' in text
    assert '(2026-05-01 → 2026-11-04)' in text
    assert '→'.encode() in run.output.read_bytes()
    assert _snapshot(default_dir) == {}


def test_tracker_csv_path_is_respected_and_row_replaced(
    tmp_path, monkeypatch, default_dir
):
    run = tracker_run(tmp_path, monkeypatch)
    before = _read_rows(run.output)
    assert [r['date'] for r in before] == ['2026-11-03', '2026-11-04']

    run.main(run.argv)

    after = _read_rows(run.output)
    assert len(after) == len(before)
    assert sorted(r['date'] for r in after) == ['2026-11-03', '2026-11-04']
    assert next(r for r in after if r['date'] == '2026-11-03') == before[0]
    replaced = next(r for r in after if r['date'] == '2026-11-04')
    assert replaced['n_fires_today'] == '120'
    assert replaced['run_at'] != 'stale'
    assert {replaced['top1_ticker'], replaced['top2_ticker']} == {
        'SPY',
        NON_ASCII_TICKER,
    }
    assert _snapshot(run.out_dir).keys() == {'lottery-tracking.csv'}
    assert _snapshot(default_dir) == {}


def test_tracker_with_no_enriched_fires_exits_and_leaves_the_csv_alone(
    tmp_path, monkeypatch, default_dir
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', pd.DataFrame(columns=['date', 'score']))
    before = run.output.read_bytes()

    with pytest.raises(SystemExit) as exit_info:
        run.main(run.argv)

    assert 'no enriched fires' in str(exit_info.value.code)
    assert run.output.read_bytes() == before
    assert _snapshot(default_dir) == {}


@pytest.mark.parametrize('name', BUILDERS)
def test_without_a_destination_the_output_lands_in_the_default_dir(
    name, tmp_path, monkeypatch, default_dir
):
    run = BUILDERS[name](tmp_path, monkeypatch)
    before = _snapshot(run.out_dir)

    run.main(run.bare_argv)

    assert (default_dir / run.output.name).is_file()
    assert _snapshot(run.out_dir) == before


def test_the_shipped_defaults_are_docs_tmp_under_the_repo_root():
    docs_tmp = feature_audit.ROOT / 'docs' / 'tmp'
    assert SHIPPED_DESTINATIONS == {
        'feature_audit': docs_tmp,
        'tracker': docs_tmp / 'lottery-tracking.csv',
        'mining': docs_tmp,
        'lineage': docs_tmp,
    }


# ── the session date ─────────────────────────────────────────────────────────


def test_mining_window_is_anchored_to_as_of(tmp_path, monkeypatch, default_dir):
    run = mining_run(tmp_path, monkeypatch)

    run.main(run.argv)

    ((sql, params),) = run.queries
    assert "%(as_of)s::date - INTERVAL '90 days'" in sql
    assert 'CURRENT_DATE' not in sql
    assert params == {'as_of': date(2026, 11, 4)}
    assert [p.name for p in run.out_dir.iterdir()] == [
        'lottery-composite-candidates-2026-11-04.md'
    ]
    text = run.output.read_text(encoding='utf-8')
    assert text.startswith('# Lottery composite candidates — 2026-11-04')
    assert _snapshot(default_dir) == {}


def test_lineage_window_is_anchored_to_as_of(tmp_path, monkeypatch, default_dir):
    run = lineage_run(tmp_path, monkeypatch)

    run.main(run.argv)

    ((sql, params),) = run.queries
    assert "%(as_of)s::date - INTERVAL '30 days'" in sql
    assert 'CURRENT_DATE' not in sql
    assert params == {'as_of': date(2026, 11, 4)}
    assert [p.name for p in run.out_dir.iterdir()] == [
        'lottery-score-lineage-2026-11-04.md'
    ]
    text = run.output.read_text(encoding='utf-8')
    assert text.startswith('# Lottery Score Lineage Audit — 2026-11-04')
    assert _snapshot(default_dir) == {}


@pytest.mark.parametrize('name', AS_OF_REPORTS)
def test_as_of_defaults_to_today(name, tmp_path, monkeypatch, default_dir):
    run = BUILDERS[name](tmp_path, monkeypatch)

    class Today(date):
        @classmethod
        def today(cls):
            return cls(2026, 11, 6)

    monkeypatch.setattr(MODULES[name], 'date', Today)

    run.main(['--out-dir', str(run.out_dir)])

    ((_, params),) = run.queries
    assert params == {'as_of': date(2026, 11, 6)}
    (report,) = run.out_dir.iterdir()
    assert report.name.endswith('-2026-11-06.md')
    assert '2026-11-06' in report.read_text(encoding='utf-8').splitlines()[0]


@pytest.mark.parametrize('name', AS_OF_REPORTS)
@pytest.mark.parametrize('value', ['2026-13-40', 'yesterday', ''])
def test_a_bad_as_of_is_a_usage_error_before_any_connection(
    name, value, tmp_path, monkeypatch, default_dir
):
    run = BUILDERS[name](tmp_path, monkeypatch)

    with pytest.raises(SystemExit) as exit_info:
        run.main(['--as-of', value, '--out-dir', str(run.out_dir)])

    assert exit_info.value.code == 2
    assert run.urls == []
    assert run.queries == []
    assert not run.out_dir.exists()
    assert _snapshot(default_dir) == {}


# ── the environment ──────────────────────────────────────────────────────────


@pytest.mark.parametrize('name', BUILDERS)
def test_missing_env_file_is_not_fatal(name, tmp_path, monkeypatch):
    run = BUILDERS[name](tmp_path, monkeypatch)
    missing = tmp_path / 'service-has-no' / '.env.local'
    monkeypatch.setattr(MODULES[name], 'ENV_FILE', missing)
    assert not missing.exists()

    run.main(run.argv)  # a SystemExit here fails the test

    assert run.output.is_file()
    assert run.urls == [FAKE_URL]


@pytest.mark.parametrize('name', BUILDERS)
def test_env_file_supplies_the_database_url_when_the_environment_has_none(
    name, tmp_path, monkeypatch
):
    run = BUILDERS[name](tmp_path, monkeypatch)
    env_file = tmp_path / 'env.local'
    env_file.write_text('DATABASE_URL="postgresql://from-file/db"\n', encoding='utf-8')
    monkeypatch.setattr(MODULES[name], 'ENV_FILE', env_file)
    monkeypatch.delenv('DATABASE_URL')  # put back at teardown, whatever the file sets

    run.main(run.argv)

    assert run.urls == ['postgresql://from-file/db']


# ── failure ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize('stage', ['connect', 'query'])
@pytest.mark.parametrize('name', BUILDERS)
def test_a_database_failure_ends_the_run_and_writes_nothing(
    name, stage, tmp_path, monkeypatch, default_dir
):
    run = BUILDERS[name](tmp_path, monkeypatch)

    def refuse(*args, **kwargs):
        raise psycopg2.OperationalError('connection refused')

    if stage == 'connect':
        monkeypatch.setattr(psycopg2, 'connect', refuse)
    else:
        monkeypatch.setattr(pd, run.reader, refuse)
    before = _snapshot(run.out_dir)

    with pytest.raises(psycopg2.OperationalError):
        run.main(run.argv)

    assert _snapshot(run.out_dir) == before
    assert _snapshot(default_dir) == {}
