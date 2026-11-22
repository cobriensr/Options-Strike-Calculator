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
* The window runs from `--as-of` back 90 days (mining) or 30 days (lineage), both
  ends inclusive: a fire dated after `--as-of` is left out, and a window with no
  fire ends the run.
* The env file is optional (the nightly service has none) and the reports write
  UTF-8.
* A failed database call, or a bad `--as-of`, ends the run before anything is
  written.

Neon is faked at the module boundary: `psycopg2.connect`,
`pandas.read_sql` / `read_sql_query` and `_report_weights.load_pointer`, where
all four reports' read of the active weights lives (what the weights say is
pinned in test_report_weights.py). No test reaches a database. The fake for the
windowed reports applies the date bounds the SQL text states, the way Postgres
would, so a bound dropped from the query shows in what the report analyses.

The UTF-8 tests make `Path.write_text` and `Path.open` default to cp1252 when
no encoding is named (`legacy_text_default`), so a dropped `encoding='utf-8'`
fails on any host, UTF-8 mode or not. Run:

    ml/.venv/Scripts/python -m pytest -q scripts/test_report_cli.py
"""

from __future__ import annotations

import csv
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import psycopg2
import pytest

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import _report_weights  # noqa: E402
import daily_tracker  # noqa: E402
import feature_audit  # noqa: E402
import mine_outcome_patterns as mining  # noqa: E402
import score_lineage_audit as lineage  # noqa: E402

SESSION = date(2026, 11, 4)
FAKE_URL = 'postgresql://fake/db'
ACTIVE_VERSION = 'refit-2026-11-01'
# What the four reports read of the active weights: the tracker its bare
# cutoffs, the audit its feed cutoffs and header fields. Mining and lineage
# hand the weights to a scorer the tests stub, so they read only the version.
ACTIVE_WEIGHTS = {
    'model_version': 'v-test',
    'trained_through': '2026-10-30',
    'cutoffs': {'t1': 16, 't2': 12},
    'feed_cutoffs': {'tier1_min_score': 16, 'tier2_min_score': 12},
}

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
# The repo's real docs/tmp. No test may change it; the happy-path tests snapshot it.
SHIPPED_DOCS_TMP = SHIPPED_DESTINATIONS['feature_audit']


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


def _in_the_sql_window(sql: str, params: dict, frame: pd.DataFrame) -> pd.DataFrame:
    """What Postgres would return: the rows inside the date bounds the SQL states.

    The lower bound is read from `date >= %(as_of)s::date - INTERVAL 'N days'`
    and must be there. The upper bound, `AND date <= %(as_of)s::date`, is applied
    only when the SQL has it, so a query that loses it hands the report a fire
    from after the session.
    """
    lower = re.search(r"date >= %\(as_of\)s::date - INTERVAL '(\d+) days'", sql)
    assert lower, 'the query has no as_of lower bound'
    as_of = params['as_of']
    keep = frame['date'] >= as_of - timedelta(days=int(lower.group(1)))
    if 'AND date <= %(as_of)s::date' in sql:
        keep &= frame['date'] <= as_of
    served = frame[keep]
    # Only the columns the SELECT lists: lineage's names `date`, mining's does not.
    return served if re.search(r'^\s+date,\s*$', sql, re.MULTILINE) else served.drop(
        columns='date'
    )


def _serve(
    monkeypatch,
    reader: str,
    frame: pd.DataFrame,
    answer: Callable[[str, Any, pd.DataFrame], pd.DataFrame] | None = None,
) -> list[tuple[str, Any]]:
    """Patch pandas' `reader`; return the (sql, params) pairs it was given.

    It serves `frame`, or what `answer(sql, params, frame)` makes of it.
    """
    queries: list[tuple[str, Any]] = []

    def read(sql, con, params=None, **kwargs):
        queries.append((sql, params))
        served = frame if answer is None else answer(sql, params, frame)
        return served.copy()

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
def active_weights(monkeypatch) -> None:
    """The store read, faked where the reports' shared reader makes it."""
    monkeypatch.setattr(
        _report_weights,
        'load_pointer',
        lambda _conn, _name: (ACTIVE_VERSION, ACTIVE_WEIGHTS),
    )


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


