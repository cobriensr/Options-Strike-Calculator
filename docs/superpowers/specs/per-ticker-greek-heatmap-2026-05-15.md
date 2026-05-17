---
status: TBD
date: 2026-05-15
---

# Per-Ticker 0DTE Greek Heatmap + Net Flow

**Date:** 2026-05-15
**Status:** Spec — awaiting approval
**Owner:** main session

## Goal

Build a standalone UI section, placed between Lottery Finder and SilentBoom, that lets the trader select any ticker in the alerts universe (~70 tickers from `_LOTTERY_TICKERS`) and see, for the **0DTE expiry**:

- **Current underlying price** displayed as a chip at the top (e.g. "TSLA $437.85"). **Source: embedded `price` field from `ws_gex_strike_expiry` payloads, already in DB.** No separate `price:<TICKER>` WS subscription — see "Price source decision" below.
- **Top 5 strikes** by `|net GEX|` (sum of call+put gamma OI, abs value)
- **ATM strike highlight:** within the returned 5 strikes, highlight whichever is closest to spot (left-border accent + slightly bolder text). If the literal ATM strike isn't in the top-5 (concentrated GEX away from spot), the highlight falls on the nearest-to-spot of those 5 — see "ATM behavior" below.
- **Per-strike Gamma / Charm / Vanna** in a 3-column heatmap (green = +, red = −)
- **Net GEX regime** label (Long Γ vs Short Γ) and aggregate magnitude
- **Net flow** row (net call premium, net put premium, net call vol, net put vol — session-cumulative)
- **Tooltips** on each cell explaining the trading implication (e.g. "+Γ here = dealer wall; price tends to pin", "+Charm = +δ decay = dealer must sell into rallies as expiry approaches")

Refresh cadence: poll every 30s; WS upstream updates ws_gex_strike_expiry per minute.

**Primary use case:** when an alert fires (lottery or silent boom), open the heatmap on that ticker to identify the nearest dealer GEX wall and net flow bias → use as an exit-zone hint.

Secondary use case: backfill 90 days of per-strike Greeks + net flow for the entire alerts universe so we can run ML on alert-outcome vs Greek-landscape features.

## What's already in place (good news)

Most infrastructure already exists from prior websocket build-outs. The remaining work is mostly subscription expansion + UI:

| Piece                                                                 | Status    | Location                                                       |
| --------------------------------------------------------------------- | --------- | -------------------------------------------------------------- |
| `ws_gex_strike_expiry` table (full Greeks, OI + vol + ask/bid splits) | ✅ Exists | migration #111, `api/_lib/db-migrations.ts`                    |
| `ws_net_flow_per_ticker` table (per-tick deltas, not cumulative)      | ✅ Exists | uw-stream `net_flow.py:40`                                     |
| `gex_strike_expiry.py` WS handler (UPSERT by minute)                  | ✅ Exists | `uw-stream/src/handlers/gex_strike_expiry.py`                  |
| `net_flow.py` WS handler                                              | ✅ Exists | `uw-stream/src/handlers/net_flow.py`                           |
| `_LOTTERY_TICKERS` frozenset (70 tickers, V3 + extended)              | ✅ Exists | `uw-stream/src/config.py:33-55`                                |
| `net_flow_lottery` shorthand (50-ticker fan-out)                      | ✅ Exists | `uw-stream/src/config.py:64`                                   |
| `option_trades_lottery` shorthand (precedent)                         | ✅ Exists | `uw-stream/src/config.py:63`                                   |
| REST backfill: `/spot-exposures/expiry-strike` integration            | ✅ Exists | `api/cron/fetch-strike-exposure.ts` (but only SPX/NDX/SPY/QQQ) |
| `scripts/backfill-strike-exposure.mjs N`                              | ✅ Exists | takes `days` arg; supports arbitrary N                         |

## Gaps (real work)

