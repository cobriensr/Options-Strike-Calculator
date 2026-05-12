"""Single source of truth for channel name → handler class mapping.

Both ``main._build_handlers`` (to instantiate handlers at boot) and
``config.Settings`` (to reject unknown channel names at construction
time) consume this registry. Adding a new channel is a one-line entry
here; nothing else needs to change in main.py or config.py.

Three forms are supported:

- **Exact channel names** (``EXACT_CHANNEL_NAMES``) — full channel name
  as it appears in the UW subscribe frame, e.g. ``"flow-alerts"``.
- **Prefixed channels** (``PREFIX_CHANNEL_NAMES``) — channels of the
  shape ``<prefix><instance>``, e.g. ``"option_trades:TSLA"``. Every
  per-instance channel sharing a prefix uses the SAME handler instance
  in main.py (queue + drain loop are pooled).
- **Shorthand tokens** (``SHORTHAND_CHANNELS``) — env-only sentinels
  that ``Settings.channels`` expands inline to N per-instance channels
  (e.g. ``option_trades_lottery`` → ``option_trades:<TICKER>`` x50).
  These are NOT subscribed to directly; the validator just needs to
  know they're legal in WS_CHANNELS.

Important: ``is_known_channel_token`` is import-cheap (no handler-class
imports) so it can be called from inside Settings field validators
without creating a config → handlers → config import cycle. Handler
class imports are deferred to ``handler_class_for_channel``, which is
only called at boot time from main.py — well after the config module
has finished loading.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from handlers.base import Handler

# Channels that subscribe by exact name, no per-instance fan-out.
EXACT_CHANNEL_NAMES: frozenset[str] = frozenset(
    {
        "flow-alerts",
        "off_lit_trades",
    },
)

# Channels of the form ``<prefix><instance>`` (e.g. ``option_trades:TSLA``).
# Entries MUST include the trailing separator so a startswith() check is
# unambiguous (e.g. matching ``option_trades:`` won't accidentally match a
# future ``option_trades_aggregate`` channel).
PREFIX_CHANNEL_NAMES: frozenset[str] = frozenset(
    {
        "option_trades:",
        "gex_strike_expiry:",
        "net_flow:",
    },
)

# Env-only shorthand tokens. Settings.channels expands each into N
# per-instance subscriptions (typically the Lottery Finder ticker
# universe). Listed here so the WS_CHANNELS validator accepts them.
SHORTHAND_CHANNELS: frozenset[str] = frozenset(
    {
        "option_trades_lottery",
        "net_flow_lottery",
    },
)


def is_known_channel_token(token: str) -> bool:
    """True iff ``token`` is a valid WS_CHANNELS entry.

    Accepts any of:
    - an exact channel name (``flow-alerts``, ``off_lit_trades``)
    - a prefix-matched channel (``option_trades:TSLA``)
    - a shorthand sentinel (``option_trades_lottery``)

    The caller is expected to have already applied alias normalization
    (e.g. ``flow_alerts`` → ``flow-alerts``) before calling.

    Import-cheap: this function does NOT pull in any handler classes,
    so it's safe to call from Settings field validators.
    """
    if token in EXACT_CHANNEL_NAMES:
        return True
    if token in SHORTHAND_CHANNELS:
        return True
    for prefix in PREFIX_CHANNEL_NAMES:
        if token.startswith(prefix) and len(token) > len(prefix):
            return True
    return False


def handler_class_for_channel(channel: str) -> type[Handler]:
    """Look up the handler class for an already-resolved channel name.

    ``channel`` is post-resolution (no shorthand, no aliases) — i.e. the
    strings that appear in ``Settings.channels``.

    Imports of handler classes happen INSIDE this function, not at
    module load, so ``config`` can import ``is_known_channel_token``
    without dragging in the handler module graph (which itself imports
    ``settings`` from config).

    Raises ``KeyError`` if no handler is registered. main.py converts
    that into a startup ``RuntimeError`` with a richer message.
    """
    from handlers.flow_alerts import FlowAlertsHandler
    from handlers.gex_strike_expiry import GexStrikeExpiryHandler
    from handlers.interval_ba import SPXWIntervalBAHandler
    from handlers.net_flow import NetFlowHandler
    from handlers.off_lit_trades import OffLitTradesHandler
    from handlers.option_trades import OptionTradesHandler

    exact: dict[str, type[Handler]] = {
        "flow-alerts": FlowAlertsHandler,
        "off_lit_trades": OffLitTradesHandler,
        # option_trades:SPXW gets a dedicated subclass that inherits
        # the raw-tick write path from OptionTradesHandler AND emits
        # Interval B/A ask-side alerts into interval_ba_alerts. See
        # docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md.
        # Listed exact so the option_trades: prefix below does NOT
        # short-circuit to the base class.
        "option_trades:SPXW": SPXWIntervalBAHandler,
    }
    if channel in exact:
        return exact[channel]

    prefix: dict[str, type[Handler]] = {
        "option_trades:": OptionTradesHandler,
        "gex_strike_expiry:": GexStrikeExpiryHandler,
        "net_flow:": NetFlowHandler,
    }
    for p, handler_cls in prefix.items():
        if channel.startswith(p) and len(channel) > len(p):
            return handler_cls
    raise KeyError(channel)
