"""Tests for ``classifier.src.server``.

Exercises the HTTP plumbing: route dispatch, method validation,
Content-Length handling, body cap, ``Connection: close`` policy, log
suppression, concurrent /health probes, plus the Phase 1.5 hardening
fixes (SIGTERM-friendly class attrs, Slowloris timeout, smuggling
defenses, /version endpoint).

All tests use a server bound to an ephemeral port (``build_server(0)``)
started in a daemon thread. Stdlib ``urllib.request`` drives requests
to avoid adding ``httpx`` as a test dep (the classifier image stays
minimal).
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from unittest.mock import MagicMock, patch

import multileg_assembler
import pytest

import server

# ── Bearer auth: every test runs with the shared secret configured ──────

TEST_SECRET = "classifier-test-secret-1b9e"
AUTH = {"Authorization": f"Bearer {TEST_SECRET}"}
# Same header as a raw request line, for the hand-built socket requests.
AUTH_LINE = f"Authorization: Bearer {TEST_SECRET}\r\n"


@pytest.fixture(autouse=True)
def _shared_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure ``CLASSIFIER_SHARED_SECRET``; tests that need it unset
    call ``monkeypatch.delenv`` themselves. Also resets the
    once-per-process "secret missing" report so each test sees a fresh
    process.
    """
    monkeypatch.setenv("CLASSIFIER_SHARED_SECRET", TEST_SECRET)
    monkeypatch.setattr(server, "_secret_missing_reported", False, raising=False)


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


def _do_get(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 5.0,
) -> tuple[int, dict[str, str], bytes]:
    """GET + return (status, headers-as-dict-lower, body bytes)."""
    req = urllib.request.Request(url, method="GET", headers=headers or {})
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
    extra_headers: dict[str, str] | None = None,
    timeout: float = 10.0,
) -> tuple[int, dict[str, str], bytes]:
    """POST with optional Content-Length override (for the body-cap test)."""
    headers = {"Content-Type": content_type, **(extra_headers or {})}
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
            extra_headers=AUTH,
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
            extra_headers=AUTH,
        )

    assert status == 500
    assert headers["connection"] == "close"


# ── /multileg-classify body-size validation ─────────────────────────────


def test_post_multileg_classify_empty_body_returns_400(running_server) -> None:
    _httpd, base_url = running_server
    # urllib won't send a Content-Length: 0 for POST without data, so use
    # the raw socket helper. urllib actually sends 'Content-Length: 0'
    # when data is empty bytes; either way we get the path covered.
    status, headers, body = _do_post(f"{base_url}/multileg-classify", body=b"", extra_headers=AUTH)
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
        f"{AUTH_LINE}"
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
        f"{AUTH_LINE}"
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
        f"{AUTH_LINE}"
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
        f"{AUTH_LINE}"
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
    authorization: str | None = AUTH["Authorization"],
    rfile_read_side_effect: Exception | None = None,
    rfile_data: bytes = b"",
) -> tuple[server.ClassifierHandler, MagicMock]:
    """Construct a ``ClassifierHandler`` with a hand-rolled rfile/wfile so
    edge cases (negative Content-Length, rfile raises BrokenPipe) can be
    exercised without a real socket. http.server's BaseHTTPRequestHandler
    doesn't make this easy — we bypass __init__ and inject the attributes
    handle_one_request reads.

    Sends the valid bearer unless ``authorization`` overrides it (``None``
    omits the header).
    """
    if authorization is not None:
        headers = {"Authorization": authorization, **(headers or {})}
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


# ── Phase 1.5 hardening: class attributes ───────────────────────────────


def test_handler_has_30_second_socket_timeout() -> None:
    """Phase 1.5 fix 1.7 (Slowloris defense): the per-handler
    ``timeout`` class attribute must be 30 seconds.

    ``StreamRequestHandler.setup`` reads this attribute and installs it
    as ``self.connection.settimeout(...)`` on every accepted socket.
    Without it (default ``None``), a Slowloris-style attacker dripping
    one byte per minute can hold a worker thread indefinitely.
    """
    assert server.ClassifierHandler.timeout == 30


def test_quiet_server_has_block_on_close_false() -> None:
    """Phase 1.5 fix 2.6: ``server_close()`` must not block on
    in-flight worker threads.

    ``ThreadingHTTPServer`` defaults to ``block_on_close = True``, which
    in combination with a slow client could push shutdown past Railway's
    SIGKILL grace window. Setting it False makes shutdown return as soon
    as the listening socket is released; in-flight threads finish
    independently or get killed with the process.
    """
    assert server._QuietThreadingHTTPServer.block_on_close is False


