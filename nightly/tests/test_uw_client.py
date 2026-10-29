"""Tests for the UW Full Tape download client.

Every request is answered by respx (no network, never a real key), and a route a
test defines but never calls fails it. Sleep, the monotonic clock and jitter are
patched at uw_client's module boundary.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Iterator
from datetime import date
from pathlib import Path

import httpx
import pytest

from constants import DOWNLOAD_DEADLINE_SECONDS, SNIFF_MAX_BYTES, USER_AGENT
from uw_client import SourceInfo, TapeDownloadError, download_tape, parse_boundary, probe_source

pytestmark = pytest.mark.respx(assert_all_called=True)

DAY = date(2026, 10, 27)
API_KEY = "test-key"
UW_URL = "https://api.unusualwhales.com/api/option-trades/full-tape/2026-10-27"
GCS_URL = "https://storage.googleapis.com/uw-full-tape/2026-10-27-fulltape.zip"
ZIP_BODY = b"PK\x03\x04" + bytes(range(256)) * 40
GCS_HEADERS = {
    "ETag": '"gcs-etag-1"',
    "Last-Modified": "Tue, 28 Oct 2026 05:12:00 GMT",
    "Content-Type": "application/zip",
}
HISTORIC_MESSAGE = (
    "Your plan includes 730 trading days of history; your earliest available date is 2024-09-10."
)
# Verbatim from UW on 2026-10-29, for GET /api/option-trades/full-tape/2021-01-04 (an
# error message; no market data). The same sentence echoes the requested day.
LIVE_HISTORIC_BODY = r"""{"code":"historic_data_access_missing","message":"The earliest date currently available to this token is 2023-11-30, so 2021-01-04 in query param date will not return historical data.\n\nAPI Basic and API Advanced subscriptions include up to 2 years of historical data. View API plans at https://unusualwhales.com/pricing?product=api.\n\nFor access beyond standard plan limits, email dev@unusualwhales.com with your use case.\n\nNote: For the endpoints /api/institution, /api/stock/:ticker/ohlc/:candle_size, /api/insider/transactions, /api/insider/:sector/sector-flow, /api/insider/:ticker, /api/insider/:ticker/ticker-flow, /api/stock/:ticker/insider-buy-sells, /api/market/correlations, /api/alerts there is no limitations on accessing historical data.\n"}"""


@pytest.fixture(autouse=True)
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Record backoff sleeps instead of sleeping; jitter is pinned to 0."""
    calls: list[float] = []
    monkeypatch.setattr("uw_client.time.sleep", calls.append)
    monkeypatch.setattr("uw_client.random.uniform", lambda _a, _b: 0.0)
    return calls


def _signed(n: int) -> httpx.Response:
    """UW's answer: a 302 to a freshly signed GCS URL (carries its own ETag)."""
    return httpx.Response(302, headers={"Location": f"{GCS_URL}?sig={n}", "ETag": '"uw-etag"'})


def _uw_route(respx_mock, *responses: httpx.Response):
    """UW route answering each attempt with the next response, defaulting to 302s."""
    queue = list(responses)
    counter = iter(range(1, 100))

    def answer(_request: httpx.Request) -> httpx.Response:
        return queue.pop(0) if queue else _signed(next(counter))

    return respx_mock.get(UW_URL).mock(side_effect=answer)


def _zip_response(body: bytes = ZIP_BODY, length: int | None = None) -> httpx.Response:
    headers = {**GCS_HEADERS, "Content-Length": str(len(body) if length is None else length)}
    return httpx.Response(200, headers=headers, content=body)


def _part(dest: Path) -> Path:
    return dest.with_name(dest.name + ".part")


def _assert_no_files(dest: Path) -> None:
    assert not dest.exists()
    assert not _part(dest).exists()


def _assert_message(err: TapeDownloadError, kind: str, detail: str) -> None:
    assert err.kind == kind
    assert err.day == DAY
    assert err.detail == detail
    text = str(err)
    assert kind in text
    assert DAY.isoformat() in text
    assert detail in text


