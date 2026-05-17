---
status: Likely Shipped
date: 2026-05-11
---

# Periscope Daily Debrief — Playbook × Price × Flow Replay

**Date:** 2026-05-11
**Status:** draft
**Successor candidate:** Phase 2 (Claude-judged calibration) — out of scope here

## Goal

A new end-of-day tab in the Periscope section that for any past trading date
renders, per 10-min slot, three lanes side-by-side:

1. **Playbook lane** — the auto-generated `panel_payload` (bias, levels,
   gamma floor/ceiling, charm zero, recommended/avoid setups, expected
   dealer behavior).
2. **Price lane** — actual SPX 1-min path during and through the next
   30-60 min, drawn against the playbook's primary level + cone.
3. **Flow lane** — the full-tape activity window from `ws_option_trades`
   (whales ≥$500K, sweeps, B/S volume on SPX + SPY + QQQ) and
   `ws_flow_alerts` entries timestamped within the same window.

The point is **human eyeballing** to build calibration intuition before
spending money on Claude-as-judge. No LLM in this loop — pure data
replay.

## Why now

- Auto-playbook (the `2026-05-10` spec) is live forward-firing every
  10 min RTH. ~40 labeled slot reads land per day starting Mon.
- After ~1 week you'll have ~200 slots to eyeball, enough to know which
  judgment criteria matter (bias direction? primary level hit? confidence
  calibration?) before designing the Claude-judged version.
- All three streams are already in Neon — no new ingestion, just a
  read-side view.

## Why not Phase 2 (Claude-judged) first

Defining "playbook was right" is the actual design question. Building
the LLM judge before knowing what to ask it produces noise. One week of
manual eyeballing reveals the real grading rubric; spec for #2 follows.

## Architecture

```text
┌───────────────────────────────────────────────────────────────────────┐
│ GET /api/periscope-debrief?date=YYYY-MM-DD                            │
│ guardOwnerOrGuestEndpoint                                              │
│                                                                        │
│ Returns: {                                                             │
│   tradingDate,                                                         │
│   slots: [                                                             │
│     {                                                                  │
│       slotCapturedAt, slotKey, mode (pre_trade|intraday|debrief),     │
│       playbook: panel_payload,                                         │
│       price: { candles: SPX 1m over [slot, slot+60m] },              │
│       flow: {                                                          │
│         whales: ws_option_trades rows >= $500K premium,               │
│         sweeps: ws_option_trades rows with sweep flag,                │
│         volume: { spx_call, spx_put, spy_call, spy_put, qqq_*,        │
│                   ask_vol, bid_vol } over the window,                  │
│         flowAlerts: ws_flow_alerts rows within [slot, slot+60m]       │
│       }                                                                │
│     }, ...                                                             │
│   ]                                                                    │
│ }                                                                      │
└───────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                  PeriscopeDebriefTab.tsx (new tab in PeriscopePanel)
                  ├─ DatePicker (defaults to yesterday CT)
                  ├─ SlotTimeline (vertical list, one row per slot)
                  └─ SlotDebriefRow
                     ├─ PlaybookLane   (compact panel_payload render)
                     ├─ PriceLane      (recharts area + level overlay)
                     └─ FlowLane       (whale list + volume bars + alerts)
```

## Phases

### Phase 1 — Backend endpoint + data assembly

**Files to create:**

- `api/periscope-debrief.ts` — GET handler, validates `?date=YYYY-MM-DD`,
  pulls slots from `periscope_analyses WHERE trading_date = $1 AND
auto_generated = TRUE AND status = 'complete' ORDER BY slot_captured_at`.
  For each slot: parallel-fetch the three lanes' data via Promise.all,
  return assembled JSON.
- `api/_lib/db-debrief.ts` — three reader functions:
  - `fetchSpxCandlesForWindow(start, end)` → 1m bars from `spx_candles_1m`.
  - `fetchFlowWindow(start, end, tickers)` → whales/sweeps/volume rollup
    from `ws_option_trades`, filtered per the standing UW filters
    (extended_hours_trade=false, contingent_trade exclusion outside
    08:30–15:00 CT, drop average_price_trade + derivative_price_trade).
  - `fetchFlowAlertsWindow(start, end)` → matching `ws_flow_alerts` rows.

**Constraints:**

- Window per slot = `[slot_captured_at, slot_captured_at + 60 min]`.
  60 min covers the next ~6 ticks plus follow-through.
- Last slot of day clamps window to ≤ 15:00 CT.
- Whale threshold: premium ≥ $500K (size × price × 100). Configurable
  via querystring `?whaleMin=…` for tuning during eyeballing phase.