# ── Phase 1.5 hardening: Transfer-Encoding / duplicate Content-Length ───


def test_chunked_transfer_encoding_returns_411(running_server) -> None:
    """Phase 1.5 fix 3.1: a ``Transfer-Encoding: chunked`` request must
    short-circuit to 411 Length Required (RFC 9110 §10.2.1).

    http.server doesn't auto-decode chunked, so without this guard the
    request would silently fail at the "empty body" 400 — misleading
    error for a TS-side streaming client.
    """
    _httpd, base_url = running_server
    host, port = "127.0.0.1", int(base_url.rsplit(":", 1)[1])
    # No Content-Length; one chunk of "hi" then terminator.
    raw = (
        f"POST /multileg-classify HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"{AUTH_LINE}"
        f"Content-Type: application/json\r\n"
        f"Transfer-Encoding: chunked\r\n"
        f"Connection: close\r\n"
        f"\r\n"
        f"2\r\nhi\r\n0\r\n\r\n"
    ).encode()
    response = _send_raw(host, port, raw, timeout=3.0)
    first_line = response.split(b"\r\n", 1)[0].decode()
    assert "411" in first_line, f"expected 411, got: {first_line!r}"
    assert b"Transfer-Encoding not supported" in response
    # 4xx → Connection: close header set.
    assert b"Connection: close" in response or b"connection: close" in response


def test_chunked_transfer_encoding_identity_value_also_returns_411(
    running_server,
) -> None:
    """Defense in depth: any ``Transfer-Encoding`` value (even the
    benign ``identity``) is rejected. We don't want to enumerate values
    the matcher's body reader does/doesn't understand; safer to require
    Content-Length framing exclusively.
    """
    _httpd, base_url = running_server
    host, port = "127.0.0.1", int(base_url.rsplit(":", 1)[1])
    raw = (
        f"POST /multileg-classify HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"{AUTH_LINE}"
        f"Content-Type: application/json\r\n"
        f"Transfer-Encoding: identity\r\n"
        f"Content-Length: 2\r\n"
        f"Connection: close\r\n"
        f"\r\n"
        f"{{}}"
    ).encode()
    response = _send_raw(host, port, raw, timeout=3.0)
    first_line = response.split(b"\r\n", 1)[0].decode()
    assert "411" in first_line, f"expected 411, got: {first_line!r}"


def test_duplicate_content_length_returns_400(running_server) -> None:
    """Phase 1.5 fix 3.2: two ``Content-Length`` headers is the classic
    HTTP smuggling pattern. Reject 400 + connection close before we
    even try to read a body.
    """
    _httpd, base_url = running_server
    host, port = "127.0.0.1", int(base_url.rsplit(":", 1)[1])
    body = b'{"trades": []}'
    raw = (
        f"POST /multileg-classify HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"{AUTH_LINE}"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Content-Length: {len(body) + 100}\r\n"
        f"Connection: close\r\n"
        f"\r\n"
    ).encode() + body
    response = _send_raw(host, port, raw, timeout=3.0)
    first_line = response.split(b"\r\n", 1)[0].decode()
    assert "400" in first_line, f"expected 400, got: {first_line!r}"
    assert b"duplicate Content-Length" in response


# ── Phase 1.5 hardening: GET /version ───────────────────────────────────


