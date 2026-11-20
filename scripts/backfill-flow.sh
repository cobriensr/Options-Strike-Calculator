#!/usr/bin/env bash
#
# Ingest every local EOD options flow CSV into the Bot-EOD archive.
#
# Walks $INPUT_DIR for files matching bot-eod-report-YYYY-MM-DD.csv and runs
# scripts/ingest-flow.py against each, oldest date first, one at a time. Each
# run writes that date's {date}-trades.parquet to the archive dir
# (ingest-flow's default, ~/Desktop/Bot-Eod-parquet, unless you pass
# --archive-dir) and then deletes the CSV. Nothing is uploaded, and no token or
# env file is needed.
#
# Re-runnable: a date whose CSV is gone is not seen again. An archive parquet
# that already exists is reused only when its row count matches the CSV;
# otherwise that date fails (exit 2) and its CSV is kept.
#
# Stops on the FIRST failure (set -e). A single bad day should not silently
# skip and corrupt the date sequence — the operator decides what to do.
#
# Usage:
#   bash scripts/backfill-flow.sh                       # every CSV in the default dir
#   bash scripts/backfill-flow.sh --keep-csv            # preserve source CSVs
#   bash scripts/backfill-flow.sh --archive-dir <dir>   # write the archive elsewhere
#
# Every argument is passed to scripts/ingest-flow.py unchanged.
#
# Env:
#   INPUT_DIR — defaults to ~/Downloads/EOD-OptionFlow
#   PYTHON    — defaults to the ML venv's python: ml/.venv/Scripts/python on
#               Windows, ml/.venv/bin/python elsewhere

set -euo pipefail

INPUT_DIR="${INPUT_DIR:-$HOME/Downloads/EOD-OptionFlow}"
if [[ -x ml/.venv/Scripts/python.exe ]]; then
  VENV_PYTHON="ml/.venv/Scripts/python"
else
  VENV_PYTHON="ml/.venv/bin/python"
fi
PYTHON="${PYTHON:-$VENV_PYTHON}"

if [[ ! -d "$INPUT_DIR" ]]; then
  echo "ERROR: input dir not found: $INPUT_DIR" >&2
  exit 2
fi

if [[ ! -x "$PYTHON" ]]; then
  echo "ERROR: Python interpreter not executable: $PYTHON" >&2
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
