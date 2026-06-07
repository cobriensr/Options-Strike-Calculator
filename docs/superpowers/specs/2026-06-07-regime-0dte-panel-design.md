# 0DTE Gamma Regime Panel — Design Spec

**Date:** 2026-06-07
**Status:** Approved design, pending spec review → implementation plan
**Working name:** `regime-0dte` / "0DTE Gamma Regime" (distinct from the parallel `flow-regime` trade-tape aggression badge — different inputs, see Reconciliation)

## Goal

A live intraday panel that reads the SPX 0DTE **dealer-gamma structure + vol surface** and tells the trader, during the session, whether the day is structurally primed to trend and — if it's breaking down — confirms it early. It also scores itself: a nightly job records each day's regime call and the realized outcome, turning a one-off 106-day backtest into a living, self-updating scorecard.

This productionizes findings from the 106-day EOD-tape study (`docs/tmp/crash-autopsy/`, memory `project_0dte_vol_regime_asymmetry`).

## Backing research (validated, n=106 days; 9 big-down, 5 big-up)

- **Gamma gate is a graded, mostly-symmetric volatility gate** (net GEX within ±1% of spot, OI-based):
  - `> 0` (positive) → calm/mean-revert: 3% big-move rate, tight range (~0.82%).
  - `−0.15 < x ≤ 0` (mild neg) → big move likely **either direction** (15% big-down ≈ 12% big-up).
  - `≤ −0.15` (deep neg, n=13) → **downside-asymmetric: 23% big-down, 0% big-up**.
- **Down-only triggers** (no bullish analog exists — up-violence is un-telegraphed):
  - `mostly_red` (≤1 green AND ≥4 red 30-min candles by 11:00 CT): 6.5× lift on big-down, 4% false-pos, **0% big-up leakage**.
  - `iv_break` (SPXW 0DTE ATM put-IV breaks >2% above its 8:30–10:00 range during 10:00–12:30 CT; ignore later breaks = EOD settlement IV blowup): 3.9× lift.
  - `midday_deep_neg` (net GEX ±1% of the **current** spot ≤ −0.15, re-measured after 12:30 CT): recovers the afternoon-developing declines the morning signals miss.
- **Combined recall on the 9 big-down days:** morning (`iv_break OR mostly_red`) = 67% recall / 12% FP; adding `midday_deep_neg` → **100% recall but 23% FP** (an "amber/fragility-intensifying" flag, not a high-conviction red).
- **No up trigger and no overnight prediction** — the panel must not fake either. Opening directional flow is noise for direction.

## Data sources (all live, server-side, 1-min cadence — confirmed by audit)

| Signal | Table | Key columns | Cron |
|---|---|---|---|
| Gamma gate + midday re-measure | `gex_strike_0dte` | `call_gamma_oi`, `put_gamma_oi`, `strike`, `price` (live spot), `timestamp`, `date` | `fetch-gex-0dte` (`* 13-21 * * 1-5`) |
| Put-IV surface break | `strike_iv_snapshots` | `iv_mid`, `strike`, `side`, `spot`, `ts`, `ticker='SPXW'`, `expiry` | `fetch-strike-iv` (`* 13-21 * * 1-5`) |
| 30-min candle persistence | `index_candles_1m` | `symbol='SPX'`, `open/high/low/close`, `timestamp`, `market_time='r'` | `fetch-spx-candles-1m` (`* 13-21 * * 1-5`) |

Notes: `gex_strike_0dte` is naive OI-based (matches the study method) and stores the per-minute spot in `price`, so the ±1% band is re-measurable around the current spot at 1pm. `strike_iv_snapshots` keeps strikes ±12% of spot (both sides) → ATM puts present; snap-to-nearest-strike per minute rather than pinning one strike. **No new capture cron is required for the three signals** — only the nightly self-scoring job is new.

## Architecture

Pure evaluator ← thin endpoint reads 3 tables → market-hours-gated hook → rich panel. Nightly cron persists the daily verdict. Mirrors the existing **Opening Flow Signal** triad (`useOpeningFlowSignal` / `api/opening-flow-signal.ts` / `OpeningFlowSignal.tsx`) and the `withCronInstrumentation` cron pattern.

### 1. Pure module — `api/_lib/regime-0dte.ts` (no I/O)
Inputs: latest-minute GEX strikes, SPXW put-IV time series, SPX 30-min candle series, current spot, current CT minute. Output `Regime0dteState`:
```
gate: 'calm' | 'big_move' | 'lean_down'
gammaProfile: { strikes: {strike, netGex}[], flipStrike, spot, bandLoStrike, bandHiStrike, gexNearSpot }
gexOpen, gexMid (re-measured), flipMinusOpenPct
triggers: {
  mostlyRed:     { fired, atCt, green, red },
  ivBreak:       { fired, atCt, magPct, refHi, series },
  middayDeepNeg: { fired, atCt, gexMid },
}
note: string   // honest context, e.g. "deep -γ, no down trigger → up-ambush risk"
asOfCt, gateSetCt
```
All thresholds as named constants (see Thresholds). Pure + table-tested (TDD).