def test_get_version_returns_matcher_sha_and_patterns(running_server) -> None:
    """Phase 1.5 fix 2.2: ``/version`` exposes matcher_sha + release +
    patterns for cross-deploy drift detection by the TS client.

    Assertions:
      - matcher_sha is a 64-char lowercase hex sha256 of the actual
        vendored ``multileg_assembler.py`` file (not 'unknown' — the
        file MUST be readable in any healthy test environment).
      - patterns is the canonical 5-element list matching the TS
        MULTILEG_STRUCTURES enum.
      - release defaults to 'local' when RAILWAY_DEPLOYMENT_ID is unset.
    """
    _httpd, base_url = running_server
    status, headers, body = _do_get(f"{base_url}/version", headers=AUTH)
    assert status == 200
    assert headers["content-type"] == "application/json"

    data = json.loads(body)
    assert set(data.keys()) == {"matcher_sha", "release", "patterns"}

    # matcher_sha is the sha256 of the imported multileg_assembler file.
    expected_path = multileg_assembler.__file__
    assert expected_path is not None
    with open(expected_path, "rb") as fh:
        expected_sha = hashlib.sha256(fh.read()).hexdigest()
    assert data["matcher_sha"] == expected_sha
    assert len(data["matcher_sha"]) == 64

    # release: either a real RAILWAY_DEPLOYMENT_ID or 'local'.
    expected_release = os.environ.get("RAILWAY_DEPLOYMENT_ID", "local")
    assert data["release"] == expected_release

    # patterns: canonical list mirroring TS MULTILEG_STRUCTURES.
    assert data["patterns"] == [
        "isolated_leg",
        "vertical",
        "strangle",
        "risk_reversal",
        "butterfly",
    ]

    # 2xx keeps keep-alive (no explicit close header).
    assert "connection" not in headers or headers["connection"].lower() != "close"


def test_get_version_caches_matcher_sha(running_server) -> None:
    """Phase 1.5 fix 2.2: matcher_sha is computed lazily on first call
    and cached at module level — subsequent /version calls should not
    re-hash the file (the file never mutates after image boot).
    """
    _httpd, base_url = running_server
    # Force the cache populated.
    _do_get(f"{base_url}/version", headers=AUTH)
    # Now intercept the compute helper and verify it isn't called again.
    with patch.object(server, "_compute_matcher_sha") as mock_compute:
        status, _, body = _do_get(f"{base_url}/version", headers=AUTH)
    assert status == 200
    assert mock_compute.call_count == 0
    # And the cached value is still the real sha.
    data = json.loads(body)
    assert len(data["matcher_sha"]) == 64
    assert data["matcher_sha"] != "unknown"


def test_post_to_version_returns_405_with_allow_get(running_server) -> None:
    """``/version`` is GET-only. POST should 405 with Allow: GET, mirroring
    the POST /health response shape so a TS-client author hitting the
    wrong verb gets a consistent diagnostic on either endpoint.
    """
    _httpd, base_url = running_server
    status, headers, body = _do_post(f"{base_url}/version", body=b"{}")
    assert status == 405
    assert headers["allow"] == "GET"
    assert headers["connection"] == "close"
    assert json.loads(body) == {"error": "method not allowed"}


def test_compute_matcher_sha_returns_unknown_on_read_error() -> None:
    """``_compute_matcher_sha`` must never raise — a missing / unreadable
    matcher file falls back to 'unknown' so /version can't crash.
    """
    with patch("builtins.open", side_effect=OSError("disk gone")):
        result = server._compute_matcher_sha()
    assert result == "unknown"


def test_compute_matcher_sha_returns_unknown_when_module_file_is_none() -> None:
    """Defensive: ``__file__`` can be None for namespace packages. Verify
    the function doesn't choke on that edge case.
    """
    with patch.object(multileg_assembler, "__file__", None):
        result = server._compute_matcher_sha()
    assert result == "unknown"


# ── Phase 1.5 hardening: socket.timeout handling in do_POST ─────────────


def test_do_post_socket_timeout_during_read_returns_408() -> None:
    """When ``rfile.read`` raises ``socket.timeout`` (Slowloris-style
    slow client hit the 30s handler timeout), respond 408 Request
    Timeout with Connection: close.
    """
    handler, wfile = _make_handler_for_do_post(
        headers={"Content-Length": "100"},
        rfile_read_side_effect=TimeoutError("slow client"),
    )
    handler.do_POST()
    all_writes = b"".join(call.args[0] for call in wfile.write.call_args_list)
    assert b"408" in all_writes
    assert b"request timeout" in all_writes
    assert b"Connection: close" in all_writes or b"connection: close" in all_writes


def test_do_post_socket_timeout_emits_sentry_breadcrumb_when_enabled() -> None:
    """Verify the timeout path adds a Sentry breadcrumb so we can see in
    the soak whether 30s is too tight.
    """
    handler, _wfile = _make_handler_for_do_post(
        headers={"Content-Length": "100"},
        rfile_read_side_effect=TimeoutError("slow"),
    )
    with (
        patch.object(server.sentry_setup, "is_enabled", return_value=True),
        patch("sentry_sdk.add_breadcrumb") as mock_breadcrumb,
    ):
        handler.do_POST()
    assert mock_breadcrumb.called
    kwargs = mock_breadcrumb.call_args.kwargs
    assert kwargs.get("category") == "classifier.http"
    assert "Slowloris" in kwargs.get("message", "")
    assert kwargs.get("data", {}).get("timeout_seconds") == 30


