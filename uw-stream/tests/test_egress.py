"""Tests for ``egress``: the Cloudflare trace lookup uw-stream makes once per session.

A real aiohttp client talks to a real aiohttp server on the loopback address (the
conftest refuses every other one), so the status handling, the timeout and the
cancellation are aiohttp's own, not a double's.
"""

from __future__ import annotations

import asyncio
import gc
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

import egress

_TRACE = "\n".join(
    [
        "fl=598f52",
        "h=api.unusualwhales.com",
        "ip=203.0.113.9",
        "ts=1763123456.789",
        "visit_scheme=https",
        "uag=uw-stream/1.0 (egress-trace)",
        "colo=MCI",
        "sliver=none",
        "http=http/2",
        "loc=US",
        "tls=TLSv1.3",
        "sni=plaintext",
        "warp=off",
        "gateway=off",
        "rbi=off",
        "kex=X25519",
        "",
    ]
)

Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]


@asynccontextmanager
async def _serve(handler: Handler) -> AsyncIterator[str]:
    """The trace URL of a loopback server whose one route is ``handler``."""
    app = web.Application()
    app.router.add_get("/cdn-cgi/trace", handler)
    server = TestServer(app)
    await server.start_server()
    try:
        yield str(server.make_url("/cdn-cgi/trace"))
    finally:
        await server.close()


def _reply(body: str | bytes = _TRACE, status: int = 200) -> Handler:
    async def handler(_request: web.Request) -> web.StreamResponse:
        data = body.encode() if isinstance(body, str) else body
        return web.Response(body=data, status=status, content_type="text/plain")

    return handler


# --- trace_url ---------------------------------------------------------------


def test_the_trace_url_is_the_socket_host_and_carries_no_token() -> None:
    url = egress.trace_url("wss://api.unusualwhales.com/socket?token=SUPER_SECRET")

    assert url == "https://api.unusualwhales.com/cdn-cgi/trace"
    assert "SUPER_SECRET" not in url


def test_a_plain_ws_url_with_a_port_maps_to_http_on_that_port() -> None:
    assert egress.trace_url("ws://127.0.0.1:8765/socket?token=x") == (
        "http://127.0.0.1:8765/cdn-cgi/trace"
    )


# --- valid_colo --------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("MCI", "MCI"),
        ("DFW", "DFW"),
        ("mci", None),  # lowercase
        ("MC", None),  # too short
        ("MCIA", None),  # too long
        ("M1I", None),  # not letters
        ("", None),
        (None, None),
    ],
)
def test_valid_colo_keeps_only_three_capital_letters(
    value: str | None, expected: str | None
) -> None:
    assert egress.valid_colo(value) == expected


# --- lookup: the answer ------------------------------------------------------


@pytest.mark.asyncio
async def test_lookup_returns_the_ip_colo_and_loc_cloudflare_reports() -> None:
    async with _serve(_reply()) as url:
        trace = await egress.lookup(url)

    assert trace == egress.Trace(ip="203.0.113.9", colo="MCI", loc="US")


@pytest.mark.asyncio
async def test_lookup_accepts_an_ipv6_address() -> None:
    body = "ip=2001:db8::1\ncolo=DFW\nloc=US\n"
    async with _serve(_reply(body)) as url:
        trace = await egress.lookup(url)

    assert trace.ip == "2001:db8::1"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "colo", "loc"),
    [
        ("ip=203.0.113.9\ncolo=mci\nloc=US\n", None, "US"),  # lowercase colo
        ("ip=203.0.113.9\ncolo=MCI\nloc=usa\n", "MCI", None),  # not a country code
        ("ip=203.0.113.9\n", None, None),  # neither line present
        ("ip=203.0.113.9\ncolo=\nloc=\n", None, None),  # both empty
        ("ip=203.0.113.9\ncolo=MCI\nloc=T1\n", "MCI", "T1"),  # Cloudflare's code for Tor
    ],
)
async def test_an_odd_colo_or_loc_is_none_and_the_ip_is_kept(
    body: str, colo: str | None, loc: str | None
) -> None:
    async with _serve(_reply(body)) as url:
        trace = await egress.lookup(url)

    assert trace == egress.Trace(ip="203.0.113.9", colo=colo, loc=loc)


@pytest.mark.asyncio
async def test_lookup_sends_a_user_agent_that_is_not_pythons_default() -> None:
    seen: list[str | None] = []

    async def handler(request: web.Request) -> web.StreamResponse:
        seen.append(request.headers.get("User-Agent"))
        return web.Response(text=_TRACE)

    async with _serve(handler) as url:
        await egress.lookup(url)

    assert seen == ["uw-stream/1.0 (egress-trace)"]


# --- lookup: what is not an answer -------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [403, 404, 429, 500, 503])
async def test_a_non_200_status_is_an_error_even_when_its_body_has_an_ip(status: int) -> None:
    """A block page can echo ``ip=``; only a 200 is the trace."""
    async with _serve(_reply(_TRACE, status=status)) as url:
        with pytest.raises(egress.TraceError, match=str(status)):
            await egress.lookup(url)


