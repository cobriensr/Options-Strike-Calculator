"""Notify Vercel that an interval B/A alert has fired.

Posts the alert payload to ``/api/push/notify`` with the shared
``INTERNAL_NOTIFY_SECRET`` header. Vercel reads ``push_subscriptions``
and fans out the Web Push notification(s) to all the owner's devices.

This module is fire-and-forget on the daemon side:

- Network failures and 5xx responses log a Sentry message but never
  raise into the caller (the handler flushed the alert to Postgres
  successfully; the user can still see it via /api/interval-ba-alerts
  polling even if the push fan-out failed).
- The hot path stays free of crypto, web-push SDK, or VAPID concerns —
  that all lives on Vercel where the Node ``web-push`` SDK runs.

Configured via env vars on Railway:

  VERCEL_NOTIFY_URL        — e.g. https://<app>/api/push/notify
  INTERNAL_NOTIFY_SECRET   — shared with Vercel's same-named env var

Both default to empty, in which case ``notify_alert`` no-ops silently.
This matches the Phase 1 ``interval_ba_enabled=False`` pattern — push
fan-out stays dormant until the operator wires up both endpoints.

Spec: docs/superpowers/specs/interval-ba-push-v2-2026-05-12.md (Phase 4d).
"""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp

from config import settings
from logger_setup import log
from sentry_setup import capture_exception, capture_message

# Total request budget. The push fan-out itself can take 200-500ms;
# 2 seconds gives plenty of headroom while keeping the daemon
# responsive to backpressure if Vercel is slow.
_TIMEOUT_S = 2.0

_SECRET_HEADER = "x-internal-notify-secret"

# Module-level strong refs for fire-and-forget tasks. Python's garbage
# collector will cancel a Task whose only reference is local — see
# https://docs.python.org/3/library/asyncio-task.html#asyncio.create_task.
# `schedule_notify` adds each new task here and the done callback
# removes it, so the set stays bounded by in-flight notifications.
_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()

# Sentry de-dup: one event per distinct failure mode per process. Without
# this, a misconfigured INTERNAL_NOTIFY_SECRET on Vercel produces one
# Sentry event per alert (59 events / 1d on 2026-05-14 → Escalating
# trend) when the issue is really a single config mismatch. Reset on
# every process start so a redeploy re-arms the alert.
_SENTRY_SEEN: set[str] = set()


def _should_report(key: str) -> bool:
    """Return True on first occurrence of `key`, False thereafter.

    Keyed on a stable failure-mode string (e.g. ``"status:401"`` or
    ``"exc:ClientConnectorError"``) so each distinct mode still pages
    once per process. Use sparingly — only on fire-and-forget paths
    where the daemon log already captures every occurrence.
    """
    if key in _SENTRY_SEEN:
        return False
    _SENTRY_SEEN.add(key)
    return True


def schedule_notify(payload: dict[str, Any]) -> None:
    """Fire-and-forget schedule of `notify_alert(payload)`.

    Holds a strong reference to the task so it can't be GC'd before
    the HTTP request finishes. Use this from the handler hot path
    instead of bare ``asyncio.create_task(notify_alert(...))``.
    """
    task = asyncio.create_task(notify_alert(payload))
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


async def notify_alert(payload: dict[str, Any]) -> None:
    """POST ``payload`` to the Vercel notify endpoint. Fire-and-forget.

    The payload shape MUST match ``pushNotifySchema`` in
    ``api/_lib/validation/common.ts`` — ``title`` and ``body`` are
    required, ``tag`` / ``requireInteraction`` / ``url`` optional.
    """
    url = settings.vercel_notify_url
    secret = settings.internal_notify_secret
    if not url or not secret:
        # v2 dormant — wired but not yet activated. No log noise on the
        # hot path; the operator sees the dormant state by inspecting
        # the env-vars on Railway.
        return

    try:
        timeout = aiohttp.ClientTimeout(total=_TIMEOUT_S)
        async with (
            aiohttp.ClientSession(timeout=timeout) as session,
            session.post(
                url,
                json=payload,
                headers={_SECRET_HEADER: secret},
            ) as resp,
        ):
            if resp.status >= 400:
                body_text = await resp.text()
                log.warning(
                    "vercel notify rejected push",
                    extra={
                        "status": resp.status,
                        "body": body_text[:300],
                        "title": payload.get("title"),
                    },
                )
                if _should_report(f"status:{resp.status}"):
                    capture_message(
                        "vercel notify rejected push",
                        level="warning",
                        tags={
                            "component": "notify",
                            "status": str(resp.status),
                        },
                        context={"title": payload.get("title")},
                    )
    except Exception as exc:
        # AbortError / ClientConnectorError / generic network — Sentry
        # the first occurrence per process, then swallow. The handler
        # path that called us already flushed to Postgres successfully.
        log.warning(
            "vercel notify call failed",
            extra={"err": str(exc), "title": payload.get("title")},
        )
        if _should_report(f"exc:{type(exc).__name__}"):
            capture_exception(
                exc,
                tags={"component": "notify"},
                context={"url": url, "title": payload.get("title")},
            )


