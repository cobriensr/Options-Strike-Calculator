# Makefile — EOD options-flow pipeline
#
# The Railway `nightly` job builds the flow research outputs every night from
# the Full Tape in R2 and writes them to R2 `research/`. The targets here are
# the local counterpart. No new by-day parquet or report is committed: the
# tracked by-day parquets are frozen history, and only the plots stay tracked
# (`make plots` rewrites them).
#
# Default usage (after dropping new CSV(s) into ~/Downloads/EOD-OptionFlow/):
#
#     make nightly
#
# Iterates every pending bot-eod-report-YYYY-MM-DD.csv (sorted ascending) and
# runs analyze + ingest + enrich per-date, then a single closing pass of
# rollup + plots + ingest-fulltape. Run as
# `make nightly update` to chain the research refresh after.
#
# Per-date steps (run for each pending CSV):
#   1. analyze.py   — per-day parquet aggregate at scripts/eod-flow-analysis/output/by-day/,
#                     read from the Full Tape in R2 (--r2: the R2_* variables must
#                     be in ENV_FILE)
#   2. ingest-flow  — full unfiltered archive parquet to PARQUET_DIR (default
#                     ~/Desktop/Bot-Eod-parquet/), source CSV deleted on success.
#                     Nothing is uploaded: the Blob flow/ copy is retired.
#   3. enrich       — replays the EOD parquets against unenriched
#                     lottery_finder_fires AND silent_boom_alerts rows
#
# Closing pass (run once at the end):
#   4. whale_plots  — regenerates the visualizations under ml/plots/whale-detection/
#                     (aggregator across every parquet — wasteful to run per-iteration)
#   5. ingest-fulltape — best-effort UW Full Tape capture (soft-fail)
#
# Override the date with DATE=YYYY-MM-DD to run the single-date pipeline:
#     make nightly DATE=2026-04-29
#
# Override the input directory with INPUT_DIR=...
#     make nightly INPUT_DIR=/path/to/csvs

SHELL := /bin/bash
# GNU Make 3.82+ (this Windows box: 4.4.1) applies these flags to every recipe
# line; the retired Mac's Make 3.81 ignored .SHELLFLAGS, so recipes there ran
# without -e/-u/pipefail.
.SHELLFLAGS := -eu -o pipefail -c
# No .ONESHELL, on purpose. Every recipe line runs in its own shell, which is
# what the `\` continuations and the sentinel file below are written for. Under
# .ONESHELL a whole recipe is one line, and `make -n` runs any recipe that
# contains $(MAKE) for real (`update`, `nightly`).

# A venv keeps its interpreter in Scripts/ on Windows and bin/ elsewhere.
ifeq ($(OS),Windows_NT)
VENV_BIN    := Scripts
else
VENV_BIN    := bin
endif
PYTHON      := ml/.venv/$(VENV_BIN)/python
# $(HOME) is C:\Users\... under Windows make; forward slashes keep the paths
# intact in sh and in Python alike. Still quote them in recipes (spaces).
HOME_DIR    := $(subst \,/,$(HOME))
INPUT_DIR   ?= $(HOME_DIR)/Downloads/EOD-OptionFlow
# Bot-EOD archive ({date}-trades.parquet). scripts/ingest-flow.py writes it
# (--archive-dir); the enrich, exit-policy-search,
# flow-inversion-timing and tune-flow-inversion scripts read it
# (--parquet-dir). None of them has a default of its own here.
PARQUET_DIR ?= $(HOME_DIR)/Desktop/Bot-Eod-parquet
INPUT_DIR_FULLTAPE   ?= $(HOME_DIR)/Downloads/EOD-FullTape
PARQUET_DIR_FULLTAPE ?= $(HOME_DIR)/Desktop/Eod-Full-Tape-parquet
# `./` on purpose: Windows make runs recipes in Git's sh.exe (bash in POSIX
# mode), where `source name` without a slash searches PATH, not the cwd.
ENV_FILE    := ./.env.local

# Sentinel file for cross-shell failure signalling in the nightly loop. Every
# recipe line runs in its own shell (no .ONESHELL, see above), so a shell
# variable set in the per-date loop cannot be read by the final exit-check
# line. A sentinel file persists across those shells.
NIGHTLY_FAIL_SENTINEL := /tmp/.strike-nightly-failed

# Every bot-eod-report-YYYY-MM-DD.csv in INPUT_DIR, ascending.
PENDING_DATES := $(shell ls -1 "$(INPUT_DIR)"/bot-eod-report-*.csv 2>/dev/null \
                       | sed -nE 's|.*bot-eod-report-([0-9]{4}-[0-9]{2}-[0-9]{2})\.csv|\1|p' \
                       | sort)

