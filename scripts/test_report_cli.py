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


# (ticker, fires on 11-03, 11-04, 11-05, fires with no peak, % of high peaks on each day)
BOUNDARY_TICKERS = [
    ('AAA', (33, 33, 35), 2, (90, 90, 90)),  # 99 fires with a peak at the end
    ('BBB', (34, 33, 35), 2, (80, 80, 80)),  # 100
    ('CCC', (34, 33, 34), 0, (70, 70, 70)),  # 101
    ('DDD', (100, 10, 10), 0, (60, 60, 60)),  # 100 from the first day on
    ('EEE', (60, 60, 20), 3, (50, 50, 50)),
    ('FFF', (100, 30, 30), 0, (40, 40, 40)),
    ('GGG', (10, 10, 10), 0, (30, 30, 30)),  # never near 100
    ('HHH', (50, 50, 50), 0, (75, 75, 100)),  # tied with III until the last day
    ('III', (50, 50, 50), 0, (75, 75, 0)),
]  # fmt: skip


def _boundary_frame() -> pd.DataFrame:
    """Fires built to cross the tracker's edges, without random numbers.

    - tickers with 99, 100 and 101 fires that have a peak (`n >= 100` keeps the
      last two), some of them with fires that have no peak at all;
    - a peak of exactly 50.0 (a hit) and one of 49.99 on every ticker;
    - null scores and null flow inversions;
    - HHH and III with equal counts and rates up to 11-04, so their ranks tie;
    - the rows in no date order, as a table scan gives them.
    """
    days = [date(2026, 11, 3), date(2026, 11, 4), date(2026, 11, 5)]
    rows = []
    for ticker, per_day, no_peak, high_pct in BOUNDARY_TICKERS:
        position = 0
        for day, count, pct in zip(days, per_day, high_pct, strict=True):
            for _ in range(count):
                if 1 <= position <= no_peak:
                    peak = np.nan
                elif position == 7:
                    peak = 50.0
                elif position == 8:
                    peak = 49.99
                elif (position * 37) % 100 < pct:
                    peak = 51.0 + position % 40
                else:
                    peak = 0.5 + position % 49
                rows.append((day, ticker, peak))
                position += 1
    i = np.arange(len(rows))
    frame = pd.DataFrame(rows, columns=['date', 'ticker', 'peak'])
    frame['mode'] = np.where(i % 3 == 0, 'B_multi_day_DTE1_3', 'A_intraday_0DTE')
    frame['score'] = np.where(i % 13 == 4, np.nan, (i * 7) % 20 + 5)
    frame['flow_inv'] = np.where(i % 11 == 3, np.nan, (i * 37) % 101 - 40.0)
    return frame.iloc[(i * 7919) % len(frame)].reset_index(drop=True)


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
# out). The code since then has to write the same fields for the same fires.
#
# The row for the newest date of _tracker_frame() (240 fires, 11-03 and 11-04), the
# file _seed_tracking_csv makes. Its last row is 11-04 as well, so the code of then
# wrote the one row, for 11-04; a run now writes 11-03's row too, and this one is equal.
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