def test_success_writes_zip_and_returns_source_info(respx_mock, tmp_path: Path):
    uw = _uw_route(respx_mock)
    gcs = respx_mock.get(GCS_URL).mock(return_value=_zip_response())
    dest = tmp_path / "day" / "2026-10-27.zip"

    info = download_tape(DAY, dest, API_KEY)

    assert info == SourceInfo(
        etag='"gcs-etag-1"',
        last_modified="Tue, 28 Oct 2026 05:12:00 GMT",
        bytes=len(ZIP_BODY),
    )
    assert dest.read_bytes() == ZIP_BODY
    assert not _part(dest).exists()
    sent = uw.calls.last.request.headers
    assert sent["Authorization"] == f"Bearer {API_KEY}"
    assert sent["Accept"] == "*/*"
    assert sent["Accept-Encoding"] == "identity"
    assert sent["User-Agent"] == USER_AGENT
    assert sent["UW-CLIENT-API-ID"] == "100003"
    # httpx 0.28 drops Authorization on the cross-origin hop; the rest still goes.
    gcs_sent = gcs.calls.last.request.headers
    assert "Authorization" not in gcs_sent
    assert gcs_sent["User-Agent"] == USER_AGENT
    assert gcs_sent["Accept-Encoding"] == "identity"


def test_gcs_404_is_not_posted(respx_mock, tmp_path: Path, sleeps: list[float]):
    uw = _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(
        return_value=httpx.Response(
            404,
            content=b"<Error><Code>NoSuchKey</Code></Error>",
            headers={"Content-Type": "application/xml"},
        )
    )
    dest = tmp_path / "t.zip"

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, dest, API_KEY)

    _assert_message(caught.value, "not_posted", "gcs-404")
    assert (caught.value.origin, caught.value.earliest) == ("gcs", None)
    assert "NoSuchKey" not in str(caught.value)
    assert uw.call_count == 1
    assert sleeps == []
    _assert_no_files(dest)


def test_uw_404_is_not_posted(respx_mock, tmp_path: Path):
    _uw_route(respx_mock, httpx.Response(404, json={"message": "not found"}))

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, tmp_path / "t.zip", API_KEY)

    _assert_message(caught.value, "not_posted", "uw-404")
    assert (caught.value.origin, caught.value.earliest) == ("uw", None)


def test_historic_403_is_outside_window(respx_mock, tmp_path: Path, sleeps: list[float]):
    uw = _uw_route(
        respx_mock,
        httpx.Response(
            403, json={"code": "historic_data_access_missing", "message": HISTORIC_MESSAGE}
        ),
    )
    dest = tmp_path / "t.zip"

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, dest, API_KEY)

    _assert_message(
        caught.value,
        "outside_window",
        "uw-403 historic window: earliest 2024-09-10, 730 trading days",
    )
    assert caught.value.earliest == date(2024, 9, 10)
    assert caught.value.origin == "uw"
    assert "Your plan includes" not in str(caught.value)
    assert uw.call_count == 1
    assert sleeps == []
    _assert_no_files(dest)


def test_historic_403_without_a_parseable_boundary_has_no_earliest(respx_mock, tmp_path: Path):
    _uw_route(
        respx_mock,
        httpx.Response(403, json={"code": "historic_data_access_missing", "message": "no dates"}),
    )

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, tmp_path / "t.zip", API_KEY)

    _assert_message(
        caught.value,
        "outside_window",
        "uw-403 historic window: earliest unknown, unknown trading days",
    )
    assert (caught.value.origin, caught.value.earliest) == ("uw", None)


def test_live_historic_403_body_gives_uw_earliest(respx_mock, tmp_path: Path):
    _uw_route(
        respx_mock,
        httpx.Response(
            403,
            content=LIVE_HISTORIC_BODY.encode(),
            headers={"Content-Type": "application/json"},
        ),
    )

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, tmp_path / "t.zip", API_KEY)

    _assert_message(
        caught.value,
        "outside_window",
        "uw-403 historic window: earliest 2023-11-30, unknown trading days",
    )
    assert (caught.value.origin, caught.value.earliest) == ("uw", date(2023, 11, 30))
    assert "unusualwhales.com" not in str(caught.value)


