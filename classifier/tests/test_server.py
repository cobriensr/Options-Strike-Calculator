"""Tests for ``classifier.src.server``.

Exercises the HTTP plumbing: route dispatch, method validation,
Content-Length handling, body cap, ``Connection: close`` policy, log
suppression, and concurrent /health probes.

All tests use a server bound to an ephemeral port (``build_server(0)``)
started in a daemon thread. Stdlib ``urllib.request`` drives requests
to avoid adding ``httpx`` as a test dep (the classifier image stays
minimal).
"""

from __future__ import annotations

import json
import socket
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

import server

# ── Fixture: spin up the real ThreadingHTTPServer on an ephemeral port ──


@pytest.fixture
def running_server():
    """Build, start, and tear down the classifier HTTP server.

    Yields ``(httpd, base_url)`` where ``base_url`` is ``http://127.0.0.1:<port>``.
    The serve_forever loop runs in a daemon thread; ``shutdown()`` +
    ``server_close()`` happen in teardown to release the listening socket.
    """
    httpd = server.build_server(0)
    port = httpd.server_address[1]
    assert port > 0, "ephemeral bind should yield a real port"

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd, f"http://127.0.0.1:{port}"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def _do_get(url: str, *, timeout: float = 5.0) -> tuple[int, dict[str, str], bytes]:
    """GET + return (status, headers-as-dict-lower, body bytes)."""
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