# The old code's row for each date of _boundary_frame(), recorded the same way. 11-03: two
# tickers at exactly 100 fires. 11-04: HHH and III tie at the top (the two ticker names
# are left out; see the test). 11-05: AAA has 99 fires with a peak and is out, BBB has 100
# and CCC 101 and are in.
GOLDEN_BOUNDARY_ROWS = {
    '2026-11-03': {
        'date': '2026-11-03', 'n_fires_today': '471', 'n_fires_total_window': '471',
        'days_in_window': '1', 't1_today': '191', 't2_today': '91', 't3_today': '189',
        'flow_inv_n': '428', 'flow_inv_mean_pct': '10.339', 'flow_inv_sharpe': '0.3549',
        't2plus_n': '257', 't2plus_mean_pct': '11.214', 't2plus_sharpe': '0.3813',
        'modeB_n': '139', 'modeB_mean_pct': '10.058', 'modeB_sharpe': '0.3365',
        'top1_ticker': 'DDD', 'top1_n': '100', 'top1_rate': '60.0',
        'top2_ticker': 'FFF', 'top2_n': '100', 'top2_rate': '41.0',
        'top3_ticker': '', 'top3_n': '', 'top3_rate': '',
    },
    '2026-11-04': {
        'date': '2026-11-04', 'n_fires_today': '309', 'n_fires_total_window': '780',
        'days_in_window': '2', 't1_today': '130', 't2_today': '57', 't3_today': '122',
        'flow_inv_n': '709', 'flow_inv_mean_pct': '10.24', 'flow_inv_sharpe': '0.3491',
        't2plus_n': '425', 't2plus_mean_pct': '10.111', 't2plus_sharpe': '0.3441',
        'modeB_n': '234', 'modeB_mean_pct': '10.35', 'modeB_sharpe': '0.3487',
        'top1_n': '100', 'top1_rate': '75.0', 'top2_n': '100', 'top2_rate': '75.0',
        'top3_ticker': 'DDD', 'top3_n': '110', 'top3_rate': '60.91',
    },
    '2026-11-05': {
        'date': '2026-11-05', 'n_fires_today': '274', 'n_fires_total_window': '1054',
        'days_in_window': '3', 't1_today': '116', 't2_today': '47', 't3_today': '111',
        'flow_inv_n': '958', 'flow_inv_mean_pct': '9.931', 'flow_inv_sharpe': '0.3389',
        't2plus_n': '573', 't2plus_mean_pct': '9.883', 't2plus_sharpe': '0.3373',
        'modeB_n': '320', 'modeB_mean_pct': '9.891', 'modeB_sharpe': '0.3378',
        'top1_ticker': 'HHH', 'top1_n': '150', 'top1_rate': '83.33',
        'top2_ticker': 'BBB', 'top2_n': '100', 'top2_rate': '78.43',
        'top3_ticker': 'CCC', 'top3_n': '101', 'top3_rate': '70.3',
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


def test_tracker_csv_path_is_respected_and_every_row_is_computed_again(
    tmp_path, monkeypatch, default_dir, legacy_text_default
):
    run = tracker_run(tmp_path, monkeypatch)
    shipped_before = _snapshot(SHIPPED_DOCS_TMP)
    before = _read_rows(run.output)
    assert [r['date'] for r in before] == ['2026-11-03', '2026-11-04']

    run.main(run.argv)

    after = _read_rows(run.output)
    assert [r['date'] for r in after] == ['2026-11-03', '2026-11-04']
    # 11-03's row was in the file already (77 fires, a run of the night before): it is
    # computed again, from its day's 120 fires.
    assert after[0]['n_fires_today'] == '120'
    assert after[0]['run_at'] != before[0]['run_at']
    replaced = after[1]
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
    assert [r['date'] for r in rows] == ['2026-11-03', '2026-11-04']
    assert _without_run_at(rows[-1]) == GOLDEN_TRACKER_ROW
    assert rows[-1]['run_at'].startswith('20')  # an ISO timestamp, not the stale marker
    # The earlier date is as of its own day: one day, its 120 fires.
    assert (rows[0]['n_fires_total_window'], rows[0]['days_in_window']) == ('120', '1')


def test_tracker_writes_a_row_for_every_enriched_date_and_nothing_else(
    tmp_path, monkeypatch, default_dir, capsys, legacy_text_default
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    # Stale rows for two dates with fires (11-03 and 11-04), and one for a date with none.
    _write_tracking_csv(run.output, ['2026-11-02', '2026-11-03', '2026-11-04'])
    _ticking_clock(monkeypatch)

    run.main(run.argv)

    after = _read_rows(run.output)
    assert [r['date'] for r in after] == ['2026-11-03', '2026-11-04', '2026-11-05']
    # Each row is as of its own date: the old code's row for the frame cut there, and
    # none of the stale values.
    assert {r['date']: _without_run_at(r) for r in after} == GOLDEN_FILL_ROWS
    assert [
        (r['n_fires_today'], r['n_fires_total_window'], r['days_in_window'])
        for r in after
    ] == [('20', '20', '1'), ('200', '220', '2'), ('100', '320', '3')]
    # One timestamp for the run: the clock moves on every read, so one per row differs.
    assert {r['run_at'] for r in after} == {'2026-11-06T01:00:00+00:00'}
    header = run.output.read_text(encoding='utf-8').splitlines()[0]
    assert header == ','.join(daily_tracker.COLUMNS)
    out = capsys.readouterr().out
    lines = [
        '[track] rebuilt 3 dates (2026-11-03 .. 2026-11-05), replacing 3 rows\n',
        '[track] 1 earlier dates have no enriched fires now and were dropped\n',
        '[track] 2 of 2 earlier rows changed\n',
        '[track] 2026-11-05: 100 new fires (T1=45 T2=20 T3=35)\n',
    ]
    positions = [out.index(line) for line in lines]
    assert positions == sorted(positions)  # in this order
    assert '(3 rows)' in out
    assert 'filled' not in out
    assert 'is newer than' not in out


def test_tracker_writes_no_row_for_a_date_without_fires(
    tmp_path, monkeypatch, default_dir
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
    assert [r['date'] for r in after] == ['2026-11-03', '2026-11-05']
    # The gap is not a day of the window: 120 fires over two dates.
    assert (after[-1]['n_fires_total_window'], after[-1]['days_in_window']) == ('120', '2')


def test_tracker_orders_the_rows_by_date_whatever_order_the_file_had(
    tmp_path, monkeypatch, default_dir, capsys
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    _write_tracking_csv(run.output, ['2026-11-05', '2026-11-03'])  # the newest first

    run.main(run.argv)

    assert [r['date'] for r in _read_rows(run.output)] == [
        '2026-11-03', '2026-11-04', '2026-11-05'
    ]  # fmt: skip
    assert '[track] 2 of 2 earlier rows changed\n' in capsys.readouterr().out


# ── the changed-rows line ───────────────────────────────────────────────────


def _edit_tracking_row(path: Path, day: str, **fields: str) -> None:
    """Change fields of the file's row for `day`, keeping the header and the other rows."""
    rows = _read_rows(path)
    for row in rows:
        if row['date'] == day:
            row.update(fields)
    with path.open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=daily_tracker.COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def _tracker_run_twice(tmp_path, monkeypatch, capsys, between=None) -> str:
    """Run the tracker on _fill_frame() twice, `between` the runs touching the file it wrote.

    Returns what the second run printed.
    """
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    csv_path = run.out_dir / 'twice.csv'  # a file that is not there yet
    run.main(['--csv', str(csv_path)])
    if between is not None:
        between(csv_path)
    capsys.readouterr()
    run.main(['--csv', str(csv_path)])
    return capsys.readouterr().out


def test_tracker_rerun_on_unchanged_data_changes_no_earlier_row(
    tmp_path, monkeypatch, default_dir, capsys
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    csv_path = run.out_dir / 'twice.csv'
    run.main(['--csv', str(csv_path)])
    first = _read_rows(csv_path)
    _ticking_clock(monkeypatch)  # the second run's run_at differs from the first's
    capsys.readouterr()

    run.main(['--csv', str(csv_path)])

    second = _read_rows(csv_path)
    assert [_without_run_at(r) for r in second] == [_without_run_at(r) for r in first]
    assert {r['run_at'] for r in second} == {'2026-11-06T01:00:00+00:00'}
    out = capsys.readouterr().out
    assert '[track] 0 of 3 earlier rows changed\n' in out
    assert 'dropped' not in out


def test_tracker_counts_an_earlier_row_with_a_changed_field(
    tmp_path, monkeypatch, default_dir, capsys
):
    out = _tracker_run_twice(
        tmp_path,
        monkeypatch,
        capsys,
        between=lambda path: _edit_tracking_row(path, '2026-11-04', top1_n='999'),
    )

    assert '[track] 1 of 3 earlier rows changed\n' in out


def test_tracker_does_not_count_a_row_that_differs_only_in_run_at(
    tmp_path, monkeypatch, default_dir, capsys
):
    out = _tracker_run_twice(
        tmp_path,
        monkeypatch,
        capsys,
        between=lambda path: _edit_tracking_row(path, '2026-11-04', run_at='an earlier run'),
    )

    assert '[track] 0 of 3 earlier rows changed\n' in out


def test_tracker_counts_a_blank_or_malformed_date_row_in_neither_number(
    tmp_path, monkeypatch, default_dir, capsys
):
    def add_odd_rows(path: Path) -> None:
        rows = _read_rows(path)
        rows += [
            {**rows[0], 'date': '', 'n_fires_today': '-1'},
            {**rows[0], 'date': 'not-a-date', 'n_fires_today': '-1'},
            {**rows[0], 'date': '2026-W45-7', 'n_fires_today': '-1'},  # 11-08, not YYYY-MM-DD
        ]
        with path.open('w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=daily_tracker.COLUMNS)
            writer.writeheader()
            writer.writerows(rows)

    out = _tracker_run_twice(tmp_path, monkeypatch, capsys, between=add_odd_rows)

    assert '[track] 0 of 3 earlier rows changed\n' in out  # not 0 of 6, not 3 of 6
    assert 'replacing 6 rows' in out  # they are replaced all the same
    assert 'dropped' not in out  # and are no date that lost its fires


def test_tracker_does_not_count_a_dropped_date_as_an_earlier_row(
    tmp_path, monkeypatch, default_dir, capsys
):
    def add_a_date_with_no_fires(path: Path) -> None:
        rows = _read_rows(path)
        with path.open('w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=daily_tracker.COLUMNS)
            writer.writeheader()
            writer.writerows([{**rows[0], 'date': '2026-11-02'}, *rows])

    out = _tracker_run_twice(tmp_path, monkeypatch, capsys, between=add_a_date_with_no_fires)

    assert '[track] 1 earlier dates have no enriched fires now and were dropped\n' in out
    assert '[track] 0 of 3 earlier rows changed\n' in out  # 11-02 is not one of the 3


def test_tracker_reads_a_missing_column_of_an_old_row_as_blank_and_ignores_extra_ones(
    tmp_path, monkeypatch, default_dir, capsys
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    # An old file from before the top-ticker columns existed, with a column of its own.
    old_columns = [*daily_tracker.COLUMNS[:17], 'legacy_note']
    old_rows = [
        {**{k: v for k, v in GOLDEN_FILL_ROWS[d].items() if k in old_columns},
         'run_at': 'old', 'legacy_note': 'x'}
        for d in ('2026-11-03', '2026-11-04')
    ]  # fmt: skip
    with run.output.open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=old_columns)
        writer.writeheader()
        writer.writerows(old_rows)

    run.main(run.argv)

    # 11-03 has no top tickers, so the columns it lacks are blank in both. 11-04 has two.
    assert '[track] 1 of 2 earlier rows changed\n' in capsys.readouterr().out


@pytest.mark.parametrize('stale_first', [True, False], ids=['stale_first', 'stale_last'])
def test_tracker_compares_the_later_of_two_rows_for_one_date(
    stale_first, tmp_path, monkeypatch, default_dir, capsys
):
    def two_rows_for_11_04(path: Path) -> None:
        rows = _read_rows(path)
        stale = {**rows[1], 'top1_n': '999'}
        pair = [stale, rows[1]] if stale_first else [rows[1], stale]
        with path.open('w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=daily_tracker.COLUMNS)
            writer.writeheader()
            writer.writerows([rows[0], *pair, rows[2]])

    out = _tracker_run_twice(tmp_path, monkeypatch, capsys, between=two_rows_for_11_04)

    assert 'replacing 4 rows' in out
    # The later row is the old file's row for the date: the current one, or the stale one.
    assert f'[track] {0 if stale_first else 1} of 3 earlier rows changed\n' in out


# ── an old file that cannot be read cleanly ──────────────────────────────────


def _rerun_over(tmp_path, monkeypatch, capsys, damage) -> tuple[str, list[dict[str, str]]]:
    """Run twice, `damage` touching the file between them; return the second run's output
    and the rows its file holds."""
    out = _tracker_run_twice(tmp_path, monkeypatch, capsys, between=damage)
    return out, _read_rows(tmp_path / 'state' / 'twice.csv')


def _assert_the_whole_series(rows: list[dict[str, str]]) -> None:
    assert {r['date']: _without_run_at(r) for r in rows} == GOLDEN_FILL_ROWS


def test_tracker_reads_an_old_file_with_an_invalid_byte_and_counts_the_damaged_row(
    tmp_path, monkeypatch, default_dir, capsys
):
    def invalid_byte(path: Path) -> None:
        # 0xA3 is a pound sign in cp1252 and not UTF-8: the 11-04 row's first ticker.
        path.write_bytes(path.read_bytes().replace(b'SPY', b'SP\xa3', 1))

    out, rows = _rerun_over(tmp_path, monkeypatch, capsys, invalid_byte)

    _assert_the_whole_series(rows)
    assert '[track] 1 of 3 earlier rows changed\n' in out  # the replaced byte is a change
    assert 'could not be read' not in out


def test_tracker_reads_an_old_file_that_starts_with_a_byte_order_mark(
    tmp_path, monkeypatch, default_dir, capsys
):
    def add_bom(path: Path) -> None:
        path.write_bytes(b'\xef\xbb\xbf' + path.read_bytes())  # what Excel's CSV UTF-8 writes

    out, rows = _rerun_over(tmp_path, monkeypatch, capsys, add_bom)

    _assert_the_whole_series(rows)
    assert '[track] 0 of 3 earlier rows changed\n' in out  # the rows were found, not lost
    assert 'replacing 3 rows' in out
    assert 'could not be read' not in out
    assert not (tmp_path / 'state' / 'twice.csv').read_bytes().startswith(b'\xef\xbb\xbf')


def test_tracker_does_not_swallow_an_error_of_the_file_system(
    tmp_path, monkeypatch, default_dir, capsys
):
    run = tracker_run(tmp_path, monkeypatch)
    a_directory = tmp_path / 'state' / 'a-directory'
    a_directory.mkdir()

    with pytest.raises(OSError):  # PermissionError here, IsADirectoryError on Linux
        run.main(['--csv', str(a_directory)])

    assert 'could not be read' not in capsys.readouterr().out  # that is for a bad CSV


def test_tracker_replaces_an_old_file_that_is_not_csv_and_says_so(
    tmp_path, monkeypatch, default_dir, capsys
):
    def oversized_field(path: Path) -> None:
        rows = _read_rows(path)
        rows[1]['top1_ticker'] = 'x' * 200_000  # past the csv module's 131,072 limit
        with path.open('w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=daily_tracker.COLUMNS)
            writer.writeheader()
            writer.writerows(rows)

    out, rows = _rerun_over(tmp_path, monkeypatch, capsys, oversized_field)

    _assert_the_whole_series(rows)
    assert '[track] the earlier file could not be read as CSV: nothing to compare\n' in out
    assert 'replacing 0 rows' in out
    assert 'earlier rows changed' not in out
    assert 'dropped' not in out


def test_tracker_prints_no_changed_rows_line_without_a_row_with_a_strict_date(
    tmp_path, monkeypatch, default_dir, capsys
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    # No file, a header only, and a file with only an odd row.
    for seed in (None, [], ['not-a-date']):
        csv_path = run.out_dir / f'seed-{len(seed) if seed is not None else "none"}.csv'
        if seed is not None:
            _write_tracking_csv(csv_path, seed)

        run.main(['--csv', str(csv_path)])

        out = capsys.readouterr().out
        assert 'earlier rows changed' not in out
        assert 'dropped' not in out
        assert [r['date'] for r in _read_rows(csv_path)] == [
            '2026-11-03', '2026-11-04', '2026-11-05'
        ]  # fmt: skip
        assert (f'replacing {len(seed or [])} rows') in out


@pytest.mark.parametrize(
    'odd_date',
    [
        pytest.param('not-a-date', id='text'),
        pytest.param('2026-13-45', id='no_such_day'),
        pytest.param('20261230', id='not_yyyy_mm_dd'),  # a later date, if it were read
        pytest.param('2026-W45-7', id='iso_week_date'),  # 11-08 to fromisoformat
        pytest.param('', id='blank'),
    ],
)
def test_tracker_replaces_a_row_whose_date_does_not_parse_and_counts_it_nowhere(
    odd_date, tmp_path, monkeypatch, default_dir, capsys
):
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _fill_frame())
    _write_tracking_csv(run.output, ['2026-11-03', odd_date])

    run.main(run.argv)

    assert [r['date'] for r in _read_rows(run.output)] == [
        '2026-11-03', '2026-11-04', '2026-11-05'
    ]  # fmt: skip
    out = capsys.readouterr().out
    assert 'replacing 2 rows' in out
    assert 'dropped' not in out  # no date lost its fires: the odd row never was one
    assert '[track] 1 of 1 earlier rows changed\n' in out  # 11-03's stale row


def test_tracker_reads_fire_dates_that_come_as_timestamps(
    tmp_path, monkeypatch, default_dir
):
    run = tracker_run(tmp_path, monkeypatch)
    frame = _fill_frame()
    frame['date'] = pd.to_datetime(frame['date'])  # datetime64, not date objects
    _serve(monkeypatch, 'read_sql', frame)
    _write_tracking_csv(run.output, ['2026-11-02'])

    run.main(run.argv)

    rows = _read_rows(run.output)
    assert {r['date']: _without_run_at(r) for r in rows} == GOLDEN_FILL_ROWS


def test_tracker_rows_match_the_old_code_at_the_edges(tmp_path, monkeypatch, default_dir):
    """Fires with 99, 100 and 101 of a ticker's peaks, a peak of exactly 50, null scores,
    null flow inversions and a tie: the rows are the ones the code before the fill wrote.
    """
    run = tracker_run(tmp_path, monkeypatch)
    _serve(monkeypatch, 'read_sql', _boundary_frame())
    _write_tracking_csv(run.output, ['2026-11-02'])

    run.main(run.argv)

    rows = {r['date']: _without_run_at(r) for r in _read_rows(run.output)}
    # HHH and III tie on 11-04 (both 100 peaks, 75.0). Which of them numpy's sort puts first
    # depends on the CPU's SIMD path, so the order is not a literal here: it is what the
    # old code's own expression (groupby, then sort_values) gives on this host for these fires.
    fires = _boundary_frame()
    window = fires[fires['date'] <= date(2026, 11, 4)]
    table = window.groupby('ticker').agg(
        n=('peak', 'count'), rate=('peak', lambda s: (s >= 50).mean() * 100)
    )
    ranked = table[table['n'] >= 100].sort_values('rate', ascending=False)
    tied = [rows['2026-11-04'].pop('top1_ticker'), rows['2026-11-04'].pop('top2_ticker')]
    assert set(tied) == {'HHH', 'III'}
    assert tied == list(ranked.index[:2])
    assert rows == GOLDEN_BOUNDARY_ROWS


# ── the cohorts' window stats, from running aggregates ──────────────────────

COHORT_PREFIXES = ('flow_inv', 't2plus', 'modeB')
SIGNIFICANT = 30  # fewer non-null flow inversions than this and a window's stats are blank


def _prefix_stats(values) -> tuple[int, float, float]:
    """The tracker's stats() as it was before the running aggregates: pandas on the whole
    window prefix. It is the reference the aggregates have to equal."""
    s = pd.to_numeric(values, errors='coerce').dropna()
    n = len(s)
    if n < SIGNIFICANT:
        return n, np.nan, np.nan
    mean = float(s.mean())
    std = float(s.std(ddof=1)) if n > 1 else 0.0
    return n, mean, mean / std if std > 0 else 0.0


def _expected_cohort_fields(fires: pd.DataFrame, day: date, t1=16, t2=12) -> dict:
    """The nine stats fields of `day`'s row, from pandas on that day's window."""
    window = fires[fires['date'] <= day]

    def classify(score):  # the tracker's tiers: a null score is T3
        if not pd.notna(score):
            return 'T3'
        return 'T1' if score >= t1 else 'T2' if score >= t2 else 'T3'

    tier = window['score'].apply(classify)
    cohorts = {
        'flow_inv': window,
        't2plus': window[tier.isin(['T1', 'T2'])],
        'modeB': window[window['mode'] == 'B_multi_day_DTE1_3'],
    }
    fields: dict = {}
    for prefix, part in cohorts.items():
        n, mean, sharpe = _prefix_stats(part['flow_inv'])
        fields[f'{prefix}_n'] = n
        fields[f'{prefix}_mean_pct'] = '' if np.isnan(mean) else round(mean, 3)
        fields[f'{prefix}_sharpe'] = '' if np.isnan(sharpe) else round(sharpe, 4)
    return fields


def _cohort_fields(row: dict) -> dict:
    return {
        f'{prefix}_{name}': row[f'{prefix}_{name}']
        for prefix in COHORT_PREFIXES
        for name in ('n', 'mean_pct', 'sharpe')
    }


def _fires_of(spec) -> pd.DataFrame:
    """Fires from (day, mode, score, flow inversions) groups: one fire per flow value."""
    records = [
        (day, mode, score, flow) for day, mode, score, flows in spec for flow in flows
    ]
    frame = pd.DataFrame(records, columns=['date', 'mode', 'score', 'flow_inv'])
    return frame.assign(peak=60.0, ticker='AAA')


def _random_fires(seed: int) -> pd.DataFrame:
    """A random frame built to hit the corners: dates whose flow inversions are all null,
    nulls elsewhere, null scores, a Mode B that starts late, and flows that are constant
    (std 0) on the first two dates for odd seeds."""
    rng = np.random.default_rng(seed)
    offsets = sorted(rng.choice(60, size=int(rng.integers(12, 24)), replace=False))
    spec = []
    for k, offset in enumerate(offsets):
        n = int(rng.integers(1, 90)) if k >= 2 else int(rng.integers(40, 90))
        flows = rng.normal(5, 40, n)
        flows[rng.random(n) < 0.1] = np.nan
        if rng.random() < 0.2:
            flows[:] = np.nan  # a date with fires and no flow inversion at all
        if seed % 2 == 1 and k < 2:
            flows[:] = 5.0
        mode_b = (rng.random(n) < 0.4) & (k >= 4)  # Mode B is empty until the fifth date
        scores = rng.integers(0, 25, n).astype(float)
        scores[rng.random(n) < 0.05] = np.nan
        day = date(2026, 9, 1) + timedelta(days=int(offset))
        for flow, b, score in zip(flows, mode_b, scores, strict=True):
            spec.append((day, 'B_multi_day_DTE1_3' if b else 'A_intraday_0DTE', score, [flow]))
    return _fires_of(spec)


@pytest.mark.filterwarnings('error')  # no 0/0 from an empty date or cohort
@pytest.mark.parametrize('seed', range(8))
def test_tracker_window_stats_equal_pandas_on_every_window_prefix(seed):
    fires = _random_fires(seed)

    rows = daily_tracker.build_rows(fires, 16, 12, 'now')

    days = sorted(fires['date'].unique())
    assert [r['date'] for r in rows] == [d.isoformat() for d in days]
    for row, day in zip(rows, days, strict=True):
        assert _cohort_fields(row) == _expected_cohort_fields(fires, day), day


@pytest.mark.filterwarnings('error')
def test_tracker_window_stats_survive_a_mean_that_is_large_next_to_the_spread():
    # 1e8 plus unit noise: Σx² − (Σx)²/n loses every digit of the variance here.
    rng = np.random.default_rng(11)
    sizes = [60, 45, 80, 50, 70, 55, 65, 40]
    spec = [
        (date(2026, 11, 2 + k), 'B_multi_day_DTE1_3' if i % 2 else 'A_intraday_0DTE', 20.0, [flow])
        for k, size in enumerate(sizes)
        for i, flow in enumerate(1e8 + rng.normal(0, 1, size))
    ]
    fires = _fires_of(spec)

    rows = daily_tracker.build_rows(fires, 16, 12, 'now')

    for row, day in zip(rows, sorted(fires['date'].unique()), strict=True):
        window = fires[fires['date'] <= day]
        for prefix, part in (
            ('flow_inv', window),
            ('t2plus', window),  # every score is a T1
            ('modeB', window[window['mode'] == 'B_multi_day_DTE1_3']),
        ):
            n, mean, sharpe = _prefix_stats(part['flow_inv'])
            assert row[f'{prefix}_n'] == n
            if n >= SIGNIFICANT:  # to the places the row is rounded to
                assert row[f'{prefix}_mean_pct'] == pytest.approx(mean, abs=6e-4), (day, prefix)
                assert row[f'{prefix}_sharpe'] == pytest.approx(sharpe, abs=6e-5), (day, prefix)
            else:
                assert row[f'{prefix}_mean_pct'] == row[f'{prefix}_sharpe'] == ''


@pytest.mark.filterwarnings('error')
def test_tracker_a_date_with_no_flow_inversion_leaves_each_cohorts_window_as_it_was():
    b, a = 'B_multi_day_DTE1_3', 'A_intraday_0DTE'
    rng = np.random.default_rng(5)

    def mixed(day, n, flows):
        modes = [b if i % 2 else a for i in range(n)]
        return [(day, mode, 20.0, [flow]) for mode, flow in zip(modes, flows, strict=True)]

    spec = (
        mixed(date(2026, 11, 2), 70, rng.normal(5, 40, 70))
        + mixed(date(2026, 11, 3), 10, [np.nan] * 10)  # fires, no flow inversion
        + mixed(date(2026, 11, 4), 20, rng.normal(5, 40, 20))
    )
    fires = _fires_of(spec)

    first, empty, last = daily_tracker.build_rows(fires, 16, 12, 'now')

    assert _cohort_fields(empty) == _cohort_fields(first)
    assert first['modeB_n'] == 35 and first['modeB_sharpe'] != ''  # a real window, not blanks
    assert last['flow_inv_n'] == first['flow_inv_n'] + 20
    for row, day in zip((first, empty, last), sorted(fires['date'].unique()), strict=True):
        assert _cohort_fields(row) == _expected_cohort_fields(fires, day)


@pytest.mark.filterwarnings('error')
def test_tracker_a_cohort_empty_until_a_later_date_stays_blank_until_it_reaches_30():
    b, a = 'B_multi_day_DTE1_3', 'A_intraday_0DTE'
    rng = np.random.default_rng(6)
    spec = [
        (date(2026, 11, 2), a, 20.0, rng.normal(5, 40, 50)),  # no Mode B at all
        (date(2026, 11, 3), a, 20.0, rng.normal(5, 40, 50)),
        (date(2026, 11, 4), b, 20.0, rng.normal(5, 40, 29)),  # 29: one short
        (date(2026, 11, 5), b, 20.0, rng.normal(5, 40, 1)),  # 30: the first window with stats
        (date(2026, 11, 6), b, 20.0, rng.normal(5, 40, 12)),
    ]
    fires = _fires_of(spec)

    rows = daily_tracker.build_rows(fires, 16, 12, 'now')

    assert [r['modeB_n'] for r in rows] == [0, 0, 29, 30, 42]
    assert [r['modeB_mean_pct'] == '' for r in rows] == [True, True, True, False, False]
    assert [r['modeB_sharpe'] == '' for r in rows] == [True, True, True, False, False]
    for row, day in zip(rows, sorted(fires['date'].unique()), strict=True):
        assert _cohort_fields(row) == _expected_cohort_fields(fires, day)


@pytest.mark.filterwarnings('error')
def test_tracker_a_cohort_whose_flow_inversions_are_all_null_is_blank():
    spec = [
        # The T1 fires have no flow inversion at all; the T3 fires do.
        (date(2026, 11, 2), 'A_intraday_0DTE', 20.0, [np.nan] * 40),
        (date(2026, 11, 2), 'A_intraday_0DTE', 3.0, list(np.linspace(-20, 40, 50))),
        (date(2026, 11, 3), 'A_intraday_0DTE', 20.0, [np.nan] * 40),
        (date(2026, 11, 3), 'A_intraday_0DTE', 3.0, list(np.linspace(-10, 50, 50))),
    ]
    fires = _fires_of(spec)

    rows = daily_tracker.build_rows(fires, 16, 12, 'now')

    for row in rows:
        assert (row['t2plus_n'], row['t2plus_mean_pct'], row['t2plus_sharpe']) == (0, '', '')
        assert row['flow_inv_n'] >= 50 and row['flow_inv_sharpe'] != ''
    for row, day in zip(rows, sorted(fires['date'].unique()), strict=True):
        assert _cohort_fields(row) == _expected_cohort_fields(fires, day)


@pytest.mark.filterwarnings('error')
@pytest.mark.parametrize(
    ('value', 'count'),
    [
        pytest.param(5.0, 40, id='an_exact_sum'),
        # 33.3 has no exact binary form, so pandas' sum of a hundred of them is a
        # little off, its mean with it, and it reports a Sharpe of about 1e15 from the
        # noise. The window is constant: its std is 0 and its Sharpe is 0.0. These are
        # literals, not pandas' values, because pandas' is the garbage.
        pytest.param(33.3, 100, id='an_inexact_sum'),
    ],
)
def test_tracker_constant_flow_inversions_have_a_sharpe_of_zero_not_blank(value, count):
    fires = _fires_of([(date(2026, 11, 2), 'A_intraday_0DTE', 20.0, [value] * count)])

    (row,) = daily_tracker.build_rows(fires, 16, 12, 'now')

    got = (row['flow_inv_n'], row['flow_inv_mean_pct'], row['flow_inv_sharpe'])
    assert got == (count, value, 0.0)


def test_tracker_has_no_rebuild_flag_any_more(tmp_path, monkeypatch, default_dir, capsys):
    run = tracker_run(tmp_path, monkeypatch)
    before = run.output.read_bytes()

    with pytest.raises(SystemExit) as exit_info:
        run.main([*run.argv, '--rebuild'])

    assert exit_info.value.code == 2  # argparse: an unrecognized argument
    assert '--rebuild' in capsys.readouterr().err
    assert run.output.read_bytes() == before  # and nothing was read or written


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
