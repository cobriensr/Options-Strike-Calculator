# Lottery Finder REIGNITION UI — past-fire chart lines + pinned promotion

**Date:** 2026-05-17
**Status:** spec — ready to implement
**Branch:** main (per `feedback_direct_to_main`)

## Goal

Two UI improvements that make bursty Lottery Finder chains visible:

- **Task B** — render every past-fire entry-price line on the expanded contract chart (currently only the latest fire renders). Lets the user see burst density once they open a chain.
- **Task A** — promote chains matching a "REIGNITION" pattern out of their ticker group into a pinned "Hot Right Now" section at the top of the feed. Makes the bursty alert harder to miss before the user even thinks to expand it.

Both tasks share an API extension that exposes per-chain fire history.

## Empirical basis

Tuned against 93 days of `lottery_finder_fires` (626K rows, 2026-01-02 → 2026-05-15) via `docs/tmp/reignition-tuning-v{3,4}-2026-05-17.py` and `docs/tmp/reignition-profitability-2026-05-17.py`.

**Anchor case:** QQQ 708P 2026-05-15 — 21 fires from 08:30 CT to 14:59 CT, a 162-min mid-day gap (10:50 → 13:32), then 5 post-gap fires that peaked at 150–578%. The locked rule catches this and ~half of the QQQ put chain that fired alongside it.

**Locked rule — REIGNITED = Top 5/day from (3, 30, 2):**

- `fire_count >= 3` AND
- `max_gap_min >= 30` (computed from `trigger_time_ct`, NOT the broken `minutes_since_prev_fire` column) AND
- `post_gap_fires >= 2`
- Then per-day rank by `(post_gap_fires * 1000 + fire_count)` DESC, keep top 5
- Once flagged, stays flagged for the rest of the session (no decay)

**Why these numbers:**
| Rule | per_day | precision (outlier-peak ≥100%) | median realized R | mean R | CI95 |
|------|---------|--------------------------------|-------------------|--------|------|
| Baseline (all multi-fire) | 606 | 40.3% | +0.5% | -5.1% | [-5.5, -4.7] |
| Top 5/day from (3,30,2) | 5.0 | **70.1%** | +18.2% | -2.3% | [-7.0, +2.7] |
| Top 10/day from (3,30,2) | 10.0 | 67.1% | +16.6% | -2.3% | [-5.5, +1.0] |
| Top 20/day from (3,30,2) | 20.0 | 60.8% | +17.8% | +0.8% | [-1.4, +3.0] |

Top 5/day chosen for UX clarity (denser high-quality set, badge means "actually rare"). Profitability is indistinguishable between Top 5 and Top 10. **This is a visual surfacing tool, NOT an auto-trade signal — mean R is negative, the trader filters further by context.**

**Critical implementation note:** the precomputed `minutes_since_prev_fire` and `burst_ratio_vs_prev` columns are unreliable (NULL/0 on the anchor chain despite 21 distinct fires). All gap math MUST use `trigger_time_ct` differences directly.

## Phases

Each phase is independently shippable. Per-phase loop per `feedback_per_phase_loop`: implement → code-reviewer subagent → fix findings → commit+push → next phase.

### Phase 1 — API extension (single PR scope)

Add per-chain fire history + reignition flag to `/api/lottery-finder`.

**Files to modify:**

- [api/lottery-finder.ts](api/lottery-finder.ts) — extend the chain-day CTE to:
  - aggregate `fires_array` (jsonb of `{trigger_time_ct, entry_price}`) per chain
  - compute `max_gap_min` (LAG over partition by chain) and `post_gap_fires`
  - apply the Top 5/day window function to set `reignited: boolean`
  - return `historicalFires` (only when `fireCount > 1`) and `reignited` on each row
- [src/components/LotteryFinder/types.ts](src/components/LotteryFinder/types.ts) — add to `LotteryFire`:
  - `historicalFires?: Array<{ triggerTimeCt: string; entryPrice: number }>`
  - `reignited?: boolean`