def build_payload(
    alert_row: tuple,
    columns: list[str],
    *,
    confluence_only: bool = False,
) -> dict[str, Any] | None:
    """Build a push-notify payload from an interval_ba_alerts row tuple.

    Title and body shapes mirror the frontend formatters in
    ``src/hooks/useIntervalBAAlerts.ts``:

      title  → "SPXW 7360C 71% ASK"           (solo)
              "SPXW 7360C 71% ASK +SPY"        (one partner)
              "SPXW 7360C 71% ASK +SPY +QQQ"   (two partners)
      body   → "$1.33M premium / 5 trades — top: $408K sweep"

    The frontend can re-derive richer detail from the alert row on click
    (the URL field points back into the app).

    ``confluence_only`` toggles the Phase 4 push-volume gate: when True,
    alerts without any cross-symbol partner return ``None`` so the
    caller skips the Web Push fan-out (the in-app feed still shows them
    because the DB write is unaffected). Default False preserves the
    pre-Phase-4 behavior — every alert produces a payload.
    """
    idx = {name: i for i, name in enumerate(columns)}
    confluence_tickers = (
        alert_row[idx["confluence_tickers"]]
        if "confluence_tickers" in idx
        else None
    )
    # Normalize to a sorted list — None and empty both mean "solo".
    partners: list[str] = sorted(confluence_tickers) if confluence_tickers else []

    if confluence_only and not partners:
        return None

    chain: str = alert_row[idx["option_chain"]]
    ticker: str = alert_row[idx["ticker"]]
    option_type: str = alert_row[idx["option_type"]]
    strike = alert_row[idx["strike"]]
    ratio_pct = alert_row[idx["ratio_pct"]]
    total_premium = alert_row[idx["total_premium"]]
    trade_count: int = alert_row[idx["trade_count"]]
    top_trade_premium = alert_row[idx["top_trade_premium"]]
    top_trade_is_sweep = alert_row[idx["top_trade_is_sweep"]]
    top_trade_is_floor = alert_row[idx["top_trade_is_floor"]]

    strike_str = (
        str(int(strike)) if float(strike) == int(strike) else f"{float(strike):.0f}"
    )
    title = f"{ticker} {strike_str}{option_type} {float(ratio_pct):.0f}% ASK"
    if partners:
        # Suffix the partner tickers so the lock-screen / notification-
        # tray glance carries the confluence signal. "+SPY" / "+SPY +QQQ".
        title += " " + " ".join(f"+{t}" for t in partners)
    body = _format_body(
        total_premium=float(total_premium),
        trade_count=trade_count,
        top_trade_premium=top_trade_premium,
        top_trade_is_sweep=top_trade_is_sweep,
        top_trade_is_floor=top_trade_is_floor,
    )

    # Severity derived from total premium — must match the server-side
    # mapping in api/interval-ba-alerts.ts deriveSeverity().
    if float(total_premium) >= 1_000_000:
        severity = "extreme"
    elif float(total_premium) >= 500_000:
        severity = "critical"
    else:
        severity = "warning"

    return {
        "title": title,
        "body": body,
        "tag": f"interval-ba-{chain}",
        "requireInteraction": severity != "warning",
    }


def _format_body(
    *,
    total_premium: float,
    trade_count: int,
    top_trade_premium: Any,
    top_trade_is_sweep: Any,
    top_trade_is_floor: Any,
) -> str:
    premium_k = round(total_premium / 1000)
    premium_str = (
        f"${premium_k / 1000:.2f}M" if premium_k >= 1000 else f"${premium_k}K"
    )
    trade_noun = "trade" if trade_count == 1 else "trades"
    body = f"{premium_str} premium / {trade_count} {trade_noun}"
    if top_trade_premium is not None:
        top_k = round(float(top_trade_premium) / 1000)
        top_str = f"${top_k / 1000:.2f}M" if top_k >= 1000 else f"${top_k}K"
        flags: list[str] = []
        if top_trade_is_sweep:
            flags.append("sweep")
        if top_trade_is_floor:
            flags.append("floor")
        flag_str = (" " + " ".join(flags)) if flags else ""
        body += f" — top: {top_str}{flag_str}"
    return body
