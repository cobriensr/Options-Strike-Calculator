---
status: TBD
date: 2026-05-12
---

# GEX Landscape — MM-attributed swap (SPX-only)

**Date:** 2026-05-12
**Status:** Shipped — Phase 1 (ae2988b8), Phase 2 (85a8e5cc), Phase 3 (5453ef8b), Phase 4 (this).

## Goal

Replace the GEX Landscape's primary data source from the naive
`ws_gex_strike_expiry` table to UW Periscope's MM-attributed per-strike
gamma + charm values written by the `periscope-scraper` Railway service
every 10 min during RTH. Keep the call/put-split **vol reinforcement
column** sourced from `ws_gex_strike_expiry` as a side channel — the
single 0DTE signal MM-attribution data structurally cannot provide
(reinforcing-wall vs. unwinding-wall is the trade for /ES hedge bias).

Scope is **SPX 0DTE only.** Drop the SPY / QQQ / NDX ticker selector;
those tickers continue to be served by their own flow-hunting surfaces
elsewhere (per `feedback_hunt_flow_in_spy_qqq.md`).

## Why now

- The user trades MM-attributed values off Periscope screenshots
  visually. The current GEX Landscape shows naive `call+put gamma OI`
  in its "Dollar Γ" column, which doesn't match what's on the screen
  — a recurring footgun.
- Periscope scraper has been writing `periscope_snapshots` reliably
  for 5+ days; spot-check audit (`project_periscope_scraper_verified.md`)
  found zero discrepancies.
- SPX/NDX never worked in the multi-ticker UI anyway (uw-stream WS
  daemon doesn't subscribe to them yet); SPY/QQQ rendered but the
  user doesn't trade GEX on them — flow hunting uses different surfaces.

## Data sources

| Surface                            | Source                                  | Cadence | Purpose                                                                |
| ---------------------------------- | --------------------------------------- | ------- | ---------------------------------------------------------------------- |
| Per-strike MM gamma + charm + sign | `periscope_snapshots` (SPX 0DTE)        | 10 min  | Primary read — classification, "Dollar Γ" column, floor/ceiling, Top 5 |
| Vol reinforcement column (✓/✗)     | `ws_gex_strike_expiry` (SPX 0DTE)       | 1 min   | Side channel — only place call/put ask/bid split exists                |
| Spot                               | `index_candles_1m` WHERE symbol = 'SPX' | 1 min   | Same as today                                                          |

## Phases

### Phase 1 — Backend: `/api/periscope-strikes` endpoint

New owner-or-guest endpoint returning raw per-strike rows for the
panel's full ±50pt grid (vs. the existing `/api/periscope-exposure`
which returns the formatted Top-N + cone + breaches).

Response shape:

```ts
{
  marketOpen: boolean,
  asOf: string,
  capturedAt: string | null,
  priorCapturedAt: string | null,
  spot: number | null,
  strikes: Array<{ strike: number; gamma: number; charm: number }>,
  availableSlots: string[],  // ISO ascending, panel='gamma' anchor
}
```

Implementation reuses `fetchLatestPeriscopeSlot()` from
`api/_lib/periscope-format.ts` — joins gamma + charm arrays into a
per-strike merge. Query params: `?date=YYYY-MM-DD&time=HH:MM` (CT)
matching `/api/periscope-exposure`. Cache headers: 30s live during RTH,
300s for historical reads.

**Files:**

- `api/periscope-strikes.ts` (new, ~100 LOC)
- `api/__tests__/periscope-strikes.test.ts` (new)
- `src/main.tsx` — add to botid `protect` array

### Phase 2 — Hook: `useGexLandscapeData` rewrite

Rewrite the adapter to consume `/api/periscope-strikes` as primary, with
a secondary fetch to `/api/gex-strike-expiry?ticker=SPX` for the vol
reinforcement column.

The projection produces a slimmer `GexStrikeLevel` — only fields
actually rendered. Keep type backwards-compatible by leaving extra
fields nullable / zeroed during transition, but the panel reads will
all route through MM data for gamma/charm signs and magnitudes.

Δ% map computation moves to **client-side** at 10-min cadence:
`gexDelta10mMap`, `gexDelta20mMap`, `gexDelta30mMap` — built from the
buffer of available slots returned by the endpoint. Server-side `LAG()`
not needed at this cadence (3 windows × 1 row each is trivial).

The 1m / 5m / 15m delta windows are **dropped** — meaningless at
10-min cadence. UI removes those columns.

**Files:**

- `src/hooks/useGexLandscapeData.ts` (rewrite, ~150 LOC)
- `src/hooks/useGexStrikeExpiry.ts` — narrow to SPX-only call; remove
  multi-ticker `Record<Ticker, ...>` returns if no other consumers
- `src/__tests__/hooks/useGexLandscapeData.test.ts` (rewrite)

### Phase 3 — Component: ticker drop + column swap

`src/components/GexLandscape/index.tsx`:

- Remove `TickerSelector`, `Ticker` type, `TICKER_OPTIONS`.
- Hardcode `ticker = 'SPX'` everywhere it's referenced.
- Remove all 4 selector props from `bias.ts`, `classify.ts` call sites
  that take `ticker` as input (used for ticker-specific thresholds; SPX
  becomes the only path).
- Update `StrikeTable` columns: drop `1M Δ%`, `5M Δ%`, `15M Δ%`; keep
  `10M Δ%`, `20M Δ%`, `30M Δ%`.
- Vol reinforcement column wired to side-channel WS data via the
  hook's secondary fetch.

**Files:**

- `src/components/GexLandscape/index.tsx`
- `src/components/GexLandscape/types.ts` — drop `Ticker`, remove
  multi-ticker shape
- `src/components/GexLandscape/constants.ts` — drop `Ticker` export
- `src/components/GexLandscape/StrikeTable.tsx` — drop 3 columns, add 2
- `src/components/GexLandscape/bias.ts` — drop ticker parameter
- `src/components/GexLandscape/classify.ts` — drop ticker parameter

### Phase 4 — Bias recalibration

**Default approach (observe-first):** ship Phase 3 with the bias panel
still rendering, but tag the verdict label with a "(calibrating)"
suffix for one full session. The verdict synthesis logic
(`computeBias()`) is structurally fine — verdict depends on signs and
relative magnitudes, not absolute scale — but the `floorTrend` /
`ceilingTrend` thresholds in `bias.ts` are tuned against naive
magnitudes. After one session of observation, recalibrate from the
real MM-attributed slot history and remove the suffix.

**Alternative:** recalibrate now from the 5 days of historical
`periscope_snapshots` already in the DB. Faster to ship but 5 days is
thin for threshold tuning.

**Files:** `src/components/GexLandscape/bias.ts` (constants only)

**Phase 4 cleanup checklist** — items flagged during the Phase 3 review
that aren't bug-fixes but need attention before the swap is truly
finished:

- `src/utils/price-trend.ts`'s `windowMs = 5 * 60 * 1000` was tuned for
  the 1-min WS cadence. At 10-min MM cadence, a 5-min window can hold
  at most one snapshot — the drift override (`rangebound` →
  `drifting-up` / `drifting-down`) is effectively dormant. Widen to
  ~20-30 min OR document that the override is intentionally dormant
  on the MM-source path.
- `useGexLandscapeData` still calls `useGexStrikeExpirySpx` for the
  vol reinforcement side channel. If UW ever publishes per-strike
  call/put ask/bid attribution in `periscope_snapshots`, drop the WS
  side channel entirely — the `wsByStrike` projection + the
  `useGexStrikeExpirySpx` hook would both become orphan code.
- `useGexLandscapeData`'s `_ticker: string` parameter is unused
  vestigial scaffolding kept for Phase 2 call-site compatibility.
  Drop it from the signature here AND the call site in `index.tsx`.

## Open questions

1. **Δ% windows** — go with `10m / 20m / 30m` as the natural slot
   cadence fit, or use a different set? My default: 10/20/30m.
2. **Bias recalibration** — observe-first (ship with "calibrating"
   tag) or recalibrate now from history? My default: observe-first.
3. **Vol reinforcement staleness display** — show the WS-feed's
   `asOf` timestamp next to the column so a stale WS connection is
   visible? My default: yes, small subscript timestamp.
4. **Top 5 GEX tracker chime** — 10-min cadence means slower
   composition changes. Keep the tracker + chime as-is (just a slower
   heartbeat) or drop it? My default: keep.
5. **SPY/QQQ/NDX leftover code** — any downstream consumer of the
   multi-ticker `Record<Ticker, ...>` shape? If yes, leave the shape
   and just bypass it; if no, narrow the underlying types. Investigate
   in Phase 2.

## Thresholds / constants

- `PRICE_WINDOW = 50` (unchanged — ±50pt grid)
- `TOP_GEX_COUNT = 5` (unchanged)
- Δ% buckets: `10m / 20m / 30m`
- Slot anchor query: `panel = 'gamma'` (per existing
  `fetchAvailableSlots` convention; 141 migration guarantees gamma /
  charm / vanna land at same captured_at)

## Data dependencies

- `periscope_snapshots` table (migration #140, #141) — already
  populated for SPX 0DTE since 2026-05-08.
- `ws_gex_strike_expiry` table — already populated for SPX (with
  ask/bid split per strike).
- `index_candles_1m` for SPX spot — already populated.
- No new migrations required.

## Out of scope

- Multi-DTE Periscope support (the scraper pins Expiry=Single to 0DTE).
- SPY/QQQ/NDX in this panel (intentionally dropped).
- Re-using MM data in other panels (Strike Battle Map, etc.) — those
  remain on naive WS data unless / until separately scoped.
- Backfilling historical `periscope_snapshots` beyond what's already
  scraped.