# Capture explicit DATE= override BEFORE the ?= default fires below.
# `command line` and `environment` are user-set; `file` means we defaulted.
ifneq ($(filter command line environment,$(origin DATE)),)
DATE_EXPLICIT := 1
else
DATE_EXPLICIT :=
endif

# Default DATE = latest pending CSV (used by single-date targets like analyze, ingest).
DATE        ?= $(lastword $(PENDING_DATES))

CSV_PATH    := $(INPUT_DIR)/bot-eod-report-$(DATE).csv

.PHONY: help nightly nightly-one nightly-resume rollup analyze ingest plots enrich refit update tune check check-r2-env dry-run clean download-fulltape ingest-fulltape version takeit-rollback takeit-drift takeit-backfill py-test-cov

help:
	@echo "EOD options-flow pipeline targets:"
	@echo ""
	@echo "  make nightly                  Iterate every pending CSV in INPUT_DIR (ascending)."
	@echo "                                Per-date: analyze --no-rollup (tape from R2), ingest,"
	@echo "                                enrich-lottery, enrich-silent-boom. Closing pass:"
	@echo "                                cumulative rollup + plots + best-effort fulltape."
	@echo "                                Auto-falls-back to plots+enrich if no CSV is pending"
	@echo "                                but parquets are on disk (CSV consumed by a previous"
	@echo "                                invocation). Run as 'make nightly update' to chain the"
	@echo "                                research refresh after."
	@echo "                                A date needs its tape in R2, which lands after the 07:15"
	@echo "                                UTC Railway run: an earlier run fails that date, keeps its"
	@echo "                                CSV, and a re-run completes it."
	@echo "  make nightly DATE=YYYY-MM-DD  Run pipeline for one specific date (no loop)"
	@echo "  make download-fulltape        Download UW Full Tape zip → ~/Downloads/EOD-FullTape/"
	@echo "                                fulltape-DATE.csv (40-col raw tape, separate schema"
	@echo "                                from bot-eod-report). Feeds 'make ingest-fulltape'."
	@echo "  make ingest-fulltape          Download + convert UW Full Tape CSV → parquet"
	@echo "                                (auxiliary archive; ~/Desktop/Eod-Full-Tape-parquet)"
	@echo "  make analyze                  EDA only: reads the day's Full Tape from R2 (needs the"
	@echo "                                R2_* vars in the env file; no CSV needed, DATE= required"
	@echo "                                when none is pending)"
	@echo "  make ingest                   CSV → Bot-EOD archive parquet + delete CSV (no upload)"
	@echo "  make plots                    Regenerate visualizations only (no CSV needed)"
	@echo "  make enrich                   Backfill lottery_finder_fires + silent_boom_alerts realized_*_pct from EOD parquet"
	@echo "  make refit                    Dry runs of the lottery refit + score backfill (the refit"
	@echo "                                runs in the nightly service; nothing is written here)"
	@echo "  make update                   Run after \`make nightly\`: refit (dry run) + exit-policy search +"
	@echo "                                feature audit + flow-inversion timing + tracker CSV. ~3-4m,"
	@echo "                                designed to run nightly so day-over-day drift is captured."
	@echo "  make tune                     Heavy parameter grid for flow-inversion (~25m). Run weekly,"
	@echo "                                not nightly — same dataset every night doesn't move the answer."
	@echo "  make dry-run                  Run analyze + ingest --keep-csv + plots"
	@echo "  make check                    Sanity-check date detection, the CSV and the venv (the"
	@echo "                                guard for ingest)"
	@echo "  make py-test-cov              Run all 3 Python suites with coverage,"
	@echo "                                fail-fast (ml, sidecar, uw-stream)"
	@echo ""
	@echo "Detected:"
	@echo "  DATE       = $(DATE)"
	@echo "  CSV_PATH   = $(CSV_PATH)"
	@echo "  INPUT_DIR  = $(INPUT_DIR)"

# The guard for `ingest`, its only user: the CSV and the venv. No env file,
# because ingest-flow.py reads no environment variable (the tape targets use
# `check-r2-env` below).
check:
	@echo "→ Sanity checks"
	@if [[ -z "$(DATE)" ]]; then \
	  echo "  ❌ No CSV found in $(INPUT_DIR). Drop bot-eod-report-YYYY-MM-DD.csv there first."; \
	  exit 2; \
	fi
	@if [[ ! -f "$(CSV_PATH)" ]]; then \
	  echo "  ❌ CSV not found: $(CSV_PATH)"; \
	  exit 2; \
	fi
	@if [[ ! -x "$(PYTHON)" ]]; then \
	  echo "  ❌ Python venv not found at $(PYTHON)"; \
	  exit 2; \
	fi
	@echo "  ✅ DATE       = $(DATE)"
	@echo "  ✅ CSV_PATH   = $(CSV_PATH) ($$(du -h "$(CSV_PATH)" | cut -f1))"
	@echo "  ✅ Python     = $(PYTHON)"