def _do_post(
    url: str,
    *,
    body: bytes | None,
    content_length_override: int | None = None,
    content_type: str = "application/json",
    timeout: float = 10.0,
) -> tuple[int, dict[str, str], bytes]:
    """POST with optional Content-Length override (for the body-cap test)."""
    headers = {"Content-Type": content_type}
    if content_length_override is not None:
        headers["Content-Length"] = str(content_length_override)
    req = urllib.request.Request(url, method="POST", data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


def _send_raw(
    host: str,
    port: int,
    raw: bytes,
    *,
    timeout: float = 5.0,
    half_close: bool = False,
) -> bytes:
    """Send a raw HTTP/1.1 request over a socket and read the response.

    Used for tests that need to lie about Content-Length or omit it
    entirely, which urllib won't let us do. ``half_close=True`` closes
    the write side after sending so a server waiting on ``rfile.read``
    sees EOF and returns what it has — needed for the truncated-body
    test where the server would otherwise block waiting for more bytes.
    """
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.sendall(raw)
        if half_close:
            sock.shutdown(socket.SHUT_WR)
        sock.settimeout(timeout)
        chunks: list[bytes] = []
        try:
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                chunks.append(chunk)
        except TimeoutError:
            pass
    return b"".join(chunks)


# ── build_server / bind ──────────────────────────────────────────────────


def test_build_server_binds_to_ephemeral_port_without_blocking() -> None:
    """``build_server(0)`` returns a bound, NOT-yet-serving server."""
    httpd = server.build_server(0)
    try:
        port = httpd.server_address[1]
        assert port > 0
        # ``serve_forever`` not called, so the server isn't accepting yet —
        # but the listening socket exists.
        assert httpd.socket.getsockname()[1] == port
    finally:
        httpd.server_close()


def test_build_server_uses_quiet_threading_class() -> None:
    """The server class must be ``_QuietThreadingHTTPServer`` so
    BrokenPipe / ConnectionReset on the response write don't print
    stack traces to stderr.
    """
    httpd = server.build_server(0)
    try:
        assert isinstance(httpd, server._QuietThreadingHTTPServer)
    finally:
        httpd.server_close()


def test_quiet_server_swallows_broken_pipe_in_handle_error(capsys) -> None:
    """_QuietThreadingHTTPServer.handle_error swallows BrokenPipeError."""
    httpd = server.build_server(0)
    try:
        # Simulate the case socketserver raises during process_request_thread.
        try:
            raise BrokenPipeError("simulated client disconnect")
        except BrokenPipeError:
            httpd.handle_error(None, ("127.0.0.1", 0))
        captured = capsys.readouterr()
        # No stack trace dumped — handle_error returned early.
        assert "Traceback" not in captured.err
        assert "BrokenPipe" not in captured.err
    finally:
        httpd.server_close()


def test_quiet_server_swallows_connection_reset(capsys) -> None:
    httpd = server.build_server(0)
    try:
        try:
            raise ConnectionResetError("simulated reset")
        except ConnectionResetError:
            httpd.handle_error(None, ("127.0.0.1", 0))
        captured = capsys.readouterr()
        assert "Traceback" not in captured.err
    finally:
        httpd.server_close()


def test_quiet_server_propagates_other_exceptions(capsys) -> None:
    """A non-disconnect exception (RuntimeError) must still hit the
    default ``handle_error`` and print to stderr — we only want to
    suppress benign client disconnects, not real bugs.
    """
    httpd = server.build_server(0)
    try:
        try:
            raise RuntimeError("genuine bug")
        except RuntimeError:
            httpd.handle_error(None, ("127.0.0.1", 0))
        captured = capsys.readouterr()
        # Default handler dumps a traceback to stderr.
        assert "RuntimeError" in captured.err or "Traceback" in captured.err
    finally:
        httpd.server_close()


# ── /health ──────────────────────────────────────────────────────────────


def test_get_health_returns_200_with_ok_status(running_server) -> None:
    _httpd, base_url = running_server
    status, headers, body = _do_get(f"{base_url}/health")
    assert status == 200
    assert headers["content-type"] == "application/json"
    assert json.loads(body) == {"status": "ok"}
    # 2xx success path keeps the default Connection behavior — no explicit
    # close header.
    assert "connection" not in headers or headers["connection"].lower() != "close"


def test_post_to_health_returns_405_with_allow_get(running_server) -> None:
    _httpd, base_url = running_server
    status, headers, body = _do_post(f"{base_url}/health", body=b"{}")
    assert status == 405
    assert headers["allow"] == "GET"
    assert headers["connection"] == "close"
    assert json.loads(body) == {"error": "method not allowed"}


# ── /unknown ────────────────────────────────────────────────────────────


def test_get_unknown_path_returns_404_with_connection_close(running_server) -> None:
    _httpd, base_url = running_server
    status, headers, body = _do_get(f"{base_url}/unknown")
    assert status == 404
    assert headers["connection"] == "close"
    assert json.loads(body) == {"error": "not found"}


def test_post_unknown_path_returns_404(running_server) -> None:
    _httpd, base_url = running_server
    status, headers, body = _do_post(f"{base_url}/unknown", body=b"{}")
    assert status == 404
    assert headers["connection"] == "close"
    assert json.loads(body) == {"error": "not found"}


# ── /multileg-classify method/route validation ──────────────────────────


def test_get_multileg_classify_returns_405_with_allow_post(running_server) -> None:
    _httpd, base_url = running_server
    status, headers, body = _do_get(f"{base_url}/multileg-classify")
    assert status == 405
    assert headers["allow"] == "POST"
    assert headers["connection"] == "close"
    assert json.loads(body) == {"error": "method not allowed"}


# ── /multileg-classify happy path with mocked matcher ───────────────────


def test_post_multileg_classify_happy_path_keeps_connection_open(
    running_server,
    sample_classify_request_body: bytes,
) -> None:
    """Success path: 200 + no Connection: close (so the TS client can
    pipeline subsequent calls)."""
    _httpd, base_url = running_server

    def fake_handle(_body: bytes) -> tuple[int, dict[str, Any]]:
        return 200, {"classifications": [{"id": "stub", "stub": True}]}

    with patch.object(server, "handle_classify_payload", side_effect=fake_handle):
        status, headers, body = _do_post(
            f"{base_url}/multileg-classify",
            body=sample_classify_request_body,
        )

    assert status == 200
    assert json.loads(body) == {"classifications": [{"id": "stub", "stub": True}]}
    # Critical: 2xx keeps keep-alive (no explicit close header).
    assert "connection" not in headers or headers["connection"].lower() != "close"


def test_post_multileg_classify_5xx_forces_connection_close(
    running_server,
    sample_classify_request_body: bytes,
) -> None:
    _httpd, base_url = running_server

    def fake_handle(_body: bytes) -> tuple[int, dict[str, Any]]:
        return 500, {"error": "boom"}

    with patch.object(server, "handle_classify_payload", side_effect=fake_handle):
        status, headers, _ = _do_post(
            f"{base_url}/multileg-classify",
            body=sample_classify_request_body,
        )

    assert status == 500
    assert headers["connection"] == "close"


# ── /multileg-classify body-size validation ─────────────────────────────


def test_post_multileg_classify_empty_body_returns_400(running_server) -> None:
    _httpd, base_url = running_server
    # urllib won't send a Content-Length: 0 for POST without data, so use
    # the raw socket helper. urllib actually sends 'Content-Length: 0'
    # when data is empty bytes; either way we get the path covered.
    status, headers, body = _do_post(f"{base_url}/multileg-classify", body=b"")
    assert status == 400
    assert headers["connection"] == "close"
    assert json.loads(body) == {"error": "empty body"}


def test_post_multileg_classify_oversize_content_length_returns_413(
    running_server,
) -> None:
    """Declare a Content-Length above the 50 MB cap. The handler must
    reject from the header alone — without trying to read 50 MB off the
    wire. We don't actually send 50 MB; the server should never get
    that far.
    """
    _httpd, base_url = running_server
    host, port = "127.0.0.1", int(base_url.rsplit(":", 1)[1])
    # Declare 60 MB Content-Length but send no body. The server must
    # see the oversize header and short-circuit to 413 BEFORE reading
    # rfile.
    oversize = 60 * 1024 * 1024
    raw = (
        f"POST /multileg-classify HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {oversize}\r\n"
        f"Connection: close\r\n"
        f"\r\n"
    ).encode()
    response = _send_raw(host, port, raw, timeout=3.0)
    # Parse the status line.
    first_line = response.split(b"\r\n", 1)[0].decode()
    assert "413" in first_line, f"expected 413, got: {first_line!r}"
    # The response body should mention payload size limits + the actual cap.
    assert b"payload too large" in response
    assert str(60 * 1024 * 1024).encode() in response  # received_bytes echoed
    assert str(50 * 1024 * 1024).encode() in response  # limit_bytes echoed


def test_post_multileg_classify_invalid_content_length_returns_400(
    running_server,
) -> None:
    """Non-integer Content-Length is malformed input → 400."""
    _httpd, base_url = running_server
    host, port = "127.0.0.1", int(base_url.rsplit(":", 1)[1])
    raw = (
        f"POST /multileg-classify HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: not-a-number\r\n"
        f"Connection: close\r\n"
        f"\r\n"
    ).encode()
    response = _send_raw(host, port, raw, timeout=3.0)
    first_line = response.split(b"\r\n", 1)[0].decode()
    # http.server's request parser may itself 400 the bogus header
    # before our handler sees it (it parses headers for us). Either way
    # the contract is "do not 500". Accept 400 from either layer.
    assert "400" in first_line, f"expected 400, got: {first_line!r}"


def test_post_multileg_classify_no_content_length_treats_as_empty(
    running_server,
) -> None:
    """No Content-Length header → ``int(self.headers.get(..., '0'))`` is 0
    → 400 ``empty body``. Documents the implementation's chosen
    behavior (per spec: "match whatever the implementation does").
    """
    _httpd, base_url = running_server
    host, port = "127.0.0.1", int(base_url.rsplit(":", 1)[1])
    raw = (
        f"POST /multileg-classify HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Content-Type: application/json\r\n"
        f"Connection: close\r\n"
        f"\r\n"
    ).encode()
    response = _send_raw(host, port, raw, timeout=3.0)
    first_line = response.split(b"\r\n", 1)[0].decode()
    assert "400" in first_line, f"expected 400, got: {first_line!r}"
    assert b"empty body" in response


def test_post_multileg_classify_truncated_body_returns_400(
    running_server,
) -> None:
    """Declare Content-Length larger than the actual body → server reads
    a short body and rejects 400 ``truncated body``. Drive via raw socket
    so we control the exact bytes sent.
    """
    _httpd, base_url = running_server
    host, port = "127.0.0.1", int(base_url.rsplit(":", 1)[1])
    body = b'{"trades": []}'  # 14 bytes
    raw = (
        f"POST /multileg-classify HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: 100\r\n"  # claim 100 but send 14
        f"Connection: close\r\n"
        f"\r\n"
    ).encode() + body
    # half_close=True so the server's blocking read returns short instead
    # of hanging forever waiting for the missing 86 bytes.
    response = _send_raw(host, port, raw, timeout=3.0, half_close=True)
    first_line = response.split(b"\r\n", 1)[0].decode()
    assert "400" in first_line, f"expected 400, got: {first_line!r}"
    assert b"truncated body" in response


# ── Concurrent /health probes ───────────────────────────────────────────


def test_concurrent_health_probes_all_succeed(running_server) -> None:
    """Smoke test that ThreadingHTTPServer actually serves requests in
    parallel. 10 concurrent GETs to /health from a thread pool.
    """
    _httpd, base_url = running_server

    def _probe() -> int:
        status, _, _ = _do_get(f"{base_url}/health")
        return status

    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(lambda _: _probe(), range(10)))

    assert results == [200] * 10


