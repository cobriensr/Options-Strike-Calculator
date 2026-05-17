---
status: TBD
date: 2026-05-03
---

# GEX Landscape — WebSocket-Driven Accuracy Upgrade

**Date:** 2026-05-03
**Owner:** Charles O'Brien
**Status:** drafted, awaiting build approval

## Goal

Now that the `gex_strike_expiry:<TICKER>` UW websocket plan is live (joined 2026-05-03; first intraday session expected 2026-05-04), upgrade the GEX Landscape component to (a) consume the richer payload fields the schema already captures, (b) eliminate the 30-min client-side warmup before Δ% columns populate, and (c) extend coverage from SPY/QQQ to SPX/NDX with per-ticker classification bands.

## Why

The component currently reads only OI sums (`call_gamma_oi`, `put_gamma_oi`, `call_charm_oi`, `put_charm_oi`) and reconstructs Δ% in the browser from a polling buffer. This means:

1. **Bid/ask Greek splits in the schema are unused.** The websocket payload includes `call_gamma_ask_vol` / `_bid_vol` (and same for charm + vanna) — these reveal whether walls are being _added to_ or _unwound by_ customer flow. Without them, classification can't distinguish a "Sticky Pin" being reinforced from one being silently torn apart.
2. **Δ% columns are empty for ~30 min after every page load.** Δ% is rebuilt in-browser from a snapshot ring buffer ([deltas.ts:13-29](src/components/GexLandscape/deltas.ts#L13)). The DB has every minute of history; the client doesn't read it. Reload at 1pm = lose all morning context.
3. **SPY/QQQ are hardcoded** in [useGexStrikeExpiry.ts:75](src/hooks/useGexStrikeExpiry.ts#L75) and [db-gex-strike-expiry.ts:17](api/_lib/db-gex-strike-expiry.ts#L17). UW serves SPX and NDX on the same channel (probe confirmed 2026-05-03).
4. **`SPOT_BAND = 12pt`** in [constants.ts](src/components/GexLandscape/constants.ts) is tuned for SPY/QQQ scale. Useless at SPX (5pt grid) or NDX (25pt grid) without per-ticker values.

## Pre-flight (Tuesday 2026-05-04)

Tuesday morning, after ~9:45 ET:

```bash
node docs/tmp/gex-ticker-probe/density_probe.mjs
```

Confirm `ws_gex_strike_expiry` is gaining minute-level rows for SPY and QQQ during RTH. If density looks healthy (per-strike rows at ≥80% of trading minutes for ATM strikes), Phases 4 and 5 unblock. If still sparse, diagnose uw-stream on Railway before proceeding to those phases.

## Phasing

Five phases. Phases 1–3 are unblocked and can ship before Tuesday's session validates the producer. Phases 4 and 5 depend on Tuesday's data being dense.

### Phase 0 — Cleanup (Step 0 Rule)

The ticker probe added `ws` as a devDependency. **Decision (2026-05-03): leave it in devDeps** — useful for future Node-side WS probing, light cost (~50KB), zero runtime impact. Probe scripts in `docs/tmp/gex-ticker-probe/` already use it.

### Phase 1 — Bid/ask classification refinement (~3 files)

**Files:**

- `src/components/GexLandscape/classify.ts` — add `computeGammaPressure(row)` returning a signed scalar; extend `classify()` to return `{ classification, pressure: 'reinforcing' | 'unwinding' | 'neutral' }`.
- `src/components/GexLandscape/StrikeTable.tsx` — render a small badge modifier ("⚠ unwinding" or color tint) next to the existing classification badge when pressure conflicts with the quadrant.
- `src/__tests__/components/GexLandscape-classify.test.ts` — new test file. Cases for each (quadrant × pressure) combination.

**Methodology:**

```text
gamma_pressure = (call_gamma_ask_vol - call_gamma_bid_vol)
               + (put_gamma_bid_vol  - put_gamma_ask_vol)
```

- `> 0`: customers net **buying** gamma → dealers shorter → walls **unwinding**
- `< 0`: customers net **selling** gamma → dealers longer → walls **reinforcing**

**Neutral-band threshold:** ratio-based, 5% of `|call_gamma_oi + put_gamma_oi|` at the same strike. Reasoning: scales naturally with strike importance — small absolute pressure at a tiny strike doesn't trigger; meaningful pressure at a major wall does. Constant lives in `constants.ts` as `PRESSURE_NEUTRAL_BAND_RATIO = 0.05`. Tune after Week 1 of real session data.

**Risk:** [classify.ts](src/components/GexLandscape/classify.ts) is also imported by [BiasPanel.tsx](src/components/GexLandscape/BiasPanel.tsx). Pressure must be a separate field on the return value, not a flip of the existing `classification` enum, so BiasPanel's quadrant logic is unaffected.

### Phase 2 — Per-ticker bands (~3 files)

**Files:**

- `src/components/GexLandscape/constants.ts` — replace scalar `SPOT_BAND` with `BAND_BY_TICKER: Record<Ticker, number>`. Values: SPY 5, QQQ 5, SPX 25, NDX 125 (each = ±5 strikes given the ticker's strike grid).
- `src/components/GexLandscape/classify.ts` — add `ticker: Ticker` parameter to `getDirection(strike, spot, ticker)` and `classify(...)`. Lookup band via `BAND_BY_TICKER[ticker]`.
- `src/components/GexLandscape/StrikeTable.tsx` and `src/components/GexLandscape/index.tsx` — thread `ticker` through props to the call sites.

**Verification:** Existing [useDealerRegime.test.ts](src/__tests__/hooks/useDealerRegime.test.ts) and any test that passes through classify must continue passing with the SPY ticker explicitly threaded. New unit test cases for SPX/NDX bands.

### Phase 3 — Multi-ticker GexLandscape on the WS data path

**Reframed (2026-05-03):** Original spec assumed GexLandscape was already SPY/QQQ-aware via `useGexStrikeExpiry`. It isn't — GexLandscape today consumes `useGexPerStrike` → `/api/gex-per-strike` → `gex_strike_0dte` (SPX-only, REST-cron-fed, no ticker param). To make ticker selection work the right way, switch GexLandscape's data source to `useGexStrikeExpiry` (the WS-fed multi-ticker path). This aligns with the broader architectural migration off REST crons (see Phase 4c-iii / Phase 7-C dark-pool retirements) and is a prerequisite for Phase 4 server-side Δ% to work for all tickers.

**Decision (Path A1):** Switch GexLandscape entirely to `useGexStrikeExpiry`. Preserve full scrub semantics by extending the API to return `timestamps[]` for the day. No ticker stays on the legacy REST path.

Split into four independently-shippable sub-phases:

#### Phase 3a — Widen ticker types (~2 files)

- `api/_lib/db-gex-strike-expiry.ts:17` — widen `GEX_STRIKE_EXPIRY_TICKERS` const to `['SPY', 'QQQ', 'SPX', 'NDX']`. Type alias derives from the const.
- `src/hooks/useGexStrikeExpiry.ts` — widen the `GexStrikeExpiryTicker` type alias (line 25) and `emptyData()` return shape (line 86) to all 4 keys. **CRITICAL: keep the runtime `TICKERS` iteration array (line 75) at `['SPY', 'QQQ']`** for now — widening it triggers `Promise.allSettled` to fire SPX/NDX fetches that 400 against the still-narrow Zod guard at `api/_lib/validation.ts:91`, surfacing as `'Partial fetch failure'` errors in the UI. The runtime array re-widens in Phase 3d.

Type-level only. No runtime data flow yet (uw-stream doesn't subscribe to SPX/NDX channels until Phase 3d).

#### Phase 3b — Adapter hook + scrub timestamps endpoint (~4 files)

- `api/gex-strike-expiry.ts` — extend response with `timestamps: string[]` (all `ts_minute` values for the requested ticker × expiry, ascending). Mirrors `/api/gex-per-strike`'s response shape so the frontend's existing scrub controls work unchanged.
- `api/_lib/db-gex-strike-expiry.ts` — add a `getTimestampsForDay(ticker, expiry)` helper.
- `src/hooks/useGexLandscapeData.ts` (new) — wraps `useGexStrikeExpiry(ticker, expiry, at)`, projects each `GexStrikeExpiryRow` into the `GexStrikeLevel` shape that GexLandscape expects, and surfaces `timestamps[]`. Handles the `volReinforcement` derivation server-side via the same simple sign-comparison logic that lives at [api/gex-per-strike.ts:78-84](api/gex-per-strike.ts#L78-L84) (`netGammaOi` vs `netGammaVol` same sign → reinforcing, opposite → opposing, zero → neutral).
- `src/__tests__/hooks/useGexLandscapeData.test.ts` (new) — projection unit tests covering volReinforcement derivation, field naming bridge (`call_gamma_ask_vol` → `callGammaAsk` etc.), and null/zero defensive paths.

#### Phase 3c — Wire GexLandscape + ticker selector (~4 files)

**Architecture note (corrected 2026-05-03):** GexLandscape and StrikeBattleMap are SIBLING components in `App.tsx:925`, not parent/child. The ticker selector belongs **inside GexLandscape itself** (above its regime banner), not in StrikeBattleMap. StrikeBattleMap remains untouched.

**Files:**

- `src/App.tsx` — replace the `useGexPerStrike()` call (line 266) feeding GexLandscape's props with a wrapping container that owns `selectedTicker` + scrub state and instantiates `useGexLandscapeData(selectedTicker, selectedDate, at)`. App.tsx is being concurrently edited — keep the diff focused and isolated to the GexLandscape mount.
- `src/components/GexLandscape/index.tsx` — accept `ticker: Ticker` (now required, no default); render the ticker selector at the very top of the section above the regime banner. Single-ticker view, no all-tickers stack.
- Audit: any other consumer of `useGexPerStrike`? `grep -rn "useGexPerStrike" src/` to confirm. If GexLandscape is the sole consumer after this change, mark `useGexPerStrike` for removal in a follow-up commit. If `analyze` or other components still use it, leave intact.

**Scrub state design:**

`useGexLandscapeData` returns only `{ strikes, timestamps, loading, error, refresh }`. The legacy `useGexPerStrike` returned 17 fields including a full scrub controller. Phase 3c needs to rebuild scrub state — options:

- **Option 1 (preferred):** introduce a small `useGexLandscapeScrub({ timestamps, marketOpen })` controller hook that owns `selectedDate`, `selectedTimestamp`, and derived `{ isLive, isScrubbed, canScrubPrev, canScrubNext, onScrubPrev, onScrubNext, onScrubTo, onScrubLive }`. Compose with `useGexLandscapeData` in the App.tsx wrapper.
- **Option 2:** absorb scrub state into `useGexLandscapeData` itself, fattening its return surface. Simpler call site, less reusable.

Option 1 keeps the data hook narrow and the scrub controller independently testable. Pick this unless there's a strong reason not to.

**Verification:** All 4 ticker radio options render. Switching between them refreshes the table without page reload. SPY and QQQ render data; SPX/NDX stay empty until Phase 3d. Scrub controls work for SPY/QQQ.

#### Phase 3d — Railway WS subscription widening + runtime TICKERS rewiden

- Railway: extend `WS_CHANNELS` env var on uw-stream service to include `gex_strike_expiry:SPX,gex_strike_expiry:NDX`. Restart service.
- Update Zod validation at `api/_lib/validation.ts:91` from `z.enum(['SPY', 'QQQ'])` to all 4 tickers.
- Re-widen the runtime `TICKERS` array at `src/hooks/useGexStrikeExpiry.ts:75` from `['SPY', 'QQQ']` to all 4 (so polling actually fetches SPX/NDX once they're valid).
- Verify Tuesday post-market that `ws_gex_strike_expiry` has SPX + NDX rows.

**Verification (Phase 3 overall):** Tuesday after-market — UI selector switches between all 4 tickers; each renders with correct band (SPY 5pt, QQQ 5pt, SPX 25pt, NDX 125pt); volReinforcement column populates correctly; scrub controls work for at least SPY/QQQ (SPX/NDX once 3d is done and a session has accumulated).

### Phase 4 — Server-side Δ gamma % (~4 files, depends on Tuesday density)

**Scope clarification (2026-05-03):** Δ CHARM column dropped from the plan. Charm grows monotonically in magnitude as expiry approaches (mostly time-decay), so a Δ%-on-charm column would be drowned out by clock-driven motion rather than reflecting flow signal. Raw CHARM column stays as-is. If a charm-based new signal is wanted later, the better candidate is **charm sign-flip proximity** (where on the strike grid charm changes sign) — separate spec.

**Files:**

- `api/_lib/db-gex-strike-expiry.ts` — add `getStrikesWithDeltas(ticker, expiry, atTs)` query using `LAG()` window functions over `ts_minute` for 1m, 5m, 10m, 15m, 30m windows on `(call_gamma_oi + put_gamma_oi)`.
- `api/gex-strike-expiry.ts` — switch to the new query. Response now includes `gamma_delta_1m`, `gamma_delta_5m`, `gamma_delta_10m`, `gamma_delta_15m`, `gamma_delta_30m`.
- `src/hooks/useGexStrikeExpiry.ts` — extend `GexStrikeExpiryRow` type with the new fields. No fetch logic changes.
- `src/components/GexLandscape/index.tsx` — delete the snapshot ring buffer (lines ~344-390). The Δ% columns now arrive populated from the server.

**Query skeleton** (validated against `ws_gex_strike_expiry` schema):

```sql
WITH series AS (
  SELECT ticker, expiry, strike, ts_minute,
         (COALESCE(call_gamma_oi,0) + COALESCE(put_gamma_oi,0)) AS net_gamma
  FROM ws_gex_strike_expiry
  WHERE ticker = $1 AND expiry = $2
    AND ts_minute >= $3::timestamptz - INTERVAL '35 minutes'
    AND ts_minute <= $3::timestamptz
)
SELECT strike, ts_minute, net_gamma,
       net_gamma / NULLIF(ABS(LAG(net_gamma, 1)  OVER w), 0) - 1 AS gamma_delta_1m,
       net_gamma / NULLIF(ABS(LAG(net_gamma, 5)  OVER w), 0) - 1 AS gamma_delta_5m,
       net_gamma / NULLIF(ABS(LAG(net_gamma, 10) OVER w), 0) - 1 AS gamma_delta_10m,
       net_gamma / NULLIF(ABS(LAG(net_gamma, 15) OVER w), 0) - 1 AS gamma_delta_15m,
       net_gamma / NULLIF(ABS(LAG(net_gamma, 30) OVER w), 0) - 1 AS gamma_delta_30m
FROM series
WINDOW w AS (PARTITION BY ticker, expiry, strike ORDER BY ts_minute)
ORDER BY ts_minute DESC, strike;
```

**Risk:** if Tuesday's density has gaps (< 80% per-minute), `LAG(_, N)` returns the wrong row. Mitigation: use a tolerant range form (`LAG(...) OVER (PARTITION BY ... ORDER BY ts_minute RANGE BETWEEN INTERVAL 'N minutes 30s' PRECEDING AND INTERVAL 'N minutes' PRECEDING)`). Decide after seeing Tuesday's data.

### Phase 5 — Verification

- `npm run review` passes (tsc + eslint + prettier + vitest --coverage).
- Manual dev test in Chrome: switch through all 4 tickers, confirm Δ% columns populate immediately on load, classification + pressure render, BiasPanel verdict unchanged in shape.
- Wednesday morning re-check: a full session of intraday data flowing; Δ% columns reflect minute-level changes; pressure flag transitions visibly during big strike volume bursts.

## Files to create/modify (rolled up)

### Modified

- `package.json`, `package-lock.json` (Phase 0 — revert)
- `src/components/GexLandscape/constants.ts` (Phases 1, 2)
- `src/components/GexLandscape/classify.ts` (Phases 1, 2)
- `src/components/GexLandscape/StrikeTable.tsx` (Phases 1, 2)
- `src/components/GexLandscape/index.tsx` (Phase 4)
- `src/components/StrikeBattleMap/index.tsx` (Phase 3)
- `src/hooks/useGexStrikeExpiry.ts` (Phases 3, 4)
- `api/_lib/db-gex-strike-expiry.ts` (Phases 3, 4)
- `api/gex-strike-expiry.ts` (Phase 4)

### Created

- `src/__tests__/components/GexLandscape-classify.test.ts` (Phase 1)
- Possibly `src/__tests__/components/GexLandscape-bands.test.ts` (Phase 2 — if existing tests don't cover)

### External

- Railway: `WS_CHANNELS` env var on `uw-stream` service (Phase 3)

## Data dependencies

- `ws_gex_strike_expiry` table (already exists, schema captures all needed columns including bid/ask vol splits)
- `gex_strike_expiry:SPX`, `:NDX` channel subscriptions on uw-stream (new)
- No new migrations needed

## Open questions (resolved 2026-05-03 unless noted)

1. ~~Pressure neutral-band threshold~~ → ratio-based, 5% of strike's |dollar gamma OI|. Tune after Week 1.
2. ~~All-tickers vs selected-ticker view~~ → single ticker, selector above the regime banner.
3. ~~Δ CHARM column~~ → dropped (mostly time-decay noise, not flow signal).
4. **Tolerant vs strict LAG** — still open; depends on Tuesday's density measurements. Decide post-validation.

## Thresholds / constants

| Constant                      | Value                                     | Where        |
| ----------------------------- | ----------------------------------------- | ------------ |
| `BAND_BY_TICKER.SPY`          | 5                                         | constants.ts |
| `BAND_BY_TICKER.QQQ`          | 5                                         | constants.ts |
| `BAND_BY_TICKER.SPX`          | 25                                        | constants.ts |
| `BAND_BY_TICKER.NDX`          | 125                                       | constants.ts |
| `PRESSURE_NEUTRAL_BAND_RATIO` | 0.05 (5% of strike's \|dollar gamma OI\|) | constants.ts |

## Done when

- All 5 phases shipped, `npm run review` clean.
- A trader loading the page mid-session sees populated Δ% columns immediately, with classification + pressure modifier visible at the right strikes.
- SPX, NDX selectable; bands feel right at each ticker's scale.
- One full session of `ws_gex_strike_expiry` data confirms producer is healthy.