@pytest.fixture
def legacy_text_default(monkeypatch) -> None:
    """A host whose default text encoding is a legacy code page (cp1252).

    A `Path.write_text` or `Path.open` that names no encoding is made in cp1252
    whatever this host's own default is, so a dropped `encoding='utf-8'` fails
    here and in CI, where UTF-8 mode would hide it (U+2192 and U+0141 are not in
    cp1252, and a UTF-8 0x81 byte is not valid in it).
    """
    real_write_text = Path.write_text
    real_open = Path.open

    def write_text(self, data, encoding=None, **kwargs):
        return real_write_text(self, data, encoding=encoding or 'cp1252', **kwargs)

    def open_(self, mode='r', buffering=-1, encoding=None, errors=None, newline=None):
        if 'b' not in mode and encoding is None:
            encoding = 'cp1252'
        return real_open(self, mode, buffering, encoding, errors, newline)

    monkeypatch.setattr(Path, 'write_text', write_text)
    monkeypatch.setattr(Path, 'open', open_)


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
    analysed: list[pd.DataFrame] = field(default_factory=list)  # fires analysed


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


# A non-ASCII ticker, for the tracker CSV and the mining report: both are UTF-8
# whatever the host's default text encoding is (U+0141 is not in cp1252, and its
# UTF-8 byte 0x81 is not valid in it).
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


FILL_DAYS = {date(2026, 11, 3): 20, date(2026, 11, 4): 200, date(2026, 11, 5): 100}


def _fill_frame(days: dict[date, int] | None = None) -> pd.DataFrame:
    """Fires on a few dates, made without random numbers so the rows they give are exact.

    In FILL_DAYS 11-03 has 20 fires, under the 30 a stats block needs, so its blocks
    are blank. By the end of 11-04 each of the two tickers has over 100 fires, so
    the top-ticker slots fill.
    """
    sizes = days or FILL_DAYS
    i = np.arange(sum(sizes.values()))
    return pd.DataFrame(
        {
            'date': np.repeat(np.array(list(sizes), dtype=object), list(sizes.values())),
            'mode': np.where(i % 3 == 0, 'B_multi_day_DTE1_3', 'A_intraday_0DTE'),
            'score': ((i * 7) % 20 + 5).astype(float),
            'peak': ((i * i * 7 + i) % 113).astype(float),
            'flow_inv': ((i * 37) % 101 - 40).astype(float),
            'ticker': np.where(i % 2 == 0, 'SPY', NON_ASCII_TICKER),
        }
    )


def _write_tracking_csv(path: Path, dates: list[str]) -> None:
    """A tracking file whose rows are the given dates, each carrying its own marker."""
    with path.open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=daily_tracker.COLUMNS)
        writer.writeheader()
        for d in dates:
            writer.writerow(
                {'date': d, 'run_at': f'seed-{d}', 'n_fires_today': '77',
                 'top1_ticker': NON_ASCII_TICKER}
            )  # fmt: skip


def _ticking_clock(monkeypatch) -> None:
    """The tracker's clock, a second later on every read of it."""
    seconds = iter(range(60))

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 11, 6, 1, 0, next(seconds), tzinfo=tz)

    monkeypatch.setattr(daily_tracker, 'datetime', Clock)


# What the tracker wrote BEFORE it filled gaps, recorded from that code (run_at left
# out). The new code has to write the same fields for the same fires.
#
# The row for the newest date of _tracker_frame() (240 fires, 11-03 and 11-04), the
# file _seed_tracking_csv makes. Its last row is 11-04 as well, so the old and the new
# code both write the one row, for 11-04.
GOLDEN_TRACKER_ROW = {
    'date': '2026-11-04', 'n_fires_today': '120', 'n_fires_total_window': '240',
    'days_in_window': '2', 't1_today': '22', 't2_today': '39', 't3_today': '59',
    'flow_inv_n': '240', 'flow_inv_mean_pct': '9.243', 'flow_inv_sharpe': '0.232',
    't2plus_n': '122', 't2plus_mean_pct': '7.648', 't2plus_sharpe': '0.187',
    'modeB_n': '122', 'modeB_mean_pct': '10.645', 'modeB_sharpe': '0.2582',
    'top1_ticker': NON_ASCII_TICKER, 'top1_n': '120', 'top1_rate': '60.0',
    'top2_ticker': 'SPY', 'top2_n': '120', 'top2_rate': '50.83',
    'top3_ticker': '', 'top3_n': '', 'top3_rate': '',
}  # fmt: skip

