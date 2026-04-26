"""Ichimoku event classifier — Ichimoku-native exits.

Mirrors `pac_classifier` but the labels module uses traditional
Ichimoku stop / target / exit conventions instead of the PAC-style
fixed ±1.5R bracket. Three preset strategies are pre-defined; each
one is a `StrategySpec` controlling stop, target, and exit-trigger
behavior. The dataset assembler joins:

    extract_events(enriched)  →  label_ichimoku_events(enriched, events, strategy)
                              ↘
                                build_features(enriched, events)  →  per-event parquet

The features module is reused unchanged from `pac_classifier`. Only
the label-generation step differs.
"""

from ichimoku_classifier.labels import (
    STRATEGY_CLOUD_STOP_2R,
    STRATEGY_KIJUN_STOP_2R,
    STRATEGY_TK_REVERSAL_EXIT,
    StrategySpec,
    label_ichimoku_event,
    label_ichimoku_events,
)

__all__ = [
    "StrategySpec",
    "STRATEGY_KIJUN_STOP_2R",
    "STRATEGY_CLOUD_STOP_2R",
    "STRATEGY_TK_REVERSAL_EXIT",
    "label_ichimoku_event",
    "label_ichimoku_events",
]
