"""Checks that make a bad /metrics token visible.

Two of them: the boot-time report of a token that is too short
(`report_weak_secrets`) and the report of a failed check on a request
(`report_mismatch`). The comparison itself stays in `health.metrics`.

Neither report logs or sends a token, a presented credential, or the length of
either. A report names the variable, the client address and the reason only.

`init_sentry` sets the SDK's logging integration not to turn ERROR log records
into events, so a bare `log.error` reaches Railway's logs and not Sentry. Both
reports go through `sentry_setup.capture_message`, which writes the same ERROR
line and files the event.
"""

from __future__ import annotations

import time
from typing import Literal

from config import settings
from logger_setup import log
from sentry_setup import capture_message

# A secret set to fewer characters than this is reported at boot as too short.
MIN_SECRET_LEN = 32

# Why a /metrics request was refused: it sent no X-Metrics-Token header, or one
# that does not match. The closed set is the only text the report adds.
Reason = Literal["missing", "wrong"]

# Shortest gap between two failed-check ERRORs. Sentry opens an issue event for
# each, and a probe can fail the check on every request.
_ERROR_INTERVAL_S = 10 * 60

# When the last failed-check ERROR was filed (a `time.monotonic()` reading), or
# None while none has been. One value, so nothing taken from a request can grow
# it. `report_mismatch` runs on the event loop with no await in it, so the read
# and the write below can't interleave and no lock is needed.
_last_error_at: float | None = None


def weak_secret_names() -> list[str]:
    """Names of the secrets that are set but shorter than `MIN_SECRET_LEN`.

    An unset or empty secret is not listed: `/metrics` answers 401 for that and
    logs one warning per process, as it always has. Only the names are
    returned, never a value.
    """
    secrets = {"INTERNAL_METRICS_TOKEN": settings.internal_metrics_token}
    return [name for name, value in secrets.items() if 0 < len(value) < MIN_SECRET_LEN]


def report_weak_secrets() -> None:
    """Report, once at boot, each secret that is set but too short.

    Call it after `init_sentry`. It never raises and never stops the service
    from booting: a short token is a weak lock, not a broken one. The report
    names the variables only, never a value or any length.
    """
    weak = weak_secret_names()
    if weak:
        capture_message(
            "Configured secret shorter than the minimum: %s",
            level="error",
            params=(", ".join(weak),),
            tags={"component": "auth", "kind": "weak_secret"},
        )


def report_mismatch(client_ip: str, reason: Reason) -> None:
    """Report one refused /metrics request; call it where the route sends its 401.

    Every call logs one WARNING with the reason and the client. At most once per
    10 minutes it also files an ERROR (a log line and a Sentry event), so a burst
    of refused requests opens one issue and not one event per request.
    `client_ip` is only logged, never trusted, and goes in as an argument: the
    ERROR's template is constant, which is what Sentry groups on.

    The time is recorded before the ERROR goes out, so a reporter that throws
    costs that one call and no later one inside the window.
    """
    global _last_error_at
    log.warning("/metrics rejected: %s X-Metrics-Token header (client %s)", reason, client_ip)
    now = time.monotonic()
    if _last_error_at is not None and now - _last_error_at < _ERROR_INTERVAL_S:
        return
    _last_error_at = now
    capture_message(
        "Secret check failed on metrics (client %s)",
        level="error",
        params=(client_ip,),
        tags={"component": "auth", "kind": "secret_check_failed"},
        context={"reason": reason},
    )
