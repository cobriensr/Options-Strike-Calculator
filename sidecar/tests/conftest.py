"""Fixtures for tests that need a real Sentry client.

The client is built from `init_sentry`'s own options but sends over an
in-memory transport, so nothing leaves the process and a test can read the bytes
the SDK would have put on the wire. The SDK is the real package: see the end of
the root `conftest.py`.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from contextlib import ExitStack
from typing import Any
from unittest.mock import patch

import pytest
import sentry_sdk
from sentry_sdk.envelope import Envelope
from sentry_sdk.transport import Transport

import sentry_setup

# A throwaway DSN on a reserved TLD, never a credential.
FAKE_DSN = "https://public@sentry.example.invalid/1"


class MemoryTransport(Transport):
    """Keeps each envelope item's wire bytes instead of sending them."""

    def __init__(self, options: dict[str, Any] | None = None) -> None:
        super().__init__(options)
        self.payloads: list[bytes] = []

    def capture_envelope(self, envelope: Envelope) -> None:
        self.payloads.extend(item.get_bytes() for item in envelope.items)

    def events(self) -> list[dict[str, Any]]:
        """Every event the client sent (sessions and check-ins carry no level)."""
        sentry_sdk.get_client().flush(timeout=5)
        return [e for e in map(json.loads, self.payloads) if "level" in e]


@pytest.fixture
def sentry_events(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[Callable[..., MemoryTransport]]:
    """A function that binds a real client to the test and returns its transport.

    The client takes `init_sentry`'s options, as captured from a patched
    `sentry_sdk.init`, with the default integrations on as in production.
    `without` names options to leave out, to show what the SDK sends without
    them. `init_sentry` also leaves `sentry_setup`'s enabled flag set for the
    test. The client is bound to its own isolation scope and closed afterwards.
    """
    monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
    monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)
    with patch.object(sentry_sdk, "init", autospec=True) as init:
        sentry_setup.init_sentry()
    init_options = dict(init.call_args.kwargs)

    with ExitStack() as stack:

        def bind(*, without: tuple[str, ...] = ()) -> MemoryTransport:
            options = {k: v for k, v in init_options.items() if k not in without}
            client = sentry_sdk.Client(transport=MemoryTransport, **options)
            stack.callback(client.close)
            scope = stack.enter_context(sentry_sdk.isolation_scope())
            scope.set_client(client)
            transport = client.transport
            assert isinstance(transport, MemoryTransport)
            return transport

        yield bind