@pytest.mark.parametrize(
    ("message", "earliest", "lookback"),
    [
        pytest.param(
            json.loads(LIVE_HISTORIC_BODY)["message"],
            date(2023, 11, 30),
            None,
            id="live-2026-10-29",
        ),
        pytest.param(
            "2021-01-04 in query param date will not return historical data, as the earliest "
            "date currently available to this token is 2023-11-30.",
            date(2023, 11, 30),
            None,
            id="requested-day-first",
        ),
        pytest.param(HISTORIC_MESSAGE, date(2024, 9, 10), 730, id="earliest-available-date"),
        pytest.param("THE EARLIEST DATE IS 2023-11-30.", date(2023, 11, 30), None, id="any-case"),
        pytest.param(
            "Requested 2021-01-04; the window starts 2023-11-30.",
            None,
            None,
            id="dates-without-the-phrase",
        ),
        pytest.param("the earliest 2023-11-30", None, None, id="earliest-without-date"),
        pytest.param("The earliest date is 2023-02-30.", None, None, id="impossible-date"),
    ],
)
def test_parse_boundary_reads_only_uws_earliest_date_phrase(
    message: str, earliest: date | None, lookback: int | None
):
    assert parse_boundary(message) == (earliest, lookback)


@pytest.mark.parametrize(
    ("body", "headers", "kind", "detail"),
    [
        ({"code": "route_not_permitted"}, {}, "auth", "uw-403"),
        (
            {"message": "blocked"},
            {"x-deny-reason": "host_not_allowed"},
            "unexpected",
            "uw-403 egress",
        ),
        ({"message": "Attention Required! | Cloudflare"}, {}, "unexpected", "uw-403 cloudflare"),
    ],
)
def test_other_403s_are_classified_without_retry(
    respx_mock, tmp_path: Path, body, headers, kind, detail
):
    uw = _uw_route(respx_mock, httpx.Response(403, json=body, headers=headers))

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, tmp_path / "t.zip", API_KEY)

    _assert_message(caught.value, kind, detail)
    assert (caught.value.origin, caught.value.earliest) == ("uw", None)
    assert uw.call_count == 1


@pytest.mark.parametrize(
    ("location", "kind", "detail"),
    [
        (GCS_URL, "unexpected", "gcs-403"),
        # Virtual-hosted GCS is still GCS.
        ("https://uw-full-tape.storage.googleapis.com/2026-10-27.zip", "unexpected", "gcs-403"),
        # Not a GCS host: the suffix match needs the dot. UW's classifier sees no
        # code in the body, so this is the plain-403 `auth` case.
        ("https://evilstorage.googleapis.com/2026-10-27.zip", "auth", "uw-403"),
    ],
)
def test_403_after_redirect_is_tagged_by_host(
    respx_mock, tmp_path: Path, sleeps: list[float], location, kind, detail
):
    uw = _uw_route(respx_mock, httpx.Response(302, headers={"Location": location}))
    respx_mock.get(location).mock(
        return_value=httpx.Response(403, content=b"<Error><Code>AccessDenied</Code></Error>")
    )

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, tmp_path / "t.zip", API_KEY)

    _assert_message(caught.value, kind, detail)
    assert caught.value.origin == detail.split("-")[0]
    assert uw.call_count == 1
    assert sleeps == []


@pytest.mark.parametrize(
    ("retry_after", "expected_sleep"),
    [("7", 7.0), ("9999", 300.0), (None, 5.0), ("Wed, 21 Oct 2026 07:28:00 GMT", 5.0)],
)
def test_429_retry_after_then_success(
    respx_mock, tmp_path: Path, sleeps: list[float], retry_after, expected_sleep
):
    headers = {"x-uw-daily-req-count": "12", "x-uw-token-req-limit": "100000000"}
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    uw = _uw_route(respx_mock, httpx.Response(429, headers=headers))
    respx_mock.get(GCS_URL).mock(side_effect=lambda _r: _zip_response())
    dest = tmp_path / "t.zip"

    info = download_tape(DAY, dest, API_KEY)

    assert uw.call_count == 2
    assert sleeps == [expected_sleep]
    assert info.bytes == len(ZIP_BODY)
    assert dest.read_bytes() == ZIP_BODY


@pytest.mark.parametrize(
    "headers",
    [{}, {"x-uw-daily-req-count": "20000"}, {"x-uw-token-req-limit": "20000"}],
    ids=["no-daily-headers", "count-only", "limit-only"],
)
def test_429_without_both_daily_headers_is_retried(
    respx_mock, tmp_path: Path, sleeps: list[float], headers
):
    uw = _uw_route(respx_mock, httpx.Response(429, headers=headers))
    respx_mock.get(GCS_URL).mock(return_value=_zip_response())

    info = download_tape(DAY, tmp_path / "t.zip", API_KEY)

    assert uw.call_count == 2
    assert sleeps == [5.0]
    assert info.bytes == len(ZIP_BODY)


