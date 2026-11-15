"""Where a websocket session left from and where it landed, as Cloudflare sees it.

Two facts per session, both for the RST half of the disconnects (README, "Splitting
the RST half"):

- ``valid_colo``: the Cloudflare data centre a ``CF-RAY`` suffix or a trace names.
- ``lookup``: one GET of ``/cdn-cgi/trace`` on the websocket's own host. Cloudflare
  answers it from the edge, as ``key=value`` lines, and ``ip=`` is the address it saw
  the request come from: uw-stream's egress IP, the address its traffic leaves Railway
  from. ``colo=`` and ``loc=`` say which data centre and country answered.

The trace is a separate TCP connection from the websocket, so its colo can differ
from the socket's own. The connector logs both next to each other.

One short-lived ``aiohttp.ClientSession`` per lookup, closed by its ``async with``:
the connector looks once per connect (8 at boot, then one per reconnect, about 50 to
260 a day), so a shared session would buy nothing and need shutdown wiring.

Touches nothing but the network, and not Sentry. ``lookup`` raises on any failure;
the connector, which knows the shard, catches it and logs a rate-limited warning.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

import aiohttp

# The whole lookup, connect to last byte. Past this it gives up and the next session
# looks again: nothing waits on it.
_TIMEOUT_S = 5.0

# UW's host 403s Python's default User-Agent.
_USER_AGENT = "uw-stream/1.0 (egress-trace)"

_TRACE_PATH = "/cdn-cgi/trace"

# A colo is an airport code, three capital letters. ``loc`` is a country code, two
# capitals or digits (Cloudflare uses ``T1`` for Tor). Anything else is reported as
# None, so what a log line carries is always one of these shapes.
_COLO = re.compile(r"[A-Z]{3}")
_LOC = re.compile(r"[A-Z0-9]{2}")


class TraceError(Exception):
    """The trace answered, but not with a trace: a non-200, or no usable ``ip=``.

    The message is fixed text (a status or a missing field), safe to log.
    """


@dataclass(frozen=True)
class Trace:
    """What a trace says: ``ip`` is always a valid address; ``colo`` and ``loc`` are None when odd."""

    ip: str
    colo: str | None
    loc: str | None


def valid_colo(value: str | None) -> str | None:
    """``value`` when it is three capital letters, else None."""
    if value is not None and _COLO.fullmatch(value):
        return value
    return None


def trace_url(ws_url: str) -> str:
    """The trace URL on the host the websocket connects to, so it is the same zone.

    Built from the host (and port) alone: ``ws_url`` carries the API key as
    ``?token=``, and neither that nor a path reaches the result. ``wss`` maps to
    ``https`` and anything else to ``http``.
    """
    parts = urlsplit(ws_url)
    scheme = "https" if parts.scheme == "wss" else "http"
    host = parts.netloc.rpartition("@")[2]
    return f"{scheme}://{host}{_TRACE_PATH}"


async def lookup(url: str) -> Trace:
    """GET the trace at ``url`` and return what it reports.

    Raises ``TraceError`` for a non-200 or a body with no valid ``ip=``, and lets the
    network's own errors through: ``TimeoutError`` past ``_TIMEOUT_S``, and an
    ``aiohttp.ClientError`` for a refused or reset connection. A redirect is not
    followed, so it is a non-200. The status is checked before the body is read: a
    block page can echo an ``ip=`` of its own.

    A cancel closes the session, and with it the connection, on the way out.
    """
    timeout = aiohttp.ClientTimeout(total=_TIMEOUT_S)
    async with (
        aiohttp.ClientSession(timeout=timeout, headers={"User-Agent": _USER_AGENT}) as session,
        session.get(url, allow_redirects=False) as response,
    ):
        if response.status != 200:
            raise TraceError(f"HTTP {response.status}")
        body = await response.text(errors="replace")
    return _parse(body)


def _parse(body: str) -> Trace:
    fields: dict[str, str] = {}
    for line in body.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            fields.setdefault(key.strip(), value.strip())
    try:
        ip = str(ipaddress.ip_address(fields.get("ip", "")))
    except ValueError:
        raise TraceError("no valid ip line") from None
    loc = fields.get("loc", "")
    return Trace(
        ip=ip,
        colo=valid_colo(fields.get("colo")),
        loc=loc if _LOC.fullmatch(loc) else None,
    )
