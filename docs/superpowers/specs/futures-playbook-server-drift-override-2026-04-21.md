# Futures Playbook — Server-side drift-override parity

**Date:** 2026-04-21
**Status:** Scoped, ready to build
**Parent:** futures-playbook-bias-metrics-2026-04-21.md, -backtest-flow-2026-04-21.md
**Prior audit:** 2b98eb8 fixed 12 bugs; the cron parity gap was documented as follow-up.

## Goal

Stop the server-side regime cron from firing `TRIGGER_FIRE` push alerts
for fade/lift triggers the client UI has dropped under drift-override.
Compute `priceTrend` server-side from `spot_exposures` so `evaluateTriggers`
emits the same `BLOCKED` decision on the cron side that `rulesForRegime`
already emits on the client side.

## Why this matters

The user trades off this panel. When the tape is grinding up through the
call wall in POSITIVE regime, `rulesForRegime` correctly drops the
`pos-fade-call-wall` row — that would be fading into a trend. The client
UI stays honest. But the server cron at `api/cron/monitor-regime-events.ts`
has no snapshot buffer, can't compute priceTrend, and still fires a
`TRIGGER_FIRE` push for `fade-call-wall`. Trader gets a push alert for a
trade the panel refuses to show. That's the worst class of UI/alert
divergence.

## Approach

Extract `computePriceTrend` to a shared pure module (`src/utils/price-trend.ts`)
that both the React hook and the Vercel Function cron can import. Change
its contract from `(currentPrice, Snapshot[], nowTs)` to a flat
`{price, ts}[]` series so the cron can call it without constructing fake
per-strike snapshots. Server queries the last 5 minutes of `spot_exposures`
and feeds the primitive.

## Files to create / modify

**Create:**

- `src/utils/price-trend.ts` — new pure module exporting:
  - `PriceTrend` interface (moved from `GexLandscape/types.ts`)
  - `DRIFT_PTS_THRESHOLD` / `DRIFT_CONSISTENCY_THRESHOLD` constants
    (moved from `GexLandscape/constants.ts`)
  - `computePriceTrend(prices: Array<{price: number; ts: number}>, nowTs, windowMs?): PriceTrend`
- `src/__tests__/utils/price-trend.test.ts` — 6+ cases covering MIN_SNAPSHOTS
  gate, direction classification, consistency boundary, threshold boundary,
  empty input, single-point input.

**Modify:**

- `src/components/GexLandscape/types.ts` — re-export `PriceTrend` from the
  new location to avoid churn in downstream imports.
- `src/components/GexLandscape/constants.ts` — re-export the two
  thresholds from the new location.
- `src/components/GexLandscape/deltas.ts` — `computePriceTrend` becomes
  an adapter that maps `Snapshot[]` → `{price, ts}[]` and delegates to
  the primitive. The old signature stays so `GexLandscape/index.tsx`
  doesn't need changes.
- `src/hooks/useFuturesGammaPlaybook.ts` — same deal; existing call site
  stays on the adapter, or flip to the primitive directly (both work).