# Env-only gate for the targets that read the Full Tape from R2 (analyze,
# analyze-one, dry-run). They never read the bot-eod CSV, so they skip `check`,
# whose CSV gate exits 2 when none is pending; they need a DATE and the R2_*
# variables instead. Presence only: the file is sourced, a variable is tested
# for being non-empty, and no value is ever printed.
R2_ENV_VARS := R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT_URL R2_BUCKET_FULLTAPE

check-r2-env:
	@if [[ -z "$(DATE)" ]]; then \
	  echo "  ❌ No DATE: no CSV is pending in $(INPUT_DIR), so pass DATE=YYYY-MM-DD."; \
	  exit 2; \
	fi
	@if [[ ! -f "$(ENV_FILE)" ]]; then \
	  echo "  ❌ $(ENV_FILE) not found — needed for the R2_* variables"; \
	  exit 2; \
	fi
	@set -a && source $(ENV_FILE) && set +a && \
	  missing=""; \
	  for name in $(R2_ENV_VARS); do \
	    if [[ -z "$${!name:-}" ]]; then missing="$$missing $$name"; fi; \
	  done; \
	  if [[ -n "$$missing" ]]; then \
	    echo "  ❌ $(ENV_FILE) lacks:$$missing"; \
	    exit 2; \
	  fi

analyze: check-r2-env
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 1/4 — analyze.py (EDA + per-day parquet aggregate, tape from R2)"
	@echo "════════════════════════════════════════════════════════════════"
	set -a && source $(ENV_FILE) && set +a && $(PYTHON) scripts/eod-flow-analysis/analyze.py --day $(DATE) --r2

ingest: check
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 2/4 — ingest-flow.py (CSV → Bot-EOD archive parquet → delete CSV)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) scripts/ingest-flow.py $(DATE) \
	  --input-dir "$(INPUT_DIR)" --archive-dir "$(PARQUET_DIR)"

plots:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 3/4 — whale_plots.py (whale-detection visualizations)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) ml/src/whale_plots.py

enrich:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 4/4 — enrich_lottery_outcomes.py --all-unenriched (replay parquet → Postgres)"
	@echo "════════════════════════════════════════════════════════════════"
	@# --all-unenriched enumerates every date with enriched_at IS NULL
	@# rows and processes each. Catches:
	@#   - The normal latest-date case (one date in the list)
	@#   - Post-nightly manual backfills (e.g. scripts/backfill_lottery_fires_for_ticker.py
	@#     inserts rows for an older date after `make nightly` already ran).
	@# Three passes per date plus a global third pass:
	@#   1. trail/hard/tier50/peak/eod/min_to_peak from parquet (per-date)
	@#   2. flow_inversion from parquet NBBO mids + net_flow_per_ticker_history (per-date)
	@#   3. per-ticker inversion-quality refit (Wilson LCB + quintile; global,
	@#      runs once after the date loop). It prints the [ticker-quality]
	@#      lines and writes the optional sim CSV. It never writes
	@#      lottery_ticker_stats: the live stats come from the
	@#      refit-lottery-ticker-stats cron (see spec
	@#      lottery-inversion-quality-filter-2026-05-19.md).
	$(PYTHON) scripts/enrich_lottery_outcomes.py --all-unenriched --parquet-dir "$(PARQUET_DIR)"
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 5/5 (cont.) — enrich_silent_boom_outcomes.py --all-unenriched"
	@echo "════════════════════════════════════════════════════════════════"
	@# Idempotent (WHERE enriched_at IS NULL). Populates peak_ceiling_pct,
	@# minutes_to_peak, realized_{30,60,120}m_pct, realized_eod_pct on
	@# silent_boom_alerts from the same per-day *-trades.parquet that the
	@# lottery enrichment uses. --all-unenriched scopes the date list to
	@# dates with pending rows (matches the lottery target's behavior so
	@# manual backfills get picked up regardless of when they landed).
	$(PYTHON) scripts/enrich_silent_boom_outcomes.py --all-unenriched --parquet-dir "$(PARQUET_DIR)"

