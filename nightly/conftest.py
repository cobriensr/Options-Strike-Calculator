"""pytest setup.

Lives at the project root (not inside tests/) so it runs before any test
module is collected. Makes `src/` importable as top-level modules, matching
the production `PYTHONPATH=/app/src`, and gives every required env var a
default so `load_settings()` works unless a test removes one.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import sys
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

# Forced, not setdefault: a real exported credential must never reach a test.
os.environ["UW_API_KEY"] = "test-key"
os.environ["R2_ACCESS_KEY_ID"] = "test-access-key-id"
os.environ["R2_SECRET_ACCESS_KEY"] = "test-secret-access-key"
os.environ["R2_ENDPOINT_URL"] = "https://example.r2.cloudflarestorage.com"
os.environ["R2_BUCKET_FULLTAPE"] = "test-bucket"


def _is_loopback(address: object) -> bool:
    if not isinstance(address, tuple) or not address:
        return True  # AF_UNIX paths and the like
    host = address[0]
    if host in ("localhost", ""):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@pytest.fixture(autouse=True)
def _no_real_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail loudly on any non-loopback connection: tests use respx and moto only."""
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex

    def _guard(real):
        def wrapper(self, address):
            if not _is_loopback(address):
                raise RuntimeError("test attempted a real network connection")
            return real(self, address)

        return wrapper

    monkeypatch.setattr(socket.socket, "connect", _guard(real_connect))
    monkeypatch.setattr(socket.socket, "connect_ex", _guard(real_connect_ex))