# ── Direct handler tests for edge cases hard to drive via HTTP ──────────


def _make_handler_for_do_post(
    *,
    path: str = "/multileg-classify",
    headers: dict[str, str] | None = None,
    rfile_read_side_effect: Exception | None = None,
    rfile_data: bytes = b"",
) -> tuple[server.ClassifierHandler, MagicMock]:
    """Construct a ``ClassifierHandler`` with a hand-rolled rfile/wfile so
    edge cases (negative Content-Length, rfile raises BrokenPipe) can be
    exercised without a real socket. http.server's BaseHTTPRequestHandler
    doesn't make this easy — we bypass __init__ and inject the attributes
    handle_one_request reads.
    """
    from http.client import HTTPMessage

    handler = server.ClassifierHandler.__new__(server.ClassifierHandler)
    handler.path = path
    handler.request_version = "HTTP/1.1"
    handler.command = "POST"
    handler.protocol_version = "HTTP/1.0"
    handler.server = MagicMock()
    handler.client_address = ("127.0.0.1", 0)
    handler.requestline = f"POST {path} HTTP/1.1"

    msg = HTTPMessage()
    for k, v in (headers or {}).items():
        msg[k] = v
    handler.headers = msg

    rfile = MagicMock()
    if rfile_read_side_effect is not None:
        rfile.read.side_effect = rfile_read_side_effect
    else:
        rfile.read.return_value = rfile_data
    handler.rfile = rfile

    wfile = MagicMock()
    handler.wfile = wfile
    return handler, wfile