refit:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  REFIT (dry runs) — the refit itself runs in the nightly service"
	@echo "════════════════════════════════════════════════════════════════"
	@# The refit runs in the nightly service's lottery-refit step (spec:
	@# docs/superpowers/specs/2026-10-28-nightly-pipeline-automation-design.md,
	@# "Refit" decisions), so both commands here are dry runs: lottery_scoring.py
	@# needs --through and prints the fit without storing it, and
	@# backfill_lottery_scores.py writes nothing without --write. DATE is empty
	@# when no CSV is pending (a bare `make update`), so --through falls back to
	@# today, as the fetch targets do.
	$(PYTHON) ml/src/lottery_scoring.py --through $(or $(DATE),$(shell date +%Y-%m-%d))
	$(PYTHON) scripts/backfill_lottery_scores.py

update: enrich refit
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  UPDATE — daily research refresh (after nightly enrichment)"
	@echo "════════════════════════════════════════════════════════════════"
	@# Prereq `enrich` (with --all-unenriched) guarantees `make nightly update`
	@# enriches every pending alert across all dates, including any inserted
	@# by manual backfills after nightly's per-CSV loop ran. Idempotent —
	@# if everything is already enriched it's a no-op DB query.
	@# Each script auto-detects the latest enriched fire date from the
	@# DB and writes a date-stamped report to docs/tmp/ so day-over-day
	@# diffs are easy. The CSV tracker keeps a one-line-per-day rollup
	@# of the headline metrics for trend charting.
	@#
	@# Total runtime ~3-4 min: most of it is `flow_inversion_timing.py`,
	@# which re-runs the simulate_flow_inversion algorithm against every
	@# enriched fire to capture inversion timestamps (parquet replay).
	$(PYTHON) scripts/exit_policy_search.py --parquet-dir "$(PARQUET_DIR)"
	$(PYTHON) scripts/feature_audit.py
	$(PYTHON) scripts/flow_inversion_timing.py --parquet-dir "$(PARQUET_DIR)"
	$(PYTHON) scripts/daily_tracker.py
	@# Outcome-mining + score-lineage feedback loop (spec: lottery-
	@# outcome-mining-and-lineage-2026-05-22). Surfaces interaction
	@# composites and per-component DOW attribution. Read-only: writes
	@# only to docs/tmp/, never touches the score column. Adds ~2 min.
	$(PYTHON) scripts/mine_outcome_patterns.py
	$(PYTHON) scripts/score_lineage_audit.py
	@# TAKE-IT drift monitor — scores freshly-promoted bundle against the
	@# rolling enriched window. Writes docs/tmp/takeit-drift-YYYY-MM-DD.md
	@# + ml/plots/takeit-drift/reliability_<feed>_<date>.png.
	$(MAKE) --no-print-directory takeit-drift
	@echo ""
	@echo "  ✅ daily research artifacts:"
	@echo "     docs/tmp/lottery-exit-policy-search-YYYY-MM-DD.md"
	@echo "     docs/tmp/lottery-feature-audit-YYYY-MM-DD.md"
	@echo "     docs/tmp/flow-inversion-timing-YYYY-MM-DD.md"
	@echo "     docs/tmp/lottery-tracking.csv  (cumulative one-row-per-day)"
	@echo "     docs/tmp/lottery-composite-candidates-YYYY-MM-DD.md  (mining)"
	@echo "     docs/tmp/lottery-score-lineage-YYYY-MM-DD.md  (attribution)"
	@echo "     docs/tmp/takeit-drift-YYYY-MM-DD.md  (drift monitor report)"
	@echo "     ml/plots/takeit-drift/reliability_<feed>_YYYY-MM-DD.png"

takeit-drift:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  TAKEIT-DRIFT — daily TAKE-IT AUC + reliability drift monitor"
	@echo "════════════════════════════════════════════════════════════════"
	@# Reads enriched lottery_finder_fires + takeit_score_log from Postgres,
	@# computes rolling AUC + reliability curves per feed (lottery/silent_boom),
	@# writes docs/tmp/takeit-drift-YYYY-MM-DD.md + reliability PNGs to
	@# ml/plots/takeit-drift/, and persists ml_-prefixed metrics to
	@# takeit_health_daily. Invoked directly from `make update` after refit.
	@if [[ ! -f "$(ENV_FILE)" ]]; then \
	  echo "  ❌ $(ENV_FILE) not found — needed for DATABASE_URL"; \
	  exit 2; \
	fi
	set -a && source $(ENV_FILE) && set +a && \
	  $(PYTHON) ml/src/takeit_drift_monitor.py

tune:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  TUNE — flow-inversion parameter grid (heavy, ~25m)"
	@echo "════════════════════════════════════════════════════════════════"
	@# 84 (prom × window × persist) combos × 63K fires per mode. Pure-
	@# Python loops — slow but cache-warm-friendly. Run weekly: the
	@# answer doesn't move on a single new day of data.
	$(PYTHON) scripts/tune_flow_inversion.py --parquet-dir "$(PARQUET_DIR)"