def test_do_post_socket_timeout_swallows_write_errors() -> None:
    """If the client socket is also dead when we try to write the 408,
    the BrokenPipeError must be swallowed so we don't crash the worker
    thread.
    """
    handler, wfile = _make_handler_for_do_post(
        headers={"Content-Length": "100"},
        rfile_read_side_effect=TimeoutError("slow"),
    )
    wfile.write.side_effect = BrokenPipeError("client gone too")
    # Must not raise.
    handler.do_POST()


def test_do_post_socket_timeout_swallows_breadcrumb_failure() -> None:
    """If ``sentry_sdk.add_breadcrumb`` raises (SDK partially torn
    down, mocked weirdly in a test), the inner ``except Exception`` must
    keep the 408 response path intact.
    """
    handler, wfile = _make_handler_for_do_post(
        headers={"Content-Length": "100"},
        rfile_read_side_effect=TimeoutError("slow"),
    )
    with (
        patch.object(server.sentry_setup, "is_enabled", return_value=True),
        patch("sentry_sdk.add_breadcrumb", side_effect=RuntimeError("sdk wedged")),
    ):
        handler.do_POST()  # must not raise
    all_writes = b"".join(call.args[0] for call in wfile.write.call_args_list)
    # 408 still emitted despite the breadcrumb failure.
    assert b"408" in all_writes
    assert b"request timeout" in all_writes


# ── Bearer auth (CLASSIFIER_SHARED_SECRET) ──────────────────────────────


_SMALL_BODY = b'{"trades": []}'
# About the size of a peak-window payload (~1-4 MB), where a server that
# answers without reading the body loses the response to a TCP reset.
_LARGE_BODY = b'{"trades": [], "pad": "' + b"x" * (3 * 1024 * 1024) + b'"}'


def _post_classify(
    host: str,
    port: int,
    auth_line: bytes,
    body: bytes = _SMALL_BODY,
    *,
    pause_before_body: float = 0.0,
    timeout: float = 5.0,
) -> bytes:
    """POST /multileg-classify with the whole body; return what came back.

    ``pause_before_body`` sends the headers, waits, then sends the body,
    the way a streaming client (undici, an edge proxy) is still uploading
    when an early response arrives. A send or receive error (the reset a
    client gets when the server closes with the body unread) ends the
    exchange and returns the bytes read so far, so a lost response fails
    an assertion instead of erroring.
    """
    head = (
        b"POST /multileg-classify HTTP/1.1\r\n"
        + f"Host: {host}:{port}\r\n".encode()
        + b"Content-Type: application/json\r\n"
        + auth_line
        + f"Content-Length: {len(body)}\r\n".encode()
        + b"Connection: close\r\n"
        + b"\r\n"
    )
    chunks: list[bytes] = []
    with socket.create_connection((host, port), timeout=timeout) as sock:
        try:
            sock.sendall(head)
            if pause_before_body:
                time.sleep(pause_before_body)
            sock.sendall(body)
            while chunk := sock.recv(65536):
                chunks.append(chunk)
        except OSError:
            pass
    return b"".join(chunks)


def _split_response(response: bytes) -> tuple[str, bytes, Any]:
    """Return (status line, raw header block, parsed JSON body)."""
    head, _, body = response.partition(b"\r\n\r\n")
    status_line = head.split(b"\r\n", 1)[0].decode()
    return status_line, head, json.loads(body) if body else None


def _host_port(base_url: str) -> tuple[str, int]:
    return "127.0.0.1", int(base_url.rsplit(":", 1)[1])


def test_classify_without_authorization_returns_401(
    running_server,
) -> None:
    _httpd, base_url = running_server
    host, port = _host_port(base_url)
    with patch.object(server, "handle_classify_payload") as mock_handle:
        response = _post_classify(host, port, b"")
    status_line, head, body = _split_response(response)
    assert "401" in status_line, f"expected 401, got: {status_line!r}"
    assert body == {"error": "unauthorized"}
    assert b"Connection: close" in head
    mock_handle.assert_not_called()


