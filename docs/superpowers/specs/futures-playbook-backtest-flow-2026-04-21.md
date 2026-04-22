# Futures Playbook — Wall-flow signals work during backtest/scrub

**Date:** 2026-04-21
**Status:** Scoped, ready to build
**Parent:** futures-playbook-bias-metrics-2026-04-21.md

## Goal

Make the WallFlowStrip (and the `flowSignals` fed into `rulesForRegime`)
work when the user scrubs to a historical timestamp, not just live mode.
Fetch a 5-minute window of per-strike snapshots around the scrubbed ts
and seed the existing snapshot ring buffer with them, so the same
`computeDeltaMap` / `computePriceTrend` pipeline emits signals in both
modes.

## Why the current state is broken for backtest

The client-side snapshot ring buffer in `useFuturesGammaPlaybook` was
designed for live accumulation — it appends each incoming snapshot and
prunes entries older than `now − 10min`. When the user scrubs backward
to an earlier timestamp, the buffer's cutoff shifts backward too, so
any forward snapshots get pruned. Each scrub lands on at most one
snapshot. `computeDeltaMap(current, prev)` returns an empty map,
`ceilingTrend5m` / `floorTrend5m` are null, and the strip shows `—`.

Conviction overlay still works (it reads charm from the current
snapshot only). Drift-override fails quietly (`priceTrend` is null for
same reason).

## Approach

**Extend the existing `/api/gex-per-strike` endpoint** with an optional
`window=<N>m` query param. When present, the response includes a new
`windowSnapshots` array containing every per-strike snapshot whose
timestamp falls within `[targetTs − N, targetTs)` on the same
trading date.

Client seeds the ring buffer with `windowSnapshots` on each scrub,
then normal Δ% / priceTrend math fires against real data. One
`computeDeltaMap` implementation powers both live and scrub.

## Files touched

**Modify:**

- `api/gex-per-strike.ts` — accept `window=<N>m` param, 1-15m range.
  When present, run a second query pulling prior snapshots within the
  window (excluding the target itself to avoid duplicate). Return them
  as `windowSnapshots: Array<{timestamp, strikes}>`.
- `api/_lib/validation.ts` — add Zod parsing for the new query param.
  `z.string().regex(/^\d+m$/)` → integer minutes 1–15.
- `src/hooks/useGexPerStrike.ts` — pass `window=5m` query when a
  consumer asks for it (new hook option `includeWindow?: boolean`).
  Expose `windowSnapshots` in the return shape.
- `src/hooks/useFuturesGammaPlaybook.ts` — seed the snapshot buffer
  from `windowSnapshots` on every scrub identity change. When
  `isScrubbed === true` and `windowSnapshots` is populated, overwrite
  the buffer rather than append.
- `src/components/FuturesGammaPlaybook/WallFlowStrip.tsx` — drop the
  em-dash placeholder in favor of rendering nothing until the buffer
  is seeded (matches the rest of the panel's "no data yet" behavior).

**Create:**

- `api/__tests__/gex-per-strike.window.test.ts` — new tests covering
  `window=5m` parsing, the prior-snapshots query, and edge cases
  (no prior snapshots, target at start of day, malformed window).

## Thresholds / constants

```ts
// In api/gex-per-strike.ts
const WINDOW_MIN_MINUTES = 1;
const WINDOW_MAX_MINUTES = 15; // hard cap so a pathological request can't pull ∞
```

## Data shape (new on the response)

```ts
interface WindowSnapshot {
  timestamp: string;              // ISO-8601
  strikes: GexStrikeLevel[];      // same shape as the primary snapshot
}

// Added to existing response when ?window=5m is passed:
windowSnapshots: WindowSnapshot[];   // chronological, empty when no prior
```

## Phases

### Phase 1 — Server endpoint (~30 min, 2 files)

- Parse `window` query param via Zod.
- Add a second SQL query: pull every distinct timestamp between
  `targetTs - Nm` and `targetTs` (exclusive of target) for the same
  date, then for each one, join its strikes. Limit: `WINDOW_MAX_MINUTES`.
- Shape into `WindowSnapshot[]`.
- Return alongside the existing payload.
- Test with `curl localhost:3000/api/gex-per-strike?date=2026-04-21&ts=...&window=5m`.

### Phase 2 — Hook wiring (~30 min, 2 files)

- Add `includeWindow` option to `useGexPerStrike` (default false so
  the analyze path and other callers don't pay for it).
- `useFuturesGammaPlaybook` passes `includeWindow: true`.
- When `windowSnapshots` changes (detected via scrub key signature
  or ts), replace the buffer ref's contents with the fetched
  snapshots, then append the current one.

### Phase 3 — UI polish (~15 min, 1 file)

- `WallFlowStrip`: swap `fmtPct(null) === '—'` for a subtle
  "awaiting snapshots" placeholder when both values are null AND the
  rules have data (distinguishes "loading" from "nothing to show").

### Phase 4 — Verification (~15 min)

- `npm run review` clean.
- Open prod after deploy, scrub to a mid-morning timestamp, confirm
  the strip shows non-zero Δ% values.
- Confirm live mode still works (scrubLive → strip accumulates
  live just like before).

## Done when

- [ ] `/api/gex-per-strike?...&window=5m` returns `windowSnapshots` of
      prior snapshots within the window.
- [ ] Scrubbing to an earlier timestamp populates the WallFlowStrip
      and re-enables the drift-override.
- [ ] `npm run review` green; all existing tests still pass.
- [ ] Manual: prod scrub to 11:00 AM shows the strip with real 5m Δ%.

## Non-goals

- Not precomputing flow signals server-side — keep the compute in one
  place (`deltas.ts`).
- Not caching window payloads — scrub is user-driven and low-frequency.
- Not changing the live path at all — it still accumulates naturally.
- Not pulling a wider window than 15m — if we want longer lookbacks
  later, that's a separate decision about retention cost.
