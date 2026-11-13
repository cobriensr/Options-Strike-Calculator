"""Tests for scripts/calendar_context_analysis.py.

The script tags each trade with the macro days around it, so its calendar must
hold every FOMC, CPI and NFP day. FOMC days come from the Fed schedule. CPI and
NFP days come from FRED's release dates, the app's own source for them
(release 10 and release 50 in TRACKED_RELEASES, api/_lib/market-events.ts).
The economic_events table is not used: it starts 2026-03-25 and holds no
August 2026 rows, so findings built from it lost CPI on 03-12 and in August and
NFP on 03-06, 08-07 and 09-04.

FRED is mocked at the module boundary: the tests patch the script's `urlopen`
with canned JSON per release_id. No test reaches FRED.

Run from the repo root so scripts/conftest.py (the no-database guard) loads:

    ml/.venv/Scripts/python -m pytest scripts/test_calendar_context_analysis.py -q
"""

from __future__ import annotations

import io
import json
import re
import sys
from datetime import date
from email.message import Message
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse

import pandas as pd
import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO = SCRIPTS_DIR.parent
ML_SRC = REPO / 'ml' / 'src'
sys.path.insert(0, str(SCRIPTS_DIR))
if str(ML_SRC) not in sys.path:
    sys.path.append(str(ML_SRC))

import calendar_context_analysis as cca  # noqa: E402
from options_features.calendar import FOMC_DATES  # noqa: E402

FAKE_KEY = 'fake-fred-key-0123456789abcdef'

# What FRED answers per release. CPI has March and August days the events
# table lacked; NFP has the three days it lacked (03-06, 08-07, 09-04) and a
# fourth that it held.
CPI_DATES = ['2026-03-12', '2026-08-12', '2026-10-14']
NFP_DATES = ['2026-03-06', '2026-08-07', '2026-09-04', '2026-10-02']


def release_body(release_id: int, dates: list[str], **extra: object) -> bytes:
    """A FRED release/dates JSON body, entries shaped as the live API sends them."""
    payload = {
        'release_dates': [{'release_id': release_id, 'date': d} for d in dates],
        **extra,
    }
    return json.dumps(payload).encode()


class _Response:
    """What urlopen returns: a context manager with .status and .read()."""

    def __init__(self, body: bytes, status: int = 200) -> None:
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_exc: object) -> None:
        return None


class FredStub:
    """The script's `urlopen`, answering from `responses` by release_id.

    A value is a body (bytes), a _Response, or an exception to raise.
    """

    def __init__(self) -> None:
        self.responses: dict[int, bytes | _Response | Exception] = {
            cca.FRED_CPI_RELEASE_ID: release_body(cca.FRED_CPI_RELEASE_ID, CPI_DATES),
            cca.FRED_NFP_RELEASE_ID: release_body(cca.FRED_NFP_RELEASE_ID, NFP_DATES),
        }
        self.requests: list[str] = []
        self.timeouts: list[object] = []

    def __call__(self, url: str, timeout: object = None) -> _Response:
        self.requests.append(url)
        self.timeouts.append(timeout)
        release_id = int(parse_qs(urlparse(url).query)['release_id'][0])
        answer = self.responses[release_id]
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, bytes):
            return _Response(answer)
        return answer


@pytest.fixture(autouse=True)
def no_real_fred(monkeypatch: pytest.MonkeyPatch) -> None:
    """No FRED key and no read of the real .env, for every test.

    scripts/conftest.py blocks no sockets and does not clear FRED_API_KEY, so
    a test that forgets the `fred` fixture must stop on the missing key
    instead of reaching FRED.
    """
    monkeypatch.setattr(cca, 'load_env_file', lambda _path: None)
    monkeypatch.delenv('FRED_API_KEY', raising=False)


@pytest.fixture
def fred(monkeypatch: pytest.MonkeyPatch) -> FredStub:
    """A fake FRED key, and `urlopen` answering from the returned stub."""
    stub = FredStub()
    monkeypatch.setenv('FRED_API_KEY', FAKE_KEY)
    monkeypatch.setattr(cca, 'urlopen', stub)
    return stub