def test_do_post_with_negative_content_length_returns_400() -> None:
    """``int("-5")`` parses fine — the guard at line 151 catches it.

    HTTP/1.1 doesn't really allow negative Content-Length, but the
    handler's defensive guard exists for the case a buggy client sends
    one. Drive directly because urllib + http.server would reject the
    header before our code ran.
    """
    handler, wfile = _make_handler_for_do_post(
        headers={"Content-Length": "-5"},
    )
    handler.do_POST()
    # The wfile got 'HTTP/1.0 400 ...' written followed by the body bytes.
    all_writes = b"".join(call.args[0] for call in wfile.write.call_args_list)
    assert b"400" in all_writes
    assert b"Content-Length must be a non-negative integer" in all_writes


def test_do_post_broken_pipe_during_rfile_read_returns_silently() -> None:
    """When the client disconnects mid-read, ``rfile.read`` raises
    BrokenPipeError. The handler must NOT crash and must NOT send a
    response (the socket is dead anyway).
    """
    handler, wfile = _make_handler_for_do_post(
        headers={"Content-Length": "100"},
        rfile_read_side_effect=BrokenPipeError("client gone"),
    )
    handler.do_POST()  # must not raise
    # No response sent — the function returned silently.
    wfile.write.assert_not_called()


def test_do_post_connection_reset_during_rfile_read_returns_silently() -> None:
    handler, wfile = _make_handler_for_do_post(
        headers={"Content-Length": "100"},
        rfile_read_side_effect=ConnectionResetError("RST"),
    )
    handler.do_POST()
    wfile.write.assert_not_called()


# ── log_message suppression ─────────────────────────────────────────────


def test_log_message_is_silenced(running_server, capsys) -> None:
    """A successful request must NOT emit the default stderr access log.

    The overridden ``log_message`` is a no-op; this asserts the override
    is actually wired up (a regression would print
    ``127.0.0.1 - - [...] "GET /health HTTP/1.1" 200 ...`` per request).
    """
    _httpd, base_url = running_server
    # Generate some traffic.
    for _ in range(3):
        _do_get(f"{base_url}/health")
    captured = capsys.readouterr()
    # The default BaseHTTPRequestHandler.log_message writes the access
    # line to stderr. Our override should keep stderr empty.
    assert "GET /health" not in captured.err
    assert "200" not in captured.err or "Traceback" in captured.err
