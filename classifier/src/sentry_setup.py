"""Sentry SDK initialization for the multileg classifier service.

Mirrors ``uw-stream/src/sentry_setup.py`` and ``sidecar/src/sentry_setup.py``
in shape: an idempotent ``init()`` callable at process start, a
``capture_exception`` helper safe to call even when Sentry is disabled,
and a default ``server_name=classifier`` tag so events from this
dedicated service can be filtered separately in the Sentry UI from the
sidecar (``server_name=api``) and uw-stream (``server_name=uw-stream``).

Service is intentionally minimal — no metrics, no breadcrumbs, no
custom ``before_send`` hook. Phase 2 may add queue-wait breadcrumbs
when the BoundedSemaphore lands; for now this module exists only to
forward exceptions out of ``handle_classify_payload``'s 500 branch.

No-op semantics: if ``SENTRY_DSN`` is empty or unset, ``init()`` does
nothing and ``capture_exception`` is a silent no-op. The service must
boot and serve requests even when Sentry is misconfigured — the
classifier is on the production scoring path and unavailable Sentry
must never block detect-cron callers.
"""

from __future__ import annotations

import os

_sentry_enabled = False


def init() -> None:
    """Initialize Sentry if SENTRY_DSN is set.

    Idempotent — safe to call multiple times; only the first call
    initializes. No-ops when SENTRY_DSN is unset or empty (local dev,
    misconfigured deploys).
    """
    global _sentry_enabled
    if _sentry_enabled:
        return

    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        # Silent return — local dev runs without a DSN and we don't want
        # log noise on every boot. Matches uw-stream's "no log spam" rule
        # adapted for a service that doesn't have a structured logger yet.
        return

    try:
        import sentry_sdk
    except ImportError:
        # sentry-sdk is in requirements.txt, so this branch is "can't
        # happen" outside a broken image; print + continue rather than
        # crash the service.
        print("sentry_setup: sentry_sdk not installed — Sentry disabled", flush=True)
        return

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=os.environ.get("RAILWAY_ENVIRONMENT", "production"),
            sample_rate=1.0,
            # traces_sample_rate=0: this service is request/response only;
            # the upstream Vercel Function already owns the trace span and
            # APM data here would just duplicate it. Error capture is the
            # only Sentry feature we need.
            traces_sample_rate=0.0,
            server_name="classifier",
            release=os.environ.get("RAILWAY_DEPLOYMENT_ID"),
        )
        # Set as a global tag too so legacy issue grouping picks it up
        # even on captures that didn't pass tags explicitly.
        sentry_sdk.set_tag("service", "classifier")
        _sentry_enabled = True
    except Exception as exc:
        print(f"sentry_setup: init failed: {exc}", flush=True)


def is_enabled() -> bool:
    """Return True if Sentry was successfully initialized."""
    return _sentry_enabled


def capture_exception(
    exc: BaseException,
    *,
    tags: dict[str, str] | None = None,
) -> None:
    """Report an exception to Sentry with optional tags.

    Silent no-op when Sentry is disabled — callers do not need to guard
    on ``is_enabled()`` before calling this. Tags are applied to a fresh
    scope so they don't leak into subsequent captures.
    """
    if not _sentry_enabled:
        return

    try:
        import sentry_sdk

        with sentry_sdk.new_scope() as scope:
            if tags:
                for key, value in tags.items():
                    scope.set_tag(key, value)
            sentry_sdk.capture_exception(exc)
    except Exception as inner:
        print(f"sentry_setup: capture_exception failed: {inner}", flush=True)