### 2. Backend
- **Endpoint** `api/regime-0dte.ts` (GET): `guardOwnerOrGuestEndpoint(req,res)` → Zod-validate query (`?date?` optional, default today) → `withRetry` reads of the 3 tables via `getDb()` → call pure module → JSON + `setCacheHeaders`. Coerce DECIMAL → number.
- **Nightly cron** `api/cron/capture-regime-0dte.ts`: schedule `30 21 * * 1-5` (after close/settle). `withCronInstrumentation` + `CRON_SECRET`. Recomputes the day's final regime + realized outcome (open/close/hi/lo, oc%, range, dir_eff, big_down/up from `index_candles_1m`) → one upsert row.
- **Table** `flow_regime_0dte_daily` — new numbered migration in `api/_lib/db-migrations.ts` (next free id), `db.test.ts` updated per the migration checklist (id in applied-mock, expected-output entry, SQL count +1 CREATE +1 INSERT).

`flow_regime_0dte_daily` columns: `date DATE PRIMARY KEY`, `gate TEXT`, `gex_open NUMERIC`, `gex_mid NUMERIC`, `flip_minus_open_pct NUMERIC`, `mostly_red BOOL`, `mostly_red_at TEXT`, `iv_break BOOL`, `iv_break_at TEXT`, `iv_break_mag_pct NUMERIC`, `midday_deep_neg BOOL`, `oc_ret_pct NUMERIC`, `range_pct NUMERIC`, `dir_eff NUMERIC`, `big_down BOOL`, `big_up BOOL`, `created_at TIMESTAMPTZ DEFAULT now()`.

### 3. Frontend
- **Hook** `src/hooks/useRegime0dte.ts`: mirror `useOpeningFlowSignal` — `usePolling` gated on the 8:30–15:00 CT window via `inPollingWindow`, `AbortController` per fetch, localStorage last-good cache, `{data, loading, error, isWindowOpen, refresh}`. Cadence ~45s (`POLL_INTERVALS` entry in `src/constants/index.ts`).
- **Component** `src/components/Regime0dte/`:
  - `index.tsx` — `SectionBox` shell, graded gate chip (color-coded), honest note line, trigger-light row.
  - `GammaProfileMini.tsx` — SVG net-GEX-by-strike bars, flip line, spot marker, ±1% band highlight.
  - `IvSparkline.tsx` — put-IV series with the 8:30–10:00 range band + break marker.
  - `CandleStrip.tsx` — 30-min green/red squares 8:30→now with an 11:00 divider.
  - `TriggerLights.tsx` — three latching lights with fire timestamps.
  - Rendered as its own `SectionBox` near `MarketRegimeSection` in `App.tsx`.

### 4. Error handling / edges
Pre-open / outside window → "waiting for open" placeholder (`isWindowOpen=false`). Sparse / `empty_chain` minute → snap-to-nearest strike; show "insufficient data", never fabricate; do not grade a gate from `< MIN_STRIKES` strikes. Gate "sets" only after first stable minute (~8:35); **triggers latch** once fired (never un-fire). Last-good cache survives a transient fetch error (Neon blip).

### 5. Testing
TDD on the pure module (gate grading at each boundary, each trigger fire/no-fire, EOD-IV cap, midday re-measure, latching). Endpoint shape + auth-guard. Cron auth-guard + happy-path + `getDb` mock sequence + `db.test.ts` update. Hook state-transitions (window open/closed, last-good). Component smoke. `e2e/regime-0dte.spec.ts` (render + a11y).

## Thresholds / constants (validated)

```
GATE_DEEP_NEG   = -0.15   // net GEX ±1% of spot ($B) → lean_down; also midday_deep_neg trigger
GATE_BAND_PCT   = 0.01    // ±1% of spot for the GEX gate window
IVBREAK_REL     = 1.02    // IV must exceed morning-range high by >2%
IVBREAK_REF_CT  = [08:30, 10:00]   // morning IV reference range
IVBREAK_WIN_CT  = [10:00, 12:30]   // valid break window (later = EOD settlement blowup, ignore)
MOSTLY_RED      = green ≤ 1 AND red ≥ 4   // 30-min SPX candles 08:30–11:00 CT
MIDDAY_AFTER_CT = 12:30   // midday gamma re-measure only after this
MIN_STRIKES     = (impl-time floor for a valid gate, e.g. 5)
POLL_CADENCE    = ~45s
Outcome defs (self-scoring): big_down oc ≤ −1%, big_up oc ≥ +1%, trend dir_eff ≥ 0.5 & range ≥ 0.8%
```

