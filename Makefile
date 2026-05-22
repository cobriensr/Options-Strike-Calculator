# Makefile — EOD options-flow pipeline
#
# Default usage (after dropping new CSV(s) into ~/Downloads/EOD-OptionFlow/):
#
#     make nightly
#
# Iterates every pending bot-eod-report-YYYY-MM-DD.csv (sorted ascending) and
# runs analyze + ingest per-date, then a single closing pass of
# plots + backfill-flow + enrich + ingest-fulltape. Run as
# `make nightly update` to chain the research refresh after.
#
# Per-date steps (run for each pending CSV):
#   1. analyze.py   — per-day parquet aggregate at scripts/eod-flow-analysis/output/by-day/
#   2. ingest-flow  — full unfiltered archive parquet to ~/Desktop/Bot-Eod-parquet/,
#                     filtered parquet uploaded to Vercel Blob, source CSV deleted on success
#
# Closing pass (run once at the end):
#   3. whale_plots  — regenerates all 13 visualizations under ml/plots/whale-detection/
#                     (aggregator across every parquet — wasteful to run per-iteration)
#   4. backfill-flow — UW REST → Postgres net-flow history
#   5. enrich       — replays the EOD parquets against unenriched
#                     lottery_finder_fires AND silent_boom_alerts rows
#   6. ingest-fulltape — best-effort UW Full Tape capture (soft-fail)
#
# Override the date with DATE=YYYY-MM-DD to run the single-date pipeline:
#     make nightly DATE=2026-04-29
#
# Override the input directory with INPUT_DIR=...
#     make nightly INPUT_DIR=/path/to/csvs

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.ONESHELL:

PYTHON      := ml/.venv/bin/python
INPUT_DIR   ?= $(HOME)/Downloads/EOD-OptionFlow
PARQUET_DIR ?= $(HOME)/Desktop/Bot-Eod-parquet
INPUT_DIR_FULLTAPE   ?= $(HOME)/Downloads/EOD-FullTape
PARQUET_DIR_FULLTAPE ?= $(HOME)/Desktop/Eod-Full-Tape-parquet
ENV_FILE    := .env.local

# Every bot-eod-report-YYYY-MM-DD.csv in INPUT_DIR, ascending.
PENDING_DATES := $(shell ls -1 $(INPUT_DIR)/bot-eod-report-*.csv 2>/dev/null \
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

.PHONY: help nightly nightly-one nightly-resume analyze ingest plots backfill-flow enrich refit update tune check dry-run clean download-fulltape ingest-fulltape version

help:
	@echo "EOD options-flow pipeline targets:"
	@echo ""
	@echo "  make nightly                  Iterate every pending CSV in INPUT_DIR (ascending)."
	@echo "                                Per-date: analyze --no-rollup, ingest, backfill-flow,"
	@echo "                                enrich-lottery, enrich-silent-boom. Closing pass:"
	@echo "                                cumulative rollup + plots + best-effort fulltape."
	@echo "                                Auto-falls-back to plots+enrich if no CSV is pending"
	@echo "                                but parquets are on disk (CSV consumed by a previous"
	@echo "                                invocation). Run as 'make nightly update' to chain the"
	@echo "                                research refresh after."
	@echo "  make nightly DATE=YYYY-MM-DD  Run pipeline for one specific date (no loop)"
	@echo "  make download-fulltape        Download UW Full Tape zip → ~/Downloads/EOD-FullTape/"
	@echo "                                fulltape-DATE.csv (40-col raw tape, separate schema"
	@echo "                                from bot-eod-report). Feeds 'make ingest-fulltape'."
	@echo "  make ingest-fulltape          Download + convert UW Full Tape CSV → parquet"
	@echo "                                (auxiliary archive; ~/Desktop/Eod-Full-Tape-parquet)"
	@echo "  make analyze                  EDA only (does NOT delete the CSV)"
	@echo "  make ingest                   CSV → parquet → Blob upload + delete CSV"
	@echo "  make plots                    Regenerate visualizations only (no CSV needed)"
	@echo "  make enrich                   Backfill lottery_finder_fires + silent_boom_alerts realized_*_pct from EOD parquet"
	@echo "  make refit                    Refit lottery score weights from enriched fires + backfill score column"
	@echo "  make update                   Run after \`make nightly\`: refit + exit-policy search +"
	@echo "                                feature audit + flow-inversion timing + tracker CSV. ~3-4m,"
	@echo "                                designed to run nightly so day-over-day drift is captured."
	@echo "  make tune                     Heavy parameter grid for flow-inversion (~25m). Run weekly,"
	@echo "                                not nightly — same dataset every night doesn't move the answer."
	@echo "  make dry-run                  Run analyze + ingest --dry-run + plots"
	@echo "  make check                    Sanity-check date detection and env"
	@echo ""
	@echo "Detected:"
	@echo "  DATE       = $(DATE)"
	@echo "  CSV_PATH   = $(CSV_PATH)"
	@echo "  INPUT_DIR  = $(INPUT_DIR)"

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
	@if [[ ! -f "$(ENV_FILE)" ]]; then \
	  echo "  ❌ $(ENV_FILE) not found — needed for BLOB_READ_WRITE_TOKEN"; \
	  exit 2; \
	fi
	@if [[ ! -x "$(PYTHON)" ]]; then \
	  echo "  ❌ Python venv not found at $(PYTHON)"; \
	  exit 2; \
	fi
	@echo "  ✅ DATE       = $(DATE)"
	@echo "  ✅ CSV_PATH   = $(CSV_PATH) ($$(du -h "$(CSV_PATH)" | cut -f1))"
	@echo "  ✅ Python     = $(PYTHON)"
	@echo "  ✅ Env file   = $(ENV_FILE)"

analyze: check
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 1/4 — analyze.py (EDA + per-day parquet aggregate)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) scripts/eod-flow-analysis/analyze.py --day $(DATE)

