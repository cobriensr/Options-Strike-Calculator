"""Shared-secret checks for the sidecar's HTTP routes.

Every secret comparison goes through this module, so a route can't grow its
own compare block. The comparison runs on bytes: `hmac.compare_digest`
raises TypeError for a str with non-ASCII characters, and `http.server`
decodes header bytes as latin-1, so any client can hand a handler such a
str.
"""

from __future__ import annotations

import hmac
import os

# The Take-It SHAP secret is also the bearer on the /archive/* routes. The
# Vercel side holds the same value as SIDECAR_TAKEIT_SECRET.
SHARED_SECRET_ENV = "TAKEIT_SIDECAR_SHARED_SECRET"


def shared_secret() -> str:
    """The configured bearer secret; empty when unset."""
    return os.environ.get(SHARED_SECRET_ENV, "")


def _matches(got: str | None, expected: str) -> bool:
    if got is None:
        return False
    try:
        # latin-1 round-trips the exact bytes http.server decoded; a char
        # beyond it can't have come off the wire, so it can't match.
        got_bytes = got.encode("latin-1")
    except UnicodeEncodeError:
        return False
    return hmac.compare_digest(got_bytes, expected.encode())


def bearer_ok(header: str | None, secret: str) -> bool:
    """True when `header` is exactly `Bearer <secret>`.

    False for a missing header, and for an empty `secret`: an unconfigured
    secret must never authenticate `Bearer ` with nothing after it.
    """
    return bool(secret) and _matches(header, f"Bearer {secret}")


def token_ok(header: str | None, secret: str) -> bool:
    """True when `header` is exactly `secret` (a raw token header).

    False for a missing header and for an empty `secret`.
    """
    return bool(secret) and _matches(header, secret)
