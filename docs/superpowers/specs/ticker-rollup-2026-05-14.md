---
status: Shipped
date: 2026-05-14
---

# Ticker Rollup for Silent Boom + Lottery Finder — 2026-05-14

## Goal

Roll up Silent Boom and Lottery Finder alerts into collapsible per-ticker panels so a single ticker (e.g. NOW with 6 alerts) appears as one entry instead of six scattered cards. Show **all** alerted tickers in the top chip strip — not just the ones on the current page. Preserve every existing filter, sort, and exit-policy knob; sorting/filtering still drives the full list, grouping is purely a render-layer concern.

## Phases

### Phase 1 — Ticker-counts endpoints (independent of pagination)

Add two lightweight endpoints that return all-day alert counts per ticker, ignoring the page slice.

- `api/silent-boom-ticker-counts.ts` — returns `{ ticker, count, peakBestPct, latestBucketCt }[]` for the current session day, respecting the same convictionFloor / hideGated server filters used by the main feed (so the chip strip and the list stay coherent).
- `api/lottery-finder-ticker-counts.ts` — same shape, joined from the fires table.

Both reuse the existing query helpers and CRON guards aren't relevant (these are user-facing GETs with the standard owner/guest gate). botid: add both paths to `protect` in [src/main.tsx](src/main.tsx).

Hooks: `useSilentBoomTickerCounts()` and `useLotteryFinderTickerCounts()`, polling on the same 30s cadence as their parent feeds, gated on `marketOpen`.

**Done when:** curl returns the same ticker set + counts as the union of all pages of the main feed, and the chip strip in the UI shows tickers that aren't on page 1.

### Phase 2 — Silent Boom ticker rollup

1. New `src/components/SilentBoom/SilentBoomTickerGroup.tsx` — header row (ticker + count badge + best peak% + chevron), expandable to reveal the existing `SilentBoomRow` children. ~80 LOC.
2. In [SilentBoomSection.tsx](src/components/SilentBoom/SilentBoomSection.tsx) after `displayedAlerts`, add `groupedByTicker` via `useMemo` keyed on `[displayedAlerts]`. Sort groups by alert count desc (then most-recent bucket desc as tiebreak).
3. Replace `displayedAlerts.map(<SilentBoomRow>)` with `groupedByTicker.map(<SilentBoomTickerGroup>)`. Within-group rows stay in the user's chosen sort order.
4. Lift expand state to localStorage: `silent-boom-ticker-expanded` → `Record<string, boolean>`. Default closed. Per-row chart-expand stays per-row ephemeral (no change).
5. Top chip strip reads from `useSilentBoomTickerCounts()` instead of `alerts` page slice. Clicking a chip still filters the list (existing `ticker` filter).

**Done when:** NOW with 6 alerts shows as one collapsed row; expanding reveals 6 SilentBoomRows in the active sort order; refresh preserves which tickers were expanded; all filters/sorts/exit-policy controls still work unchanged.

### Phase 3 — Lottery Finder ticker rollup

Mirror of Phase 2 with `LotteryFinderTickerGroup.tsx` + grouping in [LotteryFinderSection.tsx](src/components/LotteryFinder/LotteryFinderSection.tsx). Same localStorage pattern (`lottery-ticker-expanded`). Same chip strip rewire.

**Done when:** lottery finder UI parity with Silent Boom rollup behavior.

## Files to create / modify

**Create**

- `api/silent-boom-ticker-counts.ts`
- `api/lottery-finder-ticker-counts.ts`
- `api/__tests__/silent-boom-ticker-counts.test.ts`
- `api/__tests__/lottery-finder-ticker-counts.test.ts`
- `src/hooks/useSilentBoomTickerCounts.ts`
- `src/hooks/useLotteryFinderTickerCounts.ts`
- `src/components/SilentBoom/SilentBoomTickerGroup.tsx`
- `src/components/LotteryFinder/LotteryFinderTickerGroup.tsx`

**Modify**

- [src/components/SilentBoom/SilentBoomSection.tsx](src/components/SilentBoom/SilentBoomSection.tsx) — add `groupedByTicker` useMemo, swap row render, rewire chip strip
- [src/components/LotteryFinder/LotteryFinderSection.tsx](src/components/LotteryFinder/LotteryFinderSection.tsx) — same
- [src/main.tsx](src/main.tsx) — add two new endpoints to botid `protect` list
- [vercel.json](vercel.json) — no change (no new crons; the endpoints are on-demand)

## Data / migrations

None. Both new endpoints query existing tables (`silent_boom_alerts`, `lottery_finder_fires`).

## Open questions

All resolved in the 2026-05-14 conversation:

- Ticker list source: dedicated counts endpoint (option b), not page-size bump.
- Expand persistence: localStorage map ticker → expanded.
- Component shape: twin `*TickerGroup` components, no generic abstraction.
- Within-group sort: honors user's chosen sortMode (not forced chronological).
- Fetch sequencing: not needed — per-row fetches are already `enabled: expanded`, so mounting collapsed rows costs zero requests.

## Thresholds / constants

- `TICKER_COUNTS_POLL_MS = 30_000` (matches main feed)
- Top chip strip cap: keep existing 12 (defined in Section files)
- localStorage key: `silent-boom-ticker-expanded`, `lottery-ticker-expanded`

## Risk notes

- `groupedByTicker` must be `useMemo`'d or grouping reruns on every poll tick.
- Chip strip data and main feed data come from different endpoints — they can drift mid-poll. Acceptable since both refresh on the same 30s cadence; worst case is a chip appearing 30s before/after its alerts.
- Test coverage: cron-style mocks not applicable here, but the two new endpoints need Vitest coverage that exercises the SQL query path and the owner/guest gate.
