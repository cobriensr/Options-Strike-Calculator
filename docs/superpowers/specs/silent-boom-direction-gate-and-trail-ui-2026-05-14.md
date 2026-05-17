---
status: Likely Shipped
date: 2026-05-14
---

# Silent Boom + Lottery: Direction gate + Trail-30/10 UI — 2026-05-14

## Goal

Land the two follow-ups from the OTM-tide-and-trail spec (2026-05-13):

1. Wire the Phase 4 direction-gate thresholds into the live detectors so counter-trend fires get demoted automatically
2. Surface `realized_trail30_10_pct` in the silent boom UI as the default displayed exit policy

## Thresholds (locked in the prior spec's Phase 4 results)

| Detector    | Variant                   | T     | Demote rule                                                                              |
| ----------- | ------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| silent_boom | all-in (`mkt_tide_diff`)  | ±100M | put with diff > +100M OR call with diff < -100M → demote to tier3                        |
| lottery     | OTM (`mkt_tide_otm_diff`) | ±150M | put with otm_diff > +150M OR call with otm_diff < -150M → demote effective tier to tier3 |

silent_boom has `score_tier TEXT` stored; demote = overwrite to `'tier3'` at insert.
lottery has only `score INTEGER`; tier is computed at read time. Demote = expose a new `direction_gated BOOLEAN` and have the feed/UI force tier to `'tier3'` when true.

Both tables also get the new boolean column for diagnostic + filter use.

## Phases

### Phase A — Backend (migration + detectors + feeds + backfill)

**Files**:

- `api/_lib/db-migrations.ts` — new migration #151: add `direction_gated BOOLEAN DEFAULT FALSE NOT NULL` to both `silent_boom_alerts` and `lottery_finder_fires`. Single migration with two ALTER statements (atomic via `statements()`).
- `api/__tests__/db.test.ts` — id + description + call count 520 → 524 (2 ALTERs + 1 INSERT — wait no, ALTER+ALTER+INSERT = 3 calls; transaction 137 → 138).
- `api/cron/detect-silent-boom.ts` — compute gate after `tier = silentBoomScoreTier(score)`. When gated, set `tier = 'tier3'` AND track `directionGated = true` for the INSERT. Add `direction_gated` to the INSERT column list.
- `api/cron/detect-lottery-fires.ts` — compute gate after `score` is finalized. Set `directionGated = true` when triggered. Add `direction_gated` to the INSERT column list. Do NOT mutate score.
- `api/silent-boom-feed.ts` — include `direction_gated` in the SELECT and response mapping (renamed to camelCase `directionGated` per existing convention).
- `api/lottery-finder.ts` — include `direction_gated` in the SELECT; when true, override the computed `scoreTier` to `'tier3'`.
- `scripts/backfill_direction_gate.py` — one-shot. For each historical row, if the gate would have fired (using already-populated mkt_tide_diff / mkt_tide_otm_diff), set `direction_gated = TRUE`. For silent_boom, also UPDATE `score_tier = 'tier3'` on those rows. Batched 500/query. Idempotent (re-runs as no-op).

**Verification**:

- psql: `SELECT score_tier, COUNT(*), COUNT(*) FILTER (WHERE direction_gated) AS gated FROM silent_boom_alerts GROUP BY score_tier;`
- Spot-check: 17 SPY put fires on 2026-05-13 should all be flagged `direction_gated = TRUE`
- npm run review passes
- Existing detector tests get the new gate scenario added

### Phase B — Frontend (silent boom UI)

**Files**:

- `src/types/silentBoom.ts` (or wherever the row type lives) — add `directionGated?: boolean` and `realizedTrail3010Pct?: number | null` if not already there
- `src/components/SilentBoom/SilentBoomRow.tsx` — add a Trail badge alongside the existing EOD %, color-coded by trail performance. Add a "Gated ⚠" pill when `directionGated = true`.
- `src/components/SilentBoom/SilentBoomSection.tsx` — add a filter chip "Hide counter-trend" that drops `direction_gated=true` rows. Default OFF (show all, with the badge).
- `src/hooks/useSilentBoomFeed.ts` — pipe the new query param through.

**Verification**:

- Vitest unit tests for the row + section components
- Manual eyeball on dev server: 17 SPY puts on 2026-05-13 should show the Gated pill

### Phase C — Frontend (lottery UI)

**Files**:

- `src/components/LotteryFinder/LotteryRow.tsx` — show the Gated pill on counter-trend rows; the tier badge already updates because the feed forces `scoreTier='tier3'` on gated rows
- `src/components/LotteryFinder/LotteryFinderSection.tsx` — same filter chip option

**Verification**: matching unit tests + manual check

## Out of scope (separate followups)

- Tier3 demote semantics for lottery — currently we only override the tier badge. If the user wants gated fires HIDDEN from the actionable feed, that's a tier-floor filter setting (already exists via `convictionFloor`).
- The 25%/50% giveback variant of trail (the 10pp version is shipped as-is)
- Trail-30/10 for lottery UI — lottery already has its own exit-policy display; not touching it.

## Prod deploy ordering

Migration #151 must run via direct psql in prod BEFORE the detector + feed code deploys (OWNER_SECRET empty). Then the historical backfill script.
