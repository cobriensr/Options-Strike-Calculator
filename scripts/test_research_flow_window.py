"""The two flow research scripts read each day's net flow through
enrich_lottery_outcomes.load_matched_flow, not their own copy of the query.

flow_inversion_timing.py and tune_flow_inversion.py each carried the query
inline with `+ INTERVAL '1 day'`: a calendar day in the session zone, 23 or 25
hours across a DST change, while the enrich script's loader (and its work-date
EXISTS) count exactly 24. Going through the loader keeps the research on the
same window the enrichment writes its values from.

Each script is driven for one day with Neon faked at the module boundary
(psycopg2.connect, pandas.read_sql) and the loader replaced by a recorder, so
the test sees which (ticker, side) pairs are loaded and which flow each fire
is simulated with. Run:

    ml/.venv/Scripts/python -m pytest -q scripts/test_research_flow_window.py
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import flow_inversion_timing as timing  # noqa: E402
import tune_flow_inversion as tune  # noqa: E402

DAY = '2026-07-22'
ENTRY = datetime(2026, 7, 22, 15, 0, tzinfo=timezone.utc)
CALL_CHAIN = 'TSLA260722C00300000'
PUT_CHAIN = 'TSLA260722P00300000'
# Different flow per side, so a fire simulated with the wrong side shows.
CALL_FLOW = [(ENTRY + timedelta(minutes=1), 1.0)]
PUT_FLOW = [(ENTRY + timedelta(minutes=1), 2.0)]


class FakeCursor:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn

    def execute(self, sql: str, params: tuple | None = None) -> None:
        self.conn.sqls.append(' '.join(sql.split()))

    def fetchone(self):
        return (date(2026, 7, 22),)  # latest_fire_date's MAX(date)

    def fetchall(self) -> list:
        return []

    def close(self) -> None:
        pass


class FakeConn:
    """What psycopg2.connect returns; records every statement it is sent."""

    def __init__(self) -> None:
        self.sqls: list[str] = []

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def close(self) -> None:
        pass

    def flow_sqls(self) -> list[str]:
        return [s for s in self.sqls if 'net_flow_per_ticker_history' in s]


class FlowLoader:
    """Stands in for load_matched_flow: records its calls, answers by side."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def __call__(self, conn, target_date: str, ticker: str, option_type: str):
        self.calls.append((conn, target_date, ticker, option_type))
        return CALL_FLOW if option_type == 'C' else PUT_FLOW


def write_day(directory: Path) -> None:
    """One call chain and one put chain, each priced every minute after the
    entry with a quote, so both scripts build minute mids for them."""
    rows = []
    for chain in (CALL_CHAIN, PUT_CHAIN):
        for m in range(1, 6):
            rows.append(
                {
                    'executed_at': ENTRY + timedelta(minutes=m),
                    'option_chain_id': chain,
                    'price': 1.0 + 0.05 * m,
                    'canceled': False,
                    'nbbo_bid': 0.95 + 0.05 * m,
                    'nbbo_ask': 1.05 + 0.05 * m,
                    'size': 1,
                }
            )
    pd.DataFrame(rows).to_parquet(directory / f'{DAY}-trades.parquet')


def fires_frame() -> pd.DataFrame:
    """The lottery_finder_fires rows both scripts read: one call fire (id 1)
    and one put fire (id 2) on the same ticker and day."""
    rows = []
    for fire_id, chain, option_type in ((1, CALL_CHAIN, 'C'), (2, PUT_CHAIN, 'P')):
        rows.append(
            {
                'id': fire_id,
                'date': date(2026, 7, 22),
                'option_chain_id': chain,
                'underlying_symbol': 'TSLA',
                'option_type': option_type,
                'trigger_time_ct': pd.Timestamp(ENTRY),
                'entry_price': Decimal('1.0000'),
                'mode': 'A_intraday_0DTE',
                'dte': 0,
                'score': 20,
                'flow_inv': 10.0,
            }
        )
    return pd.DataFrame(rows)


@pytest.fixture
def conn(monkeypatch: pytest.MonkeyPatch) -> FakeConn:
    """psycopg2.connect and pandas.read_sql faked for the test's duration."""
    fake = FakeConn()
    monkeypatch.setenv('DATABASE_URL', 'postgresql://test/none')
    monkeypatch.setattr('psycopg2.connect', lambda _url: fake)
    monkeypatch.setattr('pandas.read_sql', lambda *_args, **_kwargs: fires_frame())
    return fake


@pytest.fixture
def loader() -> FlowLoader:
    return FlowLoader()


def test_tune_reads_each_ticker_and_side_through_the_loader(
    tmp_path: Path, conn: FakeConn, loader: FlowLoader, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_day(tmp_path)
    monkeypatch.setattr(tune, 'PARQUET_DIR', tmp_path)
    monkeypatch.setattr(tune, 'load_matched_flow', loader)

    inputs = tune.build_fire_inputs()

    # Once per (ticker, side), for the session date, on the script's connection.
    assert loader.calls == [(conn, DAY, 'TSLA', 'C'), (conn, DAY, 'TSLA', 'P')]
    # Each fire carries its own side's flow.
    flow_by_id = dict(zip(inputs['id'], inputs['flow'], strict=True))
    assert flow_by_id == {1: CALL_FLOW, 2: PUT_FLOW}
    # And the script sends no flow query of its own.
    assert conn.flow_sqls() == []


def test_timing_reads_each_ticker_and_side_through_the_loader(
    tmp_path: Path, conn: FakeConn, loader: FlowLoader, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = tmp_path / 'archive'
    archive.mkdir()
    write_day(archive)
    env_file = tmp_path / '.env.local'
    env_file.write_text('', encoding='utf-8')
    monkeypatch.setattr(timing, 'ENV_FILE', env_file)
    # The report lands under ROOT/docs/tmp: keep it out of the repo.
    monkeypatch.setattr(timing, 'ROOT', tmp_path)
    monkeypatch.setattr(timing, 'load_matched_flow', loader)
    simulated: list[tuple] = []

    def simulate(minutes, flow, entry_price, trigger_ts):
        simulated.append((flow, entry_price))
        return 10.0, trigger_ts + timedelta(minutes=10), 'inversion'

    monkeypatch.setattr(timing, 'simulate_flow_inversion', simulate)

    timing.main(['--parquet-dir', str(archive)])

    assert loader.calls == [(conn, DAY, 'TSLA', 'C'), (conn, DAY, 'TSLA', 'P')]
    # Fires run in id order: the call fire first, then the put fire.
    assert [flow for flow, _ in simulated] == [CALL_FLOW, PUT_FLOW]
    assert conn.flow_sqls() == []
    assert (tmp_path / 'docs' / 'tmp' / f'flow-inversion-timing-{DAY}.md').exists()