@pytest.mark.parametrize(
    "auth_line",
    [
        pytest.param(b"Authorization: Bearer wrong-secret\r\n", id="wrong-secret"),
        pytest.param(f"Authorization: {TEST_SECRET}\r\n".encode(), id="no-bearer-scheme"),
        pytest.param(f"Authorization: Bearer {TEST_SECRET}x\r\n".encode(), id="secret-plus-suffix"),
        pytest.param(f"Authorization: Bearer {TEST_SECRET[:-1]}\r\n".encode(), id="secret-prefix"),
        pytest.param(b"Authorization: \r\n", id="empty-value"),
    ],
)
def test_classify_with_wrong_authorization_returns_401(running_server, auth_line: bytes) -> None:
    _httpd, base_url = running_server
    host, port = _host_port(base_url)
    with patch.object(server, "handle_classify_payload") as mock_handle:
        response = _post_classify(host, port, auth_line)
    status_line, _head, body = _split_response(response)
    assert "401" in status_line, f"expected 401, got: {status_line!r}"
    assert body == {"error": "unauthorized"}
    mock_handle.assert_not_called()


def test_classify_with_non_ascii_authorization_returns_401_not_500(running_server) -> None:
    """Raw non-ASCII header bytes must be a plain 401. A str
    ``hmac.compare_digest`` raises TypeError on non-ASCII, which would kill
    the handler thread and drop the connection with no response.
    """
    _httpd, base_url = running_server
    host, port = _host_port(base_url)
    junk = b"Authorization: Bearer \xc3\xa9\xff\xfe\r\n"
    with patch.object(server, "handle_classify_payload") as mock_handle:
        response = _post_classify(host, port, junk)
    status_line, _head, body = _split_response(response)
    assert "401" in status_line, f"expected 401, got: {status_line!r}"
    assert body == {"error": "unauthorized"}
    mock_handle.assert_not_called()


def test_do_post_non_ascii_authorization_str_returns_401() -> None:
    """Same contract without a socket: a non-ASCII ``str`` header value
    (what the handler sees after http.server decodes the header) is a 401.
    """
    handler, wfile = _make_handler_for_do_post(
        headers={"Content-Length": "100"},
        authorization="Bearer é€-unicode",
    )
    with patch.object(server, "handle_classify_payload") as mock_handle:
        handler.do_POST()
    all_writes = b"".join(call.args[0] for call in wfile.write.call_args_list)
    assert b"401" in all_writes
    assert b"unauthorized" in all_writes
    mock_handle.assert_not_called()


@pytest.mark.parametrize(
    "framing",
    [
        pytest.param(f"Content-Length: {60 * 1024 * 1024}\r\n", id="oversize-not-413"),
        pytest.param(
            f"Content-Length: {server._MAX_BODY_BYTES // 2}\r\n", id="over-drain-cap-under-body-cap"
        ),
        pytest.param("Transfer-Encoding: chunked\r\n", id="chunked-not-411"),
        pytest.param("Content-Length: 14\r\nContent-Length: 114\r\n", id="duplicate-cl-not-400"),
    ],
)
def test_auth_runs_before_body_framing_checks(running_server, framing: str) -> None:
    """An unauthenticated request gets 401 before the framing checks, and
    without draining: no body is sent here, so a server that waited for
    one would block until this client times out and gets nothing.
    """
    _httpd, base_url = running_server
    host, port = _host_port(base_url)
    raw = (
        f"POST /multileg-classify HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Content-Type: application/json\r\n"
        f"{framing}"
        f"Connection: close\r\n"
        f"\r\n"
    ).encode()
    status_line, _head, body = _split_response(_send_raw(host, port, raw, timeout=3.0))
    assert "401" in status_line, f"expected 401, got: {status_line!r}"
    assert body == {"error": "unauthorized"}


# ── Auth failure drains a bounded body so the rejection is readable ─────


def test_wrong_bearer_with_large_body_gets_readable_401(running_server) -> None:
    """A ~3 MB body with the wrong bearer gets a 401 the client can read,
    every time. Answering with the body unread lets the close reset the
    connection, and the client sees a network error instead.
    """
    _httpd, base_url = running_server
    host, port = _host_port(base_url)
    with patch.object(server, "handle_classify_payload") as mock_handle:
        for attempt in range(5):
            response = _post_classify(
                host,
                port,
                b"Authorization: Bearer wrong-secret\r\n",
                _LARGE_BODY,
                pause_before_body=0.3,
            )
            status_line, head, body = _split_response(response)
            assert "401" in status_line, f"attempt {attempt}: got {status_line!r}"
            assert body == {"error": "unauthorized"}
            assert b"Connection: close" in head
    mock_handle.assert_not_called()