def failure_message() -> str:
    """The exit message when load_calendar_events stops, asserted to be FRED's."""
    with pytest.raises(SystemExit) as stopped:
        cca.load_calendar_events()
    message = str(stopped.value.code)
    assert message.startswith('FRED release dates failed: ')
    return message


# ----- load_calendar_events -----


def test_cpi_days_come_from_fred_release_10(fred: FredStub) -> None:
    cal = cca.load_calendar_events()

    assert cal['cpi'] == {
        date(2026, 3, 12),
        date(2026, 8, 12),
        date(2026, 10, 14),
    }


def test_nfp_days_come_from_fred_release_50(fred: FredStub) -> None:
    cal = cca.load_calendar_events()

    assert cal['nfp'] == {
        date(2026, 3, 6),
        date(2026, 8, 7),
        date(2026, 9, 4),
        date(2026, 10, 2),
    }


def test_fomc_days_come_from_the_fed_schedule_not_from_fred(fred: FredStub) -> None:
    cal = cca.load_calendar_events()

    assert date(2026, 9, 16) in cal['fomc']
    assert date(2026, 10, 28) in cal['fomc']
    assert cal['fomc'] == set(FOMC_DATES)
    # Only the two releases are asked for; FOMC adds no third request.
    assert len(fred.requests) == 2


def test_each_release_is_asked_for_once_with_its_whole_history(
    fred: FredStub,
) -> None:
    cca.load_calendar_events()

    urls = [url.split('?')[0] for url in fred.requests]
    assert urls == ['https://api.stlouisfed.org/fred/release/dates'] * 2
    queries = [parse_qs(urlparse(url).query) for url in fred.requests]
    assert sorted(q['release_id'] for q in queries) == [['10'], ['50']]
    for query in queries:
        assert query['api_key'] == [FAKE_KEY]
        assert query['file_type'] == ['json']
        assert query['include_release_dates_with_no_data'] == ['true']
        assert query['sort_order'] == ['asc']
        # The largest page FRED allows, so a long CPI history cannot cut off
        # the newest dates (asc order drops the tail).
        assert query['limit'] == ['10000']
        # No realtime_start: FRED then defaults to 1776-07-04, the whole
        # history. A start date here would cut the early months off.
        assert 'realtime_start' not in query


def test_the_calls_have_a_timeout(fred: FredStub) -> None:
    cca.load_calendar_events()

    assert fred.timeouts == [30, 30]


def test_the_fred_key_comes_from_the_repo_root_env_file(
    fred: FredStub, monkeypatch: pytest.MonkeyPatch
) -> None:
    # FRED_API_KEY lives in .env at the repo root, not in .env.local.
    loaded: list[Path] = []
    monkeypatch.setattr(cca, 'load_env_file', loaded.append)

    cca.load_calendar_events()

    assert loaded == [REPO / '.env']


def test_missing_fred_key_stops_the_script_before_any_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[str] = []
    monkeypatch.setattr(
        cca, 'urlopen', lambda url, timeout=None: requests.append(url)
    )

    message = failure_message()

    assert 'FRED_API_KEY' in message
    assert requests == []


