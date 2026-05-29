# Lottery Finder — alerts must never disappear intraday

**Date:** 2026-05-29
**Status:** approved, implementing

## Goal

Once a lottery chain has appeared in the feed during a trading day, it must
stay reachable for the rest of that day (pagination to a later page is fine).
Today a chain blinks out when its newest fire dips below a per-fire filter
threshold, because the feed gates a chain on its **latest** fire.

## Root cause (reproduced on TSLA 435 / 2026-05-29)

The feed collapses each chain to one representative row = the latest fire
(`ROW_NUMBER() OVER (PARTITION BY underlying_symbol, strike, option_type,
expiry ORDER BY trigger_time_ct DESC, id DESC) ... WHERE rn = 1`,
api/lottery-finder.ts:475 and the 3 sibling branches). The default
`TAKE-IT >= 0.70` floor is then tested against **that representative row's**
`takeit_prob` (api/lottery-finder.ts:539, 623, 706, 752; reignited 1020).

Each fire's `takeit_prob` is immutable, but *which* fire is the representative
changes every time the chain re-fires. So visibility is **non-monotonic**:

- TSLA 435P: `08:30 → 0.71 ✓` visible; `08:35 → 0.667 ✗` → vanished, and every
  later P fire stayed < 0.70 (down to 0.21). Gone for the day.
- TSLA 435C: flickered in/out all day as the latest C fire crossed 0.70
  (visible 0.70–0.79, gone at 0.682/0.685 at 11:11, 11:16, 11:31, 14:51 …).

**Only `takeit_prob` has this bug.** Confirmed during implementation: the
`minScore` (api/lottery-finder.ts:489 etc.) and `minPremium` (491 etc.) gates
live INSIDE the `filtered` CTE WHERE, which runs *before* `ROW_NUMBER` assigns
`rn`. So they drop individual non-qualifying fires and `rn=1` re-selects the
latest *surviving* fire — the chain persists as long as any fire ever cleared
the bar (raw `score`/per-fire premium are immutable → monotonic). The TAKE-IT
gate was the lone exception: it sat in the OUTER `WHERE f.rn = 1`, gating the
post-collapse representative's scalar. `minFireCount` is already chain-level
(COUNT window) and only grows. So the fix touches only the takeit gate.

Secondary defect: the Q1/Q2 inversion-quality suppression runs as a
post-SELECT JS filter (api/lottery-finder.ts:1520–1530) AFTER the SQL
`COUNT(*) AS total` (748), so `total` / `totalPages` / `hasMore` overcount what
is actually reachable — the page counter can read as "fires missing".

## Fix

Gate each chain on a **chain-level aggregate (max)** instead of the latest
fire's scalar. Max only grows as fires accumulate → monotonic → a chain that
ever qualified can never disappear.

- `chain_max_takeit = MAX(takeit_prob) OVER (PARTITION BY chain)` → gate on this.
- `chain_max_score`, `chain_max_premium` likewise for the score/premium floors.
- Surface the chain's peak takeit and its timestamp so the row can show a
  persistent "peak TAKE-IT 0.XX @ HH:MM" badge (display decision: keep the
  **latest** fire as the representative row, add the peak badge).

## Phases

### Phase 1 — server gating (api/lottery-finder.ts) + tests

Files: `api/lottery-finder.ts`, `api/__tests__/lottery-finder*.test.ts` (new
or extended).

- In each `filtered` CTE (4 branches: score, peak, chronological, reignited)
  add window aggregates over the chain partition:
  - `MAX(f.takeit_prob) OVER (PARTITION BY chain) AS chain_max_takeit`
  - `MAX(f.score) OVER (...) AS chain_max_score`
  - `MAX(f.entry_price * f.trigger_window_size * 100) OVER (...) AS chain_max_premium`
  - argmax timestamp for peak takeit (subquery or `FIRST_VALUE … ORDER BY
    takeit_prob DESC`): `peak_takeit_at`.
- Change the `WHERE f.rn = 1 AND …` gates to use the `chain_max_*` columns.
- Update the `SELECT COUNT(*)::int AS total` query (748) to count chains under
  the same chain-level gates.
- Extend `FireRow` (api/lottery-finder.ts:184) + `toLotteryFire` (1214) to emit
  `peakTakeitProb` and `peakTakeitAt`.

### Phase 2 — count/pagination honesty (Q1/Q2 vs total)

Files: `api/lottery-finder.ts`, tests.

- Move the Q1/Q2 inversion-quality suppression into SQL (a `WHERE
  s.inversion_quintile IS NULL OR s.inversion_quintile > 2` unless `showAll`)
  so `total`, `totalPages`, and `hasMore` reflect the reachable set. Remove the
  post-SELECT JS filter (1520–1530) or keep it as a redundant guard.

### Phase 3 — frontend peak badge + perception

Files: `src/components/LotteryFinder/types.ts`,
`src/components/LotteryFinder/LotteryRow.tsx` (or the chain header in
`LotteryFinderTickerGroup.tsx`), tests.

- Add `peakTakeitProb?: number | null`, `peakTakeitAt?: string | null` to
  `LotteryFire`.
- Render "peak TAKE-IT 0.XX @ HH:MM" on the chain header when the latest fire's
  takeit is below the peak (so it's clear why a low-takeit chain is still shown).
- (Lower priority) Signal when a chain hopped out of the reignition pin into the
  main feed, so pin re-ranking doesn't read as a vanish.

### Phase 4 — regression guard

Files: `scripts/verify-lottery-no-vanish.ts` and/or
`api/__tests__/lottery-finder-monotonic.test.ts`.

- Unit: synthetic chain where the latest fire is below floor but an earlier fire
  cleared it → assert the chain is still returned (monotonic visibility).
- Optional integration: time-travel replay (`?at=` per minute) over a real day
  asserting no chain that appeared ever disappears.

## Data dependencies

None new. Reads existing `lottery_finder_fires` + `lottery_ticker_stats`
columns. No migration.

## Open questions / decisions

- Representative display: **latest fire + peak badge** (decided).
- Gating aggregate: **max** over chain (decided).
- minScore gate uses raw `f.score` (immutable per fire); chain-max keeps it
  monotonic even though combined_score can drop via round_trip deduct.

## Thresholds / constants

Unchanged: TAKE-IT default floor 0.70, MIN_ALERT_ENTRY_PRICE 0.10,
LOTTERY_TIER thresholds 18/12, Q1/Q2 = inversion_quintile <= 2.