- `api/cron/monitor-regime-events.ts`:
  - Add `loadRecentSpotPrices(today, nowTs, windowMs)` that queries
    `spot_exposures WHERE date = today AND ticker = 'SPX' AND timestamp >= now - 5m ORDER BY timestamp ASC`.
  - Before calling `evaluateTriggers`, construct `flowSignals` with
    `priceTrend` from the new primitive; leave `upsideTargetCls`,
    `downsideTargetCls`, `ceilingTrend5m`, `floorTrend5m` as null
    (server doesn't need those for the suppression logic).
  - Drop the follow-up comment added in 2b98eb8.
- `api/__tests__/monitor-regime-events.test.ts` — new test: when price
  history shows a consistent up-drift in POSITIVE regime,
  `fade-call-wall` resolves to `BLOCKED` with a drift reason; the
  filtered `firedTriggers` list does not include it.

**Do not modify:**

- `evaluateTriggers` itself — the `flowSignals` parameter is already
  there from 2b98eb8. We're only teaching the cron to pass it.

## Open questions (decided)

- **Server-side window size?** Same 5-minute window as the client, so
  the suppression fires on the same signal footprint.
- **Minimum sample count?** Keep `MIN_SNAPSHOTS = 3` from the primitive.
  `spot_exposures` cadence is ~1min during market hours, so 5-min
  window ≈ 5 samples — easily above the threshold.
- **Do we persist priceTrend on the regime_monitor_state row?** No.
  The cron computes it fresh each tick. The state row is for edge
  detection, not for flow-signal snapshots. Persisting would invite
  staleness bugs for no real benefit.
- **Spot column source of truth?** The cron already calls
  `loadSpotExposure()` which pulls the latest `spot_exposures` row. The
  new helper is a sibling that pulls a window instead.

## Thresholds / constants

No new constants introduced. `DRIFT_PTS_THRESHOLD = 3` and
`DRIFT_CONSISTENCY_THRESHOLD = 0.55` (both existing) move locations
only. `DRIFT_OVERRIDE_CONSISTENCY_MIN = 0.55` in `playbook.ts` already
aligned in 2b98eb8.

## Non-goals

- Not computing `ceilingTrend5m` / `floorTrend5m` server-side — those
  are display-only and not consumed by `evaluateTriggers`.
- Not computing `upsideTargetCls` / `downsideTargetCls` server-side —
  charm conviction is a UI overlay, not a rule-gate.
- Not moving the whole snapshot-buffer concept server-side — we only
  need `priceTrend`. Anything beyond creates surface area for no
  benefit.
- Not changing the push notification payload. The cron already stores
  edge events in `regime_events`; we're just preventing bogus firings.

## Risk notes

- **Circular import risk:** `playbook.ts` currently imports
  `PlaybookFlowSignals` from `./types`, which will import `PriceTrend`
  from `src/utils/price-trend.ts`. `price-trend.ts` has zero dependencies
  on any other project module. Import graph stays acyclic.
- **`.js` extension hygiene:** `src/utils/price-trend.ts` will be
  imported by `api/cron/monitor-regime-events.ts` (through
  `FuturesGammaPlaybook/types` → `GexLandscape/types` re-export chain).
  All relative imports in this new file and its re-exporters must use
  explicit `.js` extensions.
- **Test isolation:** `monitor-regime-events.test.ts` mocks `sql`. We
  need a mock pattern for the new `spot_exposures` window query that
  can return different price series per test.

## Phases

### Phase 1 — Extract primitive + tests (~30 min, 2 files)
1. Create `src/utils/price-trend.ts` with the flat-series signature.
2. Write 6+ test cases.
3. Verify: `npm run test:run -- price-trend` passes.

### Phase 2 — Update client-side imports (~20 min, 3-4 files)
1. Re-export types/constants from new location in `GexLandscape/*`.
2. Rewrite `deltas.ts` `computePriceTrend` as adapter.
3. Verify: `npm run test:run` — all existing tests still pass, no
   signature changes observed at call sites.

### Phase 3 — Wire server-side (~45 min, 2 files + 1 test file)
1. Add `loadRecentSpotPrices` helper in the cron.
2. Compute `flowSignals.priceTrend` and pass into `evaluateTriggers`.
3. Remove the follow-up comment.
4. Add regression test for the drift-override suppression at the
   cron level.
5. Verify: `npm run test:run -- monitor-regime-events` passes new case.

### Phase 4 — Verification (~15 min)
1. `npm run review` clean (baseline 10 unrelated ESLint errors aside).
2. Grep for any lingering references to the moved constants/types at
   old paths outside re-export files.
3. Commit + push.

## Done when

- [ ] `computePriceTrend` lives in `src/utils/price-trend.ts` with a
      flat `{price, ts}[]` signature.
- [ ] The cron computes `priceTrend` server-side and passes it into
      `evaluateTriggers`.
- [ ] Regression test proves the cron blocks `fade-call-wall` under
      a drift-up scenario.
- [ ] `npm run test:run` green; TSC clean.
- [ ] Existing client-side behavior unchanged (GexLandscape still
      computes its priceTrend identically via the adapter).
