#!/usr/bin/env bash
# scripts/sentry/setup-monitors.sh
#
# Idempotent provisioning of Sentry issue alert rules for theta-options /
# strike-calculator. Re-running only mutates rules whose payload diverges
# from the spec; rules that already match are left alone.
#
# Reference: docs/superpowers/specs/sentry-monitoring-2026-05-07.md
#
# Requires:
#   - sentry CLI authenticated (run `sentry auth status` to check)
#   - jq
#
# Usage:
#   scripts/sentry/setup-monitors.sh           # provision / update
#   scripts/sentry/setup-monitors.sh --dry-run # show planned actions only

set -euo pipefail

ORG_SLUG="no-org-jc"
PROJECT_SLUG="sentry-emerald-desert"
USER_ID="4340311" # charles.a.obrien@outlook.com — Sentry user.id (NOT org-member id)

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

# ── Helpers ────────────────────────────────────────────────────────────

# Fetch existing rule by exact-match name (returns rule id or empty).
# Avoids a `head` SIGPIPE under pipefail by using jq's first-element trick.
find_rule_id_by_name() {
  local name="$1"
  sentry api "/api/0/projects/${ORG_SLUG}/${PROJECT_SLUG}/rules/" \
    | jq -r --arg name "$name" '[.[] | select(.name == $name) | .id] | first // ""'
}

# Pretty-print the response. If the response is a Sentry error envelope
# (an object whose values are arrays of strings, e.g.
# {"actions": ["..."]}), surface every error and exit non-zero so a bad
# rule doesn't pass silently.
print_response() {
  local resp="$1"
  if echo "$resp" | jq -e 'type == "object" and (.id // empty)' >/dev/null 2>&1; then
    echo "$resp" | jq -r '"   id=" + (.id | tostring) + " status=" + (.status // "active")'
  else
    echo "   ✗ Sentry rejected the rule:"
    echo "$resp" | jq . | sed 's/^/     /'
    return 1
  fi
}

# Submit a rule definition. If a rule with the same name exists, PUT
# (idempotent update); otherwise POST (create). Logs the action taken.
upsert_rule() {
  local rule_name="$1"
  local payload_file="$2"

  local existing_id
  existing_id="$(find_rule_id_by_name "$rule_name")"

  if [[ -n "$existing_id" ]]; then
    echo "→ Updating rule '$rule_name' (id $existing_id)"
    if [[ $DRY_RUN -eq 1 ]]; then
      jq . "$payload_file"
      return
    fi
    local resp
    resp="$(sentry api "/api/0/projects/${ORG_SLUG}/${PROJECT_SLUG}/rules/${existing_id}/" \
      --method PUT \
      --header 'Content-Type: application/json' \
      --data "$(cat "$payload_file")")"
    print_response "$resp"
  else
    echo "→ Creating rule '$rule_name'"
    if [[ $DRY_RUN -eq 1 ]]; then
      jq . "$payload_file"
      return
    fi
    local resp
    resp="$(sentry api "/api/0/projects/${ORG_SLUG}/${PROJECT_SLUG}/rules/" \
      --method POST \
      --header 'Content-Type: application/json' \
      --data "$(cat "$payload_file")")"
    print_response "$resp"
  fi
}

# ── Rule payloads ──────────────────────────────────────────────────────
# Each payload is written to a temp file so the upsert helper can both
# print it for --dry-run and feed it to sentry api as --data. Inline
# heredocs are used so this script stays self-contained.

TMPDIR_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# 1a. Volume spike on a single issue: any one issue >= 50 events / 1h.
RULE_1A_NAME="Volume spike: single issue >= 50 events/hour"
cat > "$TMPDIR_ROOT/1a.json" <<JSON
{
  "name": "${RULE_1A_NAME}",
  "owner": null,
  "actionMatch": "all",
  "filterMatch": "all",
  "frequency": 30,
  "environment": null,
  "conditions": [
    {
      "id": "sentry.rules.conditions.event_frequency.EventFrequencyCondition",
      "value": 50,
      "interval": "1h",
      "comparisonType": "count"
    }
  ],
  "filters": [],
  "actions": [
    {
      "id": "sentry.mail.actions.NotifyEmailAction",
      "targetType": "Member",
      "targetIdentifier": ${USER_ID},
      "fallthroughType": "ActiveMembers"
    }
  ]
}
JSON

# 1b. Aggregate error spike: any error-level issue >= 25 events / 5min.
RULE_1B_NAME="Error spike: any error-level issue >= 25 events/5min"
cat > "$TMPDIR_ROOT/1b.json" <<JSON
{
  "name": "${RULE_1B_NAME}",
  "owner": null,
  "actionMatch": "all",
  "filterMatch": "all",
  "frequency": 30,
  "environment": null,
  "conditions": [
    {
      "id": "sentry.rules.conditions.event_frequency.EventFrequencyCondition",
      "value": 25,
      "interval": "5m",
      "comparisonType": "count"
    }
  ],
  "filters": [
    {
      "id": "sentry.rules.filters.level.LevelFilter",
      "level": "40",
      "match": "eq"
    }
  ],
  "actions": [
    {
      "id": "sentry.mail.actions.NotifyEmailAction",
      "targetType": "Member",
      "targetIdentifier": ${USER_ID},
      "fallthroughType": "ActiveMembers"
    }
  ]
}
JSON

# 1c. Critical infra patterns: deadlock | does not exist | numeric overflow.
# Sentry's filter set doesn't OR three message regexes natively, so we use
# three filters with filterMatch=any.
RULE_1C_NAME="Critical infra: deadlock / missing relation / numeric overflow"
cat > "$TMPDIR_ROOT/1c.json" <<JSON
{
  "name": "${RULE_1C_NAME}",
  "owner": null,
  "actionMatch": "all",
  "filterMatch": "any",
  "frequency": 5,
  "environment": null,
  "conditions": [
    {
      "id": "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition"
    }
  ],
  "filters": [
    {
      "id": "sentry.rules.filters.event_attribute.EventAttributeFilter",
      "attribute": "message",
      "match": "co",
      "value": "deadlock"
    },
    {
      "id": "sentry.rules.filters.event_attribute.EventAttributeFilter",
      "attribute": "message",
      "match": "co",
      "value": "does not exist"
    },
    {
      "id": "sentry.rules.filters.event_attribute.EventAttributeFilter",
      "attribute": "message",
      "match": "co",
      "value": "numeric field overflow"
    }
  ],
  "actions": [
    {
      "id": "sentry.mail.actions.NotifyEmailAction",
      "targetType": "Member",
      "targetIdentifier": ${USER_ID},
      "fallthroughType": "ActiveMembers"
    }
  ]
}
JSON

# ── Apply ──────────────────────────────────────────────────────────────

echo "Sentry monitor provisioning — org=${ORG_SLUG} project=${PROJECT_SLUG}"
[[ $DRY_RUN -eq 1 ]] && echo "(dry run — no mutations)"
echo

upsert_rule "$RULE_1A_NAME" "$TMPDIR_ROOT/1a.json"
upsert_rule "$RULE_1B_NAME" "$TMPDIR_ROOT/1b.json"
upsert_rule "$RULE_1C_NAME" "$TMPDIR_ROOT/1c.json"

echo
echo "Done. Verify in Sentry:"
echo "  https://${ORG_SLUG}.sentry.io/alerts/rules/?project=4511060900642816"