ingest: check
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 2/4 — ingest-flow.py (CSV → Archive → Parquet → Blob → delete CSV)"
	@echo "════════════════════════════════════════════════════════════════"
	set -a && source $(ENV_FILE) && set +a && \
	  $(PYTHON) scripts/ingest-flow.py $(DATE)

plots:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 3/4 — whale_plots.py (13 visualizations)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) ml/src/whale_plots.py

backfill-flow:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 4/5 — backfill_net_flow_history.py (UW REST → Postgres)"
	@echo "════════════════════════════════════════════════════════════════"
	@# Idempotent (ON CONFLICT DO NOTHING). Mirrors the Vercel cron
	@# fetch-net-flow-history; runs locally so flow-inversion can compute
	@# even when the deployed cron silently fails.
	$(PYTHON) scripts/backfill_net_flow_history.py

enrich:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 5/5 — enrich_lottery_outcomes.py (replay parquet → Postgres)"
	@echo "════════════════════════════════════════════════════════════════"
	@# Auto-detects the date from the latest *-trades.parquet so this
	@# still works after `ingest` has deleted the source CSV (which makes
	@# `$(DATE)` resolve to empty here). Three passes:
	@#   1. trail/hard/tier50/peak/eod/min_to_peak from parquet
	@#   2. flow_inversion from parquet NBBO mids + net_flow_per_ticker_history
	@#   3. per-ticker inversion-quality refit (Wilson LCB + quintile) into
	@#      lottery_ticker_stats. Gated by WRITE_DB=1; staleness >3 days
	@#      raises a Sentry warning from the next /api/cron/refresh-vix1d
	@#      run (see spec lottery-inversion-quality-filter-2026-05-19.md).
	WRITE_DB=1 $(PYTHON) scripts/enrich_lottery_outcomes.py
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 5/5 (cont.) — enrich_silent_boom_outcomes.py"
	@echo "════════════════════════════════════════════════════════════════"
	@# Idempotent (WHERE enriched_at IS NULL). Populates peak_ceiling_pct,
	@# minutes_to_peak, realized_{30,60,120}m_pct, realized_eod_pct on
	@# silent_boom_alerts from the same per-day *-trades.parquet that the
	@# lottery enrichment uses. Mirrors that script's auto-date enumeration.
	$(PYTHON) scripts/enrich_silent_boom_outcomes.py

