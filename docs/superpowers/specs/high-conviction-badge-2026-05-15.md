# High-Conviction Badge + $0.10 Min-Entry Filter — 2026-05-15

## Goal

Surface "clean" multi-strike clusters at a glance on the ticker rollup
header (Lottery Finder + Silent Boom), and stop wasting screen real
estate on sub-$0.10 algo prints that re-fire the alert pipeline at the
2-3 cent level.

## Origin

Trader feedback (2026-05-15): the XOM ticker rollup showed 3 fires
across 152.5C / 155C / 150C with no counter flow, fired in 7 minutes
— the kind of multi-strike conviction setup worth eyeballing first.
Mixed-bias rollups (SNDK, 5 fires but a 1295P among 4 calls) should
NOT earn the badge. Separately, the alert feed contains a lot of
$0.01-$0.02 fills (algo noise) that bloat the rollup.

## Scope

### Badge predicate

A ticker rollup earns the "shiny" badge when ALL of:

| #   | Predicate                                             | Existing source          |
| --- | ----------------------------------------------------- | ------------------------ |
| 1   | `fires.length >= 3`                                   | `rows.length`            |
| 2   | `bias !== 'mixed'` (clean direction, no counter flow) | `computeBias()`          |
| 3   | `strikeRange != null` (≥2 distinct strikes)           | `computeStrikeRange()`   |
| 4   | `spreadMinutes != null && spreadMinutes <= 15`        | `computeSpreadMinutes()` |

Tide alignment is **not** required — XOM (badge target) showed `tide ↑
aligned` in the UI but trader judgment was that tide wasn't load-
bearing for the conviction read.

### Entry-price filter

Fires with `entry_price < $0.10` are filtered at the data layer
(SQL `AND entry_price >= 0.10`). They do not appear in the rollup at
all — they do not influence `fires.length`, `bias`, or any aggregate.

Threshold is a hardcoded constant for now (`MIN_ALERT_ENTRY_PRICE =
0.10`); promote to a per-user setting if usage demands it.

## Files

### Phase 1 — Badge predicate (pure)

- `src/utils/ticker-rollup-aggregates.ts` — add `isHighConviction(agg, fireCount)` + `BADGE_LABEL`
- `src/__tests__/utils/ticker-rollup-aggregates.test.ts` — predicate tests

### Phase 2 — Badge chip render + ticker-list sort

- `src/components/LotteryFinder/LotteryFinderTickerGroup.tsx` — render chip when predicate true
- `src/components/SilentBoom/SilentBoomTickerGroup.tsx` — same
- `src/components/LotteryFinder/LotteryFinderSection.tsx` — promote conviction tickers in `groupedByTicker` sort (primary key: `isHighConviction ? 0 : 1`, then existing fires-desc + recency-desc tiebreak)
- `src/components/SilentBoom/SilentBoomSection.tsx` — same sort change wherever it groups by ticker
- `src/__tests__/LotteryFinderTickerGroup.test.tsx` — chip visibility tests
- `src/__tests__/SilentBoomTickerGroup.test.tsx` — chip visibility tests
- `src/__tests__/LotteryFinderSection.test.tsx` — add a test that a conviction ticker sorts above a higher-fire-count non-conviction ticker

Scope note (2026-05-15): trader chose "sort within current page" over a
server-side pinned section. Conviction is rare (~1-3 tickers per day)
and almost always lives on page 1; cross-page promotion is deferred
unless that assumption breaks.

### Phase 3 — Entry-price filter

- `api/_lib/constants.ts` — add `MIN_ALERT_ENTRY_PRICE = 0.10`
- `api/lottery-finder.ts` — add `entry_price >= ${MIN}` to 4 SELECTs + 1 count
- `api/silent-boom-feed.ts` — add `entry_price >= ${MIN}` to 4 SELECTs + 1 count
- `api/__tests__/lottery-finder.test.ts` — assert sub-$0.10 fires excluded
- `api/__tests__/silent-boom.test.ts` — same

## Open questions

None — all four spec questions answered during the 2026-05-15
scoping conversation:

- Min fires: 3
- Max time spread: 15 min
- Tide: not required
- Price filter: hide entirely, $0.10 threshold

## Verification

After each phase: `npm run review` → code-reviewer subagent →
fix-and-recommit until pass → next phase.