# The row the old code wrote for each date of _fill_frame(), run on that frame cut at
# the date (the old code writes the row of the newest date it reads). The 11-03 row has
# blank stats (20 fires) and no top tickers; the 11-05 row's top ticker is the other
# one than 11-04's.
GOLDEN_FILL_ROWS = {
    '2026-11-03': {
        'date': '2026-11-03', 'n_fires_today': '20', 'n_fires_total_window': '20',
        'days_in_window': '1', 't1_today': '9', 't2_today': '4', 't3_today': '7',
        'flow_inv_n': '20', 'flow_inv_mean_pct': '', 'flow_inv_sharpe': '',
        't2plus_n': '13', 't2plus_mean_pct': '', 't2plus_sharpe': '',
        'modeB_n': '7', 'modeB_mean_pct': '', 'modeB_sharpe': '',
        'top1_ticker': '', 'top1_n': '', 'top1_rate': '',
        'top2_ticker': '', 'top2_n': '', 'top2_rate': '',
        'top3_ticker': '', 'top3_n': '', 'top3_rate': '',
    },
    '2026-11-04': {
        'date': '2026-11-04', 'n_fires_today': '200', 'n_fires_total_window': '220',
        'days_in_window': '2', 't1_today': '90', 't2_today': '40', 't3_today': '70',
        'flow_inv_n': '220', 'flow_inv_mean_pct': '9.605', 'flow_inv_sharpe': '0.328',
        't2plus_n': '143', 't2plus_mean_pct': '9.713', 't2plus_sharpe': '0.3273',
        'modeB_n': '74', 'modeB_mean_pct': '9.716', 'modeB_sharpe': '0.3253',
        'top1_ticker': 'SPY', 'top1_n': '110', 'top1_rate': '55.45',
        'top2_ticker': NON_ASCII_TICKER, 'top2_n': '110', 'top2_rate': '54.55',
        'top3_ticker': '', 'top3_n': '', 'top3_rate': '',
    },
    '2026-11-05': {
        'date': '2026-11-05', 'n_fires_today': '100', 'n_fires_total_window': '320',
        'days_in_window': '3', 't1_today': '45', 't2_today': '20', 't3_today': '35',
        'flow_inv_n': '320', 'flow_inv_mean_pct': '9.812', 'flow_inv_sharpe': '0.3355',
        't2plus_n': '208', 't2plus_mean_pct': '10.062', 't2plus_sharpe': '0.3439',
        'modeB_n': '107', 'modeB_mean_pct': '8.598', 'modeB_sharpe': '0.2932',
        'top1_ticker': NON_ASCII_TICKER, 'top1_n': '160', 'top1_rate': '56.25',
        'top2_ticker': 'SPY', 'top2_n': '160', 'top2_rate': '53.12',
        'top3_ticker': '', 'top3_n': '', 'top3_rate': '',
    },
}  # fmt: skip


def _without_run_at(row: dict[str, str]) -> dict[str, str]:
    return {k: v for k, v in row.items() if k != 'run_at'}


def tracker_run(tmp_path, monkeypatch) -> Run:
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


AFTER_SESSION = date(2026, 11, 5)  # a fire the run for 11-04 must not read
INSIDE_90_NOT_30 = date(2026, 9, 15)  # 50 days back: in mining's window, not lineage's
BEFORE_90 = date(2026, 7, 1)  # 126 days back, in neither window
# fire id -> the date it fired. Four are in both windows.
FIRE_DATES = {
    1: date(2026, 11, 2),
    2: date(2026, 11, 3),
    3: SESSION,
    4: SESSION,
    5: AFTER_SESSION,
    6: INSIDE_90_NOT_30,
    7: BEFORE_90,
}