1. **No `gex_strike_expiry_lottery` shorthand.** `option_trades_lottery` and `net_flow_lottery` exist; we need a parallel shorthand to fan-out `gex_strike_expiry:<TICKER>` to all 70 lottery tickers. Single-file change.
2. **REST backfill ticker universe is too narrow.** `fetch-strike-exposure.ts` ZERO_GAMMA_TICKERS = [SPX, NDX, SPY, QQQ]. We need to backfill the full lottery universe (one-shot, 90 days) — but only for ML training, NOT as a recurring cron (websocket is the live source).
3. **Net flow REST backfill doesn't exist yet.** `/stock/{ticker}/net-prem-ticks` integration is in `fetch-flow.ts` for a different universe; we need a one-shot backfill script for the 70-ticker lottery universe.
4. **No API endpoint** combining per-strike Greeks + net flow for a single ticker on 0DTE.
5. **No UI component.**
6. **Need to confirm `WS_CHANNELS` env on Railway** includes `gex_strike_expiry_lottery` and `net_flow_lottery` after Phase 1 ships.

## Phases

Each phase is independently shippable + committable. Per-phase loop: implement → code-reviewer subagent → fix findings → commit + push → next phase.

### Phase 1 — Stream subscription expansion (small, server-side)

**Scope:** Add `gex_strike_expiry_lottery` shorthand to `uw-stream` so all 70 lottery tickers get per-strike Greek streaming.

**Files:**

- `uw-stream/src/config.py` — add `_GEX_STRIKE_EXPIRY_LOTTERY = "gex_strike_expiry_lottery"`, register in `shorthand_prefix` dict, document in docstring
- `uw-stream/src/channel_registry.py` — register the shorthand token as known (so `_validate_channels_known` accepts it)
- `uw-stream/tests/test_config_aliases.py` — add test asserting the shorthand expands to 70 `gex_strike_expiry:<TICKER>` channels

**Deploy:** Update `WS_CHANNELS` env var on Railway uw-stream service to include `gex_strike_expiry_lottery,net_flow_lottery,...` (operator-side; document in the commit message).

**Verify:** After Railway redeploys, check uw-stream `/metrics` for `gex_strike_expiry:<TICKER>` channel rows for ~10 random lottery tickers. Spot-check `ws_gex_strike_expiry` table for rows in those tickers within 5 minutes.

### Phase 2 — REST backfill for ML training (one-shot)

**Scope:** Pull 90 days of historical per-strike Greeks + net flow for the full 70-ticker lottery universe. One-shot — no recurring cron. Two separate scripts so they can run in parallel.

**Files:**

- `scripts/backfill-strike-exposure-lottery.mjs` — new script. Iterates `_LOTTERY_TICKERS` × N trading days × 0DTE expiry. Hits `/stock/{ticker}/spot-exposures/expiry-strike` and UPSERTs into `strike_exposures`. CLI shape: `node scripts/backfill-strike-exposure-lottery.mjs 90`. Concurrency-limited via `mapWithConcurrency()` from `api/_lib/uw-fetch.ts` (cap = 3 to respect UW concurrent-request limit).
- `scripts/backfill-net-flow-lottery.mjs` — new script. Iterates `_LOTTERY_TICKERS` × N trading days. Hits `/stock/{ticker}/net-prem-ticks` and writes deltas into `ws_net_flow_per_ticker`. Same concurrency pattern.
- `api/_lib/db-migrations.ts` — **maybe** ALTER `strike_exposures` to add `ticker` to the unique-key columns if not present (recon confirmed it already is). No-op if no migration needed.

**Open question — write target for net flow backfill:** Should historical net flow go into `ws_net_flow_per_ticker` (mixes WS deltas + REST data — same shape since UW REST also emits deltas per their notebook reference) or a separate `historical_net_flow_per_ticker` table? **Default pick:** Same table, with a `source` column ALTER (`'ws'` vs `'rest_backfill'`) if not already present. Need to verify.