refit:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  REFIT — recompute ticker weights + backfill scores"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) ml/src/lottery_scoring.py
	$(PYTHON) scripts/sync_lottery_score_weights.py
	$(PYTHON) scripts/backfill_lottery_scores.py

update: refit
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  UPDATE — daily research refresh (after nightly enrichment)"
	@echo "════════════════════════════════════════════════════════════════"
	@# Each script auto-detects the latest enriched fire date from the
	@# DB and writes a date-stamped report to docs/tmp/ so day-over-day
	@# diffs are easy. The CSV tracker keeps a one-line-per-day rollup
	@# of the headline metrics for trend charting.
	@#
	@# Total runtime ~3-4 min: most of it is `flow_inversion_timing.py`,
	@# which re-runs the simulate_flow_inversion algorithm against every
	@# enriched fire to capture inversion timestamps (parquet replay).
	$(PYTHON) scripts/exit_policy_search.py
	$(PYTHON) scripts/feature_audit.py
	$(PYTHON) scripts/flow_inversion_timing.py
	$(PYTHON) scripts/daily_tracker.py
	@echo ""
	@echo "  ✅ daily research artifacts:"
	@echo "     docs/tmp/lottery-exit-policy-search-YYYY-MM-DD.md"
	@echo "     docs/tmp/lottery-feature-audit-YYYY-MM-DD.md"
	@echo "     docs/tmp/flow-inversion-timing-YYYY-MM-DD.md"
	@echo "     docs/tmp/lottery-tracking.csv  (cumulative one-row-per-day)"

tune:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  TUNE — flow-inversion parameter grid (heavy, ~25m)"
	@echo "════════════════════════════════════════════════════════════════"
	@# 84 (prom × window × persist) combos × 63K fires per mode. Pure-
	@# Python loops — slow but cache-warm-friendly. Run weekly: the
	@# answer doesn't move on a single new day of data.
	$(PYTHON) scripts/tune_flow_inversion.py

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
nightly-resume: plots backfill-flow enrich
	@# No prereq on the CSV — assumes ingest already happened.

nightly:
ifdef DATE_EXPLICIT
	@echo "→ DATE=$(DATE) (explicit override) — single-date pipeline"
	@if [[ -f "$(CSV_PATH)" ]]; then \
	  $(MAKE) --no-print-directory nightly-one DATE=$(DATE); \
	  echo ""; \
	  echo "═══ Closing pass (cumulative rollup + plots) ═══"; \
	  $(PYTHON) scripts/eod-flow-analysis/analyze.py --rollup-only; \
	  $(MAKE) --no-print-directory plots; \
	elif ls -1 $(PARQUET_DIR)/$(DATE)-trades.parquet >/dev/null 2>&1; then \
	  echo "  CSV gone but parquet on disk — running backfill-flow + enrich + plots only for $(DATE)"; \
	  $(MAKE) --no-print-directory backfill-flow-one enrich-one plots DATE=$(DATE); \
	else \
	  echo "❌ Neither $(CSV_PATH) nor $(PARQUET_DIR)/$(DATE)-trades.parquet exists."; \
	  exit 2; \
	fi