def test_daily_quota_429_is_not_retried(respx_mock, tmp_path: Path, sleeps: list[float]):
    uw = _uw_route(
        respx_mock,
        httpx.Response(
            429,
            headers={
                "x-uw-daily-req-count": "20000",
                "x-uw-token-req-limit": "20000",
                "Retry-After": "5",
            },
        ),
    )

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, tmp_path / "t.zip", API_KEY)

    _assert_message(caught.value, "quota_daily", "uw-429 daily 20000 of 20000")
    assert caught.value.origin == "uw"
    assert uw.call_count == 1
    assert sleeps == []


def test_5xx_exhausts_to_transient(respx_mock, tmp_path: Path, sleeps: list[float]):
    uw = respx_mock.get(UW_URL).mock(return_value=httpx.Response(503, text="upstream sad"))
    dest = tmp_path / "t.zip"

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, dest, API_KEY)

    _assert_message(caught.value, "transient", "uw-503 after 4 attempts")
    assert caught.value.origin == "uw"  # carried from the retried attempts
    assert uw.call_count == 4
    assert sleeps == [5.0, 10.0, 20.0]
    _assert_no_files(dest)


def test_backoff_adds_jitter(respx_mock, tmp_path: Path, monkeypatch, sleeps: list[float]):
    monkeypatch.setattr("uw_client.random.uniform", lambda a, b: b)
    respx_mock.get(UW_URL).mock(return_value=httpx.Response(502))

    with pytest.raises(TapeDownloadError):
        download_tape(DAY, tmp_path / "t.zip", API_KEY)

    assert sleeps == [8.0, 13.0, 23.0]


def test_short_body_is_retried(respx_mock, tmp_path: Path, sleeps: list[float]):
    uw = _uw_route(respx_mock)
    gcs = respx_mock.get(GCS_URL).mock(
        side_effect=[_zip_response(ZIP_BODY[:5000], length=len(ZIP_BODY)), _zip_response()]
    )
    dest = tmp_path / "t.zip"

    info = download_tape(DAY, dest, API_KEY)

    assert info.bytes == len(ZIP_BODY)
    assert dest.read_bytes() == ZIP_BODY
    assert not _part(dest).exists()
    # Each attempt asks UW again, so each gets a freshly signed URL.
    assert uw.call_count == 2
    assert [c.request.url.params["sig"] for c in gcs.calls] == ["1", "2"]
    assert sleeps == [5.0]


def test_short_body_every_attempt_is_corrupt(respx_mock, tmp_path: Path):
    _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(
        side_effect=lambda _r: _zip_response(ZIP_BODY[:5000], length=len(ZIP_BODY))
    )
    dest = tmp_path / "t.zip"

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, dest, API_KEY)

    _assert_message(
        caught.value, "corrupt", f"gcs-200 got 5000 of {len(ZIP_BODY)} bytes after 4 attempts"
    )
    _assert_no_files(dest)


def test_mid_stream_disconnect_exhausts_to_transient(
    respx_mock, tmp_path: Path, sleeps: list[float]
):
    # A truncated body over a real connection: h11 raises RemoteProtocolError.
    def truncated(_request: httpx.Request) -> httpx.Response:
        def body() -> Iterator[bytes]:
            yield ZIP_BODY[:3000]
            raise httpx.RemoteProtocolError("peer closed connection mid-body")

        headers = {**GCS_HEADERS, "Content-Length": str(len(ZIP_BODY))}
        return httpx.Response(200, headers=headers, content=body())

    uw = _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(side_effect=truncated)
    dest = tmp_path / "t.zip"

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, dest, API_KEY)

    _assert_message(caught.value, "transient", "RemoteProtocolError after 4 attempts")
    assert uw.call_count == 4
    assert sleeps == [5.0, 10.0, 20.0]
    _assert_no_files(dest)


def test_transport_error_is_retried(respx_mock, tmp_path: Path, sleeps: list[float]):
    _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(side_effect=[httpx.ReadTimeout("slow"), _zip_response()])
    dest = tmp_path / "t.zip"

    info = download_tape(DAY, dest, API_KEY)

    assert info.bytes == len(ZIP_BODY)
    assert sleeps == [5.0]