- Volume rollup binned at 5-min granularity to keep payload small
  (~12 bins × 6 series ≈ 72 numbers per slot).

**Tests:** `api/__tests__/periscope-debrief.test.ts` — mock getDb,
verify (1) day with no playbooks returns `{slots: []}`, (2) day with
2 slots returns 2 entries with all three lanes populated, (3) UW
filters applied (contingent_trade, average_price_trade dropped),
(4) auth guard runs.

### Phase 2 — Frontend tab + components

**Files to create:**

- `src/components/Periscope/DebriefTab.tsx` — tab content, owns date
  picker state, fetches `/api/periscope-debrief?date=…`, renders
  `<SlotDebriefRow>` for each slot.
- `src/components/Periscope/SlotDebriefRow.tsx` — 3-column flex row:
  PlaybookLane | PriceLane | FlowLane. Mobile collapses to stacked.
- `src/components/Periscope/PlaybookLane.tsx` — compact render of
  `panel_payload` reusing `<SpotLine>`, `<GammaRow>`, `<TriggerList>`
  primitives already in `PlaybookSection.tsx`. Read-only, smaller
  font.
- `src/components/Periscope/PriceLane.tsx` — Recharts `ComposedChart`
  with SPX area + horizontal lines at `panel_payload.gammaFloor`,
  `gammaCeiling`, `charmZero`, and any `longTrigger.level` /
  `shortTrigger.level`. Cone (if present in payload) drawn as
  shaded band.
- `src/components/Periscope/FlowLane.tsx` — small table: top 3
  whales (premium, ticker, C/P, strike, side), 5-min B/S volume
  bars (call vs put, ask vs bid), flow-alert chips colored by
  severity.

**Files to modify:**

- `src/components/Periscope/PeriscopePanel.tsx` — add `Debrief` tab to
  the existing tab bar.

**Tests:** `src/__tests__/DebriefTab.test.tsx` — date picker change
refetches; empty-day shows "No auto-playbooks for this date — check
that auto-playbook was running"; populated day renders 3 lanes per
slot with semantic selectors.

### Phase 3 — Verification

- `npm run review` clean.
- Manual: pull last Friday (2026-05-08) via the dev tab and visually
  confirm Periscope panel for one slot matches its `panel_payload`
  rendered in the playbook lane.
- Manual: verify the price lane axis covers `[slot, slot+60m]` and
  the gamma floor/ceiling overlays land at the right levels.
- Manual: confirm whale entries on the flow lane are dollar-premium
  sorted and respect the standing UW filters.

## Data dependencies

- `periscope_analyses` (cols: `trading_date`, `slot_captured_at`,
  `panel_payload`, `auto_generated`, `status`, `mode`) — already
  populated by the auto-playbook system.
- `spx_candles_1m` — already populated by the SPX candle cron.
- `ws_option_trades` — populated live by `uw-stream` Railway service.
- `ws_flow_alerts` — populated live by `uw-stream`.

No new tables, no new ingestion. Read-only feature.

## Out of scope

- Claude-as-judge grading (separate spec; designed AFTER ≥1 week of
  manual eyeballing reveals the rubric).
- Scoring / win-rate aggregation (also Phase 2 — needs the rubric).
- Mobile-optimized layout beyond stacked collapse.
- Comparing across days (per-day view only; cross-day comparison is
  a Phase 2+ concern).

## Open questions

- **Window length 60 min — too short for `pre_trade` slot?** That slot
  fires at 08:30 CT and the playbook usually projects through morning.
  Maybe `pre_trade` gets a 180-min window, `intraday` 60 min, `debrief`
  N/A. **Default:** uniform 60 min, revisit after eyeballing.
- **SPY/QQQ inclusion in flow lane — distracting or signal?** Memory
  `feedback_hunt_flow_in_spy_qqq` says ETFs are where 0DTE setup hides.
  **Default:** include SPY + QQQ alongside SPX, group by ticker.
- **What counts as "primary level" for the price overlay?** Today
  `panel_payload` has multiple levels. **Default:** draw all of
  `gammaFloor`, `gammaCeiling`, `charmZero`, plus any
  `longTrigger.level` / `shortTrigger.level`. User filters visually.

## Thresholds / constants

- Whale premium floor: $500,000 (default; querystring override).
- Window: 60 min from `slot_captured_at`, clamped to ≤ 15:00 CT.
- Volume bin width: 5 min.
- Top whales rendered: 3 per slot.

## Cost

Zero LLM spend. One additional Vercel Function read per day-view
load, hitting Neon and rendering in the browser.
