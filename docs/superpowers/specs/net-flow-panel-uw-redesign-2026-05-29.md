# Net Flow Panel — UW-style Redesign

**Date:** 2026-05-29
**Status:** In progress

## Goal

Make the NET FLOW panel (rendered by `TickerNetFlowChart`) match the cleaner
Unusual Whales net-flow layout the user prefers: a single inline metric header
with color-dotted labels, in-pane titles (`Net Premiums` / `Net Volume`), and a
premium-dominant pane split — replacing the current two-row header + dense
7-metric swatch strip.

## Why

The current chart engine is already identical to the UW reference
(lightweight-charts v5, two panes, same series + colors). The only difference is
chrome. That chrome is **duplicated 3×** across `LotteryRow`, `IntervalBARow`,
and `SilentBoomRow`, each wrapping the same `TickerNetFlowChart`. Centralizing
the header into the chart matches UW, kills the duplication, and makes all three
consumers consistent.

## Phases

### Phase 1 — `TickerNetFlowChart.tsx` (+ `TickerNetFlowChart.test.tsx`)

- New optional prop `symbol?: string`.
- Compute latest header stats from existing `series`/`candles`:
  - `spot` = `candles.at(-1).close`
  - `netVol` = `last.cumNcv − last.cumNpv` (contracts, comma-formatted)
  - `npp` = `last.cumNpp`, `ncp` = `last.cumNcp` (compact $M/$K)
  - freshness label = M/D + last-tick CT time (12h)
- Render inline header row above the canvas with the full metric set:
  `{date time} • {SYM}: {spot} • NCP • NPP • Δ$ • NCV • NPV • Δv`. Charted-line
  metrics carry a colored dot mapping to their series (amber=price, green=NCP,
  red=NPP, slate=Δv→volume pane); derived/volume metrics (Δ$, NCV, NPV) are
  plain neutral text, with signed green/red coloring on the Δ values. (User
  wants the contract-volume split visible, not just net Vol — 2026-05-29.)
- Add `Net Premiums` / `Net Volume` pane-title overlays (absolute, top-left of
  each pane; volume-pane Y computed from `chart.panes()[1]` geometry like the
  existing marker-X recompute).
- Set pane stretch factors 3:1 (premiums:volume) to match UW proportions.
- Keep hover readout strip + fire-time marker unchanged.
- Backward compatible: `symbol` optional so existing tests/signature hold.

### Phase 2 — the 3 consumers

- `LotteryRow.tsx`, `IntervalBARow.tsx`, `SilentBoomRow.tsx`: pass `symbol`,
  delete each one's header `<div>` + stats strip + now-unused `flowStats` memo
  and local premium/vol formatters (orphan cleanup).
- Update consumer tests if the removed markup was asserted (mocks already stub
  the chart to `ariaLabel` only, so low risk).

## Files

- Phase 1: `src/components/charts/TickerNetFlowChart.tsx`,
  `src/__tests__/TickerNetFlowChart.test.tsx`
- Phase 2: `src/components/LotteryFinder/LotteryRow.tsx`,
  `src/components/IntervalBAFeed/IntervalBARow.tsx`,
  `src/components/SilentBoom/SilentBoomRow.tsx` (+ their tests if needed)

## Data dependencies

None — all header values derive from props already passed (`series`,
`candles`, `date`). Only new prop is `symbol`.

## Thresholds / constants

- Pane stretch: price 3 : volume 1.
- Header dot colors: price `#fbbf24`, vol slate-400, NPP `#f87171`, NCP
  `#34d399` (mirror series colors).

## Open questions

- Line/candle price toggle (UW top-right) is a feature, not chrome — **deferred**
  unless requested.

## Out of scope

- Candlestick price mode.
- Any change to the net-flow data pipeline / API.