**Verify:** After backfill completes (estimated 30-60 min for 70 tickers × 60 trading days × 1 expiry), run a sanity SQL: `SELECT ticker, COUNT(DISTINCT date) FROM strike_exposures WHERE ticker IN (...) GROUP BY ticker` — every ticker should have ~60 rows.

### Phase 3 — API endpoint

**Scope:** New endpoint returning per-strike Greeks + net flow for a single ticker on the 0DTE expiry. Read-only, public (matches lottery/silent-boom feed visibility).

**Files:**

- `api/greek-heatmap.ts` — new endpoint. Query param `ticker` (Zod-validated against `_LOTTERY_TICKERS`). Response shape:
  ```ts
  {
    ticker: 'TSLA',
    expiry: '2026-05-15',
    asOf: '2026-05-15T16:32:00Z',
    underlyingPrice: 437.85,  // latest price from ws_gex_strike_expiry
    atmStrike: 437.5,  // closest strike in topStrikes to underlyingPrice
    regime: 'Long Γ' | 'Short Γ',
    netGexK: 1591.2,  // in thousands, matches existing GEX section
    topStrikes: [
      { strike: 450, callGammaOi: ..., putGammaOi: ..., netGamma: ..., callCharmOi: ..., putCharmOi: ..., netCharm: ..., callVannaOi: ..., putVannaOi: ..., netVanna: ... },
      // ...top 5 by |netGamma|
    ],
    netFlow: {
      cumulativeCallPrem: 1716.00,
      cumulativeCallVol: 6,
      cumulativePutPrem: 1990.00,
      cumulativePutVol: 17,
      asOf: '2026-05-15T16:32:01Z',
    },
  }
  ```
- `api/_lib/validation.ts` — add `GreekHeatmapQuerySchema` (Zod)
- `api/_lib/db-greek-heatmap.ts` — new query helper. SQL: latest row per (ticker, expiry=today, strike) from `ws_gex_strike_expiry`, ORDER BY ABS(call_gamma_oi + put_gamma_oi) DESC LIMIT 5. Net flow: `SUM(net_call_prem) OVER (PARTITION BY ticker, date(ts) ORDER BY ts)` for cumulative on the latest tick today.
- `api/__tests__/greek-heatmap.test.ts` — endpoint test, mocked DB
- `src/main.tsx` — add `/api/greek-heatmap` to `initBotId()` `protect` array

**Verify:** `curl 'http://localhost:3000/api/greek-heatmap?ticker=TSLA'` returns valid JSON with 5 strikes + net flow during market hours.

### Phase 4 — UI component

**Scope:** New section `<GreekHeatmapSection>` between `<LotteryFinderSection>` and `<SilentBoomSection>` in `src/App.tsx`.

**Files:**

- `src/components/GreekHeatmap/GreekHeatmapSection.tsx` — top-level section, wraps in `<SectionBox label="0DTE Greek Heatmap" collapsible>`. Chip-button ticker selector (mirrors LotteryFinder pattern, lines 905-945). Default selection: SPY. Header row shows: ticker selector | price chip (e.g. "TSLA $437.85") | regime chip (Long Γ / Short Γ).
- `src/components/GreekHeatmap/GreekHeatmapTable.tsx` — 3-column table (Gamma / Charm / Vanna) × 5 rows (top strikes by |net GEX|). Color coding: emerald for +, rose for −, intensity by magnitude. **ATM-row highlight:** the row whose `strike === atmStrike` gets a left-border accent (e.g. `border-l-2 border-amber-400`) + slightly bolder font weight. Implementation: pass `atmStrike` from the API response down to row rendering.
- `src/components/GreekHeatmap/NetFlowRow.tsx` — net flow display rows. NCP, NPP, and Total (NCP + NPP). Total renders green-400 when positive, rose-400 when negative.
- `src/components/GreekHeatmap/PriceChip.tsx` — current underlying price chip ("TSLA $437.85"). Renders neutral; not used to convey direction.
- `src/components/GreekHeatmap/RegimeChip.tsx` — Long Γ / Short Γ chip with aggregate magnitude (mirrors existing GEX section styling).
- `src/components/GreekHeatmap/tooltipText.ts` — **USER WILL WRITE THIS**. Static strings for tooltip content per cell type. (See "User contribution" below.)
- `src/hooks/useGreekHeatmap.ts` — fetches `/api/greek-heatmap?ticker=X`, polls every 30s when section is expanded + marketOpen.
- `src/App.tsx` — insert `<GreekHeatmapSection marketOpen={marketOpen} />` between lines 1068-1070 (per recon).
- `src/__tests__/GreekHeatmapSection.test.tsx` — render test, ticker switching, polling gate on marketOpen.