- [api/**tests**/lottery-finder.test.ts](api/__tests__/lottery-finder.test.ts) — verify both fields populate correctly; cover the Top 5/day rank cutoff

**Constants** (single source of truth, exported from `api/_lib/constants.ts`):

```ts
export const REIGNITION_MIN_FIRES = 3;
export const REIGNITION_MIN_GAP_MIN = 30;
export const REIGNITION_MIN_POST_GAP_FIRES = 2;
export const REIGNITION_TOP_N_PER_DAY = 5;
```

**SQL shape (sketch):**

```sql
WITH fires_ranked AS (
  SELECT f.*,
         (EXTRACT(EPOCH FROM trigger_time_ct - LAG(trigger_time_ct) OVER chain) / 60) AS gap_min,
         ROW_NUMBER() OVER chain AS fire_seq
  FROM lottery_finder_fires f
  WINDOW chain AS (PARTITION BY date, option_chain_id ORDER BY trigger_time_ct)
),
chain_stats AS (
  SELECT date, option_chain_id,
         COUNT(*) AS fire_count,
         MAX(gap_min) AS max_gap_min,
         COUNT(*) FILTER (
           WHERE fire_seq >= (SELECT MIN(fire_seq) FROM fires_ranked f2
                              WHERE f2.date = f.date AND f2.option_chain_id = f.option_chain_id
                                AND f2.gap_min = (SELECT MAX(gap_min) FROM fires_ranked f3
                                                  WHERE f3.date = f2.date AND f3.option_chain_id = f2.option_chain_id))
         ) AS post_gap_fires
  FROM fires_ranked f
  GROUP BY date, option_chain_id
),
reignition_ranks AS (
  SELECT date, option_chain_id,
         ROW_NUMBER() OVER (
           PARTITION BY date
           ORDER BY post_gap_fires DESC, fire_count DESC
         ) AS rn
  FROM chain_stats
  WHERE fire_count >= $MIN_FIRES
    AND max_gap_min >= $MIN_GAP
    AND post_gap_fires >= $MIN_POST_GAP
)
SELECT ... CASE WHEN rr.rn <= $TOP_N THEN TRUE ELSE FALSE END AS reignited ...
```

(The actual query may end up cleaner — this is illustrative. Optimizer may prefer a single-pass CTE.)

**Acceptance:**

- Existing endpoint contract unchanged; new fields additive
- `historicalFires` only populated when `fireCount > 1` (avoid bloat)
- Reignited row count per day matches `docs/tmp/reignition-tuning-v4` output ±10% over a 30-day sample
- No measurable query latency regression (the existing aggregation is already a chain-day collapse)

### Phase 2 — Task B: past-fire entry lines on contract chart

Render every fire's entry-price line on the expanded contract chart.

**Files to modify:**

- [src/components/LotteryFinder/ContractTapeChart.tsx](src/components/LotteryFinder/ContractTapeChart.tsx) — new `historicalFires` prop; render each as an orange dashed line (`stroke="#fb923c"`, `strokeDasharray="2 3"`); keep latest purple line as-is
- [src/components/LotteryFinder/LotteryRow.tsx](src/components/LotteryFinder/LotteryRow.tsx) — pass `fire.historicalFires` to `<ContractTapeChart>`
- [src/**tests**/ContractTapeChart.test.tsx](src/__tests__/ContractTapeChart.test.tsx) — assert N orange lines rendered when N past fires given, plus the single purple line

**Visual spec:**

- Past fires: vertical line at each `triggerTimeCt`, orange `#fb923c`, dashed `2 3`, 50% opacity
- Latest fire: existing purple `#a855f7`, dashed `3 2`, full opacity — unchanged
- No tooltip on past lines (keep it simple); the chart already has a hover layer for volume bars
- Lines span the full price-zone height (not the volume zone)

**Acceptance:**