else
	@if [[ -n "$(PENDING_DATES)" ]]; then \
	  count=$$(echo "$(PENDING_DATES)" | wc -w | tr -d ' '); \
	  echo "→ Found $$count pending CSV(s) in $(INPUT_DIR):"; \
	  for d in $(PENDING_DATES); do echo "   • $$d"; done; \
	  for d in $(PENDING_DATES); do \
	    echo ""; \
	    echo "▶▶▶ Processing $$d ◀◀◀"; \
	    $(MAKE) --no-print-directory nightly-one DATE=$$d; \
	  done; \
	  echo ""; \
	  echo "═══ Closing pass (cumulative rollup + plots, once across all dates) ═══"; \
	  $(PYTHON) scripts/eod-flow-analysis/analyze.py --rollup-only; \
	  $(MAKE) --no-print-directory plots; \
	elif ls -1 $(PARQUET_DIR)/*-trades.parquet >/dev/null 2>&1; then \
	  echo "→ No CSV in $(INPUT_DIR), but parquet already on disk in $(PARQUET_DIR)"; \
	  echo "  (CSV was consumed by a previous invocation — running plots + backfill-flow + enrich only)"; \
	  $(MAKE) --no-print-directory nightly-resume; \
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

# Per-date inner pipeline. Called once per pending CSV by `nightly`, or directly
# by `nightly DATE=YYYY-MM-DD`. Per-date steps are analyze, ingest, backfill-flow,
# and enrich — because backfill_net_flow_history.py and enrich_lottery_outcomes.py
# are single-date scripts (they pick the latest parquet via detect_latest_date()
# if no --date is passed). Only `plots` is a true cross-date aggregator and runs
# once in `nightly`'s closing pass.
#
# Per-date `analyze` passes --no-rollup; the cumulative rollup is regenerated
# once at the end of the loop in `nightly`'s closing pass.
nightly-one:
	@if [[ -z "$(DATE)" ]]; then \
	  echo "❌ nightly-one requires DATE=YYYY-MM-DD"; \
	  exit 2; \
	fi
	@if [[ ! -f "$(CSV_PATH)" ]]; then \
	  echo "❌ CSV not found for DATE=$(DATE): $(CSV_PATH)"; \
	  exit 2; \
	fi
	@$(MAKE) --no-print-directory analyze-one ingest backfill-flow-one enrich-one DATE=$(DATE)

# Per-date analyze that skips the cumulative rollup (rollup runs once in the
# closing pass). Differs from `analyze` only by the --no-rollup flag.
analyze-one: check
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 1/4 — analyze.py --no-rollup (per-day parquet aggregate)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) scripts/eod-flow-analysis/analyze.py --day $(DATE) --no-rollup

# Per-date backfill of the net-prem-ticks history. Wraps backfill-flow with
# an explicit --date so the loop iterates correctly instead of fetching the
# latest parquet's date every iteration.
backfill-flow-one:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 4/5 — backfill_net_flow_history.py --date $(DATE)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) scripts/backfill_net_flow_history.py --date $(DATE)

# Per-date enrich. Wraps `enrich` to pass --date so each backlogged date
# enriches its own lottery_finder_fires rows. enrich_silent_boom_outcomes.py
# already iterates internally, so we pass --date there too to scope it.
enrich-one:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 5/5 — enrich_lottery_outcomes.py --date $(DATE)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) scripts/enrich_lottery_outcomes.py --date $(DATE)
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 5/5 (cont.) — enrich_silent_boom_outcomes.py --date $(DATE)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) scripts/enrich_silent_boom_outcomes.py --date $(DATE)

dry-run: check
	@# Intentionally omits `enrich` — dry-run skips DB writes by contract.
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  DRY RUN — analyze + ingest --dry-run + plots"
	@echo "  CSV will NOT be uploaded or deleted."
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) scripts/eod-flow-analysis/analyze.py --day $(DATE)
	$(PYTHON) scripts/ingest-flow.py $(DATE) --dry-run --keep-csv
	$(PYTHON) ml/src/whale_plots.py
	@echo ""
	@echo "✅ Dry run complete — no upload, no CSV deletion."

clean:
	@echo "Nothing to clean (parquets are tracked in git, plots are tracked in git)."

# Build-cache canary: compare the deployed API's baked-in SHA to the
# local git HEAD. A mismatch means Vercel served a stale Function
# bundle (see feat(observability) commits 08da74f9 / 03e34fd4).
# Override the domain with PROD_URL=https://...
PROD_URL ?= https://theta-options.com

version:
	@local_sha=$$(git rev-parse --short=7 HEAD); \
	api_sha=$$(curl -fsS $(PROD_URL)/api/version | sed -nE 's/.*"sha":"([^"]+)".*/\1/p'); \
	echo ""; \
	echo "  local HEAD : $$local_sha"; \
	echo "  api SHA    : $$api_sha"; \
	if [[ "$$local_sha" == "$$api_sha" ]]; then \
	  echo "  ✅ match"; \
	else \
	  echo "  ⚠️  mismatch — either pre-deploy or Vercel served a stale Function bundle"; \
	fi; \
	echo "  PROD_URL=$(PROD_URL) (override with PROD_URL=https://...)"
