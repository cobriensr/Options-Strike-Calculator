#!/usr/bin/env bash
#
# Backfill the EOD options flow Parquet archive from local CSVs.
#
# Walks $INPUT_DIR for files matching bot-eod-report-YYYY-MM-DD.csv and
# runs scripts/ingest-flow.py against each in date order. Sequential by
# design: each ingest is dominated by Blob upload throughput, parallelism
# would just contend on the same uplink.
#
# Idempotent via the script's own delete-after-upload behavior — once a
# CSV is gone, it's already in Blob. Pre-existing parquet files at the
# Blob target path will be overwritten (allowOverwrite=true).
#
# Stops on the FIRST failure (set -e + explicit exit). A single bad day
# should not silently skip and corrupt the date sequence — the operator
# decides what to do.
#
# Usage:
#   set -a; source .env.local; set +a       # export BLOB_READ_WRITE_TOKEN
#   bash scripts/backfill-flow.sh            # process all CSVs in default dir
#   bash scripts/backfill-flow.sh --keep-csv # preserve source CSVs
#   bash scripts/backfill-flow.sh --dry-run  # local Parquet only, no upload
#
# Env:
#   INPUT_DIR — defaults to ~/Downloads/EOD-OptionFlow
#   PYTHON    — defaults to ml/.venv/bin/python (the project's ML venv)

set -euo pipefail

INPUT_DIR="${INPUT_DIR:-$HOME/Downloads/EOD-OptionFlow}"
PYTHON="${PYTHON:-ml/.venv/bin/python}"

if [[ ! -d "$INPUT_DIR" ]]; then
  echo "ERROR: input dir not found: $INPUT_DIR" >&2
  exit 2
fi

if [[ ! -x "$PYTHON" ]]; then
  echo "ERROR: Python interpreter not executable: $PYTHON" >&2
  exit 2
fi

# Pre-flight token check unless this is a dry run. Catches the
# missing-env case ONCE upfront instead of failing on every CSV.
if [[ " $* " != *" --dry-run "* ]] && [[ -z "${BLOB_READ_WRITE_TOKEN:-}" ]]; then
  echo "ERROR: BLOB_READ_WRITE_TOKEN not set." >&2
  echo "Run: set -a; source .env.local; set +a" >&2
  exit 2
fi

# Discover CSVs. shopt nullglob so an empty match yields an empty array,
# not the literal pattern. Bash globs are sorted alphabetically by default,
# and the YYYY-MM-DD date format sorts lexicographically — no explicit
# sort needed. Avoid `mapfile` (bash 4+) for macOS-default bash 3.2 compat.
shopt -s nullglob
csv_files=("$INPUT_DIR"/bot-eod-report-*.csv)
shopt -u nullglob

if [[ ${#csv_files[@]} -eq 0 ]]; then
  echo "No CSVs found in $INPUT_DIR — nothing to do."
  exit 0
fi

echo "Found ${#csv_files[@]} CSV(s) to process:"
for f in "${csv_files[@]}"; do
  size=$(du -h "$f" | cut -f1)
  echo "  $(basename "$f")  $size"
done
echo

start_ts=$(date +%s)
processed=0

for csv in "${csv_files[@]}"; do
  base=$(basename "$csv" .csv)
  date_str="${base#bot-eod-report-}"
  if [[ ! "$date_str" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "SKIP malformed filename: $csv" >&2
    continue
  fi
  echo "=== $date_str ==="
  "$PYTHON" scripts/ingest-flow.py "$date_str" --input-dir "$INPUT_DIR" "$@"
  processed=$((processed + 1))
  echo
done

elapsed=$(( $(date +%s) - start_ts ))
echo "✓ Processed $processed file(s) in ${elapsed}s"