def test_transport_error_every_attempt_is_transient(respx_mock, tmp_path: Path):
    respx_mock.get(UW_URL).mock(side_effect=httpx.ConnectError("refused"))

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, tmp_path / "t.zip", API_KEY)

    _assert_message(caught.value, "transient", "ConnectError after 4 attempts")
    assert caught.value.origin is None  # no response was classified


def test_encoded_200_is_unexpected_on_first_attempt(
    respx_mock, tmp_path: Path, sleeps: list[float]
):
    packed = gzip.compress(ZIP_BODY)
    uw = _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(
        return_value=httpx.Response(
            200,
            headers={**GCS_HEADERS, "Content-Encoding": "gzip", "Content-Length": str(len(packed))},
            content=packed,
        )
    )
    dest = tmp_path / "t.zip"

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, dest, API_KEY)

    _assert_message(caught.value, "unexpected", "gcs-200 content-encoding gzip")
    assert uw.call_count == 1
    assert sleeps == []
    _assert_no_files(dest)


def test_non_zip_200_is_unexpected_without_body(respx_mock, tmp_path: Path, sleeps: list[float]):
    row = {"option_chain_id": "SPXW261027C05800000", "price": "12.35", "size": 7}
    text = json.dumps({"data": [row] * 30_000}).encode()
    assert len(text) > 2_000_000
    piece = 5000  # not a divisor of SNIFF_MAX_BYTES, so the last read overshoots the cap
    consumed: list[int] = []

    def body() -> Iterator[bytes]:
        for start in range(0, len(text), piece):
            chunk = text[start : start + piece]
            consumed.append(len(chunk))
            yield chunk

    uw = _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(
        return_value=httpx.Response(
            200,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": str(len(text)),
            },
            content=body(),
        )
    )
    dest = tmp_path / "t.zip"

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, dest, API_KEY)

    _assert_message(caught.value, "unexpected", "gcs-200 non-zip (application/json)")
    message = str(caught.value)
    for fragment in ("SPXW261027C05800000", "12.35", "option_chain_id", '{"data"'):
        assert fragment not in message
    # Reading stops at the first network read that reaches the cap.
    assert SNIFF_MAX_BYTES <= sum(consumed) < SNIFF_MAX_BYTES + piece
    assert uw.call_count == 1
    assert sleeps == []
    _assert_no_files(dest)


def test_200_historic_body_is_unexpected_not_outside_window(
    respx_mock, tmp_path: Path, sleeps: list[float]
):
    # The documented out-of-window answer is a 403; a 200 carrying the code is an
    # anomaly, so it fails loudly instead of marking the day unavailable for good.
    payload = {"code": "historic_data_access_missing", "message": HISTORIC_MESSAGE}
    uw = _uw_route(respx_mock, httpx.Response(200, json=payload))

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, tmp_path / "t.zip", API_KEY)

    _assert_message(caught.value, "unexpected", "uw-200 non-zip historic_data_access_missing")
    assert "Your plan includes" not in str(caught.value)
    assert uw.call_count == 1
    assert sleeps == []


def test_zip_without_content_length_is_unexpected(respx_mock, tmp_path: Path):
    def body() -> Iterator[bytes]:
        yield ZIP_BODY

    _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(
        return_value=httpx.Response(200, headers=GCS_HEADERS, content=body())
    )
    dest = tmp_path / "t.zip"

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, dest, API_KEY)

    _assert_message(caught.value, "unexpected", "gcs-200 no content-length")
    _assert_no_files(dest)


def test_download_deadline_raises_timeout(respx_mock, tmp_path: Path, monkeypatch):
    clock = {"now": 1_000.0}
    monkeypatch.setattr("uw_client.time.monotonic", lambda: clock["now"])
    piece = b"PK\x03\x04" + bytes(4092)
    pieces = 40
    yielded: list[int] = []

    def body() -> Iterator[bytes]:
        for i in range(pieces):
            if i == 1:  # the stream trickles: the deadline passes after the first read
                clock["now"] += DOWNLOAD_DEADLINE_SECONDS + 1
            yielded.append(i)
            yield piece

    uw = _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(
        return_value=httpx.Response(
            200, headers={**GCS_HEADERS, "Content-Length": str(len(piece) * pieces)}, content=body()
        )
    )
    dest = tmp_path / "t.zip"

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, dest, API_KEY)

    _assert_message(
        caught.value, "timeout", f"deadline {DOWNLOAD_DEADLINE_SECONDS}s passed after 8192 bytes"
    )
    # Checked once per network read: it stopped on the second read, not at the end.
    assert yielded == [0, 1]
    assert uw.call_count == 1
    _assert_no_files(dest)


