"""Fixed tunables for the nightly tape job.

These are constants, not env vars (R7): none is a deploy-free operational knob.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

# First session the tape covers; the calendar never plans earlier days.
TAPE_START = date(2026, 1, 2)
# Longest run of missed sessions one run will try to catch up.
CATCHUP_MAX_DAYS = 30
RUN_DEADLINE_SECONDS = 5 * 3600
# A day starts only with this much run time left: its 1800 s download deadline (which
# spans retries) plus convert and upload. It makes RUN_DEADLINE_SECONDS a true bound.
DAY_BUDGET_SECONDS = 3600
# How long past RUN_DEADLINE_SECONDS the watchdog waits before it ends a hung run.
WATCHDOG_GRACE_SECONDS = 900
# A rewrite probe starts only with this much run time left: a stalled one (4 attempts,
# each a UW and a GCS hop on 60 s timeouts, plus backoff) takes about 1000 s.
PROBE_BUDGET_SECONDS = 1200
DOWNLOAD_DEADLINE_SECONDS = 1800
DOWNLOAD_MAX_ATTEMPTS = 4
MIN_FREE_DISK_BYTES = 15 * 2**30
WORK_DIR = Path("/tmp/nightly")
# Neon connections. A child process builds PGCONNECT_TIMEOUT and PGOPTIONS from these two
# values, never from literals.
DB_CONNECT_TIMEOUT_SECONDS = 15
# The largest query, list_work_dates' scan of the 2.47 GB lottery_finder_fires, runs in
# seconds; past 300 s it is a hang.
DB_STATEMENT_TIMEOUT_MS = 300_000
# Trading days after which a never-posted day is marked unavailable.
UNAVAILABLE_AGE_TRADING_DAYS = 5
# The outcome check looks at the last 3 sessions, so a night that missed two (the enrich
# crons run 21:40-23:45 UTC, before this job) is still caught on the third.
OUTCOME_CHECK_SESSIONS = 3
# One statement under DB_STATEMENT_TIMEOUT_MS: the check sends a single query. Connect
# retries are not in it (about 31 s of backoff plus 6 x DB_CONNECT_TIMEOUT_SECONDS per
# resolved address), so they can run the step past RUN_DEADLINE_SECONDS, bounded by
# WATCHDOG_GRACE_SECONDS.
OUTCOME_CHECK_BUDGET_SECONDS = 300
# A table-day whose fires have outcomes for less than this share is "mostly null" (owner
# answer 2 on the phase 2 plan).
LOW_OUTCOME_SHARE = 0.95
# Where the enrichment step's tape days land: its own directory, which `open_reader` empties.
ENRICH_CACHE_DIR = WORK_DIR / "enrich"
# A day starts only with this much step time left: its download (up to the reader's 600 s
# deadline) plus both enrich passes. 3 x the slowest local day (79 s, Task 6) is below the
# 900 s floor; the plan's budget table caps this at 1,800.
ENRICH_DAY_BUDGET_SECONDS = 900
# Failed days plus all-NULL days after which the step stops for the night. A broken tape
# layout or chain format fails or nulls every day, and each would cost a download; this
# bounds the wasted downloads and the Sentry exceptions (one per failed day).
ENRICH_MAX_DAY_FAILURES = 3
# UW's 403 names this token's boundary, and a full plan reaches back about 2 years: a
# boundary newer than this many days before the last session means the entitlement
# shrank, not that UW lacks the day, so it never marks one.
OUTSIDE_WINDOW_MIN_LOOKBACK_DAYS = 690
# A run writes at most this many unavailable markers; later ones fail and retry next night.
MAX_MARKERS_PER_RUN = 2
REWRITE_RECHECK_DAYS = 5
# Tuned on the 112 R2 days: the lowest ratio to the trailing-20 median was 0.835
# (2026-02-19). Every day's executed_at fell between 09:30:00 and 18:04:15 ET.
PLAUSIBLE_MIN_ROW_RATIO = 0.65
PLAUSIBLE_MIN_TRAILING = 10
# A tape with fewer rows fails and is retried: real days run 7.68M-14.93M rows, and
# half-days about 4-5M.
MIN_TAPE_ROWS = 1_000_000
ROW_GROUP_SIZE = 1_048_576
SNIFF_MAX_BYTES = 65_536
SCHEMA_VERSION = "nightly-1"
USER_AGENT = "strike-calculator-nightly/1.0"