# Manually download the UW Full Tape zip for inspection / future research.
#
# IMPORTANT: This is NOT the same feed as the manually-downloaded
# bot-eod-report CSV that `nightly` consumes. The Full Tape is the raw
# transaction tape (40 cols, includes per-side vol breakdown + trade IDs)
# while the bot-eod-report is UW's enriched product (30 cols, includes
# `side`, `equity_type`, `sector` derivations not in the raw tape).
# `ingest-flow.py` will hard-fail if pointed at a Full Tape CSV.
#
# Defaults DATE to today (local) when not provided. Idempotent: skips
# if the target CSV already exists.
download-fulltape:
	@FETCH_DATE="$(DATE)"; \
	if [[ -z "$$FETCH_DATE" ]]; then FETCH_DATE=$$(date +%Y-%m-%d); fi; \
	echo ""; \
	echo "════════════════════════════════════════════════════════════════"; \
	echo "  STEP 0 — download-fulltape (UW Full Tape → CSV) for $$FETCH_DATE"; \
	echo "════════════════════════════════════════════════════════════════"; \
	if [[ ! -f "$(ENV_FILE)" ]]; then \
	  echo "  ❌ $(ENV_FILE) not found — needed for UW_API_KEY"; \
	  exit 2; \
	fi; \
	set -a && source $(ENV_FILE) && set +a && \
	  bash scripts/download-fulltape.sh "$$FETCH_DATE"

# Download + ingest the UW Full Tape into the auxiliary parquet archive.
# Standalone — runnable on its own to retry after a UW posting lag, and
# also hooked into `nightly` as a best-effort final step (soft-fail). The
# download step is idempotent: if today's CSV is already present it skips
# the HTTP fetch. The ingest writes
# ~/Desktop/Eod-Full-Tape-parquet/{date}-fulltape.parquet and deletes the
# source CSV on success (unless --keep-csv was passed manually).
ingest-fulltape:
	@FETCH_DATE="$(DATE)"; \
	if [[ -z "$$FETCH_DATE" ]]; then FETCH_DATE=$$(date +%Y-%m-%d); fi; \
	echo ""; \
	echo "════════════════════════════════════════════════════════════════"; \
	echo "  STEP — ingest-fulltape (UW Full Tape → CSV → Parquet) for $$FETCH_DATE"; \
	echo "════════════════════════════════════════════════════════════════"; \
	if [[ ! -f "$(ENV_FILE)" ]]; then \
	  echo "  ❌ $(ENV_FILE) not found — needed for UW_API_KEY"; \
	  exit 2; \
	fi; \
	set -a && source $(ENV_FILE) && set +a && \
	  bash scripts/download-fulltape.sh "$$FETCH_DATE" && \
	  $(PYTHON) scripts/ingest-fulltape.py "$$FETCH_DATE" && \
	  if [[ "$(SKIP_R2)" == "1" ]]; then \
	    echo "  ⏭  SKIP_R2=1 set — parquet stays local, R2 push skipped"; \
	  else \
	    echo ""; \
	    echo "════════════════════════════════════════════════════════════════"; \
	    echo "  STEP — push to Cloudflare R2 (idempotent, only new files upload)"; \
	    echo "════════════════════════════════════════════════════════════════"; \
	    $(PYTHON) scripts/upload-fulltape-to-r2.py; \
	  fi

# Resume target — `plots + enrich` only. Useful when the CSV has
# already been consumed by `ingest` in a previous invocation but the
# parquet is still on disk. `nightly` auto-dispatches into this when
# the CSV gate fails but a parquet exists.
nightly-resume: plots enrich
	@# No prereq on the CSV — assumes ingest already happened. Regenerate the
	@# cumulative rollup too, so a parquet-only resume produces the same closing
	@# artifacts as a full CSV run. Idempotent: reads the by-day parquets only.
	$(PYTHON) scripts/eod-flow-analysis/analyze.py --rollup-only

# Cumulative rollup over every by-day parquet. Its own target so the `nightly`
# lines below reach it through $(MAKE): `make -n` runs a recipe line that
# contains $(MAKE) for real, so a bare python call on such a line would run
# too, while a sub-make inherits -n and only prints.
rollup:
	$(PYTHON) scripts/eod-flow-analysis/analyze.py --rollup-only

# Every step below runs as `$(MAKE) … || { warn; touch sentinel; }`, so a
# failure under .SHELLFLAGS' -e can't end its line early: the rest of the
# closing pass and ingest-fulltape still run, and the final check exits 1.
nightly:
	@# Start clean: a sentinel left by an earlier, interrupted run must not
	@# fail this one.
	@rm -f "$(NIGHTLY_FAIL_SENTINEL)"