def test_deadline_passing_during_backoff_is_timeout(respx_mock, tmp_path: Path, monkeypatch):
    clock = {"now": 1_000.0}
    slept: list[float] = []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        clock["now"] += DOWNLOAD_DEADLINE_SECONDS + 1

    monkeypatch.setattr("uw_client.time.monotonic", lambda: clock["now"])
    monkeypatch.setattr("uw_client.time.sleep", sleep)
    uw = respx_mock.get(UW_URL).mock(return_value=httpx.Response(503))

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, tmp_path / "t.zip", API_KEY)

    _assert_message(
        caught.value, "timeout", f"deadline {DOWNLOAD_DEADLINE_SECONDS}s passed after 0 bytes"
    )
    assert uw.call_count == 1
    assert slept == [5.0]


def _trickle(data: bytes, clock: dict[str, float], consumed: list[int]) -> Iterator[bytes]:
    """Serve `data` in 1,000-byte reads; the deadline passes once the first is read."""
    for start in range(0, len(data), 1000):
        if start:
            clock["now"] += DOWNLOAD_DEADLINE_SECONDS + 1
        piece = data[start : start + 1000]
        consumed.append(len(piece))
        yield piece


def test_deadline_during_sniff_raises_timeout(respx_mock, tmp_path: Path, monkeypatch):
    clock = {"now": 1_000.0}
    consumed: list[int] = []
    monkeypatch.setattr("uw_client.time.monotonic", lambda: clock["now"])
    text = json.dumps({"data": [{"price": "12.35"}] * 20_000}).encode()
    uw = _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(
        return_value=httpx.Response(
            200,
            headers={"Content-Type": "application/json", "Content-Length": str(len(text))},
            content=_trickle(text, clock, consumed),
        )
    )
    dest = tmp_path / "t.zip"

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, dest, API_KEY)

    _assert_message(
        caught.value, "timeout", f"deadline {DOWNLOAD_DEADLINE_SECONDS}s passed after 2000 bytes"
    )
    assert sum(consumed) < SNIFF_MAX_BYTES
    assert uw.call_count == 1
    _assert_no_files(dest)


def test_deadline_during_403_sniff_raises_timeout(respx_mock, tmp_path: Path, monkeypatch):
    clock = {"now": 1_000.0}
    consumed: list[int] = []
    monkeypatch.setattr("uw_client.time.monotonic", lambda: clock["now"])
    text = json.dumps({"message": "x" * 20_000, "code": "historic_data_access_missing"}).encode()
    _uw_route(
        respx_mock,
        httpx.Response(
            403,
            headers={"Content-Type": "application/json"},
            content=_trickle(text, clock, consumed),
        ),
    )
    dest = tmp_path / "t.zip"

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, dest, API_KEY)

    _assert_message(
        caught.value, "timeout", f"deadline {DOWNLOAD_DEADLINE_SECONDS}s passed after 2000 bytes"
    )
    assert sum(consumed) < SNIFF_MAX_BYTES
    _assert_no_files(dest)


def test_keyboard_interrupt_mid_stream_propagates_and_removes_part(respx_mock, tmp_path: Path):
    dest = tmp_path / "t.zip"
    part_existed: list[bool] = []

    def body() -> Iterator[bytes]:
        yield ZIP_BODY[:1000]
        part_existed.append(_part(dest).exists())
        raise KeyboardInterrupt

    _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(
        return_value=httpx.Response(
            200, headers={**GCS_HEADERS, "Content-Length": str(len(ZIP_BODY))}, content=body()
        )
    )

    with pytest.raises(KeyboardInterrupt):
        download_tape(DAY, dest, API_KEY)

    assert part_existed == [True]
    _assert_no_files(dest)


def test_401_is_auth_not_retried(respx_mock, tmp_path: Path, sleeps: list[float]):
    uw = _uw_route(respx_mock, httpx.Response(401, json={"reason": "unrecognized_token"}))

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, tmp_path / "t.zip", API_KEY)

    _assert_message(caught.value, "auth", "uw-401")
    assert "unrecognized_token" not in str(caught.value)
    assert uw.call_count == 1
    assert sleeps == []


