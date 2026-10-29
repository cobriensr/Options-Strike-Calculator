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
DOWNLOAD_DEADLINE_SECONDS = 1800
DOWNLOAD_MAX_ATTEMPTS = 4
MIN_FREE_DISK_BYTES = 15 * 2**30
WORK_DIR = Path("/tmp/nightly")
# Trading days after which a never-posted day is marked unavailable.
UNAVAILABLE_AGE_TRADING_DAYS = 5
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