ifdef DATE_EXPLICIT
	@echo "→ DATE=$(DATE) (explicit override) — single-date pipeline"
	@if [[ -f "$(CSV_PATH)" ]]; then \
	  $(MAKE) --no-print-directory nightly-one DATE=$(DATE) || { echo "⚠️  nightly-one $(DATE) failed" >&2; touch "$(NIGHTLY_FAIL_SENTINEL)"; }; \
	  echo ""; \
	  echo "═══ Closing pass (cumulative rollup + plots) ═══"; \
	  $(MAKE) --no-print-directory rollup || { echo "⚠️  rollup failed" >&2; touch "$(NIGHTLY_FAIL_SENTINEL)"; }; \
	  $(MAKE) --no-print-directory plots || { echo "⚠️  plots failed" >&2; touch "$(NIGHTLY_FAIL_SENTINEL)"; }; \
	elif ls -1 "$(PARQUET_DIR)"/$(DATE)-trades.parquet >/dev/null 2>&1; then \
	  echo "  CSV gone but parquet on disk — replaying parquet for $(DATE) (idempotent)"; \
	  $(MAKE) --no-print-directory enrich-one DATE=$(DATE) || { echo "⚠️  enrich-one $(DATE) failed" >&2; touch "$(NIGHTLY_FAIL_SENTINEL)"; }; \
	  echo ""; \
	  echo "═══ Closing pass (cumulative rollup + plots) ═══"; \
	  $(MAKE) --no-print-directory rollup || { echo "⚠️  rollup failed" >&2; touch "$(NIGHTLY_FAIL_SENTINEL)"; }; \
	  $(MAKE) --no-print-directory plots || { echo "⚠️  plots failed" >&2; touch "$(NIGHTLY_FAIL_SENTINEL)"; }; \
	else \
	  echo "❌ Neither $(CSV_PATH) nor $(PARQUET_DIR)/$(DATE)-trades.parquet exists."; \
	  exit 2; \
	fi