def test_os_error_is_typed(respx_mock, tmp_path: Path):
    # The day folder can't be created, so the client fails before any request;
    # respx_mock (no routes) turns any request a reorder might add into a failure.
    blocker = tmp_path / "blocker"
    blocker.write_text("a file where the day folder should be")

    with pytest.raises(TapeDownloadError) as caught:
        download_tape(DAY, blocker / "t.zip", API_KEY)

    assert caught.value.kind == "unexpected"
    assert caught.value.detail.startswith("FileExistsError")
    assert str(tmp_path) not in str(caught.value)
    assert not respx_mock.calls


def test_probe_source_reads_headers_only(respx_mock):
    consumed: list[int] = []

    def body() -> Iterator[bytes]:
        consumed.append(1)
        yield ZIP_BODY

    uw = _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(
        return_value=httpx.Response(
            200, headers={**GCS_HEADERS, "Content-Length": "1834567890"}, content=body()
        )
    )

    info = probe_source(DAY, API_KEY)

    assert info == SourceInfo(
        etag='"gcs-etag-1"', last_modified="Tue, 28 Oct 2026 05:12:00 GMT", bytes=1_834_567_890
    )
    assert consumed == []
    assert uw.call_count == 1


def test_probe_source_classifies_like_download(respx_mock, sleeps: list[float]):
    _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(return_value=httpx.Response(404))

    with pytest.raises(TapeDownloadError) as caught:
        probe_source(DAY, API_KEY)

    _assert_message(caught.value, "not_posted", "gcs-404")
    assert caught.value.origin == "gcs"
    assert sleeps == []


def test_probe_source_retries_5xx(respx_mock, sleeps: list[float]):
    uw = _uw_route(respx_mock, httpx.Response(500))
    respx_mock.get(GCS_URL).mock(
        return_value=httpx.Response(200, headers={**GCS_HEADERS, "Content-Length": "10"})
    )

    info = probe_source(DAY, API_KEY)

    assert info.etag == '"gcs-etag-1"'
    assert uw.call_count == 2
    assert sleeps == [5.0]


def test_probe_source_on_a_uw_200_is_unexpected(respx_mock, sleeps: list[float]):
    # Only the signed GCS object's headers identify the tape.
    _uw_route(
        respx_mock,
        httpx.Response(
            200, json={"data": []}, headers={"ETag": '"uw-etag"', "Content-Length": "12"}
        ),
    )

    with pytest.raises(TapeDownloadError) as caught:
        probe_source(DAY, API_KEY)

    _assert_message(caught.value, "unexpected", "uw-200 probe non-gcs")
    assert sleeps == []


def test_probe_source_without_content_length_is_unexpected(respx_mock):
    def body() -> Iterator[bytes]:
        yield ZIP_BODY

    _uw_route(respx_mock)
    respx_mock.get(GCS_URL).mock(
        return_value=httpx.Response(200, headers=GCS_HEADERS, content=body())
    )

    with pytest.raises(TapeDownloadError) as caught:
        probe_source(DAY, API_KEY)

    _assert_message(caught.value, "unexpected", "gcs-200 no content-length")


def test_error_str_is_kind_day_detail():
    err = TapeDownloadError("transient", DAY, "uw-503 after 4 attempts")

    assert str(err) == "transient 2026-10-27: uw-503 after 4 attempts"
    assert (err.earliest, err.origin) == (None, None)


def test_keyword_fields_leave_str_and_repr_unchanged():
    plain = TapeDownloadError("outside_window", DAY, "uw-403 historic window")
    tagged = TapeDownloadError(
        "outside_window", DAY, "uw-403 historic window", earliest=date(2024, 9, 10), origin="uw"
    )

    assert str(tagged) == str(plain) == "outside_window 2026-10-27: uw-403 historic window"
    assert repr(tagged) == repr(plain)
    assert tagged.args == ("outside_window", DAY, "uw-403 historic window")
    assert (tagged.earliest, tagged.origin) == (date(2024, 9, 10), "uw")
    with pytest.raises(TypeError):
        TapeDownloadError("outside_window", DAY, "x", date(2024, 9, 10))  # keyword-only
