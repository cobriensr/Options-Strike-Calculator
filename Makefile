# Makefile — EOD options-flow pipeline
#
# Default usage (after dropping a new CSV into ~/Downloads/EOD-OptionFlow/):
#
#     make nightly
#
# That runs:
#   1. analyze.py   — produces per-day parquet aggregate at scripts/eod-flow-analysis/output/by-day/
#   2. ingest-flow  — writes a full unfiltered archive parquet to
#                     ~/Desktop/Bot-Eod-parquet/, then writes a filtered
#                     parquet, uploads to Vercel Blob, and deletes the
#                     source CSV only after both writes + upload succeed
#   3. whale_plots  — regenerates all 13 visualizations under ml/plots/whale-detection/
#
# Override the date with DATE=YYYY-MM-DD if needed:
#     make nightly DATE=2026-04-29
#
# Override the input directory with INPUT_DIR=...
#     make nightly INPUT_DIR=/path/to/csvs

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.ONESHELL:

PYTHON      := ml/.venv/bin/python
INPUT_DIR   ?= $(HOME)/Downloads/EOD-OptionFlow
ENV_FILE    := .env.local

# Auto-detect the latest CSV's date if DATE is not provided.
# Looks for files named bot-eod-report-YYYY-MM-DD.csv.
DATE        ?= $(shell ls -1 $(INPUT_DIR)/bot-eod-report-*.csv 2>/dev/null \
                      | sed -nE 's|.*bot-eod-report-([0-9]{4}-[0-9]{2}-[0-9]{2})\.csv|\1|p' \
                      | sort | tail -1)

CSV_PATH    := $(INPUT_DIR)/bot-eod-report-$(DATE).csv

.PHONY: help nightly analyze ingest plots check dry-run clean

help:
	@echo "EOD options-flow pipeline targets:"
	@echo ""
	@echo "  make nightly                  Run full pipeline (analyze → ingest → plots)"
	@echo "  make nightly DATE=YYYY-MM-DD  Run pipeline for a specific date"
	@echo "  make analyze                  EDA only (does NOT delete the CSV)"
	@echo "  make ingest                   CSV → parquet → Blob upload + delete CSV"
	@echo "  make plots                    Regenerate visualizations only (no CSV needed)"
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
	@echo "  STEP 1/3 — analyze.py (EDA + per-day parquet aggregate)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) scripts/eod-flow-analysis/analyze.py --day $(DATE)

ingest: check
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 2/3 — ingest-flow.py (CSV → Archive → Parquet → Blob → delete CSV)"
	@echo "════════════════════════════════════════════════════════════════"
	set -a && source $(ENV_FILE) && set +a && \
	  $(PYTHON) scripts/ingest-flow.py $(DATE)

plots:
	@echo ""
	@echo "════════════════════════════════════════════════════════════════"
	@echo "  STEP 3/3 — whale_plots.py (13 visualizations)"
	@echo "════════════════════════════════════════════════════════════════"
	$(PYTHON) ml/src/whale_plots.py

nightly: analyze ingest plots
	@# Final summary is printed by ml/src/whale_plots.py (the `plots` step) so
	@# the date is sourced from the loaded data, not from `$(DATE)` — which
	@# resolves to empty here because `?= $(shell ls ...)` re-runs after the
	@# CSV has been deleted by `ingest`.

dry-run: check
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
