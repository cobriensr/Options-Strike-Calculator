---
status: Likely Shipped
date: 2026-05-16
---

# Lottery / SilentBoom — flow badges + cohort countdown — 2026-05-16

## Goal

Surface three pieces of live alert context on every Lottery + SilentBoom row
without expanding it:

1. **Flow Match / Flow Mismatch** — does the ticker's current cumulative
   NCP-vs-NPP delta agree with the alert's option type?
2. **Flow Inverted** — did the ticker's net flow agree at fire time but
   no longer? (This is the highest-edge exit signal per the
   `lottery-net-flow-eda` simulation.)
3. **Cohort countdown** — minutes remaining vs. `cohort.p75MinutesToPeak`,
   tick every 60 s.

All three are visible on the collapsed row so the user can scan a list
of fires and decide which ones to exit.

## Why ticker net flow, not market tide

Today the fire object carries `macro.mktTideNcp/Npp` (SPY-wide market
tide snapshot at trigger). That's the wrong signal for a per-ticker
match: a call alert on TSM can have positive ticker NCP-NPP even when
the SPY tide is bearish. Use the per-ticker series fed by `uw-stream`
into `ws_net_flow_per_ticker` (and the REST backfill in
`net_flow_per_ticker_history`).

## Phases

### Phase 1 — Server: batch "current snapshot" endpoint

**File:** `api/ticker-net-flow-current.ts` (new)

- `GET /api/ticker-net-flow-current?tickers=AAA,BBB,CCC&date=YYYY-MM-DD`
- Returns `{ ticker → { cumNcp, cumNpp, asOfTs } }` for the latest row
  per ticker for that date.
- Single CTE: UNION `ws_net_flow_per_ticker` + `net_flow_per_ticker_history`
  for the requested tickers + date, partition by ticker, take last
  cumulative row (`SUM(...) OVER (PARTITION BY ticker ORDER BY ts)`).
- Zod-validate `tickers` (1-100 comma-separated symbols), `date` (YYYY-MM-DD).
- 30 s in-memory cache keyed by `tickers|date` (mirrors `net-flow-history`).
- Add path to `protect` array in `src/main.tsx` if it's a public endpoint
  (yes — same auth posture as `net-flow-history`).

**Test:** `api/__tests__/ticker-net-flow-current.test.ts`

- mocks `getDb`, verifies query shape + zod rejection + 200 happy path.

### Phase 2 — Server: snapshot fire-time flow on each fire

**Files:** `api/lottery-finder.ts`, `api/silent-boom-feed.ts`,
respective types.ts, respective tests.

Subquery (or LATERAL) per fire row pulling the most-recent
`(cum_ncp, cum_npp)` from `net_flow_per_ticker_history` at or before
`trigger_time_ct`. Add columns:

- `fireTimeCumNcp: number | null`
- `fireTimeCumNpp: number | null`

These let the client decide "was the flow matching when this fired?"
without re-querying the history endpoint per row. Backfill-clean —
older rows just get `null` until the next fetch picks them up via the
LATERAL join.

### Phase 3 — Client: `useTickerNetFlowBatch` hook

**File:** `src/hooks/useTickerNetFlowBatch.ts` (new)

```ts
useTickerNetFlowBatch({
  tickers: string[];         // unique tickers from displayed fires/alerts
  date: string;              // matches section's date filter
  marketOpen: boolean;       // gate polling
}): {
  data: Map<string, { cumNcp: number; cumNpp: number; asOfTs: string }>;
  loading: boolean;
  error: Error | null;
}
```

- Polls `/api/ticker-net-flow-current` every 60 s while `marketOpen`.
- Skips polling when `tickers.length === 0`.
- Returns an empty Map until first fetch resolves (no stale flashing).

**Test:** `src/__tests__/useTickerNetFlowBatch.test.ts`

- vi.useFakeTimers, mock fetch, verify 60 s cadence + gate on
  `marketOpen=false`.

### Phase 4 — Client: Flow Match / Flow Mismatch badge

**Files:**

- `src/components/LotteryFinder/LotteryRow.tsx`
- `src/components/SilentBoom/SilentBoomRow.tsx`
- `src/components/LotteryFinder/LotteryFinderSection.tsx` (pass hook
  data + computed badge state down)
- mirror in SilentBoom section

Pure helper (testable in isolation):

```ts
// src/utils/flow-match.ts (new)
export type FlowMatchState =
  | 'match' // call & Δ>0, or put & Δ<0
  | 'mismatch' // call & Δ<0, or put & Δ>0
  | 'flat' // Δ === 0 or both sides null
  | 'unknown'; // no current snapshot for this ticker yet

export function computeFlowMatch(
  optionType: 'C' | 'P',
  cumNcp: number | null | undefined,
  cumNpp: number | null | undefined,
): FlowMatchState;
```

Badge UX: green `Flow Match`, red `Flow Mismatch`, no badge for
`flat`/`unknown`.

**Test:** `src/__tests__/utils/flow-match.test.ts` — table-driven cases
covering each branch.

### Phase 5 — Client: Flow Inverted badge

Build on Phase 4 + Phase 2 (fire-time snapshot).

Pure helper:

```ts
// src/utils/flow-inverted.ts (new)
export type FlowInvertedState =
  | 'inverted' // fire-time matched, current does NOT match
  | 'stable' // current state matches fire-time state
  | 'unknown'; // missing fire-time or current snapshot
```