## Phases (each independently shippable)

1. **Pure module** — `api/_lib/regime-0dte.ts` + types + constants + TDD tests. No wiring.
2. **Backend** — migration + `flow_regime_0dte_daily` + `db.test.ts`; `api/regime-0dte.ts` + test; `api/cron/capture-regime-0dte.ts` + test + `vercel.json` cron entry.
3. **Frontend** — `useRegime0dte` + `Regime0dte/` component (panel + 4 sub-viz) + tests; `POLL_INTERVALS` entry.
4. **Wire-in** — render in `App.tsx`; `e2e/regime-0dte.spec.ts`; optional: seed `flow_regime_0dte_daily` from the 106-day `master_scorecard.csv` so the live scorecard starts with history.

## Files

**Create:** `api/_lib/regime-0dte.ts`, `api/regime-0dte.ts`, `api/cron/capture-regime-0dte.ts`, `src/hooks/useRegime0dte.ts`, `src/components/Regime0dte/{index,GammaProfileMini,IvSparkline,CandleStrip,TriggerLights}.tsx`, tests (`api/__tests__/regime-0dte.test.ts`, `api/__tests__/regime-0dte-endpoint.test.ts`, `api/__tests__/capture-regime-0dte.test.ts`, `src/__tests__/useRegime0dte.test.ts`, `src/__tests__/Regime0dte.test.tsx`, `e2e/regime-0dte.spec.ts`).

**Modify:** `api/_lib/db-migrations.ts` (migration), `api/__tests__/db.test.ts` (migration checklist), `vercel.json` (cron), `src/App.tsx` (render), `src/constants/index.ts` (poll interval).

## Data dependencies
New table `flow_regime_0dte_daily` (migration). New cron `capture-regime-0dte` in `vercel.json`. No new env vars. No new external APIs (reads existing Neon tables). No new capture cron for the three signals.

## Reconciliation with `flow-regime` (parallel feature)
Orthogonal, not duplicate. `flow-regime` = intraday trade-tape **aggression** recognizer (`net_delta_tilt` + `idx0dte_put_share` from `ws_option_trades`, ~50-ticker WS universe, percentile-scored). This = day-level dealer **structure + vol surface** (OI-GEX + IV-break, SPX/SPXW only). They can sit side-by-side: flow-regime = "is current flow abnormal for this time of day"; regime-0dte = "is today structurally set up to trend, and is it breaking down." No shared inputs.

## ✅ GEX unit calibration (DONE 2026-06-07)
Calibrated via `scripts/calibrate-regime-gate.mjs` (read-only prod query, 74 days 2026-02-20..06-05).

**Sign bug caught (correctness-critical):** in `gex_strike_0dte`, `put_gamma_oi` is stored **signed-negative**, so net dealer GEX = `call_gamma_oi + put_gamma_oi`, NOT `call − put` (the original Task-5 mapping and the data-audit's report were wrong). Verified against raw rows: `call_gamma_oi ∈ [0, +1.3e11]`, `put_gamma_oi ∈ [−7.7e10, 0]`. The `call − put` form is positive every day and erases the signal.

**Result:** open-spot `gexNearSpot` (sum of `call+put` within ±1%) 12th-percentile over 74 days = **−1.52e10** → `GATE_DEEP_NEG = -1.5e10` (live units, ~1e10 scale; NOT the study's −0.15). Cross-validated against realized open→close from `index_candles_1m`: days ≤ cutoff had **55.6% down-rate (≤−0.5%) vs 9.8%** for the rest and **11% up-rate vs 28%** — the same downside-asymmetry as the 106-day study, on independent live data. The gate *sign* (calm vs negative), `mostly_red` (candle counts), and `iv_break` (relative %) were always scale-invariant and unaffected. Threshold is an absolute magnitude — recalibrate if the 0DTE OI scale drifts.

## Open questions (defaults noted)
- **Migration number** — next free id, determined at implementation.
- **Gamma-profile viz** — build SVG from scratch vs reuse an existing per-strike bar component (check periscope/GEX components first). Default: self-contained SVG.
- **Historical backfill** — optional Phase 4 seed of `flow_regime_0dte_daily` from `master_scorecard.csv`. Default: include (cheap, gives the scorecard instant history).
- **Scope** — SPX/SPXW only; NDXP/NDX out of scope for v1.
- **Access** — owner+guest read (`guardOwnerOrGuestEndpoint`), consistent with other GEX surfaces. No `checkBot` (mirrors `opening-flow-signal`), so no `src/main.tsx` botid `protect` change.