def _fetched_fires() -> pd.DataFrame:
    """What the mining and lineage tables hold, before their date bounds apply.

    Only the columns fetch_fires reads, plus `date` for the fake to filter on.
    """
    return pd.DataFrame(
        {
            'id': list(FIRE_DATES),
            'date': list(FIRE_DATES.values()),
            'realized_flow_inversion_pct': [60.0, -60.0, 10.0, None, 40.0, 15.0, 20.0],
            'realized_eod_pct': [55.0, -70.0, 12.0, 0.0, 35.0, 10.0, 18.0],
            'peak_ceiling_pct': [90.0, 5.0, 30.0, 20.0, 80.0, 40.0, 50.0],
        }
    )  # fmt: skip


def mining_run(tmp_path, monkeypatch) -> Run:
    out_dir = tmp_path / 'mining'
    urls = _fake_database(monkeypatch)
    queries = _serve(
        monkeypatch, 'read_sql_query', _fetched_fires(), _in_the_sql_window
    )
    features = pd.DataFrame(
        {key: ['x', 'y', 'x', 'y'] for key in mining.FEATURE_KEYS}
        | {'outcome_pct': [60.0, -60.0, 10.0, 0.0]}
    )
    analysed: list[pd.DataFrame] = []

    def build_feature_tuples(df, weights):
        analysed.append(df)
        return features

    combo = {  # one winning composite, named for a non-ASCII ticker
        'combo': f'ticker={NON_ASCII_TICKER} & tod=AM_open',
        'n_total': 40, 'n_winners': 12, 'n_losers': 2, 'lift_win': 3.0,
        'lift_loss': 0.5, 'net_score': 2.5, 'best_singleton_net': 1.0, 'marginal': 1.5,
    }  # fmt: skip
    monkeypatch.setattr(mining, 'build_feature_tuples', build_feature_tuples)
    monkeypatch.setattr(mining, 'scan_combos', lambda *args, **kwargs: ([combo], 1, 1))
    return Run(
        main=mining.main,
        argv=['--as-of', '2026-11-04', '--out-dir', str(out_dir)],
        bare_argv=['--as-of', '2026-11-04'],
        out_dir=out_dir,
        output=out_dir / 'lottery-composite-candidates-2026-11-04.md',
        urls=urls,
        queries=queries,
        reader='read_sql_query',
        analysed=analysed,
    )


def lineage_run(tmp_path, monkeypatch) -> Run:
    out_dir = tmp_path / 'lineage'
    urls = _fake_database(monkeypatch)
    queries = _serve(
        monkeypatch, 'read_sql_query', _fetched_fires(), _in_the_sql_window
    )
    table = pd.DataFrame(
        [
            {
                'dow': 0, 'dow_name': 'Monday', 'component': 'tod', 'n_win': 30,
                'n_loss': 25, 'support': 55, 'win_mean': 1.0, 'loss_mean': 0.5,
                'gap': 0.5, 'flagged': False,
            }
        ]
    )  # fmt: skip
    analysed: list[pd.DataFrame] = []

    def run_attribution(df, weights):
        analysed.append(df)
        return table, table[table['flagged']]

    monkeypatch.setattr(lineage, 'run_attribution', run_attribution)
    return Run(
        main=lineage.main,
        argv=['--as-of', '2026-11-04', '--out-dir', str(out_dir)],
        bare_argv=['--as-of', '2026-11-04'],
        out_dir=out_dir,
        output=out_dir / 'lottery-score-lineage-2026-11-04.md',
        urls=urls,
        queries=queries,
        reader='read_sql_query',
        analysed=analysed,
    )


BUILDERS = {
    'feature_audit': feature_audit_run,
    'tracker': tracker_run,
    'mining': mining_run,
    'lineage': lineage_run,
}
AS_OF_REPORTS = ('mining', 'lineage')


# ── the destination ──────────────────────────────────────────────────────────


