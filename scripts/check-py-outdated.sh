#!/usr/bin/env bash
# Check outdated Python packages across local venvs (default) or Railway services (--remote).
#
# Usage:
#   scripts/check-py-outdated.sh              # local .venv check (fast)
#   scripts/check-py-outdated.sh --remote     # railway run pip list --outdated
#   scripts/check-py-outdated.sh --json       # JSON output (local only)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="local"
FORMAT="columns"

for arg in "$@"; do
  case "$arg" in
    --remote) MODE="remote" ;;
    --json)   FORMAT="json" ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

# service_dir : railway_service_name
SERVICES=(
  "sidecar:sidecar"
  "uw-stream:uw-stream"
  "ml:__local_only__"
)

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
err()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }

check_local() {
  local dir="$1"
  local venv="$dir/.venv"
  if [[ ! -x "$venv/bin/pip" ]]; then
    warn "  skip — no $venv/bin/pip"
    return
  fi
  "$venv/bin/pip" list --outdated --format="$FORMAT" 2> >(grep -vE 'Cache entry deserialization failed|^\[notice\]|new release of pip|To update, run' >&2) \
    || warn "  pip failed in $dir"
}

check_remote() {
  local svc="$1"
  if [[ "$svc" == "__local_only__" ]]; then
    warn "  skip — ml/ is local-only (no Railway service)"
    return
  fi
  if ! command -v railway >/dev/null 2>&1; then
    err "  railway CLI not installed (brew install railway)"
    return 1
  fi
  railway run --service "$svc" -- pip list --outdated --format=columns \
    || warn "  railway run failed for $svc (linked? logged in?)"
}

for pair in "${SERVICES[@]}"; do
  dir="${pair%%:*}"
  svc="${pair##*:}"
  echo
  bold "=== $dir ($MODE) ==="
  if [[ "$MODE" == "remote" ]]; then
    check_remote "$svc"
  else
    check_local "$dir"
  fi
done

echo
dim "Done. For Node services (e.g. periscope-scraper) use: (cd periscope-scraper && npm outdated)"
