"""WebSocket connector.

Single coroutine that owns the connection. On disconnect, exponentially
backs off then reconnects and **resubscribes** every channel — the UW
server forgets joins on disconnect (this is the most common operational
footgun, called out in the unusual-whales-websocket skill).

Every successfully parsed frame is forwarded to the router. The router
is the only thing that decides what to do with a payload; the connector
is a pure transport.
"""

from __future__ import annotations

import asyncio
import contextlib
import time

import orjson
import websockets

from config import settings
from logger_setup import log
from sentry_setup import capture_exception, capture_message
from state import state

# Backoff schedule. We start at 1s and double until 60s; reset to 1s on
# any clean connect.
_INITIAL_BACKOFF_S = 1.0
_MAX_BACKOFF_S = 60.0

# Ping cadence so we get prompt failure detection on a hung TCP. UW
# does not document a server-side keepalive; 20s is conservative.
_PING_INTERVAL_S = 20.0
_PING_TIMEOUT_S = 20.0

# Threshold for raising a Sentry warning if reconnects pile up.
_RECONNECT_STORM_THRESHOLD = 5

# A session must stay up at least this long to count as "healthy" and reset
# the reconnect backoff. Mirrors the Databento sidecar's MIN_HEALTHY_SESSION_S
# (sidecar/src/main.py). Subscribe succeeding is NOT enough: a provider shedding
# an over-cap connection (the 50-channel-cap incident class) accepts the joins
# and then closes the socket ~immediately. If we reset backoff on subscribe
# success alone, those sub-second sessions form a ~1s tight reconnect loop with
# no escalation — exactly the silent flap this guards against. Genuinely healthy
# sessions stream for minutes/hours and clear this bar trivially.
_MIN_HEALTHY_SESSION_S = 60.0

# Inter-join pacing. With the Lottery universe expanded across
# option_trades / net_flow / gex_strike_expiry shorthands we send ~150
# join frames on every (re)connect. UW does not document a join-rate
# limit, but firing 150 control frames back-to-back is exactly the kind
# of burst a server-side throttle would drop — and a dropped join is a
# silently-unsubscribed channel. A few ms between joins spreads the burst
# (150 * 10ms = ~1.5s added to a reconnect) without meaningfully delaying
# the small-channel common case. Override-free: this is deliberately a
# constant, not an env knob, to keep the surface small.
_JOIN_PACING_S = 0.01

# Self-healing re-subscribe. A join frame can be silently lost — UW dropping a
# control-frame burst, a transient throttle, or a server-side reject the router
# discards. The connector joins each channel once on connect, so a lost join
# leaves that channel ``subscribed=False`` forever. While connected, each shard
# re-sends joins for its still-unacked channels every _RESUBSCRIBE_INTERVAL_S,
# after an initial delay so the first burst's acks can arrive before we
# reconcile (else we'd re-join channels that are merely pending). This heals
# faster than the subscription watchdog's alert window, so a dropped join
# self-corrects silently and the watchdog only fires for channels that survive
# repeated re-joins (a genuine upstream reject, not a lost frame).
_RESUBSCRIBE_INITIAL_DELAY_S = 30.0
_RESUBSCRIBE_INTERVAL_S = 60.0