- A chain with 21 fires renders 20 orange lines + 1 purple (last fire is the marker)
- When `historicalFires` is undefined/null/empty, behavior matches current production (just the purple line)
- No regression in chart hover tooltip behavior

### Phase 3 — Task A: REIGNITION pinned section

Surface REIGNITED chains in a pinned section above the ticker groups.

**Files to create:**

- [src/components/LotteryFinder/ReignitionSection.tsx](src/components/LotteryFinder/ReignitionSection.tsx) — pinned section component; reuses `<LotteryRow>` for actual rendering
- [src/**tests**/ReignitionSection.test.tsx](src/__tests__/ReignitionSection.test.tsx) — covers empty state, sort order, and that promoted rows have the chip

**Files to modify:**

- [src/components/LotteryFinder/LotteryFinderSection.tsx](src/components/LotteryFinder/LotteryFinderSection.tsx) — split the fires list:
  - `reignited` rows → render in `<ReignitionSection>` at top
  - non-reignited rows → render in existing ticker groups below
  - Each row appears in **exactly one** section (no double-render)
  - Pagination: REIGNITED section is always visible on every page (does NOT consume pagination slots from the ticker-grouped feed)
- [src/components/LotteryFinder/LotteryRow.tsx](src/components/LotteryFinder/LotteryRow.tsx) — render `🔥 REIGNITED` chip when `fire.reignited === true` (orange/red, near the existing ×N badge)

**Visual spec for the pinned section:**

- Header: `🔥 Hot Right Now (N)` with subtle pulse animation on the icon
- Border: orange/red gradient or wash to distinguish from ticker groups
- Empty state: section hides entirely when N = 0 (don't show empty box)
- Sort within section: by most-recent fire DESC (so freshest reignition first)

**Persistence note:** "Stays flagged for the session" is enforced by the SQL (`fire_count`, `max_gap_min`, `post_gap_fires` are all chain-day aggregates that only grow during the session). Once a chain qualifies, subsequent API polls will keep returning `reignited: true` for the rest of the day.

**Acceptance:**

- On 2026-05-15 data, 5 chains qualify and render in the pinned section
- QQQ 708P 5/15 is one of them (anchor)
- Removing `reignited` from a row removes it from the section and restores it to its ticker group
- Section has accessible heading + landmark role for screen readers (per `wcag-audit-patterns`)
- No layout shift when section appears/disappears across polls

## Data dependencies

- Reuses existing `lottery_finder_fires` table — no new migrations
- Reuses existing `/api/lottery-finder` endpoint — no new routes
- No new env vars
- No new external API calls

## Open questions

(None — all resolved during 2026-05-17 scoping conversation.)

## Out of scope (deferred)

- **Alternative exit policies** (trail-from-entry, hard +25% target) — separate analysis, follow-up after spec lands
- **Burst-spike chart annotation** — i.e. highlight WHICH 5-min volume bucket triggered the reignition. The user mentioned wanting this thought through but it's not part of the agreed scope.
- **REIGNITION-specific outcome tracking** — i.e. a separate `realized_reignition_pct` column. The existing `realized_trail30_10_pct` covers the use case.
- **Push notification on new reignition** — could plug into existing alert infra but not in this spec.

## Implementation order

1. Phase 1 (API + types) — must land first; Phase 2 and 3 depend on `historicalFires` + `reignited` in the response
2. Phase 2 (chart lines) — independent of Phase 3, can ship as soon as Phase 1 is committed
3. Phase 3 (pinned section) — independent of Phase 2, can ship as soon as Phase 1 is committed

If implementing in one continuous session, do them in order 1 → 2 → 3. Each phase gets its own commit and code-reviewer pass per `feedback_per_phase_loop`.

## Verification gates

Per `feedback_run_review` + `feedback_always_test`:

- `npm run review` (tsc + eslint + prettier + vitest --coverage) must pass after each phase
- Every new module needs a test file (per `feedback_always_test`)
- No `console.log` in committed code
