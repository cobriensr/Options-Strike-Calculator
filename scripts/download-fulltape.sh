#!/usr/bin/env bash
# Downloads the Unusual Whales Full Tape zip for a given trading date,
# unzips it, and places the CSV at:
#
#     ~/Downloads/EOD-FullTape/fulltape-{date}.csv
#
# That path is what scripts/ingest-fulltape.py expects. The Full Tape is
# the auxiliary archive feed (40 cols, raw transaction tape) parallel to
# bot-eod-report — see docs/superpowers/specs/fulltape-archive-2026-05-07.md.
# The downloaded CSV is consumed by `make ingest-fulltape`, converted to
# ~/Desktop/Eod-Full-Tape-parquet/{date}-fulltape.parquet, then deleted
# (unless --keep-csv was passed to the ingest script).
#
# Override the destination dir with INPUT_DIR=... if needed.
#
# Usage:
#   UW_API_KEY=xxx bash scripts/download-fulltape.sh 2026-05-07
#
# Notes:
#   - UW retains only the LAST 3 TRADING DAYS at this endpoint.
#   - Endpoint requires an Advanced API subscription.
#   - This script is idempotent: if the target CSV already exists, it skips.

set -euo pipefail

DATE="${1:?Usage: download-fulltape.sh YYYY-MM-DD}"

if [[ ! "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "❌ Invalid date format: '$DATE' (expected YYYY-MM-DD)" >&2
  exit 2
fi

INPUT_DIR="${INPUT_DIR:-$HOME/Downloads/EOD-FullTape}"
TARGET="$INPUT_DIR/fulltape-${DATE}.csv"

if [[ -f "$TARGET" ]]; then
  SIZE=$(du -h "$TARGET" | cut -f1)
  echo "✅ Already present: $TARGET ($SIZE) — skipping download"
  exit 0
fi

if [[ -z "${UW_API_KEY:-}" ]]; then
  echo "❌ UW_API_KEY is not set in the environment." >&2
  echo "   The Makefile sources .env.local before invoking this script." >&2
  exit 2
fi

mkdir -p "$INPUT_DIR"

TMP_ZIP=$(mktemp -t uw-fulltape-XXXXXX.zip)
TMP_DIR=$(mktemp -d -t uw-fulltape-XXXXXX)
trap 'rm -rf "$TMP_ZIP" "$TMP_DIR"' EXIT

URL="https://api.unusualwhales.com/api/option-trades/full-tape/${DATE}"
echo "→ GET $URL"

# 600s timeout because full tape can be multi-GB; UW's CDN streams it
# slowly. -L follows any redirects. -sS keeps it quiet but surfaces
# real errors. The token is passed via header, never in the URL.
HTTP_CODE=$(curl -sS -L \
  --max-time 600 \
  -H "Authorization: Bearer $UW_API_KEY" \
  -o "$TMP_ZIP" \
  -w '%{http_code}' \
  "$URL")

if [[ "$HTTP_CODE" != "200" ]]; then
  # UW's endpoint 302-redirects to a GCS signed URL. When the underlying
  # zip hasn't been posted yet, GCS returns 404 with an XML body whose
  # <Code> is NoSuchKey. Distinguish that "not posted yet" case from a
  # real auth/window 404 so the operator knows whether to retry later
  # vs. fix configuration.
  BODY=$(head -c 500 "$TMP_ZIP" 2>/dev/null || true)
  TODAY_CT=$(TZ='America/Chicago' date +%Y-%m-%d)
  YESTERDAY_CT=$(TZ='America/Chicago' date -v-1d +%Y-%m-%d 2>/dev/null \
    || TZ='America/Chicago' date -d 'yesterday' +%Y-%m-%d 2>/dev/null \
    || echo '')
  if [[ "$HTTP_CODE" == "404" && "$BODY" == *"<Code>NoSuchKey</Code>"* ]] && \
     [[ "$DATE" == "$TODAY_CT" || "$DATE" == "$YESTERDAY_CT" ]]; then
    echo "⏳ UW hasn't posted the Full Tape zip for $DATE yet." >&2
    echo "   The endpoint is redirecting to GCS correctly, but the underlying" >&2
    echo "   object doesn't exist there. UW typically posts a few hours after" >&2
    echo "   close — sometimes overnight. Retry in 1–3 hours." >&2
    exit 6
  fi
  echo "❌ HTTP $HTTP_CODE from UW Full Tape" >&2
  echo "   Common causes: 401 (bad token), 404 (date out of last-3-day window or not yet posted), 403 (no Advanced subscription), 429 (rate limited)." >&2
  echo "   Response body (truncated):" >&2
  echo "$BODY" >&2
  echo >&2
  exit 3
fi

# Sanity check: confirm the response is actually a zip archive, not a
# JSON error body that happened to come back with a 200.
if ! file "$TMP_ZIP" | grep -qi 'zip archive'; then
  echo "❌ Response is not a zip archive:" >&2
  file "$TMP_ZIP" >&2
  echo "   First 500 bytes:" >&2
  head -c 500 "$TMP_ZIP" >&2 || true
  echo >&2
  exit 4
fi

ZIP_SIZE=$(du -h "$TMP_ZIP" | cut -f1)
echo "→ Downloaded zip: $ZIP_SIZE"

unzip -q "$TMP_ZIP" -d "$TMP_DIR"

# UW packs the tape as a single CSV inside the zip. Find it without
# assuming a specific filename — that lets this script survive any
# UW-side rename without breaking.
CSV_FOUND=$(find "$TMP_DIR" -type f -name '*.csv' | head -1)
if [[ -z "$CSV_FOUND" ]]; then
  echo "❌ No CSV found inside the zip:" >&2
  ls -lR "$TMP_DIR" >&2
  exit 5
fi

mv "$CSV_FOUND" "$TARGET"
SIZE=$(du -h "$TARGET" | cut -f1)
echo "✅ Wrote $TARGET ($SIZE)"