class Connector:
    """Manages the lifecycle of a single multiplexed UW WS connection."""

    def __init__(
        self,
        channels: list[str],
        receive_queue: asyncio.Queue,
        name: str = "ws",
    ) -> None:
        self.channels = channels
        # Shard label — distinguishes this connection in logs/metrics when
        # the channel set is sharded across multiple connections. Connection
        # health is tracked per-name in ``state.connections``.
        self.name = name
        # Bounded queue between the connector (producer) and the router
        # (consumer). Connector only does ``put_nowait`` so the WS
        # receive task can never block on JSON parsing or handler
        # dispatch — those happen on the router task.
        self._receive_queue = receive_queue
        # Set True by ``_connect_once`` only once a connection has stayed up
        # for at least ``_MIN_HEALTHY_SESSION_S`` (subscribe success alone is
        # NOT enough — see that constant). ``run`` reads it to decide whether
        # the next reconnect resets the backoff (healthy session dropped →
        # start fresh at 1s) or escalates it (connect failures, or sub-threshold
        # flaps, with no healthy session between).
        self._established = False

    async def run(self) -> None:
        """Run forever, reconnecting as needed."""
        backoff = _INITIAL_BACKOFF_S
        while True:
            # Reset per iteration; ``_connect_once`` flips it to True only if
            # the session stayed up at least ``_MIN_HEALTHY_SESSION_S`` (subscribe
            # success alone is not enough — see _connect_once / that constant).
            self._established = False
            try:
                await self._connect_once()
                # _connect_once returns cleanly only on graceful close.
                # That is unusual; treat it like a transient failure so
                # we do reconnect rather than exit the daemon. We mark
                # disconnect + reconnect for symmetry with the exception
                # branches so /metrics' reconnects_last_hour is accurate.
                state.set_connection(self.name, False)
                state.record_reconnect()
                log.info("WS closed cleanly, reconnecting after grace")
                # Storm-check the clean-close path too. A provider shedding an
                # over-cap connection sends a CLEAN close (no exception), so a
                # rapid succession of clean closes is exactly how that incident
                # class presents — and must trip the same alert the exception
                # branches do, not slip through silently.
                self._maybe_alert_storm()
            except (
                websockets.ConnectionClosed,
                # Handshake-rejection variants (HTTP 503, 502, 504, etc. on the
                # WS upgrade) inherit from InvalidHandshake. They were
                # previously falling through to the catch-all `except
                # Exception`, which Sentry-captured every retry — a sustained
                # UW outage produced one Sentry event per backoff cycle
                # (~60s). Treat them like a connection drop: warning log +
                # storm alert + backoff, no per-event capture. The storm
                # alert at >=5 reconnects/hour still surfaces the incident.
                websockets.InvalidHandshake,
            ) as exc:
                state.set_connection(self.name, False)
                state.record_reconnect()
                log.warning(
                    "WS connection unavailable",
                    extra={"err": str(exc), "backoff": backoff},
                )
                self._maybe_alert_storm()
            except (TimeoutError, OSError) as exc:
                state.set_connection(self.name, False)
                state.record_reconnect()
                log.warning(
                    "WS transport error",
                    extra={"err": str(exc), "backoff": backoff},
                )
                self._maybe_alert_storm()
            except Exception as exc:
                # Anything we didn't anticipate — Sentry it, then keep
                # trying. The daemon must not exit while market hours
                # are live.
                state.set_connection(self.name, False)
                state.record_reconnect()
                capture_exception(exc, tags={"component": "connector"})

            # Backoff schedule, applied uniformly across the clean-close
            # and every exception branch:
            #
            # - If THIS attempt established a HEALTHY connection (stayed up at
            #   least ``_MIN_HEALTHY_SESSION_S``), reset to the initial 1s so
            #   the NEXT reconnect starts fresh. A connection that streamed for
            #   hours and then dropped should not inherit an escalated backoff
            #   left over from an earlier rough start.
            # - Otherwise (connect/subscribe failed, OR a sub-threshold flap
            #   that subscribed and then dropped near-instantly), sleep the
            #   current backoff and then escalate it toward the cap. This is
            #   the sustained-outage behavior AND the defense against an
            #   over-cap-shed tight reconnect loop: escalation keeps us off a
            #   ~1s hammer when a provider repeatedly accepts joins then closes.
            if self._established:
                backoff = _INITIAL_BACKOFF_S
            await asyncio.sleep(backoff)
            if not self._established:
                backoff = min(backoff * 2, _MAX_BACKOFF_S)

    async def _connect_once(self) -> None:
        """Open one WS, join channels, drain messages until the socket dies.

        ``state.ws_connected`` only flips to ``True`` AFTER
        ``_subscribe_all`` succeeds — flipping it on TCP/TLS handshake
        completion alone (the obvious place) makes ``/healthz`` lie when
        a typo'd channel name or server-side error frame causes the
        join to fail. The socket would stay open with no data flowing
        and the daemon would report green until the next disconnect.

        ``self._established`` (which ``run`` keys the backoff-reset on) is set
        ONLY in the receive-loop ``finally``, and only if the session stayed up
        at least ``_MIN_HEALTHY_SESSION_S``. Subscribe succeeding does not count
        a session as healthy: an over-cap-shed connection accepts the joins and
        then closes immediately, and we must NOT reset backoff for those flaps.
        """
        log.info(
            "connecting to WS",
            extra={"shard": self.name, "channels": self.channels},
        )
        async with websockets.connect(
            settings.ws_url,
            ping_interval=_PING_INTERVAL_S,
            ping_timeout=_PING_TIMEOUT_S,
            max_size=2**22,  # 4 MB; option_trades can carry big arrays
        ) as ws:
            try:
                await self._subscribe_all(ws)
            except Exception as exc:
                # Subscribe failed — leave ws_connected False so /healthz
                # reflects reality and the run() loop reconnects with a
                # fresh handshake on the next iteration. Re-raise so the
                # surrounding try/except in run() bumps the reconnect
                # counter and applies the backoff.
                log.warning(
                    "WS subscribe failed; reconnecting",
                    extra={"err": str(exc)},
                )
                capture_exception(
                    exc,
                    tags={"component": "connector", "stage": "subscribe"},
                )
                raise
            state.set_connection(self.name, True)
            log.info("WS connected, awaiting messages", extra={"shard": self.name})
            # Monotonic clock so a wall-clock adjustment (NTP step) can't make a
            # short session look healthy or vice-versa.
            session_start = time.monotonic()
            # Self-healing re-subscribe runs concurrently with the receive loop
            # on the same socket (websockets >=12 allows concurrent send+recv).
            # Cancelled in the finally when the socket drops — the next connect
            # re-subscribes from scratch, so a stale reconcile must not linger.
            reconcile_task = asyncio.create_task(
                self._reconcile_subscriptions(ws),
                name=f"reconcile:{self.name}",
            )
            try:
                async for raw in ws:
                    # Hand off to the router via a bounded queue. We never
                    # ``await`` here — the WS receive task must never block
                    # on parsing or dispatch (those run on the router task).
                    # On overflow, drop the oldest frame to make room: under
                    # sustained overload we'd rather lose stale ticks than
                    # back up the OS receive buffer.
                    try:
                        self._receive_queue.put_nowait(raw)
                    except asyncio.QueueFull:
                        try:
                            self._receive_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                        else:
                            # task_done() balances the get_nowait we just did
                            # so receive_queue.join() (if anyone calls it)
                            # stays correct.
                            self._receive_queue.task_done()
                        # Should be impossible — we just made room — but
                        # defensive in case another producer ever exists.
                        # Log if it ever does happen so we don't drop frames
                        # silently in an "impossible" branch.
                        try:
                            self._receive_queue.put_nowait(raw)
                        except asyncio.QueueFull:
                            log.warning(
                                "receive_queue overflow even after eviction "
                                "— dropping new frame",
                            )
                        state.receive_queue_drops += 1
            finally:
                # Treat the session as healthy (→ reset backoff in ``run``)
                # ONLY if it stayed up long enough. Runs on both the clean
                # ``async for`` exit and an exception unwinding through here
                # (e.g. ConnectionClosed), so a sub-threshold flap that
                # subscribed then dropped near-instantly leaves _established
                # False and the backoff escalates.
                session_dur = time.monotonic() - session_start
                self._established = session_dur >= _MIN_HEALTHY_SESSION_S
                reconcile_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await reconcile_task

    async def _subscribe_all(self, ws) -> None:
        """Send a join frame for every configured channel.

        Joins are paced by ``_JOIN_PACING_S`` so a large universe (~150
        channels via the Lottery shorthands) doesn't fire its entire join
        burst in one event-loop tick — a server-side join-rate throttle
        would otherwise drop some frames, leaving those channels silently
        unsubscribed. Pacing goes BETWEEN frames, not after the last one,
        so a single-channel subscribe adds no delay.
        """
        for i, ch in enumerate(self.channels):
            if i > 0:
                await asyncio.sleep(_JOIN_PACING_S)
            await self._send_join(ws, ch)
            # Subscription is pending until the server's ok ack arrives;
            # router flips this flag when it sees the ack.
            state.channel(ch).subscribed = False
            log.info("sent join frame", extra={"channel": ch})

    async def _send_join(self, ws, channel: str) -> None:
        """Send one join frame for ``channel`` as a WS TEXT frame.

        MUST be TEXT (opcode 0x1), not BINARY (0x2): UW's server only reads
        join control messages from text frames and silently drops binary ones.
        ``orjson.dumps()`` returns bytes (which the websockets lib would send as
        BINARY) so we ``.decode()`` to str. Does NOT touch the ``subscribed``
        flag — callers own that (``_subscribe_all`` marks pending; the reconcile
        loop leaves it as-is so a concurrently-arriving ack isn't clobbered).
        """
        frame = orjson.dumps({"channel": channel, "msg_type": "join"}).decode()
        await ws.send(frame)

    async def _reconcile_once(self, ws) -> list[str]:
        """Re-send joins for THIS shard's channels still unacked. One pass.

        Returns the channels re-joined (empty when all are subscribed) so the
        loop / tests can observe what was healed. Only re-joins channels in
        ``self.channels`` — never another shard's — and never resets the
        ``subscribed`` flag, so an ack arriving mid-pass still wins. The router
        flips ``subscribed=True`` when each re-join's ack returns.
        """
        stuck = [ch for ch in self.channels if not state.channel(ch).subscribed]
        if not stuck:
            return []
        log.warning(
            "re-sending joins for stuck channels",
            extra={
                "shard": self.name,
                "stuck_count": len(stuck),
                "sample": stuck[:10],
            },
        )
        for i, ch in enumerate(stuck):
            if i > 0:
                await asyncio.sleep(_JOIN_PACING_S)
            await self._send_join(ws, ch)
        return stuck

    async def _reconcile_subscriptions(self, ws) -> None:
        """Periodically self-heal stuck subscriptions while connected.

        Runs as a sibling task to the receive loop on the same socket. After an
        initial delay (so the connect-time join burst's acks can land), it
        re-joins any of this shard's still-unacked channels every
        ``_RESUBSCRIBE_INTERVAL_S``. A ``ConnectionClosed`` mid-pass means the
        socket dropped — return so the stale cycle ends; ``run`` reconnects and
        re-subscribes from scratch. Cancelled by ``_connect_once`` on drop.
        """
        await asyncio.sleep(_RESUBSCRIBE_INITIAL_DELAY_S)
        while True:
            try:
                await self._reconcile_once(ws)
            except websockets.ConnectionClosed:
                return
            await asyncio.sleep(_RESUBSCRIBE_INTERVAL_S)

    def _maybe_alert_storm(self) -> None:
        """Raise a Sentry warning if reconnects pile up in the last hour.

        ``reconnects_last_hour`` is process-global, so with N sharded
        connections it counts reconnects across ALL shards. Scale the threshold
        by the shard count (``_RECONNECT_STORM_THRESHOLD`` per shard) so routine
        independent per-shard reconnect churn doesn't trip a storm alert tuned
        for a single socket — a real storm still crosses N*base quickly.
        """
        count = state.reconnects_last_hour()
        threshold = _RECONNECT_STORM_THRESHOLD * max(1, len(settings.channel_shards))
        if count >= threshold:
            capture_message(
                "uw-stream reconnect storm",
                level="warning",
                tags={"component": "connector"},
                context={"reconnects_last_hour": count, "threshold": threshold},
            )