def test_blank_fred_key_counts_as_missing(
    fred: FredStub, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FRED_API_KEY', '  ')

    assert 'FRED_API_KEY' in failure_message()
    assert fred.requests == []


def test_network_error_stops_the_script_with_the_cause(fred: FredStub) -> None:
    fred.responses[cca.FRED_NFP_RELEASE_ID] = URLError('Name or service not known')

    message = failure_message()

    assert 'URLError' in message
    assert 'Name or service not known' in message
    assert 'release 50' in message


def test_timeout_stops_the_script_with_the_cause(fred: FredStub) -> None:
    fred.responses[cca.FRED_CPI_RELEASE_ID] = TimeoutError('timed out')

    message = failure_message()

    assert 'TimeoutError' in message
    assert 'timed out' in message
    assert 'release 10' in message


def test_http_500_stops_the_script_with_the_status_and_not_the_key(
    fred: FredStub,
) -> None:
    # urllib raises HTTPError for a 4xx or 5xx; the real one carries the URL,
    # which holds the api_key, so the message must not echo it.
    fred.responses[cca.FRED_CPI_RELEASE_ID] = HTTPError(
        f'https://api.stlouisfed.org/fred/release/dates?api_key={FAKE_KEY}',
        500,
        'Internal Server Error',
        Message(),
        io.BytesIO(b''),
    )

    message = failure_message()

    assert 'HTTPError' in message
    assert '500' in message
    assert FAKE_KEY not in message


def test_a_non_200_status_stops_the_script(fred: FredStub) -> None:
    # urlopen returns a 2xx other than 200 without raising.
    fred.responses[cca.FRED_NFP_RELEASE_ID] = _Response(
        release_body(cca.FRED_NFP_RELEASE_ID, NFP_DATES), status=203
    )

    message = failure_message()

    assert 'HTTP 203' in message
    assert 'release 50' in message


def test_a_malformed_body_stops_the_script_with_the_cause(fred: FredStub) -> None:
    fred.responses[cca.FRED_NFP_RELEASE_ID] = b'<html>502 Bad Gateway</html>'

    message = failure_message()

    assert 'JSONDecodeError' in message
    assert 'release 50' in message


@pytest.mark.parametrize(
    'body',
    [
        b'{"error_code": 400, "error_message": "Bad Request."}',
        b'{"release_dates": "none"}',
        b'{"release_dates": null}',
        b'[]',
    ],
    ids=['no key', 'not a list', 'null', 'not an object'],
)
def test_a_payload_without_a_release_dates_list_stops_the_script(
    fred: FredStub, body: bytes
) -> None:
    fred.responses[cca.FRED_CPI_RELEASE_ID] = body

    message = failure_message()

    assert 'release_dates' in message
    assert 'release 10' in message


@pytest.mark.parametrize(
    'body',
    [
        b'{"release_dates": [{"release_id": 10, "date": "soon"}]}',
        b'{"release_dates": [{"release_id": 10}]}',
    ],
    ids=['bad date', 'no date'],
)
def test_an_unreadable_entry_stops_the_script(fred: FredStub, body: bytes) -> None:
    fred.responses[cca.FRED_CPI_RELEASE_ID] = body

    message = failure_message()

    assert 'release 10' in message
    assert 'Error' in message  # the exception type, e.g. ValueError


@pytest.mark.parametrize(
    'release_id', [cca.FRED_CPI_RELEASE_ID, cca.FRED_NFP_RELEASE_ID]
)
def test_an_empty_date_list_stops_the_script(
    fred: FredStub, release_id: int
) -> None:
    # An empty source must not give empty findings. The other release still
    # has dates, so only that one release trips the check.
    fred.responses[release_id] = release_body(release_id, [])

    message = failure_message()

    assert f'release {release_id}' in message
    assert 'no dates' in message


def test_a_truncated_list_stops_the_script(fred: FredStub) -> None:
    # FRED reports the full count; a page shorter than it lost its newest dates.
    fred.responses[cca.FRED_CPI_RELEASE_ID] = release_body(
        cca.FRED_CPI_RELEASE_ID, CPI_DATES, count=1200
    )

    message = failure_message()

    assert 'truncated' in message
    assert 'release 10' in message


def test_a_complete_count_is_not_a_truncation(fred: FredStub) -> None:
    fred.responses[cca.FRED_CPI_RELEASE_ID] = release_body(
        cca.FRED_CPI_RELEASE_ID, CPI_DATES, count=len(CPI_DATES)
    )

    cal = cca.load_calendar_events()

    assert cal['cpi'] == {date.fromisoformat(d) for d in CPI_DATES}


def test_main_lists_only_the_calendar_days_inside_the_sample_window(
    fred: FredStub, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # FRED answers the whole history, so the findings must not list all of it.
    trades_csv = tmp_path / 'trades.csv'
    trades_csv.write_text(
        'anchor_ts,trade_type,ret_15m,control_ret_15m,ret_30m,control_ret_30m,'
        'ret_60m,control_ret_60m\n'
        '2026-10-02T14:00:00Z,long_call_e1,1.0,0.5,1.0,0.5,1.0,0.5\n'
        '2026-10-14T14:00:00Z,long_call_e1,2.0,1.0,2.0,1.0,2.0,1.0\n'
        '2026-10-20T14:00:00Z,long_put_e5,-1.0,0.5,-1.0,0.5,-1.0,0.5\n'
    )
    findings = tmp_path / 'findings.md'
    monkeypatch.setattr(cca, 'TRADES_CSV', trades_csv)
    monkeypatch.setattr(cca, 'FINDINGS_MD', findings)
    monkeypatch.setattr(cca, 'TMP_DIR', tmp_path)

    cca.main()

    text = findings.read_text(encoding='utf-8')
    assert '- CPI release days: 2026-10-14\n' in text
    assert '- NFP release days: 2026-10-02\n' in text
    for outside in ('2026-03-12', '2026-08-12', '2026-03-06', '2026-09-04'):
        assert outside not in text
    tagged = pd.read_csv(tmp_path / 'aggregate_framework_trades_tagged.csv')
    flags = tagged.set_index('date')[['is_cpi_day', 'is_nfp_day']]
    assert flags.loc['2026-10-14'].tolist() == [True, False]
    assert flags.loc['2026-10-02'].tolist() == [False, True]
    assert flags.loc['2026-10-20'].tolist() == [False, False]


def test_main_writes_no_findings_when_fred_fails(
    fred: FredStub, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    trades_csv = tmp_path / 'trades.csv'
    trades_csv.write_text('anchor_ts,trade_type\n2026-10-14T14:00:00Z,long_call_e1\n')
    findings = tmp_path / 'findings.md'
    monkeypatch.setattr(cca, 'TRADES_CSV', trades_csv)
    monkeypatch.setattr(cca, 'FINDINGS_MD', findings)
    monkeypatch.setattr(cca, 'TMP_DIR', tmp_path)
    fred.responses[cca.FRED_CPI_RELEASE_ID] = URLError('connection refused')

    with pytest.raises(SystemExit) as stopped:
        cca.main()

    assert 'FRED release dates' in str(stopped.value.code)
    assert not findings.exists()
    assert list(tmp_path.glob('*_tagged.csv')) == []


# ----- the release IDs match the app -----


def test_release_ids_match_tracked_releases_in_the_app() -> None:
    """The script's CPI and NFP IDs are the ones the app tracks.

    Twin of api/__tests__/fomc-schedule.test.ts, which guards calendar.py
    against the TypeScript FOMC schedule: a renumbered release in
    TRACKED_RELEASES would otherwise leave this script reading another
    release's days.
    """
    source = (REPO / 'api' / '_lib' / 'market-events.ts').read_text(encoding='utf-8')
    block = re.search(
        r'const TRACKED_RELEASES\b[^=]*=\s*\[(.*?)\n\];', source, re.DOTALL
    )
    assert block is not None, 'market-events.ts: TRACKED_RELEASES not found'
    events_by_id = {
        int(release_id): event
        for release_id, event in re.findall(
            r"id:\s*(\d+),\s*event:\s*'([^']+)'", block.group(1)
        )
    }

    assert events_by_id.get(cca.FRED_CPI_RELEASE_ID) == 'CPI'
    assert events_by_id.get(cca.FRED_NFP_RELEASE_ID) == 'NFP'


# ----- calendar primitives -----


@pytest.mark.parametrize(
    ('year', 'month', 'expected'),
    [
        (2024, 3, date(2024, 3, 15)),  # the 1st is a Friday
        (2026, 1, date(2026, 1, 16)),
        (2026, 2, date(2026, 2, 20)),  # the 1st is a Sunday
        (2026, 5, date(2026, 5, 15)),  # the 1st is a Friday
        (2026, 10, date(2026, 10, 16)),
        (2026, 12, date(2026, 12, 18)),
    ],
)
def test_third_friday_table(year: int, month: int, expected: date) -> None:
    assert cca.third_friday(year, month) == expected


def test_third_friday_is_a_friday_between_the_15th_and_the_21st() -> None:
    for year in range(2024, 2029):
        for month in range(1, 13):
            d = cca.third_friday(year, month)
            assert (d.year, d.month) == (year, month)
            assert d.weekday() == 4
            assert 15 <= d.day <= 21


def test_opex_dates_in_range_crosses_the_new_year() -> None:
    assert cca.opex_dates_in_range(date(2026, 11, 1), date(2027, 2, 28)) == [
        date(2026, 11, 20),
        date(2026, 12, 18),
        date(2027, 1, 15),
        date(2027, 2, 19),
    ]


def test_opex_dates_in_range_leaves_out_a_third_friday_outside_the_range() -> None:
    assert cca.opex_dates_in_range(date(2026, 10, 17), date(2026, 11, 19)) == []


@pytest.mark.parametrize(
    ('d', 'n', 'expected'),
    [
        (date(2026, 10, 30), 2, True),  # Oct 31 is a Saturday: Fri 30th is last
        (date(2026, 10, 29), 2, True),
        (date(2026, 10, 28), 2, False),
        (date(2026, 10, 31), 2, False),  # the Saturday itself
        (date(2026, 10, 30), 1, True),
        (date(2026, 10, 29), 1, False),
        (date(2026, 12, 31), 2, True),  # December: the next month is January
        (date(2026, 12, 30), 2, True),
        (date(2026, 12, 29), 2, False),
        (date(2026, 9, 30), 2, True),
    ],
)
def test_is_last_business_day_of_month(d: date, n: int, expected: bool) -> None:
    assert cca.is_last_business_day_of_month(d, n=n) is expected


# ----- tag_calendar -----

OPEX_SET = {date(2026, 10, 16), date(2026, 11, 20)}
CAL = {
    'fomc': {date(2026, 10, 28)},
    'cpi': {date(2026, 10, 14)},
    'nfp': {date(2026, 10, 2)},
}


def test_tag_calendar_on_opex_day() -> None:
    tags = cca.tag_calendar(date(2026, 10, 16), OPEX_SET, CAL)

    assert tags['days_to_opex'] == 0
    assert tags['is_opex_day'] is True
    assert tags['is_opex_week'] is True
    assert tags['is_fomc_day'] is False
    assert tags['is_cpi_day'] is False
    assert tags['is_nfp_day'] is False
    assert (tags['dom'], tags['dow']) == (16, 4)


def test_tag_calendar_on_a_cpi_day_in_opex_week() -> None:
    tags = cca.tag_calendar(date(2026, 10, 14), OPEX_SET, CAL)

    assert tags['is_cpi_day'] is True
    assert tags['is_opex_week'] is True  # Mon Oct 12 to Fri Oct 16
    assert tags['is_opex_day'] is False
    assert tags['days_to_opex'] == 2


def test_tag_calendar_on_an_fomc_day_outside_opex_week() -> None:
    tags = cca.tag_calendar(date(2026, 10, 28), OPEX_SET, CAL)

    assert tags['is_fomc_day'] is True
    assert tags['is_opex_week'] is False
    assert tags['days_to_opex'] == 23  # the next OPEX is Nov 20
    assert tags['is_eom'] is False


def test_tag_calendar_on_an_nfp_day() -> None:
    tags = cca.tag_calendar(date(2026, 10, 2), OPEX_SET, CAL)

    assert tags['is_nfp_day'] is True
    assert tags['days_to_opex'] == 14


def test_tag_calendar_marks_quarter_end_as_month_end_too() -> None:
    tags = cca.tag_calendar(date(2026, 9, 30), OPEX_SET, CAL)

    assert tags['is_eoq'] is True
    assert tags['is_eom'] is True


def test_tag_calendar_after_the_last_opex_has_no_days_to_opex() -> None:
    tags = cca.tag_calendar(date(2026, 11, 23), OPEX_SET, CAL)

    assert tags['days_to_opex'] is None
    assert tags['is_opex_week'] is False
