# Shared Never-Vanish Feed Hook + Lottery Rewire

## Goal

Consolidate the ~120 lines of never-vanish orchestration hand-rolled in both
LotteryFinder and SilentBoom into a single generic `useNeverVanishFeed<T>` hook,
then rewire LotteryFinder to it while fixing 4 code-review findings.

## The 4 findings

1. **Filter-signature storageKey (bug):** the union storageKey is `date`-only
   (`feed-union:lottery:${date}`). Changing a server-side filter (takeitFloor,
   minScore, etc.) does NOT rescope the union, so a previously-pinned now-excluded
   row stays pinned. Fix: include a stable compact hash of the ACTIVE SERVER-SIDE
   filter params in the storageKey. Client-only filters (hide-toggles, moneyness,
   scrub) are excluded.
2. **Reignited double-render (bug):** ticker-group partition uses the stale
   per-row `reignited` flag (`f.reignited !== true`). A chain that left the
   per-poll top-N (now `reignited:false` in the main union but still pinned in the
   reignited union) renders in BOTH the reignited section AND a ticker group. Fix:
   partition by membership in the reignited-union key set.
3. **Pagination coherence (bug):** `totalPages` derives from
   `Math.max(serverTotal, union.length)` which can advertise pages the server's
   `hasMore` can't reach. Fix: `totalPages = Math.max(1, ceil(serverTotal / PAGE_SIZE))`
   — server-anchored. `total` still floors at union length for the "N pinned"
   display, but pagination is decoupled from it.
4. **ET-midnight roll:** a tab left open past ET-midnight keeps the old `date`,
   so the new day's fires upsert into the prior day's union. Fix: auto-advance the
   feed's default `date` to the live ET trading day on a low-frequency interval,
   only when the user hasn't manually picked a historical date.

## Hook API (`src/hooks/useNeverVanishFeed.ts`)

```ts
useNeverVanishFeed<T>({
  fetched, engaged, storageKey, key,
  serverTotal, hasMore, pageSize,
  serverTickerCounts?, getSymbol, tombstones?,
}): { rows, total, totalPages, hasMore, tickerCounts }
```

- `rows` — engaged → whole union; disengaged → `fetched`.
- `total` — engaged → `max(serverTotal, union.length)`; disengaged → serverTotal.
- `totalPages` — ALWAYS `max(1, ceil(serverTotal / pageSize))` (finding #3).
- `tickerCounts` — per-ticker MAX(server, union), server order preserved,
  union-only appended desc.
- Also exposes `unionKeys` (Set) for the page>0 dedup + reignited partition.

## Files

- create `src/hooks/useNeverVanishFeed.ts`
- create `src/__tests__/useNeverVanishFeed.test.ts`
- modify `src/components/LotteryFinder/index.tsx` (rewire + #1/#2/#4)
- modify `src/__tests__/LotteryFinderSection.test.tsx` (#1/#2/#3 tests)

## filterSig

Compact `:`-joined string of the active server-side params, NOT including `:` in
values (storageKey is `:`-delimited and parsed by useStickyUnion's sweep). Use a
djb2 hash → base36 so the sig is a single opaque token with no delimiters.

Params hashed: minTakeitProb, minScore, minFireCount, mode, optionType, tod,
reload, cheapCallPm, minPremium, showAll.

## SilentBoom

Out of scope for this pass (task is Lottery rewire). SilentBoom keeps its
hand-rolled block; a follow-up can rewire it to the same hook.