**Verify:** `npm run dev`, expand the section, select TSLA → see price chip + 5 strikes + Greeks + net flow. ATM-closest row visibly highlighted. Hover any cell → tooltip explains effect. Change ticker → data refreshes. Close section → polling stops.

### Phase 5 — ML feature wiring (deferred)

**Scope:** Once 90 days of backfilled data exists, add features to `api/_lib/build-features-gex.ts` (or a new `build-features-alerts-greeks.ts`) that join alert fires from `ws_flow_alerts` with the nearest-in-time per-strike Greek snapshot. Goal: discover if proximity to a +Γ wall predicts alert exit-zone hit rate.

**This phase is deliberately out of scope for the initial build.** Spec note only — surface as a follow-up after Phases 1-4 ship and 90 days accumulate.

## Data dependencies

- **Live data:** UW websocket `gex_strike_expiry:<TICKER>` + `net_flow:<TICKER>` per ticker in `_LOTTERY_TICKERS`. Already paid for (Advanced plan).
- **Historical data:** UW REST `/spot-exposures/expiry-strike` + `/net-prem-ticks`. 90-day pull = ~70 × 60 trading days × 1 expiry × 2 endpoints = ~8,400 REST calls. Concurrent cap of 3 means ~50 min wall-clock at minimum.
- **No new env vars.** UW_API_KEY already in place on Railway + Vercel.

## Decisions (locked 2026-05-15)

1. **Default selected ticker:** SPY.
2. **Weekends / holidays (no 0DTE expiry):** Show empty state with text "0DTE expiry not available — next session: <date>".
3. **Net flow cumulative computation:** Server-side `SUM(...) OVER (PARTITION BY ticker, date ORDER BY ts)` so the API contract is "cumulative as of latest tick".
4. **Net flow display:** Three rows — NCP, NPP, Total (NCP + NPP). Total is green when positive, red when negative. No "BULLISH/BEARISH" interpretive chip.
5. **Top-5 strike selection metric:** Net — `|call_gamma_oi + put_gamma_oi|` per strike, sort desc.
6. **Charm/Vanna sign convention:** `call_charm_oi + put_charm_oi` (net per strike), color by sign.
7. **Phase order:** Ship Phases 1, 3, 4 first (live UI). Defer Phase 2 (90-day REST backfill) until UI is shipped. ML-readiness comes after the live read works.

## Price source decision (2026-05-15)

UW exposes a `price:<TICKER>` WS channel that emits `{close, time, vol}` per trade — sub-second cadence. Worth using? Not for this heatmap:

- The `gex_strike_expiry` WS payload **already includes** a `price` field representing the underlying spot at the GEX calculation time (per-minute). It's already in `ws_gex_strike_expiry.price`.
- The heatmap polls every 30s; minute-aged price matches that refresh cadence.
- Adding a `price_lottery` shorthand would mean a new handler (`uw-stream/src/handlers/price.py`), a new table (`ws_price_per_ticker`), a new migration, ~70 new WS subscriptions (210 → 280 channels), and per-trade write volume (much higher than per-minute GEX).

**Decision:** Read the latest price from `ws_gex_strike_expiry` (minute cadence). Add `price:<TICKER>` later only if sub-second ticking matters for a different use case (e.g. a live ticker tape strip).