Logic:

- `wasMatch = computeFlowMatch(type, fireTimeCumNcp, fireTimeCumNpp) === 'match'`
- `isMatch = computeFlowMatch(type, currentCumNcp, currentCumNpp) === 'match'`
- `inverted` ⟺ `wasMatch && !isMatch`

Badge UX: amber `Flow Inverted ⚠` with title explaining "this is the
exit signal that historically preserves the largest peak share — see
`lottery-net-flow-eda`".

**Test:** `src/__tests__/utils/flow-inverted.test.ts` — covers the four
match/mismatch×wasMatch/wasNotMatch cells + missing-data cases.

### Phase 6 — Client: cohort countdown timer

**File:** `src/components/LotteryFinder/CohortCountdown.tsx` (new),
mirror for SilentBoom.

```tsx
<CohortCountdown
  triggerTimeCt={fire.triggerTimeCt}
  p75MinutesToPeak={fire.tickerStats?.cohort.p75MinutesToPeak ?? null}
/>
```

- One `useEffect` with `setInterval(60_000)` at section level publishing
  `Date.now()` to context, so we don't spawn N timers.
- Component subscribes via `useContext` and recomputes
  `remaining = max(0, p75 − (now − triggerCt) in min)`.
- Renders:
  - `82m left` (>15 min)
  - amber `12m left` (≤15 min)
  - red `expired` (≤0)
  - `—` when `p75MinutesToPeak == null`.

**Test:** `src/__tests__/components/CohortCountdown.test.tsx` — fake
timers, verify color thresholds + null handling.

### Phase 6.5 — Combined "Exit Now" badge

The countdown + inversion badges each communicate a partial signal.
For a trader scanning the list, the more useful question is "do I
need to be OUT of this trade right now?" Surface a single red
**EXIT** chip when either condition is true:

- Countdown `remaining ≤ 0` (cohort P75 hold time has fully elapsed)
- Flow has inverted (`FlowInvertedState === 'inverted'`)

Pure helper (composes Phase 5 + Phase 6):

```ts
// src/utils/exit-now.ts (new)
export type ExitNowReason = 'expired' | 'inverted' | 'expired_and_inverted';

export function computeExitNow(args: {
  remainingMin: number | null; // null = no cohort stat available
  flowInverted: boolean;
}): { active: boolean; reason: ExitNowReason | null };
```

Badge UX: pulsing red `EXIT` chip with a one-line tooltip:

- `expired` → "Cohort P75 hold elapsed — historical median peak has
  passed."
- `inverted` → "Ticker net flow inverted — strongest documented exit
  signal."
- `expired_and_inverted` → "Hold expired + flow inverted — both exit
  rules fired."

Positioned at the **far right** of the collapsed row so it's the first
thing your eye lands on when scrolling.

**Test:** `src/__tests__/utils/exit-now.test.ts` — table-driven across
the three reason states + the inactive case.

### Phase 7 — Verification (always last)

- `npm run review` — tsc + eslint + prettier + vitest with coverage,
  zero failures.
- `npm run dev:full` — open Lottery + SilentBoom sections in the
  browser, confirm:
  - Flow Match badge appears within 60 s of section load
  - Flow Inverted appears when fire-time agreed but current doesn't
  - Countdown ticks down by 1 every minute (use 1-min watch test)
- Confirm no console errors during the 5-minute soak.

## Open questions

- Q1: For SilentBoom alerts, the same `cohort.p75MinutesToPeak` source
  exists per (tier, ticker). Confirm shape parity before Phase 6
  (read `SilentBoomAlert` types).
- Q2: Inversion badge title should link to the eda doc — link target?
  Default to a tooltip-only blurb if no public path.
- Q3: Should expired alerts auto-collapse / dim? Out of scope for v1;
  keep `expired` purely visual.

## Files touched / created

**New:**

- `api/ticker-net-flow-current.ts`
- `api/__tests__/ticker-net-flow-current.test.ts`
- `src/hooks/useTickerNetFlowBatch.ts`
- `src/__tests__/useTickerNetFlowBatch.test.ts`
- `src/utils/flow-match.ts`
- `src/__tests__/utils/flow-match.test.ts`
- `src/utils/flow-inverted.ts`
- `src/__tests__/utils/flow-inverted.test.ts`
- `src/components/LotteryFinder/CohortCountdown.tsx`
- `src/components/SilentBoom/CohortCountdown.tsx` (or shared)
- `src/__tests__/components/CohortCountdown.test.tsx`

**Modified:**

- `api/lottery-finder.ts` (+ types.ts, test)
- `api/silent-boom-feed.ts` (+ types.ts, test)
- `src/components/LotteryFinder/LotteryRow.tsx`
- `src/components/LotteryFinder/LotteryFinderSection.tsx`
- `src/components/SilentBoom/SilentBoomRow.tsx`
- `src/components/SilentBoom/SilentBoomSection.tsx`
- `src/main.tsx` (add new endpoint to botid protect list)

## Constants / thresholds

- Countdown amber threshold: 15 min remaining
- Polling cadence: 60 s
- Endpoint cache TTL: 30 s
- Batch endpoint ticker cap: 100 (matches `/api/lottery-finder` page size)
