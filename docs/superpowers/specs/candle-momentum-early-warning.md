# Candle Momentum Early Warning

## Goal

Add client-side momentum and acceleration signals computed from 1-minute SPX candles to give the user earlier warning of directional moves — without waiting for the 5-minute server-side GEX recomputation cycle.

## Problem

The GEX target cron writes snapshots every 5 minutes. The client polls every 60 seconds. The delta percentages (5M/20M) shown on the target tile are lookback metrics computed at cron time. Worst-case latency from move-start to signal: ~6 minutes. For 0DTE trading, this is too slow to be proactive.

## Solution

Compute momentum signals **client-side** from the 1-minute candles the hook already has. These update every 60 seconds (poll interval) and reflect the most recent candle data — cutting latency from ~6 min to ~60 seconds.

## Phases

### Phase 1: Pure Utility (`src/utils/candle-momentum.ts`)

New pure module — no React, no side effects.

**`CandleMomentum` interface:**
- `roc1`: 1-candle rate of change (pts)
- `roc3`: 3-candle rate of change (pts)
- `roc5`: 5-candle rate of change (pts)
- `streak`: consecutive same-direction candles (+N green, -N red)
- `avgRange`: average candle range over last 5 candles
- `avgRangePrev`: average candle range over 5 candles before that
- `rangeExpanding`: boolean — are ranges widening?
- `acceleration`: second derivative — ROC of ROC (roc1 - previous roc1)
- `signal`: classified state: `'surge-up' | 'drift-up' | 'flat' | 'drift-down' | 'surge-down'`

**`computeMomentum(candles: SPXCandle[]): CandleMomentum`**

**Signal classification thresholds:**
- `surge`: |streak| >= 3 AND rangeExpanding
- `drift`: |streak| >= 2 OR |roc3| > threshold but not expanding
- `flat`: everything else

### Phase 2: PriceChart 1m/5m Toggle

- Add `interval: '1m' | '5m'` prop (default `'5m'`)
- When `'1m'`, skip `resampleTo5Min()` — render raw 1-min candles
- Add `onIntervalChange` callback prop
- Toggle rendered in SectionBox `headerRight`

### Phase 3: Wire Into GexTarget

- Add `candleInterval` state in `GexTarget/index.tsx`
- Compute `CandleMomentum` from `visibleCandles` via `useMemo`
- Pass interval + momentum to PriceChart

### Phase 4: Momentum/Acceleration Visual (placement TBD)

**Option A: Histogram pane** — lightweight-charts pane index 2, colored momentum bars
**Option B: Header badge** — `SURGE ▼` / `DRIFT ▲` in PriceChart header
**Option C: Both** — badge for at-a-glance, histogram for trajectory

Waiting on user input for placement decision.

### Phase 5: Tests

- Unit tests for `candle-momentum.ts` — streak detection, range expansion, signal classification
- Component test updates for PriceChart toggle

## Files to Create/Modify

| Phase | File | Action |
|-------|------|--------|
| 1 | `src/utils/candle-momentum.ts` | Create |
| 2 | `src/components/GexTarget/PriceChart.tsx` | Modify |
| 3 | `src/components/GexTarget/index.tsx` | Modify |
| 4 | PriceChart or new component | TBD |
| 5 | `src/__tests__/utils/candle-momentum.test.ts` | Create |

## Thresholds / Constants

- Streak threshold for `surge`: 3 consecutive candles
- Streak threshold for `drift`: 2 consecutive candles
- Range expansion: current 5-candle avg range > previous 5-candle avg range by > 20%
- ROC threshold for drift: 2 pts over 3 candles (tunable)
- These go in the utility as named constants, easy to tune

## Open Questions

- [ ] Option 3 placement: histogram pane, header badge, or both?
- [ ] Should surge signal trigger a browser notification (Notification API)?
- [ ] Should momentum feed into the GEX target scoring pipeline (priceConfirm)?