else
	@if [[ -n "$(PENDING_DATES)" ]]; then \
	  count=$$(echo "$(PENDING_DATES)" | wc -w | tr -d ' '); \
	  echo "→ Found $$count pending CSV(s) in $(INPUT_DIR):"; \
	  for d in $(PENDING_DATES); do echo "   • $$d"; done; \
	  failed_dates=""; \
	  for d in $(PENDING_DATES); do \
	    echo ""; \
	    echo "▶▶▶ Processing $$d ◀◀◀"; \
	    if ! $(MAKE) --no-print-directory nightly-one DATE=$$d; then \
	      echo "⚠️  $$d FAILED after retries — isolating, continuing with remaining dates" >&2; \
	      failed_dates="$$failed_dates $$d"; \
	      touch "$(NIGHTLY_FAIL_SENTINEL)"; \
	    fi; \
	  done; \
	  echo ""; \
	  echo "═══ Closing pass (cumulative rollup + plots, once across all dates) ═══"; \
	  $(MAKE) --no-print-directory rollup || { echo "⚠️  rollup failed" >&2; touch "$(NIGHTLY_FAIL_SENTINEL)"; }; \
	  $(MAKE) --no-print-directory plots || { echo "⚠️  plots failed" >&2; touch "$(NIGHTLY_FAIL_SENTINEL)"; }; \
	  if [[ -n "$$failed_dates" ]]; then \
	    echo "" >&2; \
	    echo "⚠️  Nightly completed with FAILED date(s):$$failed_dates" >&2; \
	    echo "   The closing pass ran on the dates that succeeded; failed dates'" >&2; \
	    echo "   enrichment is retried by 'make update' (--all-unenriched). To re-run" >&2; \
	    echo "   one date in full: make nightly DATE=YYYY-MM-DD" >&2; \
	  fi; \
	elif ls -1 "$(PARQUET_DIR)"/*-trades.parquet >/dev/null 2>&1; then \
	  echo "→ No CSV in $(INPUT_DIR), but parquet already on disk in $(PARQUET_DIR)"; \
	  echo "  (CSV was consumed by a previous invocation — running plots + enrich only)"; \
	  $(MAKE) --no-print-directory nightly-resume || { echo "⚠️  nightly-resume failed" >&2; touch "$(NIGHTLY_FAIL_SENTINEL)"; }; \
	else \
	  echo "❌ No CSV in $(INPUT_DIR) and no parquet in $(PARQUET_DIR)."; \
	  echo "   Drop a bot-eod-report-YYYY-MM-DD.csv first."; \
	  exit 2; \
	fi
endif
	@# Best-effort capture of UW's Full Tape into the parallel parquet archive.
	@# Soft-fails: a UW posting lag, network blip, or schema drift logs a warning
	@# but does NOT abort `nightly` and does NOT block a chained `make update`.
	@# Re-run via `make ingest-fulltape` once UW posts.
	$(MAKE) --no-print-directory ingest-fulltape || echo "⚠️  Full Tape ingest failed (UW lag or network); re-run with 'make ingest-fulltape' after UW posts. Bot-eod pipeline succeeded."
	@# Surface the failures isolated above. The closing pass + Full Tape have
	@# already run; exit non-zero now so the failure is visible (CI / shell
	@# exit code) without having aborted the rest of the night. The sentinel
	@# file carries the flag across recipe-line shell boundaries (each line is
	@# its own shell). Any failed step sets it, on every path: a per-date
	@# pipeline, the parquet replay or resume, rollup, plots. The first line
	@# of the recipe clears it.
	@if [[ -f "$(NIGHTLY_FAIL_SENTINEL)" ]]; then \
	  rm -f "$(NIGHTLY_FAIL_SENTINEL)"; \
	  echo "❌ nightly: one or more steps failed (see the ⚠️ lines above)." >&2; \
	  exit 1; \
	fi

# Per-date inner pipeline. Called once per pending CSV by `nightly`, or directly
# by `nightly DATE=YYYY-MM-DD`. Per-date steps are analyze, ingest and enrich —
# because enrich_lottery_outcomes.py is a single-date script (it picks the latest
# parquet via detect_latest_date() if no --date is passed). Only `plots` is a
# true cross-date aggregator and runs once in `nightly`'s closing pass.
#
# Per-date `analyze` passes --no-rollup; the cumulative rollup is regenerated
# once at the end of the loop in `nightly`'s closing pass.
# analyze-one goes first and needs the day's tape in R2 (it lands after the
# 07:15 UTC Railway run): an earlier run fails the date with its CSV kept, and
# a re-run completes it.
nightly-one:
	@if [[ -z "$(DATE)" ]]; then \
	  echo "❌ nightly-one requires DATE=YYYY-MM-DD"; \
	  exit 2; \
	fi
	@if [[ ! -f "$(CSV_PATH)" ]]; then \
	  echo "❌ CSV not found for DATE=$(DATE): $(CSV_PATH)"; \
	  exit 2; \
	fi
	@$(MAKE) --no-print-directory analyze-one ingest enrich-one DATE=$(DATE)

# Per-date analyze that skips the cumulative rollup (rollup runs once in the
# closing pass). Differs from `analyze` only by the --no-rollup flag.
analyze-one: check-r2-env
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 1/4 — analyze.py --no-rollup (per-day parquet aggregate, tape from R2)"
	@echo "════════════════════════════════════════════════════════════════"
	set -a && source $(ENV_FILE) && set +a && $(PYTHON) scripts/eod-flow-analysis/analyze.py --day $(DATE) --no-rollup --r2

# Per-date enrich. Wraps `enrich` to pass --date so each backlogged date
# enriches its own lottery_finder_fires rows. enrich_silent_boom_outcomes.py
# already iterates internally, so we pass --date there too to scope it.
enrich-one:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 4/4 — enrich_lottery_outcomes.py --date $(DATE)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) scripts/enrich_lottery_outcomes.py --date $(DATE) --parquet-dir "$(PARQUET_DIR)"
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 4/4 (cont.) — enrich_silent_boom_outcomes.py --date $(DATE)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) scripts/enrich_silent_boom_outcomes.py --date $(DATE) --parquet-dir "$(PARQUET_DIR)"

dry-run: check-r2-env
	@# Intentionally omits `enrich` — dry-run skips DB writes by contract.
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  DRY RUN — analyze (tape from R2) + ingest --keep-csv + plots"
	@echo "  CSV is kept; nothing is uploaded (the Blob flow/ copy is retired)."
	@echo "════════════════════════════════════════════════════════════════"
	set -a && source $(ENV_FILE) && set +a && $(PYTHON) scripts/eod-flow-analysis/analyze.py --day $(DATE) --r2
	$(PYTHON) scripts/ingest-flow.py $(DATE) --keep-csv \
	  --input-dir "$(INPUT_DIR)" --archive-dir "$(PARQUET_DIR)"
	$(PYTHON) ml/src/whale_plots.py
	@echo ""
	@echo "✅ Dry run complete — no CSV deletion."

clean:
	@echo 'Nothing to clean: no new by-day parquet or report is committed; only the plots stay tracked (`make plots` rewrites them).'

# Build-cache canary: compare the deployed API's baked-in SHA to the
# local git HEAD. A mismatch means Vercel served a stale Function
# bundle (see feat(observability) commits 08da74f9 / 03e34fd4).
# Override the domain with PROD_URL=https://...
PROD_URL ?= https://theta-options.com

version:
	@# `|| true`: under .SHELLFLAGS' -e + pipefail a failed curl would end the
	@# line before it reports; an empty api_sha prints as a mismatch instead.
	@local_sha=$$(git rev-parse --short=7 HEAD); \
	api_sha=$$(curl -fsS $(PROD_URL)/api/version | sed -nE 's/.*"sha":"([^"]+)".*/\1/p' || true); \
	echo ""; \
	echo "  local HEAD : $$local_sha"; \
	echo "  api SHA    : $$api_sha"; \
	if [[ "$$local_sha" == "$$api_sha" ]]; then \
	  echo "  ✅ match"; \
	else \
	  echo "  ⚠️  mismatch — either pre-deploy or Vercel served a stale Function bundle"; \
	fi; \
	echo "  PROD_URL=$(PROD_URL) (override with PROD_URL=https://...)"

