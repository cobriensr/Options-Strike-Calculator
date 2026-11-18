"""Shared-secret checks for the sidecar's HTTP routes.

Every secret comparison goes through this module, so a route can't grow its
own compare block. The comparison runs on bytes: `hmac.compare_digest`
raises TypeError for a str with non-ASCII characters, and `http.server`
decodes header bytes as latin-1, so any client can hand a handler such a
str.

It also holds the two checks that make a bad secret visible: the boot-time
list of secrets that are too short (`weak_secret_names`) and the report of a
failed check (`report_mismatch`). Neither one logs a secret, a presented
credential, or the length of either.
"""

from __future__ import annotations

import hmac
import os
import threading
import time
from typing import Literal

from logger_setup import log
from sentry_setup import event_tags

# The Take-It SHAP secret is also the bearer on the /archive/* routes. The
# Vercel side holds the same value as SIDECAR_TAKEIT_SECRET.
SHARED_SECRET_ENV = "TAKEIT_SIDECAR_SHARED_SECRET"

# The token the X-Admin-Token header of POST /admin/seed-archive must match.
SEED_TOKEN_ENV = "ARCHIVE_SEED_TOKEN"

# A secret set to fewer characters than this is logged at boot as too weak.
MIN_SECRET_LEN = 32

# The routes that check a secret and report a failure.
Surface = Literal["archive", "takeit-explain", "seed"]

# Why a check failed: the request sent no credential (no header, or an empty
# one), or sent one that does not match. The closed set is the only text the
# report adds, and it is the `reason` tag on the Sentry event.
Reason = Literal["missing", "wrong"]

# The surfaces are the only keys of the throttle below, so nothing taken from a
# request can grow it.
SURFACES: tuple[Surface, ...] = ("archive", "takeit-explain", "seed")

# Shortest gap between two ERROR logs for one surface. Sentry turns every
# ERROR log into an event, and a misconfigured caller can fail the check on
# every request.
_ERROR_INTERVAL_S = 10 * 60

# When each surface last logged its ERROR (a `time.monotonic()` reading), or
# None while it has not. Fixed keys, written under the lock.
_last_error_at: dict[str, float | None] = dict.fromkeys(SURFACES)
_throttle_lock = threading.Lock()


def shared_secret() -> str:
    """The configured bearer secret; empty when unset."""
    return os.environ.get(SHARED_SECRET_ENV, "")


def seed_token() -> str:
    """The configured seed token; empty when unset."""
    return os.environ.get(SEED_TOKEN_ENV, "")


def weak_secret_names() -> list[str]:
    """Names of the secrets that are set but shorter than `MIN_SECRET_LEN`.

    An unset or empty secret is not listed: the routes answer 503 or 401 for
    that and say so themselves. Only the names are returned, never a value.
    """
    secrets = {SHARED_SECRET_ENV: shared_secret(), SEED_TOKEN_ENV: seed_token()}
    return [name for name, value in secrets.items() if 0 < len(value) < MIN_SECRET_LEN]


def mismatch_reason(presented: str | None) -> Reason:
    """`missing` when the request sent no credential, `wrong` when it sent one.

    `presented` is the credential header's value, as `http.server` gives it:
    None for no header. An empty header counts as none sent. Only the closed
    result is reported, never the value.
    """
    return "wrong" if presented else "missing"


def report_mismatch(surface: Surface, client_ip: str, reason: Reason) -> None:
    """Log one failed secret check; call it where the route sends its 401.

    Every call logs one WARNING with the surface, the reason and the client.
    At most once per surface per 10 minutes it also logs an ERROR, which Sentry
    turns into an event tagged `reason`, so a burst of failed requests opens
    one issue per surface and not one event per request. `client_ip` is only
    logged, never trusted. A surface outside `SURFACES` gets the WARNING and no
    ERROR, which keeps the throttle's keys fixed.

    The time is recorded before the ERROR goes out, so a log sink that throws
    costs that one call and no later one inside the window.
    """
    log.warning(
        "%s secret check failed (reason %s, client %s)", surface, reason, client_ip
    )
    with _throttle_lock:
        if surface not in _last_error_at:
            return
        last = _last_error_at[surface]
        now = time.monotonic()
        if last is not None and now - last < _ERROR_INTERVAL_S:
            return
        _last_error_at[surface] = now
    # The surface is part of the template: Sentry groups a logged event by its
    # unformatted message, so each surface opens its own issue, as the Vercel
    # side's fingerprint does. The client address stays a parameter. The
    # reason is a tag, as on the other two services, set on a scope that ends
    # with this block so no later event carries it.
    with event_tags({"reason": reason}):
        # The Sentry alert rule "Auth: wrong secret, short secret or guest-key
        # limit" matches messages that start with this text; reword it and
        # update the rule.
        log.error(f"Secret check failed on {surface} (client %s)", client_ip)


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