def test_feature_audit_writes_into_out_dir(
    tmp_path, monkeypatch, default_dir, legacy_text_default
):
    run = feature_audit_run(tmp_path, monkeypatch)
    shipped_before = _snapshot(SHIPPED_DOCS_TMP)

    run.main(run.argv)

    assert [p.name for p in run.out_dir.iterdir()] == [
        'lottery-feature-audit-2026-11-04.md'
    ]
    text = run.output.read_bytes().decode('utf-8')  # UTF-8 though the default is cp1252
    assert text.startswith('# Fire-row feature audit')
    assert 'Dataset: 300 fires' in text
    # The ≥ is not in cp1252 either.
    assert f'T1 = qas ≥ 16, T2 = qas ≥ 12 (feed cutoffs of version {ACTIVE_VERSION})' in text
    assert _snapshot(default_dir) == {}
    assert _snapshot(SHIPPED_DOCS_TMP) == shipped_before


def test_tracker_csv_path_is_respected_and_row_replaced(
    tmp_path, monkeypatch, default_dir, legacy_text_default
):
    run = tracker_run(tmp_path, monkeypatch)
    shipped_before = _snapshot(SHIPPED_DOCS_TMP)
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
    assert _snapshot(SHIPPED_DOCS_TMP) == shipped_before


def test_tracker_row_for_the_newest_date_is_the_one_it_always_wrote(
    tmp_path, monkeypatch, default_dir
):
    run = tracker_run(tmp_path, monkeypatch)

    run.main(run.argv)

    rows = _read_rows(run.output)
    assert [r['date'] for r in rows] == ['2026-11-03', '2026-11-04']  # one row written
    assert _without_run_at(rows[-1]) == GOLDEN_TRACKER_ROW
    assert rows[-1]['run_at'].startswith('20')  # an ISO timestamp, not the stale marker


