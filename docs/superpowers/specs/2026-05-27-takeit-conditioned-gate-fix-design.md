# TAKE-IT-Conditioned Gate Fix — Design

**Date:** 2026-05-27
**Status:** Draft (follow-up to the suspicious-flow / TAKE-IT-floor spec —
implement AFTER that ships)
**Origin:** META 2026-05-27 — two Silent Boom 0DTE calls (617.5C +2787%, 615C
+996%) were hard-gated to tier3 for printing counter to market tide, yet both
scored TAKE-IT **0.78** and exploded. The gate overrode a correct model call.

## Goal

Stop the Silent Boom counter-tide gate from suppressing high-conviction fires.
Make the hard tier3 override **conditional on TAKE-IT**: exempt
`takeit_prob >= 0.70`, keep the gate below it (where it correctly kills losers).

## Evidence (tune-before-ship)

Silent Boom 0DTE fires, Jan 2 → May 27 2026, realized trailing-stop return
(`docs/tmp/sf-gate.mjs`):

| gated fires     | n   | peak ≥100% | peak ≥300% | mean trail | verdict       |
| --------------- | --- | ---------- | ---------- | ---------- | ------------- |
| TAKE-IT <0.5    | 154 | 15%        | 3%         | **−15.5%** | gate correct  |
| TAKE-IT 0.5–0.7 | 131 | 26%        | 3%         | −18.2%     | gate correct  |
| TAKE-IT ≥0.7    | 448 | 38%        | 12%        | **+0.4%**  | gate is wrong |

Ungated TAKE-IT ≥0.7 peers: peak ≥100% 38%, mean trail −4.5%. So gated ≥0.7
fires perform **as well as or better than** their ungated peers — the override
is pure downside above 0.70. Below 0.70 the gate removes genuine losers and
should stay. Overall gated-vs-ungated is near-identical (peak100 30.9 vs 31.4),
confirming the gate's value is entirely concentrated in the low-TAKE-IT tail.

## Change

In `api/cron/detect-silent-boom.ts`, where `direction_gated` currently forces
`score_tier = tier3`:

- Compute `takeit_prob` **before** the gate decision (ordering dependency — the
  cron already computes it; ensure it precedes the tier override).
- Apply the tier3 override **only when** `takeit_prob < 0.70` OR `takeit_prob IS
NULL`. When `takeit_prob >= 0.70`, keep `direction_gated = true` (preserve the
  counter-tide flag for display/audit) but **do not overwrite the tier** — let
  the alert show its real conviction with a "gated (counter-tide)" annotation.

Net: the gate still suppresses low-conviction counter-tide fires; high-TAKE-IT
counter-tide fires (today's META) keep their real tier and surface.

## Scope decisions

- **Silent Boom only.** Lottery's gate is already soft (score preserved, feed
  may down-rank display) and only touches calls with extreme OTM tide; its
  measured harm is near-zero. Optional later: apply the same `≥0.70` exemption
  to the lottery feed's display down-rank. Not in this spec.
- **Threshold = 0.70**, matching the floor knee from the companion spec. Single
  source of truth: reuse the shared TAKE-IT threshold constant.

## Backfill (optional)

Existing gated rows already have `score_tier` overwritten to tier3. A one-off
script could recompute the tier for historical `direction_gated = true AND
takeit_prob >= 0.70` rows so backtests/feed history reflect the new policy.
Low priority — forward-only is acceptable; flag as optional Phase 3.

## Phases

**Phase 1 — Gate logic + test.** Edit `detect-silent-boom.ts`; ensure
`takeit_prob` precedes the gate; condition the tier3 override on `< 0.70`.
Extend the detect-silent-boom cron test (add the file if absent): cases —
(a) gated with `takeit_prob >= 0.70` → tier preserved, `direction_gated` still
true; (b) gated with `takeit_prob < 0.70` → tier3; (c) gated with null takeit
→ tier3.

**Phase 2 — Display annotation.** Where the feed/UI renders the Gated pill,
distinguish "gated but tier-preserved (TAKE-IT ≥0.70)" from "gated and
suppressed". Small tooltip/label change so the user knows why a counter-tide
alert is still showing at its real tier.

**Phase 3 (optional) — Historical backfill** of tier for gated high-TAKE-IT rows.

## Data dependencies

- None new. Uses existing `takeit_prob`, `direction_gated`, `score_tier`.

## Rollout / monitoring

- Scoring change, no flag. After ship, watch the `ws_*` / silent-boom fires
  tracking for counter-tide tier1/tier2 fires that previously would have been
  tier3; re-probe realized outcomes after ~20 active days to confirm the
  exemption holds out-of-sample.

## Open questions (with default picks)

1. Exempt at `>= 0.70` or `> 0.70`? **Default `>= 0.70`** (inclusive, matches
   companion floor).
2. Should null `takeit_prob` ever be exempt? **Default no** — null means the
   model didn't score it; treat as below threshold and let the gate apply.
3. Annotate display now or defer? **Default annotate in Phase 2** so a
   tier-preserved gated alert isn't confusing.

## Non-goals

- No change to the gate's tide threshold (±100M) or which directions are gated.
- No lottery gate change in this spec.
- No removal of `direction_gated` — it stays as an audit/display flag.
