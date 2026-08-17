"""HTTP client for the local Theta Data Terminal v2 API.

The Terminal hosts its server at http://127.0.0.1:25510 (see
theta_launcher.py). This module wraps the endpoints we actually need
for nightly EOD ingest plus the Index Data PRO proxy routes:

  - GET /v2/list/expirations?root=SPXW           — list all expirations
  - GET /v2/list/strikes?root=SPXW&exp=20260418  — list strikes for exp
  - GET /v2/hist/option/eod?...                  — EOD row per contract
  - GET /v2/snapshot/index/price?root=SPX        — current index value
  - GET /v2/hist/index/ohlc?...                  — index interval candles

Theta v2 quirks encoded here:

  1. Strikes in the wire format are integer thousandths — $5100.00 is
     sent as 5100000. We normalize to Decimal-in-dollars on the public
     API boundary so callers don't have to care.
  2. Dates are YYYYMMDD integers, not ISO strings.
  3. When a contract has no data for the requested range, Theta returns
     a plain-text body like ":No data for the specified timeframe &
     contract." rather than an empty JSON array. We catch this and
     surface it as an empty list.
  4. Free-tier responses can also include HTTP 472 "Not entitled" —
     we raise ThetaSubscriptionError so the fetcher can skip the root.

Uses urllib.request to stay dep-free (no requests/httpx). Timeouts and
retries are handled inline; Sentry reporting happens in the caller
(theta_fetcher), not here — keeping this module pure-functional makes
it easy to test.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from logger_setup import log

# Verified empirically against the live jar (Theta Terminal v1.8.6 Rev A):
# HTTP binds :25510 (WS :25520); :25503 is never bound.
DEFAULT_BASE_URL = "http://127.0.0.1:25510"
DEFAULT_TIMEOUT_S = 15
DEFAULT_MAX_RETRIES = 3

# Non-5xx HTTP codes that are transient and worth retrying on the same
# backoff path as 5xx (FINDING D):
#   429 — rate limit
#   476 — Theta MDDS transient disconnect
# 472 ("Not entitled") is intentionally excluded — it raises
# ThetaSubscriptionError immediately so the fetcher can skip the root.
_RETRYABLE_THROTTLE_CODES = frozenset({429, 476})


def _is_retryable_http(code: int) -> bool:
    """True for HTTP codes that should retry with backoff (5xx + throttles)."""
    return (500 <= code < 600) or (code in _RETRYABLE_THROTTLE_CODES)


# Strikes are stored on the wire as integer thousandths of a dollar.
# 5100000 wire -> $5100.00 human. Divisor lives in one place so tests
# can assert against it symbolically.
STRIKE_WIRE_DIVISOR = Decimal(1000)

# Theta's `ms_of_day` fields are milliseconds since 00:00:00.000 Eastern.
_ET_ZONE = ZoneInfo("America/New_York")

# Default interval for index OHLC candles: 1 minute in milliseconds.
DEFAULT_INDEX_IVL_MS = 60000


class ThetaClientError(Exception):
    """Base class for client errors."""


class ThetaSubscriptionError(ThetaClientError):
    """Raised when Theta denies the request for subscription reasons (HTTP 472)."""


@dataclass(frozen=True)
class EodRow:
    """One day of EOD data for a single option contract.

    Fields match the theta_option_eod table columns. Decimals for price
    fields, plain ints for sizes/volumes/counts. All monetary fields
    may be None when Theta did not emit that value (e.g. no trades).
    """

    symbol: str
    expiration: date
    strike: Decimal
    option_type: str  # 'C' or 'P'
    trade_date: date
    open: Decimal | None
    high: Decimal | None
    low: Decimal | None
    close: Decimal | None
    volume: int | None
    trade_count: int | None
    bid: Decimal | None
    ask: Decimal | None
    bid_size: int | None
    ask_size: int | None


@dataclass(frozen=True)
class IndexPriceSnapshot:
    """Current value of a calculated index (SPX / VIX family).

    `ts_ms` is derived from Theta's `date` + `ms_of_day` columns
    (milliseconds since ET midnight) as epoch milliseconds. Indices
    have no trades, so there is no volume/size here by design.
    """

    root: str
    price: Decimal
    snapshot_date: date
    ts_ms: int


@dataclass(frozen=True)
class IndexOhlcCandle:
    """One interval candle of index values (OHLC of prices).

    Indices have no volume — deliberately NO volume field so callers
    can't accidentally depend on a fabricated one.
    """

    ts_ms: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal


class ThetaClient:
    """Thin HTTP wrapper around the Theta Terminal v2 API."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        timeout_s: int = DEFAULT_TIMEOUT_S,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.max_retries = max_retries

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def list_expirations(self, root: str) -> list[date]:
        """Return all known expirations for a root, sorted ascending."""
        body = self._get_json("/v2/list/expirations", {"root": root})
        raw = body.get("response", [])
        return sorted({_parse_yyyymmdd(d) for d in raw})

    def list_strikes(self, root: str, expiration: date) -> list[Decimal]:
        """Return all listed strikes (in dollars) for a root + expiration."""
        body = self._get_json(
            "/v2/list/strikes",
            {"root": root, "exp": _format_yyyymmdd(expiration)},
        )
        raw = body.get("response", [])
        return sorted({_strike_wire_to_dollars(s) for s in raw if s is not None})

    def fetch_eod(
        self,
        root: str,
        expiration: date,
        strike: Decimal,
        option_type: str,
        start_date: date,
        end_date: date,
    ) -> list[EodRow]:
        """Fetch EOD rows for a single contract across [start, end].

        Returns [] when Theta has no data for the range (plain-text
        "No data..." response). Raises ThetaSubscriptionError when the
        request is denied for entitlement reasons.
        """
        params = {
            "root": root,
            "exp": _format_yyyymmdd(expiration),
            "strike": _strike_dollars_to_wire(strike),
            "right": _normalize_right(option_type),
            "start_date": _format_yyyymmdd(start_date),
            "end_date": _format_yyyymmdd(end_date),
        }
        body = self._get_json("/v2/hist/option/eod", params)

        header = body.get("header") or {}
        fmt: list[str] = header.get("format") or []
        rows: list[list[Any]] = body.get("response") or []
        if not fmt or not rows:
            return []

        return [
            _row_to_eod(
                fmt,
                row,
                symbol=root,
                expiration=expiration,
                strike=strike,
                option_type=option_type,
            )
            for row in rows
        ]

    def snapshot_index_price(self, root: str) -> IndexPriceSnapshot | None:
        """Fetch the current value of an index root (Index Data PRO).

        Wraps GET /v2/snapshot/index/price?root=... Returns None when
        Theta has no snapshot for the root (plain-text "No data..."
        response). Raises ThetaSubscriptionError on entitlement denial.
        """
        body = self._get_json("/v2/snapshot/index/price", {"root": root})

        header = body.get("header") or {}
        fmt: list[str] = header.get("format") or []
        rows: list[list[Any]] = body.get("response") or []
        if not fmt or not rows:
            return None

        cells = _zip_row_strict(fmt, rows[0])
        price = cells.get("price")
        if price is None:
            raise ThetaClientError(
                f"Theta index snapshot missing 'price' field: {rows[0]!r}"
            )
        date_value = cells.get("date")
        if date_value is None:
            raise ThetaClientError(
                f"Theta index snapshot missing 'date' field: {rows[0]!r}"
            )
        snapshot_date = _parse_yyyymmdd(date_value)
        ms_of_day = int(cells.get("ms_of_day") or 0)
        return IndexPriceSnapshot(
            root=root,
            price=Decimal(str(price)),
            snapshot_date=snapshot_date,
            ts_ms=_et_epoch_ms(snapshot_date, ms_of_day),
        )

    def hist_index_ohlc(
        self,
        root: str,
        day: date,
        ivl_ms: int = DEFAULT_INDEX_IVL_MS,
    ) -> list[IndexOhlcCandle]:
        """Fetch one day of index OHLC interval candles (Index Data PRO).

        Wraps GET /v2/hist/index/ohlc per-date (start_date == end_date
        == `day`) at `ivl_ms` millisecond intervals (default 1 minute).
        Returns [] when Theta has no data for the day. Raises
        ThetaSubscriptionError on entitlement denial. Candles carry no
        volume — indices don't trade.
        """
        params = {
            "root": root,
            "start_date": _format_yyyymmdd(day),
            "end_date": _format_yyyymmdd(day),
            "ivl": ivl_ms,
        }
        body = self._get_json("/v2/hist/index/ohlc", params)

        header = body.get("header") or {}
        fmt: list[str] = header.get("format") or []
        rows: list[list[Any]] = body.get("response") or []
        if not fmt or not rows:
            return []

        return [_row_to_index_ohlc(fmt, row, fallback_date=day) for row in rows]

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------

    def _get_json(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        """GET path?params, retry on 5xx, return parsed JSON (or {} on no-data)."""
        url = f"{self.base_url}{path}?{urlencode(params)}"

        last_exc: Exception | None = None
        backoff_s = 1.0

        for attempt in range(1, self.max_retries + 1):
            try:
                req = Request(url, headers={"Accept": "application/json"})
                with urlopen(req, timeout=self.timeout_s) as resp:  # noqa: S310
                    raw = resp.read()
                return _parse_body(raw)
            except HTTPError as exc:
                if exc.code == 472:
                    raise ThetaSubscriptionError(
                        f"Theta denied request (HTTP 472): {url}"
                    ) from exc
                if _is_retryable_http(exc.code) and attempt < self.max_retries:
                    log.warning(
                        "Theta %s returned %d; retrying (%d/%d)",
                        path,
                        exc.code,
                        attempt,
                        self.max_retries,
                    )
                    last_exc = exc
                    time.sleep(backoff_s)
                    backoff_s = min(backoff_s * 2, 10.0)
                    continue
                raise ThetaClientError(
                    f"Theta {path} failed with HTTP {exc.code}: {url}"
                ) from exc
            except (URLError, TimeoutError, OSError) as exc:
                if attempt < self.max_retries:
                    log.warning(
                        "Theta %s network error: %s; retrying (%d/%d)",
                        path,
                        exc,
                        attempt,
                        self.max_retries,
                    )
                    last_exc = exc
                    time.sleep(backoff_s)
                    backoff_s = min(backoff_s * 2, 10.0)
                    continue
                raise ThetaClientError(f"Theta {path} network failure: {url}") from exc

        # Defensive — the loop above should always raise or return.
        raise ThetaClientError(f"Theta {path} exhausted retries: {last_exc}")


# ---------------------------------------------------------------------------
# Helpers — pulled out of the class for easier unit testing
# ---------------------------------------------------------------------------


def _parse_body(raw: bytes) -> dict[str, Any]:
    """Parse a Theta v2 response body.

    Theta returns plain-text ":No data..." strings (not JSON) when a
    contract has no data for the requested window. Callers still want
    a dict-shaped response so their parsing code doesn't branch; we
    coerce those to an empty {"header":{"format":[]},"response":[]}.
    """
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        return {"header": {"format": []}, "response": []}

    # Plain-text "no data" response — NOT valid JSON.
    # Example: ":No data for the specified timeframe & contract."
    if text.startswith(":") or text.lower().startswith("no data"):
        return {"header": {"format": []}, "response": []}

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ThetaClientError(f"Theta returned non-JSON body: {text[:200]!r}") from exc


def _parse_yyyymmdd(value: int | str) -> date:
    """Parse Theta's integer YYYYMMDD date into datetime.date."""
    return datetime.strptime(str(value), "%Y%m%d").date()


def _et_epoch_ms(d: date, ms_of_day: int) -> int:
    """Convert Theta's (date, ms-since-ET-midnight) pair to epoch ms."""
    midnight_et = datetime(d.year, d.month, d.day, tzinfo=_ET_ZONE)
    return int(midnight_et.timestamp() * 1000) + int(ms_of_day)


def _zip_row_strict(fmt: list[str], row: list[Any]) -> dict[str, Any]:
    """Zip a v2 row (array of values) with its format header.

    strict=True so a format/row length mismatch (Theta adds or removes a
    column) fails loudly instead of silently truncating to wrong/null
    fields (FINDING C). Shared by the option-EOD and index parsers.
    """
    try:
        return dict(zip(fmt, row, strict=True))
    except ValueError as exc:
        raise ThetaClientError(
            f"Theta row/format length mismatch: "
            f"len(format)={len(fmt)} len(row)={len(row)} row={row!r}"
        ) from exc


def _format_yyyymmdd(d: date) -> str:
    return d.strftime("%Y%m%d")


def _strike_wire_to_dollars(wire: int | str) -> Decimal:
    """Convert Theta's integer thousandths into a Decimal-in-dollars."""
    return (Decimal(str(wire)) / STRIKE_WIRE_DIVISOR).quantize(Decimal("0.01"))


def _strike_dollars_to_wire(dollars: Decimal) -> int:
    """Convert a Decimal-in-dollars strike into the wire integer thousandths."""
    return int((Decimal(dollars) * STRIKE_WIRE_DIVISOR).to_integral_value())


def _normalize_right(option_type: str) -> str:
    """Normalize call/put variations into Theta's expected 'C' or 'P'."""
    v = option_type.strip().upper()
    if v in ("C", "CALL"):
        return "C"
    if v in ("P", "PUT"):
        return "P"
    raise ValueError(f"Unknown option type: {option_type!r}")


def _row_to_eod(
    fmt: list[str],
    row: list[Any],
    *,
    symbol: str,
    expiration: date,
    strike: Decimal,
    option_type: str,
) -> EodRow:
    """Zip a v2 row (array of values) with its format header into an EodRow."""
    # The format list names every column in the wire row. The single-
    # contract endpoint doesn't echo symbol/strike/right/exp back — those
    # are request-side knowns we inject here. Length drift fails loudly
    # via the shared strict-zip helper (FINDING C).
    cells = _zip_row_strict(fmt, row)

    def _num(field: str) -> Decimal | None:
        value = cells.get(field)
        if value is None:
            return None
        return Decimal(str(value))

    def _int(field: str) -> int | None:
        value = cells.get(field)
        if value is None:
            return None
        return int(value)

    trade_date_value = cells.get("date")
    if trade_date_value is None:
        raise ThetaClientError(f"Theta row missing 'date' field: {row!r}")

    return EodRow(
        symbol=symbol,
        expiration=expiration,
        strike=strike,
        option_type=_normalize_right(option_type),
        trade_date=_parse_yyyymmdd(trade_date_value),
        open=_num("open"),
        high=_num("high"),
        low=_num("low"),
        close=_num("close"),
        volume=_int("volume"),
        trade_count=_int("count"),
        bid=_num("bid"),
        ask=_num("ask"),
        bid_size=_int("bid_size"),
        ask_size=_int("ask_size"),
    )


def _row_to_index_ohlc(
    fmt: list[str],
    row: list[Any],
    *,
    fallback_date: date,
) -> IndexOhlcCandle:
    """Zip an index OHLC row with its format header into a candle.

    Unknown-but-named extra columns (e.g. a `count` field) are ignored;
    only an unnamed length drift fails (strict zip). OHLC fields are
    required — an index interval always has computed values, so a None
    there means the wire format changed under us and must fail loudly.
    Indices have no volume; none is read and none is fabricated.
    """
    cells = _zip_row_strict(fmt, row)

    ms_of_day = cells.get("ms_of_day")
    if ms_of_day is None:
        raise ThetaClientError(f"Theta index ohlc row missing 'ms_of_day': {row!r}")

    date_value = cells.get("date")
    row_date = _parse_yyyymmdd(date_value) if date_value is not None else fallback_date

    def _req(field: str) -> Decimal:
        value = cells.get(field)
        if value is None:
            raise ThetaClientError(
                f"Theta index ohlc row missing '{field}' field: {row!r}"
            )
        return Decimal(str(value))

    return IndexOhlcCandle(
        ts_ms=_et_epoch_ms(row_date, int(ms_of_day)),
        open=_req("open"),
        high=_req("high"),
        low=_req("low"),
        close=_req("close"),
    )