def test_tracker_fills_every_fire_date_after_the_csvs_last_row(
    tmp_path, monkeypatch, default_dir, capsys, legacy_text_default
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    _write_tracking_csv(run.output, ['2026-11-01', '2026-11-02'])
    before = _read_rows(run.output)
    _ticking_clock(monkeypatch)

    run.main(run.argv)

    after = _read_rows(run.output)
    assert after[:2] == before  # the rows already there, untouched and in order
    assert [r['date'] for r in after] == [
        '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'
    ]  # fmt: skip
    filled = after[2:]
    # Each row is as of its own date: the old code's row for the frame cut there.
    assert {r['date']: _without_run_at(r) for r in filled} == GOLDEN_FILL_ROWS
    assert [
        (r['n_fires_today'], r['n_fires_total_window'], r['days_in_window'])
        for r in filled
    ] == [('20', '20', '1'), ('200', '220', '2'), ('100', '320', '3')]
    # One timestamp for the run: the clock moves on every read, so one per row differs.
    assert {r['run_at'] for r in filled} == {'2026-11-06T01:00:00+00:00'}
    header = run.output.read_text(encoding='utf-8').splitlines()[0]
    assert header == ','.join(daily_tracker.COLUMNS)
    out = capsys.readouterr().out
    assert '[track] filled 3 dates (2026-11-03 .. 2026-11-05)' in out
    assert '[track] 2026-11-05: 100 new fires (T1=45 T2=20 T3=35)' in out  # newest row
    assert '(5 rows)' in out


def test_tracker_writes_no_row_for_a_date_without_fires(
    tmp_path, monkeypatch, default_dir, capsys
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(
        monkeypatch,
        'read_sql',
        _fill_frame({date(2026, 11, 3): 20, date(2026, 11, 5): 100}),  # none on 11-04
    )
    _write_tracking_csv(run.output, ['2026-11-02'])

    run.main(run.argv)

    after = _read_rows(run.output)
    assert [r['date'] for r in after] == ['2026-11-02', '2026-11-03', '2026-11-05']
    # The gap is not a day of the window: 120 fires over two dates.
    assert (after[-1]['n_fires_total_window'], after[-1]['days_in_window']) == ('120', '2')
    assert '[track] filled 2 dates (2026-11-03 .. 2026-11-05)' in capsys.readouterr().out


def test_tracker_does_not_rewrite_the_last_rows_date_when_later_dates_exist(
    tmp_path, monkeypatch, default_dir
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    _write_tracking_csv(run.output, ['2026-11-03', '2026-11-04'])
    before = _read_rows(run.output)

    run.main(run.argv)

    after = _read_rows(run.output)
    assert after[:2] == before  # 11-04 has fires, but its row is the file's own
    assert [r['date'] for r in after] == ['2026-11-03', '2026-11-04', '2026-11-05']


def test_tracker_rerun_after_a_fill_replaces_the_newest_row_only(
    tmp_path, monkeypatch, default_dir, capsys
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    _write_tracking_csv(run.output, ['2026-11-02'])
    run.main(run.argv)
    first = _read_rows(run.output)
    _ticking_clock(monkeypatch)
    capsys.readouterr()

    run.main(run.argv)  # nothing new since: the last date is the file's last

    second = _read_rows(run.output)
    assert [r['date'] for r in second] == [r['date'] for r in first]
    assert second[:-1] == first[:-1]
    assert _without_run_at(second[-1]) == _without_run_at(first[-1])
    assert second[-1]['run_at'] == '2026-11-06T01:00:00+00:00'  # rewritten by this run
    assert 'filled' not in capsys.readouterr().out  # one date is not a fill


@pytest.mark.parametrize(
    'seed',
    [
        pytest.param(None, id='no_file'),
        pytest.param([], id='header_only'),
        pytest.param(['not-a-date'], id='no_row_with_a_date'),
    ],
)
def test_tracker_without_a_last_date_writes_the_newest_date_only(
    seed, tmp_path, monkeypatch, default_dir, capsys
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    csv_path = run.out_dir / 'fresh.csv'  # a file that is not there yet
    if seed is not None:
        _write_tracking_csv(csv_path, seed)

    run.main(['--csv', str(csv_path)])

    rows = _read_rows(csv_path)
    # Never the whole history into a file with no last date; an odd row stays.
    assert [r['date'] for r in rows] == [*(seed or []), '2026-11-05']
    assert _without_run_at(rows[-1]) == GOLDEN_FILL_ROWS['2026-11-05']
    assert 'filled' not in capsys.readouterr().out


@pytest.mark.parametrize(
    'odd_date',
    [
        pytest.param('not-a-date', id='text'),
        pytest.param('2026-13-45', id='no_such_day'),
        pytest.param('20261230', id='not_yyyy_mm_dd'),  # a later date, if it were read
        pytest.param('', id='blank'),
    ],
)
def test_tracker_ignores_a_row_whose_date_does_not_parse_but_keeps_it(
    odd_date, tmp_path, monkeypatch, default_dir
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    _write_tracking_csv(run.output, ['2026-11-02', odd_date])
    before = _read_rows(run.output)

    run.main(run.argv)

    after = _read_rows(run.output)
    assert after[:2] == before  # the odd row stays where it was
    assert [r['date'] for r in after[2:]] == ['2026-11-03', '2026-11-04', '2026-11-05']


def test_tracker_reads_fire_dates_that_come_as_timestamps(
    tmp_path, monkeypatch, default_dir
):
    run = tracker_run(tmp_path, monkeypatch)
    frame = _fill_frame()
    frame['date'] = pd.to_datetime(frame['date'])  # datetime64, not date objects
    _serve(monkeypatch, 'read_sql', frame)
    _write_tracking_csv(run.output, ['2026-11-02'])

    run.main(run.argv)

    filled = _read_rows(run.output)[1:]
    assert {r['date']: _without_run_at(r) for r in filled} == GOLDEN_FILL_ROWS


def test_tracker_with_a_csv_ahead_of_the_fires_writes_the_newest_date_only(
    tmp_path, monkeypatch, default_dir
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    _write_tracking_csv(run.output, ['2026-11-09'])

    run.main(run.argv)

    assert [r['date'] for r in _read_rows(run.output)] == ['2026-11-09', '2026-11-05']


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


def test_mining_window_is_anchored_to_as_of(
    tmp_path, monkeypatch, default_dir, legacy_text_default
):
    run = mining_run(tmp_path, monkeypatch)
    shipped_before = _snapshot(SHIPPED_DOCS_TMP)

    run.main(run.argv)

    ((sql, params),) = run.queries
    assert "%(as_of)s::date - INTERVAL '90 days'" in sql
    assert 'AND date <= %(as_of)s::date' in sql
    assert 'CURRENT_DATE' not in sql
    assert params == {'as_of': date(2026, 11, 4)}
    assert [p.name for p in run.out_dir.iterdir()] == [
        'lottery-composite-candidates-2026-11-04.md'
    ]
    text = run.output.read_bytes().decode('utf-8')  # the Ł is not in cp1252
    assert text.startswith('# Lottery composite candidates — 2026-11-04')
    assert f'Active lottery weights: {ACTIVE_VERSION} (model_version v-test)' in text
    assert 'Sample: the 90 days up to 2026-11-04, aligned single-leg' in text
    assert f'ticker={NON_ASCII_TICKER} & tod=AM_open' in text
    assert _snapshot(default_dir) == {}
    assert _snapshot(SHIPPED_DOCS_TMP) == shipped_before


def test_lineage_window_is_anchored_to_as_of(
    tmp_path, monkeypatch, default_dir, legacy_text_default
):
    run = lineage_run(tmp_path, monkeypatch)
    shipped_before = _snapshot(SHIPPED_DOCS_TMP)

    run.main(run.argv)

    ((sql, params),) = run.queries
    assert "%(as_of)s::date - INTERVAL '30 days'" in sql
    assert 'AND date <= %(as_of)s::date' in sql
    assert 'CURRENT_DATE' not in sql
    assert params == {'as_of': date(2026, 11, 4)}
    assert [p.name for p in run.out_dir.iterdir()] == [
        'lottery-score-lineage-2026-11-04.md'
    ]
    text = run.output.read_bytes().decode('utf-8')  # the ✓ is not in cp1252
    assert text.startswith('# Lottery Score Lineage Audit — 2026-11-04')
    assert f'Active lottery weights: {ACTIVE_VERSION} (model_version v-test)' in text
    assert 'Window: the 30 days up to 2026-11-04, enriched aligned single-leg' in text
    assert '✓' in text
    assert _snapshot(default_dir) == {}
    assert _snapshot(SHIPPED_DOCS_TMP) == shipped_before


@pytest.mark.parametrize(
    ('name', 'analysed_ids'),
    [
        pytest.param('mining', {1, 2, 3, 4, 6}, id='mining-90-days'),
        pytest.param('lineage', {1, 2, 3, 4}, id='lineage-30-days'),
    ],
)
def test_the_window_ends_at_as_of_and_reaches_back_its_length(
    name, analysed_ids, tmp_path, monkeypatch, default_dir
):
    """A fire dated after the session is left out, as is one before the window."""
    run = BUILDERS[name](tmp_path, monkeypatch)

    run.main(run.argv)

    (fires,) = run.analysed
    analysed = {FIRE_DATES[i] for i in fires['id']}
    assert AFTER_SESSION not in analysed
    assert BEFORE_90 not in analysed
    assert set(fires['id']) == analysed_ids


@pytest.mark.parametrize('name', AS_OF_REPORTS)
def test_an_empty_window_ends_the_run_and_writes_nothing(
    name, tmp_path, monkeypatch, default_dir
):
    run = BUILDERS[name](tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql_query', _fetched_fires().iloc[0:0])

    with pytest.raises(SystemExit) as exit_info:
        run.main(run.argv)

    assert 'No fires found' in str(exit_info.value.code)
    assert run.analysed == []
    assert not run.out_dir.exists()
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


@pytest.mark.parametrize('module', [mining, lineage], ids=['mining', 'lineage'])
def test_connect_leaves_the_connect_timeout_to_libpq(module, monkeypatch):
    """No `connect_timeout` argument: it would beat the PGCONNECT_TIMEOUT the
    nightly sets for a report's child, which the other Neon reports follow."""
    monkeypatch.setenv('DATABASE_URL', FAKE_URL)
    monkeypatch.delenv('DATABASE_URL_UNPOOLED', raising=False)
    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def connect(*args, **kwargs):
        calls.append((args, kwargs))
        return FakeConnection(SESSION)

    monkeypatch.setattr(psycopg2, 'connect', connect)

    module.connect()

    assert calls == [((FAKE_URL,), {'sslmode': 'require'})]


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