# Flip the active TAKE-IT bundle in the loader manifest without redeploying.
#
# Read-only (show current manifest):
#   make takeit-rollback
#
# Flip one feed:
#   make takeit-rollback FEED=lottery PATH_OVERRIDE=takeit/lottery-v2026-05-10.json
#   make takeit-rollback FEED=silentboom PATH_OVERRIDE=takeit/silentboom-v2026-05-10.json
#
# Dry-run (print what would be written, no Blob write):
#   make takeit-rollback FEED=lottery PATH_OVERRIDE=takeit/lottery-v2026-05-10.json DRY_RUN=1

takeit-rollback:
	@if [[ ! -f "$(ENV_FILE)" ]]; then \
	  echo "  ❌ $(ENV_FILE) not found — needed for BLOB_READ_WRITE_TOKEN"; \
	  exit 2; \
	fi
	@set -a && source $(ENV_FILE) && set +a && \
		FEED=$(FEED) PATH_OVERRIDE=$(PATH_OVERRIDE) DRY_RUN=$(DRY_RUN) \
		node scripts/takeit-rollback.mjs

# Backfill takeit_prob + takeit_model_version on historical rows that were
# inserted before the TAKE-IT scorer was wired into the detect crons.
# Uses the production scoring code path (scoreLottery / scoreSilentBoom)
# for parity — no Python drift risk.
#
# Idempotent (WHERE takeit_prob IS NULL), resumable, batched (2000 rows).
# Writes a timestamped log to scripts/output/backfill-takeit-<runId>.log.
#
# Usage:
#   make takeit-backfill                          # both feeds
#   make takeit-backfill FEED=lottery
#   make takeit-backfill FEED=silent_boom SINCE=2026-03-01 LIMIT=10000

FEED          ?=
SINCE         ?=
LIMIT         ?=

takeit-backfill:
	@if [[ ! -f "$(ENV_FILE)" ]]; then \
	  echo "  ❌ $(ENV_FILE) not found — needed for DATABASE_URL"; \
	  exit 2; \
	fi
	@set -a && source $(ENV_FILE) && set +a && \
		FEED=$(FEED) SINCE=$(SINCE) LIMIT=$(LIMIT) \
		npx tsx scripts/backfill-takeit-scores.mjs

# Python test coverage — fan out across all three Python projects (fail-fast).
# The `npm run test:coverage` analogue for the Python side. Each project has its
# own .venv and its own pytest config, so this cd's into each and uses that
# project's interpreter (VENV_BIN picks bin/ or Scripts/). Every recipe line
# runs in its own shell and make stops at the first line that fails — so the
# FIRST project whose tests or coverage gate fail aborts the whole target
# (fail-fast, no extra plumbing).
#
#   ml / sidecar  delegate to each project's own `test-cov` target so the
#                 coverage flags stay single-sourced in the sub-Makefile.
#   uw-stream     no Makefile and no cov in addopts, so the flags are passed here.
py-test-cov:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  PY-TEST-COV 1/3 — ml"
	@echo "════════════════════════════════════════════════════════════════"
	$(MAKE) --no-print-directory -C ml test-cov
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  PY-TEST-COV 2/3 — sidecar"
	@echo "════════════════════════════════════════════════════════════════"
	$(MAKE) --no-print-directory -C sidecar test-cov
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  PY-TEST-COV 3/3 — uw-stream"
	@echo "════════════════════════════════════════════════════════════════"
	cd uw-stream && .venv/$(VENV_BIN)/python -m pytest tests/ --cov=src --cov-report=term-missing
	@echo ""
	@echo "  ✅ all three Python suites passed with coverage"