def test_secret_unset_with_large_body_gets_readable_503(
    running_server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("CLASSIFIER_SHARED_SECRET")
    _httpd, base_url = running_server
    host, port = _host_port(base_url)
    for attempt in range(3):
        response = _post_classify(
            host, port, AUTH_LINE.encode(), _LARGE_BODY, pause_before_body=0.3
        )
        status_line, _head, body = _split_response(response)
        assert "503" in status_line, f"attempt {attempt}: got {status_line!r}"
        assert body == {"error": "CLASSIFIER_SHARED_SECRET not configured"}


def _chunk_recording_rfile(handler: server.ClassifierHandler) -> list[int]:
    """Make ``handler.rfile.read(n)`` return ``n`` bytes; record each ``n``."""
    sizes: list[int] = []

    def _read(n: int) -> bytes:
        sizes.append(n)
        return b"x" * n

    handler.rfile.read.side_effect = _read
    return sizes


def test_auth_failure_drains_body_in_bounded_chunks() -> None:
    """The drain reads the declared length in chunks of at most
    ``_AUTH_FAIL_DRAIN_CHUNK`` and never asks for the whole body at once,
    so peak memory is one chunk. The 401 goes out after the drain.
    """
    chunk = server._AUTH_FAIL_DRAIN_CHUNK
    content_length = 3 * chunk + 5
    handler, wfile = _make_handler_for_do_post(
        headers={"Content-Length": str(content_length)},
        authorization="Bearer wrong-secret",
    )
    sizes = _chunk_recording_rfile(handler)
    with patch.object(server, "handle_classify_payload") as mock_handle:
        handler.do_POST()
    assert sum(sizes) == content_length
    assert max(sizes) <= chunk
    assert len(sizes) == 4
    all_writes = b"".join(call.args[0] for call in wfile.write.call_args_list)
    assert b"401" in all_writes
    mock_handle.assert_not_called()


def test_secret_unset_drains_body_too(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CLASSIFIER_SHARED_SECRET")
    handler, wfile = _make_handler_for_do_post(headers={"Content-Length": "1000"})
    sizes = _chunk_recording_rfile(handler)
    handler.do_POST()
    assert sum(sizes) == 1000
    all_writes = b"".join(call.args[0] for call in wfile.write.call_args_list)
    assert b"503" in all_writes


@pytest.mark.parametrize(
    "headers",
    [
        # Resolved in the test body, so the cap is read at run time.
        pytest.param({"Content-Length": "<cap + 1>"}, id="over-drain-cap"),
        pytest.param({}, id="no-content-length"),
        pytest.param({"Content-Length": "abc"}, id="invalid-content-length"),
        pytest.param({"Content-Length": "-5"}, id="negative-content-length"),
        pytest.param({"Transfer-Encoding": "chunked", "Content-Length": "100"}, id="chunked"),
    ],
)
def test_auth_failure_skips_drain_without_a_usable_length(headers: dict[str, str]) -> None:
    """Missing, invalid, chunked or over-cap framing: answer and close
    without reading anything."""
    if headers.get("Content-Length") == "<cap + 1>":
        headers = {"Content-Length": str(server._AUTH_FAIL_DRAIN_MAX + 1)}
    handler, wfile = _make_handler_for_do_post(headers=headers, authorization="Bearer wrong-secret")
    handler.do_POST()
    handler.rfile.read.assert_not_called()
    all_writes = b"".join(call.args[0] for call in wfile.write.call_args_list)
    assert b"401" in all_writes


def test_auth_failure_skips_drain_on_duplicate_content_length() -> None:
    handler, wfile = _make_handler_for_do_post(authorization="Bearer wrong-secret")
    handler.headers["Content-Length"] = "14"
    handler.headers["Content-Length"] = "114"
    handler.do_POST()
    handler.rfile.read.assert_not_called()
    assert b"401" in b"".join(call.args[0] for call in wfile.write.call_args_list)


def test_auth_failure_drain_stops_at_eof() -> None:
    """A client that closes early ends the drain; no spin on empty reads."""
    handler, wfile = _make_handler_for_do_post(
        headers={"Content-Length": "100000"},
        authorization="Bearer wrong-secret",
        rfile_data=b"",
    )
    handler.do_POST()
    assert handler.rfile.read.call_count == 1
    assert b"401" in b"".join(call.args[0] for call in wfile.write.call_args_list)


@pytest.mark.parametrize(
    "read_error",
    [TimeoutError("slow"), ConnectionResetError("RST"), BrokenPipeError("gone")],
    ids=["timeout", "reset", "broken-pipe"],
)
def test_auth_failure_drain_survives_socket_errors(read_error: OSError) -> None:
    """A drain that times out or loses the socket still tries the 401 and
    never raises out of the handler thread."""
    handler, wfile = _make_handler_for_do_post(
        headers={"Content-Length": "1000"},
        authorization="Bearer wrong-secret",
        rfile_read_side_effect=read_error,
    )
    handler.do_POST()  # must not raise
    assert b"401" in b"".join(call.args[0] for call in wfile.write.call_args_list)


def test_auth_failure_response_write_errors_are_swallowed() -> None:
    handler, wfile = _make_handler_for_do_post(
        headers={"Content-Length": "10"},
        authorization="Bearer wrong-secret",
        rfile_data=b"x" * 10,
    )
    wfile.write.side_effect = BrokenPipeError("client gone")
    handler.do_POST()  # must not raise


@pytest.mark.parametrize("secret", [None, "   "], ids=["unset", "whitespace"])
def test_classify_with_secret_unset_returns_503(
    running_server, monkeypatch: pytest.MonkeyPatch, secret: str | None
) -> None:
    if secret is None:
        monkeypatch.delenv("CLASSIFIER_SHARED_SECRET")
    else:
        monkeypatch.setenv("CLASSIFIER_SHARED_SECRET", secret)
    _httpd, base_url = running_server
    host, port = _host_port(base_url)
    with patch.object(server, "handle_classify_payload") as mock_handle:
        response = _post_classify(host, port, AUTH_LINE.encode())
    status_line, head, body = _split_response(response)
    assert "503" in status_line, f"expected 503, got: {status_line!r}"
    assert body == {"error": "CLASSIFIER_SHARED_SECRET not configured"}
    assert b"Connection: close" in head
    mock_handle.assert_not_called()


def test_secret_unset_reports_to_sentry_once_per_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The misconfiguration is named on the service that has it, once per
    process (the detect crons call every minute)."""
    monkeypatch.delenv("CLASSIFIER_SHARED_SECRET")
    with patch.object(server.sentry_setup, "capture_message") as mock_capture:
        for _ in range(3):
            handler, wfile = _make_handler_for_do_post(headers={"Content-Length": "100"})
            handler.do_POST()
            writes = b"".join(call.args[0] for call in wfile.write.call_args_list)
            assert b"503" in writes
    mock_capture.assert_called_once_with(
        "classifier.auth.secret_missing",
        level="error",
        extra={"env_var": "CLASSIFIER_SHARED_SECRET"},
    )


@pytest.mark.parametrize("secret_set", [True, False], ids=["secret-set", "secret-unset"])
def test_health_needs_no_authorization(
    running_server, monkeypatch: pytest.MonkeyPatch, secret_set: bool
) -> None:
    """Railway's healthcheck sends no header; /health must stay 200 even
    while the secret is missing, so a misconfigured deploy still boots."""
    if not secret_set:
        monkeypatch.delenv("CLASSIFIER_SHARED_SECRET")
    _httpd, base_url = running_server
    status, _headers, body = _do_get(f"{base_url}/health")
    assert status == 200
    assert json.loads(body) == {"status": "ok"}


@pytest.mark.parametrize(
    "headers",
    [
        pytest.param({}, id="no-header"),
        pytest.param({"Authorization": "Bearer wrong-secret"}, id="wrong-secret"),
    ],
)
def test_get_version_requires_authorization(running_server, headers: dict[str, str]) -> None:
    _httpd, base_url = running_server
    status, resp_headers, body = _do_get(f"{base_url}/version", headers=headers)
    assert status == 401
    assert resp_headers["connection"] == "close"
    assert json.loads(body) == {"error": "unauthorized"}


def test_get_version_with_secret_unset_returns_503(
    running_server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("CLASSIFIER_SHARED_SECRET")
    _httpd, base_url = running_server
    status, _headers, body = _do_get(f"{base_url}/version", headers=AUTH)
    assert status == 503
    assert json.loads(body) == {"error": "CLASSIFIER_SHARED_SECRET not configured"}