**Override:** If the user wants sub-second price ticking on the heatmap chip, we'll add `price_lottery` as Phase 1B before continuing to Phase 3. Same shape as the Phase 1 commit.

## ATM behavior (2026-05-15)

"Top 5 by |GEX|" can leave the literal ATM strike outside the result set when dealer gamma is concentrated away from spot.

**Default:** Highlight whichever of the returned 5 strikes is closest to spot. The visual hint becomes "of the dealer's top GEX walls, this one is nearest to where price is now" — usually the most actionable wall for exit timing.

**Alternative (not chosen):** Always include the literal ATM strike as a 6th row even if it's outside top-5 by |GEX|. Trade-off: clutters the table with a strike that has structurally low GEX. Available if you want it later.

## Still to confirm during build

- `source` column on `ws_net_flow_per_ticker` — need to grep migration history before deciding whether to ALTER. Punt to Phase 2 since the live UI doesn't care.

## Thresholds / constants

- **Top-N strikes:** 5 (per user spec).
- **Refresh interval:** 30s frontend poll; 1-min upstream UPSERT cadence on `ws_gex_strike_expiry`.
- **Backfill window:** 90 trading days for ML.
- **REST concurrency cap:** 3 (matches uwFetch's existing global concurrency).
- **Regime threshold:** Long Γ if `SUM(call_gamma_oi + put_gamma_oi) > 0` across all strikes for the 0DTE expiry; Short Γ otherwise.
- **Net flow bias chip:** BULLISH if `cumulativeCallPrem >= 2 × cumulativePutPrem`; BEARISH if `cumulativePutPrem >= 2 × cumulativeCallPrem`; NEUTRAL otherwise. **OPEN — defer to user.**

## User contribution (learning mode)

**Why this matters:** The tooltip text is the _interpretive lens_ between raw Greek values and a trading decision. This is your domain — what does "+Charm at 437.5 going into 2:30 PM" actually tell you to do? The infrastructure team can't write this; only you can.

**Where to write it:** `src/components/GreekHeatmap/tooltipText.ts`. After Phase 4 scaffolding lands, you'll fill in 6-8 short strings (one per cell-type × sign-direction combination) that the heatmap renders on hover.

**Trade-offs to consider:**

- Length: tooltips that exceed ~120 chars get cut off / look bad. Tight phrasing wins.
- Audience: you'll re-read these in 6 months. Self-explanatory > clever.
- Asymmetry: +Γ and −Γ aren't symmetric in trading consequence; the tooltips shouldn't be either.

## Risks

- **Subscription cost:** Adding 70 `gex_strike_expiry` subscriptions on top of existing 70 `option_trades` + 70 `net_flow` puts uw-stream at ~210 channels. Existing service handles this with batching, but worth watching `ws_backpressure_policy` metrics post-deploy.
- **DB write volume:** `ws_gex_strike_expiry` gets per-minute UPSERTs per (ticker, strike). For 70 tickers × ~20 strikes × 390 minutes = 546K UPSERTs/day. Existing table indexes handle this for SPY/QQQ; need to monitor latency after fan-out.
- **REST backfill rate-limit:** 90 days × 70 tickers × 2 endpoints concurrent-capped at 3 = ~50 min wall clock. Run off-hours and watch Sentry for 429 spikes.

## Acceptance criteria (Done When)

- [ ] Phase 1: `ws_gex_strike_expiry` table receives rows for all 70 lottery tickers within 5 min of deploy
- [ ] Phase 2: `strike_exposures` + `ws_net_flow_per_ticker` have 90 trading days of data for all 70 lottery tickers
- [ ] Phase 3: `GET /api/greek-heatmap?ticker=TSLA` returns valid response with 5 strikes + net flow during market hours
- [ ] Phase 4: UI section renders between Lottery Finder + SilentBoom; ticker selection works; polling gated on marketOpen + section expanded; tooltips render
- [ ] `npm run review` passes (tsc + eslint + prettier + vitest --coverage)
- [ ] Code-reviewer subagent verdict: `pass`
