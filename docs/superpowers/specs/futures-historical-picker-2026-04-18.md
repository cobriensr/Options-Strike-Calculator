# Futures Historical Time Picker — 2026-04-18

## Goal

Let the user pick an arbitrary past datetime in the Futures panel and see
each symbol's price + derived metrics (1h change, day change, volume ratio,
VX term spread, ES-SPX basis) as of that moment. Source: 1-minute
`futures_bars` with on-the-fly derivation (matching the existing
`computeSnapshot()` cron logic, just with a caller-supplied timestamp
instead of `new Date()`).

## Decisions

- **Source table:** `futures_bars` (1-min, continuous via Databento stream)
  — not `futures_snapshots` (5-min derived). User explicitly asked for
  1-min granularity.
- **Granularity:** snap picker value to the nearest bar at-or-before the
  chosen time. Display the actual `ts` used so there's no ambiguity (badge
  already shows "updated at" — reuse).
- **Range:** `min` on the datetime input = `MIN(ts)` across
  `futures_bars`, fetched once with the first snapshot response and cached
  on the hook. `max` = now (live).
- **Default / "Now":** empty `at` param → current behavior (latest bar).
  "Now" button clears the picker.
- **Basis fallback:** when no `market_snapshots` row exists for the
  picked `trade_date`, `esSpxBasis = null`. Don't invent fallbacks.
- **Trade date:** derived from the picked timestamp in ET, same as the
  cron does with `getETDateStr(now)`.
- **Owner-gating & bot check:** unchanged — endpoint already enforces.

## Files to create / modify

### Backend

- **MODIFY** `api/futures/snapshot.ts` — accept optional `?at=<ISO>` query
  param. Validate with Zod (`validation.ts`). When present, route to
  historical path (uses shared derivation).
- **CREATE** `api/_lib/futures-derive.ts` — extract `computeSnapshot()`
  and related helpers from `api/cron/fetch-futures-snapshot.ts` into a
  shared module that takes `(symbol, tradeDate, at: Date)`. Cron + endpoint
  both import from here.
- **MODIFY** `api/cron/fetch-futures-snapshot.ts` — import the shared
  helper instead of defining inline.

### Frontend

- **MODIFY** `src/hooks/useFuturesData.ts` — accept optional `at?: string`
  (ISO). Re-fetch when it changes. Expose `oldestTs` (returned by the
  endpoint) for picker `min`.
- **MODIFY** `src/components/FuturesCalculator/FuturesPanel.tsx` — add
  datetime-local input + "Now" button in the header. Show a subtle
  "VIEWING HISTORICAL" pill when `at` is set.
- **NO CHANGES** to `FuturesGrid.tsx` or `VixTermStructure.tsx` — they
  just render what the hook passes them.

### Tests

- **CREATE** `api/__tests__/futures-snapshot-historical.test.ts` —
  validates `?at=` routing, Zod rejection of malformed input, nearest-bar
  snapping, and basis null when no SPX row.
- **MODIFY** `api/__tests__/futures-snapshot.test.ts` — confirm
  backwards-compat (no `at` param = current behavior).
- **CREATE** `src/__tests__/hooks/useFuturesData.historical.test.ts` —
  hook refetches when `at` changes, resets on empty.
- **MODIFY** `src/__tests__/components/FuturesPanel.test.tsx` — picker
  renders, typing a date triggers fetch, "Now" clears it.

## Data dependencies

- Reads `futures_bars` (1-min OHLCV from sidecar) and `market_snapshots`
  (for SPX). Both already exist; no new tables, no migrations.

## API shape

```ts
// GET /api/futures/snapshot?at=2026-04-17T14:30:00Z
// Response unchanged, plus:
{
  // existing fields...
  oldestTs: string | null; // MIN(ts) from futures_bars, for picker min
  requestedAt: string | null; // echoes input when historical
}
```

## Phases

1. **Backend:** extract derivation helper, wire `?at=` into endpoint with
   Zod validation, add `oldestTs` + `requestedAt` to response. Tests.
2. **Frontend:** hook accepts `at`, panel renders picker, "Now" button
   resets, historical pill. Tests.
3. **Verify:** `npm run review` clean. Manual smoke: load panel, pick
   yesterday 10:30 CT, confirm prices change. Click Now, confirm reverts.

Each phase is independently shippable and goes through the Get It Right
loop (implement → review subagent → act).

## Thresholds / constants

- Picker step: 60 seconds (matches 1-min bar granularity).
- `at` Zod schema: `z.string().datetime().optional()` — reject anything
  that isn't a valid ISO datetime.

## Open questions

None remaining after 2026-04-18 scoping turn.
