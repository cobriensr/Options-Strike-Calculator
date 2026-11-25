"""Fixed tunables for the nightly tape job.

These are constants, not env vars (R7): none is a deploy-free operational knob.
"""

from __future__ import annotations

from datetime import date, time
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
# Neon connections. Phase 3's child processes will build PGCONNECT_TIMEOUT and PGOPTIONS
# from these two values, never from literals.
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
# A day starts only with this much step time left: its download (held to the tape reader's
# FETCH_DEADLINE_SECONDS, 600 s, from the day's start; the bound is checked between reads, so
# a stalled read can pass it, and the watchdog bounds the run) plus both enrich passes.
# 3 x the slowest local day (79 s, Task 6) is below the 900 s floor; the plan's budget table
# caps this at 1,800.
ENRICH_DAY_BUDGET_SECONDS = 900
# Failed days, all-NULL (table, day) pairs and unpriced passes (below) after which the step
# stops for the night. A tape layout or chain format the scripts cannot read shows as one of
# them, each catching what the others miss: a day that raises; a table-day whose fires hold no
# value from another writer, so none gets an outcome; or a pass that wrote nothing where the
# fires do hold a value (the shares stay near 100%) or in the inversion pass (no share), the
# inversion pass only on a day no inversion was resolved on before it (see enrich_step).
# Each would cost a download; this bounds the wasted downloads, the fires stamped and the
# Sentry exceptions (one per failed day).
ENRICH_MAX_DAY_FAILURES = 3
# A pass is unpriced when it wrote nothing and tagged at least this many rows. Rows tagged,
# not rows selected: tagging marks a fire examined and locks it out of the work set. A
# broken chain id hits every fire, and a lottery day has thousands. About 20% of flow results
# are legitimately undefined, so 20 in a row that are all undefined is negligible. A day
# re-listed for a few leftover fires stays under it; one re-listed for hundreds of them (the
# inversion pass after another writer priced the rest) is not judged by it.
ENRICH_UNPRICED_FLOOR = 20
# The interval-ba-tape step (spec 2026-11-24-interval-ba-rebuild-design.md, section 6.6). Its tape
# days land in a directory of its own, because `open_reader` empties the one it is given; DuckDB
# spills one level under it (interval_ba_step), where that emptying clears a killed run's spill.
INTERVAL_BA_CACHE_DIR = WORK_DIR / "interval-ba"
# A day starts only with this much step time left: its download (held to the tape reader's
# FETCH_DEADLINE_SECONDS, 600 s; the bound is checked between reads, so a stalled read can pass
# it, and the watchdog bounds the run) plus heal_day's DuckDB scans of the day and its one Neon
# transaction. The same as the other two per-day tape steps.
INTERVAL_BA_DAY_BUDGET_SECONDS = 900
# Failed days after which the step stops for the night. Each costs a download and a Sentry
# exception, and a tape layout the replay cannot read breaks every day alike.
INTERVAL_BA_MAX_DAY_FAILURES = 3
# DuckDB's memory limit for one day: at most a quarter of the nightly service's memory limit and
# at most 2000MiB (spec 6.6). Railway's limit for the service read 8,000,000,000 bytes on
# 2026-11-25, so a quarter is 2,000,000,000 bytes, below 2000MiB (2,097,152,000 bytes). DuckDB
# reads GB as 10**9 bytes. Re-derive this when the service's memory limit changes.
INTERVAL_BA_DUCKDB_MEMORY = "2GB"
INTERVAL_BA_DUCKDB_THREADS = 2
# The refit step's name, in the step table, its logs and its Sentry notices (tag `step`).
REFIT_STEP_NAME = "lottery-refit"
# The refit step's row of the plan's D2 budget table: what a night reserves for it.
REFIT_BUDGET_SECONDS = 1800
# A promotion starts only with this much time left, counting the step's own deadline and the
# cutoff below, whichever is nearer. The rescore reads every stored fire and writes the
# changed ones in one transaction; it is timed on prod before the push (plan Task 22). A
# rescore that overruns its deadline rolls back whole and the shadow stays a shadow for the
# next night, so this is a floor on the work started; the deadline is the bound.
PROMOTION_MIN_SECONDS = 1200
# A promotion's rescore must be over by this UTC time of day, which is an hour before the
# earliest US open (13:30 UTC in EDT): it locks every fire it rewrites, and from 13:00 UTC the
# live detect cron and the other fire writers would block on it or deadlock with it. The
# step reads the wall clock when it starts one, defers it with less than PROMOTION_MIN_SECONDS
# to go, and caps the rescore's deadline here.
PROMOTION_CUTOFF_UTC = time(12, 30)
# A reviewed one-time switch, the precedent being PROMOTE_TO_LIVE in
# api/cron/refit-lottery-ticker-stats.ts. False: a shadow that passes its gates is marked
# `passed` and the owner is told, and no live score changes. A promotion rewrites the live
# feed's scores and tiers, which needs the owner's go-ahead (plan Task 23), so it is turned
# on by a commit that flips this constant, never by an env var (R7).
PROMOTION_ENABLED = False
# Phase 3, the research steps. Two directories, side by side and never nested: the derive step
# writes and spills into the first, and `open_reader` empties the second (its tape days).
RESEARCH_WORK_DIR = WORK_DIR / "research"
RESEARCH_TAPE_DIR = WORK_DIR / "research-tape"
# A research-derive day starts only with this much step time left: a download held to the tape
# reader's FETCH_DEADLINE_SECONDS (600 s; the bound is checked between reads, so a stalled read
# can pass it, and the watchdog bounds the run) plus about 2x the 90 s local derive of the
# largest day (15,964 fires). It stays at or below FETCH_DEADLINE_SECONDS + 300, or D2's row
# of the budget table changes first.
RESEARCH_DAY_BUDGET_SECONDS = 900
# Failed days after which research-derive stops for the night: each costs a download and a
# Sentry exception, and a layout the derive cannot read breaks every day alike.
RESEARCH_MAX_DAY_FAILURES = 3
# Failed sessions after which research-derive sets a day aside, so it stops taking a failure
# slot every night. The same number as the per-night cap above.
RESEARCH_SET_ASIDE_NIGHTS = 3
# A set-aside day is tried again this many calendar days after the session it was set aside
# on: a week catches an outside cause clearing (an R2 or Neon issue) with no one stepping in.
RESEARCH_SET_ASIDE_RETRY_DAYS = 7
# Each retry that fails doubles the wait (7, 14, 28) and it stays here, so a day that never
# recovers costs one attempt a month.
RESEARCH_SET_ASIDE_RETRY_DAYS_MAX = 28
# The report steps' rows of D2's budget table, what a night reserves for each: eight steps at
# REPORT_BUDGET_SECONDS (2,400 s) and the two that pull every enriched fire at
# LARGE_REPORT_BUDGET_SECONDS (1,200 s).
REPORT_BUDGET_SECONDS = 300
LARGE_REPORT_BUDGET_SECONDS = 600
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
