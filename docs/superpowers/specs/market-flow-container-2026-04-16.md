# Market Flow Container — Backtesting Controls

## Goal

Wrap the 4 flow sections (Flow Aggression, Retail x Whale Confluence, Options Flow, Whale Positioning) into a single "Market Flow" container with shared date/time scrub controls, enabling historical backtesting across all flow data from one set of controls.

## Architecture

```
SectionBox "Market Flow"
  headerRight: ScrubControls (time prev/next, time dropdown, date picker, LIVE/SCRUBBED badge, refresh)
  ├── FlowDirectionalRollup       (sub-section, collapsible)
  ├── FlowConfluencePanel          (sub-section, collapsible)
  ├── OptionsFlowTable             (sub-section, collapsible, keeps existing badges)
  └── WhalePositioningTable        (sub-section, collapsible, keeps premium slider)
```

**State ownership**: MarketFlow container owns `selectedDate` + `scrubTimestamp`. Both hooks receive these as params. Children are pure views — no independent time state.

**Timestamp unification**: Both API endpoints return `timestamps[]` (distinct 1-min buckets with data). Container merges them into a unified scrub list so the dropdown shows all times where *either* data source has data.

## Data flow changes

### API: `GET /api/options-flow/top-strikes`

Add optional params:
- `?date=YYYY-MM-DD` — filter `flow_alerts` to that date (default: today ET)
- `?as_of=ISO_TIMESTAMP` — filter `WHERE created_at <= as_of` before ranking

Response adds:
- `timestamps: string[]` — distinct 1-min bucket labels with data for the date (ascending)

When `date` is today and no `as_of`: current rolling-window behavior (live mode).
When `date` is past or `as_of` is set: full-day query with cutoff, no rolling window.

### API: `GET /api/options-flow/whale-positioning`

Add optional params:
- `?date=YYYY-MM-DD` — query `whale_alerts` DB table instead of live UW proxy
- `?as_of=ISO_TIMESTAMP` — filter `WHERE created_at <= as_of`

Response adds:
- `timestamps: string[]` — same pattern as top-strikes

When `date` is today and no `as_of`: current live UW proxy behavior.
When `date` is past or `as_of` is set: query `whale_alerts` table.

### Hooks: `useOptionsFlow` + `useWhalePositioning`

Add params: `selectedDate?: string`, `asOf?: string | null`
- Pass to API as query params
- When `asOf` is set: one-shot fetch (no polling)
- When `selectedDate` is past: one-shot fetch (no polling)
- Otherwise: current polling behavior (live mode)

Return adds: `timestamps: string[]`

### Frontend: `MarketFlow` container component

New file: `src/components/MarketFlow/index.tsx`
- Owns `selectedDate`, `scrubTimestamp` state
- Calls both hooks with date/time params
- Merges `timestamps[]` from both hooks (sorted union, deduped)
- Renders `ScrubControls` in SectionBox headerRight
- Renders 4 children as collapsible sub-sections

Reuse: Extract `ScrubControls` from `GexLandscape/HeaderControls.tsx` into `src/components/ui/ScrubControls.tsx` (it's already generic — just needs the refresh aria-label parametrized).

## Tasks

- [ ] Extract `ScrubControls` from GexLandscape/HeaderControls → `src/components/ui/ScrubControls.tsx`; update GexLandscape to import from new location → Verify: GEX Landscape still renders controls
- [ ] Update `top-strikes.ts`: add `date` + `as_of` params to Zod schema; add date-filtered query branch; return `timestamps[]` → Verify: `npm run lint` passes
- [ ] Update `whale-positioning.ts`: add `date` + `as_of` params; add DB query branch for historical; return `timestamps[]` → Verify: `npm run lint` passes
- [ ] Update `useOptionsFlow`: accept `selectedDate` + `asOf` params; pass to API; disable polling when scrubbing/backtest; return `timestamps[]` → Verify: lint passes
- [ ] Update `useWhalePositioning`: same pattern → Verify: lint passes
- [ ] Create `src/components/MarketFlow/index.tsx`: container with ScrubControls, state ownership, timestamp merge, 4 sub-sections → Verify: lint passes
- [ ] Update `App.tsx`: replace 4 individual SectionBox renders with single `<MarketFlow>` → Verify: `npm run review` passes
- [ ] Add tests for API date/as_of params + hook scrub behavior → Verify: `npm run test:run`

## Open questions

- **1-min bucket granularity**: Flow alerts arrive in bursts, not on a clock. 1-minute buckets give full resolution for reviewing intraday flow evolution.
- **Confluence time semantics**: When scrubbed to 11:30, Confluence shows intersection of "options flow as of 11:30" + "whale alerts as of 11:30". This is correct — both sides see the same historical moment.

## Done when

- [ ] Market Flow container renders all 4 sub-sections with shared scrub controls
- [ ] Picking a past date loads historical data from DB for both flow and whale
- [ ] Time scrubber steps through available snapshots
- [ ] Whale premium slider still works independently
- [ ] `npm run review` passes (tsc + eslint + prettier + vitest)
