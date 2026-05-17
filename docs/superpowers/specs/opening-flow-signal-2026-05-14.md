---
status: Likely Shipped
date: 2026-05-14
---

# Opening Flow Signal Widget (V4 Rule + Highest-Volume Strike)

**Date:** 2026-05-14
**Author:** charlesobrien (drafted with Claude)
**Source rule:** `docs/tmp/spy-opening-flow/FINDINGS_V5_WALKFORWARD.md` (V4 rule, OOS validated) + `docs/tmp/spy-opening-flow/strike_selection_test.py` (highest-volume strike winner)

## Goal

Surface a real-time 0DTE opening-flow signal for SPY and QQQ during the 09:30–09:45 ET window, with the exact contract details ready to trade.

## Rule (as proven by 91-day backtest + OOS walk-forward)

For each of SPY and QQQ:

1. **First slice (09:30:00–09:34:59 ET):** identify all tickets with `(strike, option_type)` premium ≥ $1M.
2. **Top-3 same side:** the 3 largest tickets by premium must all be on the same side. Otherwise no signal.
3. **Slice-2 confirm (09:35:00–09:39:59 ET):** bias-side share of total ≥ $1M ticket premium ≥ 60%. Otherwise no signal.
4. **Pick contract:** the **highest-volume** bias-side ≥$1M ticket. (Test winner: +1.45 R_stop30 vs +1.24 for largest-premium.)
5. **Entry:** at 09:40:00 ET at the prevailing ask.
6. **Exit:** hard −30% stop OR exit at 10:40:00 ET, whichever first.

## Phases

### Phase 1 — Backend endpoint + rule library

**Files:**

- `api/_lib/opening-flow.ts` — V4 rule evaluation logic (pure functions, fully unit-testable).
- `api/_lib/validation/opening-flow.ts` — Zod schema for optional `date` query param (dev/testing only; prod uses today).
- `api/opening-flow-signal.ts` — `GET /api/opening-flow-signal` endpoint.
- `api/__tests__/opening-flow-signal.test.ts` — covers: window not open, slice-1 in progress, slice-2 in progress, signal fires, signal blocked by top-3 mixed, signal blocked by s2 < 60%.

**Endpoint behavior:**

```typescript
GET /api/opening-flow-signal[?date=YYYY-MM-DD]

Response:
{
  windowStatus: 'before_open' | 'slice1' | 'slice2' | 'evaluating' | 'closed',
  asOfUtc: string,
  ctNow: string,  // "08:42 CT"
  signalWindowOpensCt: string,
  tickers: {
    [ticker: 'SPY' | 'QQQ']: {
      slice1: {
        tickets: Array<{ strike: number, side: 'call'|'put', premium: number, volume: number, avgFill: number }>,
        biasSide: 'call' | 'put' | null,
        biasRatio: number,
        top3SameSide: boolean,
      } | null,
      slice2: {
        totalPremium: number,
        biasPremium: number,
        biasShare: number | null,
        confirms: boolean,
      } | null,
      signal: {
        fired: true,
        side: 'call' | 'put',
        contract: {
          strike: number,
          optionType: 'call' | 'put',
          premium: number,
          volume: number,
          sliceAvgFill: number,
        },
        exitAtCt: '09:40 CT',
        exitTargetCt: '10:40 CT',
        stopPct: 0.30,
      } | { fired: false, reason: 'top3_mixed' | 's2_below_60' | 'no_tickets' | 'window_not_complete' }
    }
  }
}
```

**Data source:** Query `ws_option_trades` directly (live stream via `uw-stream` Railway service). Filter: ticker IN ('SPY','QQQ'), expiry = today ET, executed_at within slice window.

**Auth:** `guardOwnerOrGuestEndpoint()` — read-only, same gating as `api/lottery-contract-tape.ts`.

**Bot protection:** Add to botid `protect` list in `src/main.tsx`.

### Phase 2 — Frontend hook + component

**Files:**

- `src/hooks/useOpeningFlowSignal.ts` — polls `/api/opening-flow-signal` every 30s when in 09:25–09:50 ET window; else returns last-known state with status flag.
- `src/components/opening-flow/OpeningFlowSignal.tsx` — main panel.
- `src/components/opening-flow/SignalCard.tsx` — per-ticker card (SPY card + QQQ card).
- `src/__tests__/OpeningFlowSignal.test.tsx` — render states.
- `src/App.tsx` — integrate the panel near the top.

**Visual layout (text mockup):**

```
┌─────────────────────────────────────────────────────────────────┐
│ Opening Flow Signal                          09:37 CT (slice 2) │
├─────────────────────────────────────────────────────────────────┤
│ SPY                                                              │
│ Bias: CALL 81%  · Top-3: 3/3 calls ✓ · Slice-2: 78% ✓             │
│                                                                  │
│ ▶ TRADE: BUY SPY 745C 0DTE                                       │
│   Entry: $1.36 (slice-1 avg)  Volume: 24,683 contracts          │
│   Stop: −30% ($0.95)   Exit: 10:40 CT (in 1h 03m)               │
│                                                                  │
│ ▼ Slice 1 tickets (7 qualifying):                                │
│   745C $3.35M  24,683v  · 744C $2.53M  13,554v  · 746C ...      │
├─────────────────────────────────────────────────────────────────┤
│ QQQ                                                              │
│ Bias: CALL 100% · Top-3: 3/3 calls ✓ · Slice-2: 100% ✓            │
│                                                                  │
│ ▶ TRADE: BUY QQQ 716C 0DTE                                       │
│   Entry: $2.47  Volume: 13,036 contracts                         │
│   Stop: −30% ($1.73)   Exit: 10:40 CT (in 1h 03m)               │
└─────────────────────────────────────────────────────────────────┘
```

**Window states:**

- Before 09:25 CT: "Next signal window opens 08:30 CT" (CT 8:30 = ET 9:30; outside polling)
- 09:25–09:30 CT: "Monitoring — first slice opens in N min"
- 09:30–09:35 CT: "Slice 1 in progress (Xm Ys left)"
- 09:35–09:40 CT: shows slice 1 result, awaiting slice 2
- 09:40–09:45 CT: shows full evaluation (signal or "no signal")
- After 09:45 CT: locks in final state until 16:00 CT, then collapses

**Polling cadence:** 30s during 09:25–09:50 CT. Outside that window, no polling.

### Phase 3 — Wiring + final polish

- Add path to botid `protect` list in `src/main.tsx`.
- Verify `npm run review` (tsc + eslint + prettier + vitest) is green.
- Commit + push.

## Test coverage

- Endpoint unit tests: 7+ scenarios (window states + signal outcomes).
- Hook test: polling on/off based on time-of-day.
- Component test: renders each window state correctly.

## Non-goals (for this iteration)

- **No persistent record of fired signals.** Live read-only. (Can add a DB log in a follow-up if you want historical performance tracking.)
- **No push notification / Sentry alert.** UI-only.
- **No live position-sizing math.** User decides their own size based on account.
- **No exit-time alarm.** UI shows countdown but no audible/visual alarm. (Easy add later.)

## Open questions resolved

- Data source: `ws_option_trades` (live stream).
- UI location: dedicated section in `App.tsx`.
- Polling: 30s auto during window.
- Display: strike + entry + top-3 + slice-2 + exit countdown.
- Strike selection: highest-volume bias-side ticket (proven by strike test).
