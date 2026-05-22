# Was-Conviction History — Spec

**Date:** 2026-05-22
**Source:** Live trading session with Wonce, 2026-05-21 (paraphrased):

> "is there a way to note that it once had conviction which set of alerts triggered it"
> "basically when MSFT had those string of puts" "it was conviction"

## Goal

When a ticker hits the ✦ conviction state at any point in the day, remember it. After the state drops (e.g., the 15-min spread cap is exceeded by later fires), render a "was-conviction at HH:MM CT (Nf)" badge so the user can see that the ticker *had* a conviction footprint earlier and which fires triggered it.

## Design — frontend-only derivation

Compute on read; no schema change. The `useTickerGrouping` hook already receives the unfiltered fire set (after Item 2). Run a sliding 15-min window over each ticker's fires; record the earliest window where `isHighConviction(agg, windowSize)` returns true. Surface:

- `wasConvictionAt: string | null` — ISO timestamp of the earliest qualifying window's first fire
- `wasConvictionFireCount: number` — number of fires in that earliest window
- `wasConvictionFireMs: number[]` — millis of the qualifying fires (for the tooltip)

The hook + components already get unfiltered items; this is pure derivation on top.

## Files (4)

1. **`src/utils/ticker-rollup-aggregates.ts`** — new exported helper:
   ```ts
   export interface ConvictionWindow {
     firstFireMs: number;
     fireCount: number;
     fireMs: number[];
   }
   export function findEarliestConvictionWindow(
     summaries: RollupAlertSummary[],
   ): ConvictionWindow | null;
   ```
   - Sort summaries by `triggeredAt` ms ascending (guard against unsorted input)
   - Two-pointer sliding window of fires within `HIGH_CONVICTION_MAX_SPREAD_MINUTES` (=15min)
   - For each window position, build a sub-aggregate and call `isHighConviction(subAgg, window.length)`
   - First true window → return it
   - No true window → null

2. **`src/hooks/useTickerGrouping.ts`** — when `unfilteredItems` is provided, compute `findEarliestConvictionWindow` per ticker. Add to `TickerGroup<T>`:
   ```ts
   wasConvictionAt: string | null;          // ISO of earliest window first fire
   wasConvictionFireCount: number;          // 0 when null
   ```
   (Skip the fireMs array on the group type — components only need the timestamp + count for the badge; the full ID list is overkill for the first ship.)

3. **`src/components/LotteryFinder/LotteryFinderTickerGroup.tsx`** + **`src/components/SilentBoom/SilentBoomTickerGroup.tsx`** — render a NEW badge when:
   - `conviction === false` (live is off)
   - `wasConvictionAt != null` (historic state existed)
   
   Format: `was ✦ HH:MM (Nf)` — small amber chip distinct from the live ✦ conviction badge (which is bold amber). Tooltip cites the exact window: "Earliest 15-min window of qualifying conviction footprint started at HH:MM CT with N fires."

4. **Tests** in `src/__tests__/utils/ticker-rollup-aggregates.test.ts` (new `findEarliestConvictionWindow` describe block) + `src/hooks/__tests__/useTickerGrouping.test.ts` (group exposes wasConvictionAt) + the two TickerGroup component tests (badge renders when wasConvictionAt set + conviction false; doesn't when conviction is true).

## Cases to test

- Ticker fires 3 puts within 6 min, then 5 more spread over 30 min → `conviction === false` (spread > 15) but `wasConvictionAt` populated from the early cluster
- Ticker only ever had 2 fires → both `conviction` and `wasConvictionAt` null/false
- Live conviction true → render the live badge; suppress the "was" badge (avoid double rendering)
- `unfilteredItems` omitted → `wasConvictionAt: null` (back-compat)

## Out of scope

- Persisting the wasConvictionAt across page reload — currently derived each render from unfiltered items. Reload is fine because the API serves the full day's fires.
- Surfacing the actual fire IDs that triggered conviction (a list, not just a count). Defer to a follow-up if Wonce asks for click-through.
- Backend changes — none.

## Verification

- `npm run review` clean
- Manual: fixture with MSFT 8 puts spread 0–30 min (peaks conviction at minute 6, drops by minute 20) renders `was ✦ HH:MM (4f)` after conviction drops.
