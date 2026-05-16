# Lottery Contract + Net Flow Panel Polish — 2026-05-15

## Goal

Bring the LotteryFinder per-fire **CONTRACT** and **NET FLOW** panels (rendered
inside `LotteryRow` when a row is expanded) up to — and past — Unusual Whales
Contract-Lookup parity. The current panels are functionally correct but
information-sparse and have a real x-axis rendering bug (NET FLOW renders UTC
times instead of CT).

The user trades 0DTE every session and reads these panels under time pressure;
every millisecond saved decoding a chart compounds over the day.

## Observed bugs

1. **NET FLOW x-axis renders UTC times.** `TickerNetFlowChart.tsx` sets
   `localization.timeFormatter` (which formats the crosshair tooltip only) but
   never sets `timeScale.tickMarkFormatter` (which formats the axis labels).
   Result: axis shows `19:45 19:50 19:55 19:59` (UTC) instead of `14:45 ... 14:59` CT.
2. **NET FLOW visible window collapses to last ticks.** `fitContent()` runs once
   on first non-empty data load. If the data starts narrow (early in the session
   or after a polling refresh), the chart stays zoomed in.
3. **Fire-time marker has no label.** Users hovering the dashed purple line have
   no idea what time it represents.

## Polish opportunities (in priority order)

### CONTRACT panel

1. Header is missing `OI`, total premium `$`, and `%OTM` — UW packs these into
   the same strip.
2. No hover tooltip: hand-rolled SVG, no per-bar inspection. User can't read
   exact bid/mid/ask split for a given minute without squinting.
3. Volume bars share a single 35% zone with no y-axis tick label — magnitude is
   guessed.
4. Three-point CT time axis is sparse; five is more readable across a 6.5-hour
   session.
5. No annotation on the largest print of the day (biggest single-minute bar
   should be highlighted).
6. No VWAP horizontal reference across the price zone.
7. Colored side labels (Bid/Mid/Ask) in the header strip have no swatches —
   readers must infer red=bid, green=ask.

### NET FLOW panel

1. Header strip is missing `Net Vol` (the very thing the bottom pane shows).
2. Crosshair tooltip is lightweight-charts default — value-per-line rather than a
   single readable "at this time, here's everything" strip.
3. No visual divergence shading between NCP and NPP (the _call vs put_ premium
   regime is the whole point of the panel).
4. No zero-cross markers — visually impossible to tell when cumulative NCV first
   crossed zero, which is a hold/cut signal.
5. Marker has no label.
6. Header swatches missing.

### Outside the box

1. **Cross-panel hover sync** — UW does not do this. If the user hovers a moment
   on the CONTRACT chart, the NET FLOW cursor should snap to the same time.
   Reading "what happened on the contract when underlying moved 0.4%?" becomes
   one glance, not three.

## Phases

Each phase is independently shippable. Per `feedback_per_phase_loop.md`: each
phase ends with the code-reviewer subagent + `npm run review` + commit + push.

| #   | Scope                                                                              | Files                                                               |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | NET FLOW: `tickMarkFormatter`, session-pin visible range, marker title             | `TickerNetFlowChart.tsx`                                            |
| 2   | Header density + swatches in both panels                                           | `LotteryRow.tsx`                                                    |
| 3   | CONTRACT: hover tooltip, max-bar callout, VWAP line, 5-tick axis, volume-max label | `ContractTapeChart.tsx`                                             |
| 4   | NET FLOW: custom crosshair readout strip, divergence fill, zero-cross markers      | `TickerNetFlowChart.tsx`                                            |
| 5   | Cross-panel hover sync: shared `hoverTime` state                                   | `LotteryRow.tsx`, `ContractTapeChart.tsx`, `TickerNetFlowChart.tsx` |
| 6   | Tests + `npm run review` + commit                                                  | `ContractTapeChart.test.tsx`, `TickerNetFlowChart.test.tsx`         |

## Data dependencies

All data is already on the wire — no new endpoints, migrations, or env vars.

- `fire.entry.openInterest` → CONTRACT header OI
- `fire.entry.spotAtFirst` + `fire.strike` + `fire.optionType` → %OTM
- `tapeStats.avgFill * tapeStats.total * 100` → total Premium $
- `netFlow.series[*].cumNcv`, `cumNpv` → vol totals
- `ContractTapeBar.highPrice` / `lowPrice` already present for tooltip

## Open questions / defaults picked

- **Tooltip placement** for CONTRACT chart: float at cursor, clamped within
  SVG bounds. (Could attach to parent panel container — chose cursor for
  precision.)
- **Sync direction**: bidirectional — hover either chart, the other tracks.
- **Marker title format**: `"⚡ fire 11:32:17 CT"` — short enough not to crowd
  the chart.
- **Visible range default**: full session 08:30–15:00 CT. Re-pinned on every
  data update. User can still zoom/scroll, and we only re-pin when the visible
  range exactly equals the prior auto-fit (to avoid stomping manual zoom).
  _Decision_: simplest path — re-pin on every data update. If users complain
  about losing zoom on poll, switch to detection logic in a follow-up.

## Thresholds

- Tooltip is shown when the cursor is within ±half-a-bar-width of a bar's center.
- "Biggest print" callout fires only when the top bar is ≥ 2× the median bar
  (otherwise it's just normal flow, no point annotating).
- Cross-panel sync is debounced to animation frames (rAF) to avoid setState
  storms on rapid mousemove.

## Out of scope

- Click-to-zoom / lasso selection
- PNG export
- Strike-level NCP/NPP overlay on NET FLOW (different feature)
- Mobile touch interactions (Lottery Finder is desktop-only by design)
