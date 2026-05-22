# Lottery Reload Deltas — Spec

**Date:** 2026-05-21
**Source:** Live trading conversation with Wonce, 2026-05-21.
**Goal:** When a lottery alert re-fires on a contract already alerted today, surface
the **Δ option price** and **Δ underlying** *since the first fire on this chain*
on the alert card, so the user can identify reload opportunities at a glance.

## Why

From today's session (paraphrased):

> "i wonder if its possible if we can structure the alerts to show if the
> original alert is down X% because i notice a lot of these have nice reload
> opportunities" — Wonce, 10:55 CT

The user noted multiple reload setups today (AMZN 265C 6D, ARM 300C 1D, GOOGL
400C 8D). The information needed to spot them (option entry vs prior fire,
spot drift since first fire) is partially in the system today but not surfaced
on the card.

## Current state

**Backend already has:**

- `lottery_finder_fires.entry_price` — option price per fire ([api/_lib/db-migrations.ts](api/_lib/db-migrations.ts))
- `lottery_finder_fires.entry_drop_pct_vs_prev` — option Δ vs IMMEDIATELY PRIOR fire ([api/_lib/lottery-finder.ts:644](api/_lib/lottery-finder.ts#L644))
- `lottery_finder_fires.reload_tagged` boolean — strict gate: `burstRatio ≥ 2 AND entryDrop ≤ -30%`
- `historicalFires[]` array on the API response with prior fires' triggerTimeCt + entryPrice ([api/lottery-finder.ts](api/lottery-finder.ts))

**Backend GAP:**

- `spot_at_first` is **per-cron-pass**, not per-chain-day. The cron runs every minute over a 7-min rolling window; `firstTick.underlyingPrice` in [api/_lib/lottery-finder.ts:484](api/_lib/lottery-finder.ts#L484) is the first tick the detector saw IN THAT BATCH, not the chain's first fire of the day. So we can't trust it for cross-fire Δ underlying.
- There is NO per-fire `spot_at_trigger` column. Each fire's tick has `cur.underlyingPrice` in the detector loop but it's discarded.

**Frontend GAP:**

- The `RE-LOAD` badge ([LotteryRow.tsx:840](src/components/LotteryFinder/LotteryRow.tsx#L840)) renders only on the strict-gate tag (≥2× burst + ≤-30% drop) and shows no actual %.
- No soft-reload indicator for re-fires that don't meet the strict threshold — meaning a fire that re-triggered 18% cheaper with normal burst goes unflagged.

## Phases

### Phase 1A — Capture per-fire spot (backend)

1. **Migration #N** (next available id): add column
   ```sql
   ALTER TABLE lottery_finder_fires
     ADD COLUMN IF NOT EXISTS spot_at_trigger NUMERIC(12,4)
   ```
   NULL-allowed for pre-existing rows. No backfill.

2. **Detector** ([api/_lib/lottery-finder.ts](api/_lib/lottery-finder.ts)):
   - Add `spotAtTrigger: number` to `LotteryFire` interface (line 272 area)
   - In `detectChainFires`, capture `cur.underlyingPrice` per fire (use the trigger-tick's spot, not the entry-tick — matches `triggerTimeCt`)
   - If `cur.underlyingPrice == null`, skip the fire (same guard pattern as `firstTick`)

3. **Enricher** ([api/_lib/lottery-finder.ts:enrichFires](api/_lib/lottery-finder.ts)): pass `spotAtTrigger` through `LotteryFireRecord`.

4. **Cron** ([api/cron/detect-lottery-fires.ts](api/cron/detect-lottery-fires.ts)):
   - Add `spot_at_trigger` to the INSERT column list + values
   - Add to the structured-log fields

5. **Read endpoint** ([api/lottery-finder.ts](api/lottery-finder.ts)):
   - Add `spot_at_trigger` to all 4 SELECT queries (lines 444, 523, 601, 894)
   - Add to row mapping (line ~1273 area)
   - Add to `historicalFires` subquery so prior fires also carry their per-fire spot
   - Expose `spotAtTrigger` on `entry` block AND on each `historicalFires` entry

6. **Types** ([src/components/LotteryFinder/types.ts](src/components/LotteryFinder/types.ts)):
   - Add `spotAtTrigger: number | null` to `LotteryFireEntry`
   - Augment `historicalFires[]` items with `spotAtTrigger: number | null`

7. **Tests:**
   - `api/__tests__/db.test.ts` — add `{ id: N }` to applied-mock, add migration to expected-output list, bump SQL call count by 2 (CREATE + schema_migrations INSERT)
   - `api/__tests__/lottery-finder.test.ts` (or detector unit test if present) — assert `spotAtTrigger` flows through `detectChainFires` → `enrichFires` → mapped row

**Files touched (Phase 1A): ~5**
- `api/_lib/db-migrations.ts`
- `api/_lib/lottery-finder.ts`
- `api/cron/detect-lottery-fires.ts`
- `api/lottery-finder.ts`
- `src/components/LotteryFinder/types.ts`
- `api/__tests__/db.test.ts`
- (1 test file under `api/__tests__/`)

### Phase 1B — Surface deltas on the alert card (frontend)

1. **Compute deltas** in [LotteryRow.tsx](src/components/LotteryFinder/LotteryRow.tsx) (near top of component, in a `useMemo`):
   - `firstFire = fire.historicalFires?.[0]` (oldest prior fire on the chain today; `historicalFires` is sorted oldest → newest per existing chart usage)
   - `optionDeltaPct = firstFire ? ((fire.entry.price - firstFire.entryPrice) / firstFire.entryPrice) * 100 : null`
   - `underlyingDeltaPct = (firstFire?.spotAtTrigger != null && fire.entry.spotAtTrigger != null) ? ((fire.entry.spotAtTrigger - firstFire.spotAtTrigger) / firstFire.spotAtTrigger) * 100 : null`
   - Both null on first fire of the day (no `firstFire` yet) — badge does not render

2. **Render a `RELOAD` indicator** (only when `alertSeq > 1` AND `optionDeltaPct != null`):
   - Place it adjacent to the existing `RE-LOAD` strict-tag badge (line 840 area)
   - Format: `RELOAD opt −42% · spx +0.1%` (option Δ first, underlying Δ second; sign-explicit; rounded to whole %)
   - Color tiers (informational, no scoring impact):
     - `optionDeltaPct <= -30` AND `reloadTagged === true` → green border + strict-tag tooltip (this REPLACES the existing bare RE-LOAD badge text but keeps the same visual hierarchy)
     - `optionDeltaPct <= -15` → amber border, "soft reload" tooltip
     - `optionDeltaPct < 0` → neutral border, "cheaper-than-first" tooltip
     - `optionDeltaPct >= 0` → do NOT render (avoid clutter; re-fires at flat/higher entry aren't reload opportunities)
   - Tooltip cites both deltas: "Option entry is X% vs first fire at HH:MM CT; underlying is Y% in the same window."

3. **Remove the bare `RE-LOAD` badge** at [LotteryRow.tsx:840](src/components/LotteryFinder/LotteryRow.tsx#L840) — the new badge supersedes it when on; nothing else uses the bare label.

4. **Tests:**
   - `src/components/LotteryFinder/__tests__/LotteryRow.test.tsx` (or co-located) — add cases:
     - First fire (no `historicalFires`) → no reload badge
     - Re-fire with option −42%, strict tag true → green "RELOAD opt −42%" rendered
     - Re-fire with option −18%, strict tag false → amber soft-reload
     - Re-fire with option −5% → neutral
     - Re-fire with option +3% → no badge

**Files touched (Phase 1B): ~3**
- `src/components/LotteryFinder/LotteryRow.tsx`
- `src/components/LotteryFinder/__tests__/LotteryRow.test.tsx` (or nearest equivalent)
- Possibly `src/components/LotteryFinder/types.ts` (already covered in 1A)

## Thresholds / constants

- Strict reload (green): `optionDeltaPct <= -30` AND `reload_tagged === true` (preserves existing 9.1% historical lottery rate cohort)
- Soft reload (amber): `optionDeltaPct <= -15` (display-only; not yet validated as a score input)
- Neutral (gray): `optionDeltaPct < 0`
- Suppressed: `optionDeltaPct >= 0` or `alertSeq === 1`

These are display-only thresholds. **No scoring/filter changes** — the existing `reload_tagged` boolean and `score` calc are untouched. Add a TODO comment that the soft-reload cohort should be validated on the next backtest pass before being promoted to a score input.

## Out of scope

- Backfilling `spot_at_trigger` for historical rows — leave NULL; UI degrades gracefully.
- Changing the strict `isReload()` thresholds in [api/_lib/lottery-finder.ts:418-428](api/_lib/lottery-finder.ts#L418-L428).
- Adding the soft-reload cohort to scoring — observe in production first.
- Surfacing `entry_drop_pct_vs_prev` (vs IMMEDIATELY PRIOR fire) — the user's mental model is "down since first fire," not "down since the last burst."
- Fixing the per-cron-pass `spot_at_first` bug (it's used elsewhere for range-kill and mode classification; out of scope for this feature).

## Open questions

None — defaults baked above. If the user pushes back, the soft-reload color tiers and the suppression rule are the most likely tunings.

## Verification before completion

- `npm run review` clean (tsc + eslint + prettier + vitest)
- Manual: render a fixture row with `historicalFires=[{entryPrice: 3.45, spotAtTrigger: 266.28}]` and current `entry.price=2.27, entry.spotAtTrigger=266.50`; confirm "RELOAD opt −34% · spx +0.1%" appears in amber.
