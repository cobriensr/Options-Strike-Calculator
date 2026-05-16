"""Constants for the take-it score pipeline.

Centralized so Phase 2 (training) and Phase 3 (scoring) can import from one place
and so the EDA notebook can sweep these without touching the builder.
"""

WIN_LABEL_THRESHOLD_PCT = 20.0
"""peak_ceiling_pct >= this -> win = 1. Tunable; 20% was picked off the median
realized return of tier-2+ lottery fires per ml/findings.json."""

BURST_STORM_WINDOW_MIN = 30
"""Rolling window (minutes) used to count co-fires for the burst_storm flag."""

BURST_STORM_MIN_COFIRES = 5
"""Minimum number of distinct underlyings firing in BURST_STORM_WINDOW_MIN to
flag burst_storm_badge = 1. Matches the heuristic in the UI badge (commit d5621932)."""

COFIRE_WINDOW_MIN = 5
"""How close a Silent Boom alert must be (in minutes, same option_chain_id) to
a Lottery fire to count as silent_boom_cofire_within_5min, and vice versa."""

AGGRESSIVE_ASK_PCT_THRESHOLD = 0.85
"""ask_pct >= this -> aggressive_premium_flag = 1. Matches the Aggressive
Premium filter chip semantics (commit 217a1c75)."""

TOP_N_TICKERS = 15
"""Number of distinct tickers to one-hot encode; rest fall into OTHER."""