@pytest.mark.asyncio
async def test_a_redirect_is_not_followed_and_is_an_error() -> None:
    async def other(_request: web.Request) -> web.StreamResponse:
        raise AssertionError("the redirect target was fetched")

    async def handler(_request: web.Request) -> web.StreamResponse:
        raise web.HTTPMovedPermanently(location="/elsewhere")

    app = web.Application()
    app.router.add_get("/cdn-cgi/trace", handler)
    app.router.add_get("/elsewhere", other)
    server = TestServer(app)
    await server.start_server()
    try:
        with pytest.raises(egress.TraceError, match="301"):
            await egress.lookup(str(server.make_url("/cdn-cgi/trace")))
    finally:
        await server.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        "",
        "<html><body>Just a moment...</body></html>",
        "colo=MCI\nloc=US\n",  # no ip line
        "ip=\ncolo=MCI\n",  # empty ip
        "ip=not-an-ip\ncolo=MCI\n",
        "ip=<script>alert(1)</script>\n",
        "ip=203.0.113.9.7\n",
        "ip=999.1.1.1\n",
        "ip=203.0.113.9; DROP TABLE x\n",
        # An IPv6 scope id is valid to ipaddress, and is text a trace never carries.
        "ip=2001:db8::1%eth0\n",
        "ip=2001:db8::1%not an interface\ncolo=MCI\nloc=US\n",
        b"\xff\xfe\x00\x01 not text at all",
    ],
)
async def test_a_body_with_no_valid_ip_is_an_error(body: str | bytes) -> None:
    async with _serve(_reply(body)) as url:
        with pytest.raises(egress.TraceError, match="ip"):
            await egress.lookup(url)


@pytest.mark.asyncio
async def test_a_body_past_the_size_cap_is_an_error_and_the_client_stops_reading() -> None:
    """A real trace is a few hundred bytes. A body that keeps coming must not be read
    into memory until the timeout: the lookup gives up at the cap and drops the
    connection, which the server sees as its next write failing."""
    chunk = b"x" * 65536
    total_chunks = 4096  # 256 MiB, far more than the client should ever take
    sent = 0
    client_gone = asyncio.Event()

    async def endless(request: web.Request) -> web.StreamResponse:
        nonlocal sent
        response = web.StreamResponse(status=200)
        response.content_type = "text/plain"
        await response.prepare(request)
        try:
            for _ in range(total_chunks):
                await response.write(chunk)
                sent += len(chunk)
        except (ConnectionError, asyncio.CancelledError):
            client_gone.set()  # the write failed, or aiohttp cancelled the handler
            raise
        return response

    async with _serve(endless) as url:
        with pytest.raises(egress.TraceError, match="too large"):
            await egress.lookup(url)
        await asyncio.wait_for(client_gone.wait(), timeout=2.0)

    # The server was stopped by the client's close, not by running out of body: what
    # it sent is a few socket buffers (128 KiB when this was written), a small fraction
    # of the 256 MiB on offer.
    assert sent < total_chunks * len(chunk) // 16


@pytest.mark.asyncio
async def test_a_body_just_under_the_cap_is_still_read() -> None:
    """The cap is on the body, not on a trace: padding up to it parses as before."""
    body = _TRACE + "pad=" + "x" * 1000 + "\n"
    assert len(body) < egress._MAX_BODY_BYTES
    async with _serve(_reply(body)) as url:
        trace = await egress.lookup(url)

    assert trace == egress.Trace(ip="203.0.113.9", colo="MCI", loc="US")


@pytest.mark.asyncio
async def test_a_lookup_that_outlasts_its_timeout_raises_timeout_error(monkeypatch) -> None:
    release = asyncio.Event()

    async def slow(_request: web.Request) -> web.StreamResponse:
        await release.wait()
        return web.Response(text=_TRACE)

    monkeypatch.setattr(egress, "_TIMEOUT_S", 0.1)
    async with _serve(slow) as url:
        try:
            with pytest.raises(TimeoutError):
                await egress.lookup(url)
        finally:
            release.set()


def test_the_lookup_gives_up_after_five_seconds() -> None:
    assert egress._TIMEOUT_S == 5.0


@pytest.mark.asyncio
async def test_a_refused_connection_raises_the_aiohttp_error() -> None:
    async with _serve(_reply()) as url:
        pass  # the server is closed now: nothing listens on that port

    with pytest.raises(aiohttp.ClientConnectorError):
        await egress.lookup(url)


# --- lookup: cancellation ----------------------------------------------------


@pytest.mark.asyncio
async def test_cancelling_a_lookup_closes_its_connection_and_leaves_nothing_behind() -> None:
    """The connector cancels the lookup when the session ends. The cancel must close the
    client session (the server sees the socket go) and leave no unclosed-session report."""
    in_handler = asyncio.Event()
    client_gone = asyncio.Event()

    async def hang(_request: web.Request) -> web.StreamResponse:
        in_handler.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            client_gone.set()  # aiohttp cancels a handler whose client disconnected
            raise
        return web.Response(text=_TRACE)

    reports: list[dict[str, Any]] = []
    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: reports.append(context))
    try:
        async with _serve(hang) as url:
            task = asyncio.create_task(egress.lookup(url))
            await asyncio.wait_for(in_handler.wait(), timeout=2.0)

            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

            await asyncio.wait_for(client_gone.wait(), timeout=2.0)
        gc.collect()
        await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(previous)

    assert reports == []
