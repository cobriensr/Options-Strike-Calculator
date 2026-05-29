# Conviction "strong" tier (✦✦) — cheap, pre-PM attention router

**Status:** building 2026-05-29
**Spec type:** single-phase UI tier addition

## Goal

Add a second, louder conviction badge — `✦✦ conviction` — that fires only
when an existing `✦ conviction` cluster is **cheap** (every fire ≤ $1
entry) and formed **before the PM session** (< 12:30 CT). It routes the
trader's eye to clusters with the highest *spike potential*. It is
explicitly **not** an expectancy/profit signal.

## Why (evidence)

2026-05-29 study (see [[project_conviction_no_oos_edge]], scripts/analyze-conviction-*-2026-05-29.ts):

- Conviction geometry alone has **no** mechanical edge; it fires on ~80%
  of LF ticker-days and within-ticker/TOD lift is −5.7pp.
- The only filter that survived a proper out-of-sample (date-holdout)
  test was **cheap (entry ≤ $1) + not-PM**, on the **% peak** metric:
  monotone in cheapness (≤$1 +7.9pp → ≤$0.30 +18pp OOS), cheap≤1 ∩ not-PM
  ≈ **+15pp** peak-reachability.
- On **realized dollars** (trail-30/10 stop AND +50% target), the cheap
  gate is flat-to-negative — so this is a *spike-reachability* signal,
  monetizable only by a discretionary "sell into the spike" trader, not
  a mechanical rule. The badge tooltip must say so.
- The takeit_prob gate looked huge in-sample and **inverted** OOS
  (overfit) — deliberately NOT used here.

## Scope (no architectural change, ~5 files)

### Constants + predicate — `src/utils/ticker-rollup-aggregates.ts`
- Add optional `entryPrice?: number | null` to `RollupAlertSummary`
  (raw $/contract; distinct from the existing aggregate `premium`).
- `STRONG_CONVICTION_MAX_ENTRY = 1.0`
- `STRONG_CONVICTION_PM_START_CT_HOUR = 12.5` (matches backend
  `getTimeOfDayFromCtHourMin` PM boundary in api/_lib/lottery-finder.ts).
- `isStrongConviction(agg, fireCount, rows)`: `isHighConviction` AND every
  row has finite `entryPrice ≤ 1` AND every row's `triggeredAt` is < 12:30
  CT (via `getCTTime`). Missing/unparseable values fail the tier
  (conservative — never fire the louder badge on partial data).
- `STRONG_CONVICTION_BADGE_LABEL = '✦✦ conviction'`.

### Hook — `src/hooks/useTickerGrouping.ts`
- Add `strongConviction: boolean` to `TickerGroup`.
- Compute in the unfiltered branch and the return (same back-compat
  fallback pattern as `conviction`).

### Sections — `LotteryFinder/index.tsx`, `SilentBoom/index.tsx` (`extract`)

- Map `entryPrice` into the `RollupAlertSummary` built by the
  `useTickerGrouping` `extract` projection (LF `f.entry.price`, SB
  `a.entryPrice`). This is the badge-driving path — the panels' own local
  `computeRollupAggregates` mapping only feeds in-card display aggregates
  and is intentionally left untouched.
- Thread `strongConviction={g.strongConviction}` to each panel.

### Panels — `LotteryFinder/LotteryFinderTickerGroup.tsx`, `SilentBoom/SilentBoomTickerGroup.tsx`

- Accept `strongConviction?: boolean` prop.
- When `strongConviction`, render `✦✦` (distinct styling) **instead of**
  the base `✦`; tooltip frames it as higher spike-potential, NOT
  expectancy. Otherwise unchanged.

### Sections — `LotteryFinder/index.tsx`, `SilentBoom/index.tsx`
- Thread `strongConviction={g.strongConviction}`.

## Tests
- `isStrongConviction` table tests (accept golden cheap+AM cluster;
  reject: non-conviction, any fire > $1, missing entryPrice, any PM fire;
  accept entry == $1.00 boundary; reject 12:30 CT exactly). Label export.
- Existing conviction/hook/component tests stay green.

## Out of scope
- No change to `isHighConviction` (the base ✦ tag stays exactly as-is —
  the trader wanted it kept).
- No backend/detection/scoring change. No realized-$ claim anywhere.

## Open follow-ups (not this change)
- Audit whether the live takeit/lottery score is overfit in production
  (option B) — bigger fish; ties to the 2026-06-16 reprobe.
- Re-test structure-awareness (is_isolated_leg) once it has ≥30 labelled
  dates (~July) for an honest holdout — the one C-research thread with a
  realized-$ spread, currently in-sample-only (7 days).
