# Futures Setups Backtest — 8 Candidate NQ/ES Setups

**Date:** 2026-05-15
**Owner:** Charles
**Status:** Spec — pre-Phase 0

## Goal

Backtest 8 candidate NQ/ES intraday setups on the 400-day TBBO archive + 16-year
1m OHLCV archive, produce one comparable performance report per setup, and use the
results to decide which 2–3 (if any) are worth productionizing as a "Setups
Section" in the React app.

Every setup is tested with the **exact rule as specified** — no per-setup
parameter tuning. If a rule fails as written, it fails; we do not curve-fit
thresholds to rescue it. This is the only way the results stay honest enough
to risk real capital on later.

## Non-goals

- No live execution wiring in this spec. Backtest only.
- No new ingestion. Uses data already in `ml/data/archive/` and Neon Postgres.
- No UI work. Results are JSON + Markdown reports.
- No re-running already-validated experiments (NQ 1h OFI is shipped; we don't
  re-derive its ρ here).

## Data sources

| Source                   | Path / table                                                                    | Used by                                                   |
| ------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| TBBO tick + L1 book      | `ml/data/archive/tbbo/year=YYYY/part.parquet`                                   | OFI, CVD, spread z, tape distribution, stop-hunt detector |
| 1m OHLCV                 | `ml/data/archive/ohlcv_1m/year=YYYY/part.parquet`                               | All setups (bars, VWAP, IB, sweep detection)              |
| Futures snapshots (live) | Neon `futures_snapshots`, `futures_bars`                                        | ES/NQ basis, VX term — historical reconstruction          |
| ES options EOD           | Neon `futures_options_daily`                                                    | Setup 4 (basis-stress validator), Setup 7 (mech-hedge)    |
| 0DTE SPX gamma           | Neon `greek_exposures_0dte`, `zero_gamma_levels`                                | Setup 5, Setup 7                                          |
| Cross-asset (ZN/GC/CL)   | `ml/data/archive/ohlcv_1m/` (assuming Databento coverage) + Neon `futures_bars` | Setup 7                                                   |
| Earnings calendar        | TBD (UW endpoint or manual seed)                                                | Setup 8                                                   |

**Look-ahead discipline:** every feature is computed on data with `timestamp <= decision_ts`. Strict left-closed windows. Walk-forward only.

## Walk-forward split

| Split | Date range              | Use                                                                            |
| ----- | ----------------------- | ------------------------------------------------------------------------------ |
| Train | 2025-04-20 → 2025-12-31 | Threshold sanity (rule already specifies thresholds; this is observation-only) |
| Test  | 2026-01-01 → 2026-04-17 | Reported performance numbers                                                   |

Roughly 9 months train / 3.5 months test. Short for futures but matches the TBBO archive boundaries. No re-training between splits — the rule is fixed.

## Setups (rules, fixed)

| #   | Slug                            | Trigger                                                               | Direction                 | Stop                   | Target                     | Disqualifier                                          |
| --- | ------------------------------- | --------------------------------------------------------------------- | ------------------------- | ---------------------- | -------------------------- | ----------------------------------------------------- |
| 1   | `nq-ofi-extreme`                | NQ 1h OFI ≥ p95 (rolling 252d)                                        | Long NQ if + / Short if − | 30m swing              | VAH/VAL or +2 ATR          | MACRO-STRESS regime active                            |
| 2   | `nq-leads-es-catchup`           | NQ 1h OFI ≥ +0.4 AND ES OFI ≤ +0.1 AND ES/NQ 30m corr ≥ 0.7           | Long ES (laggard)         | Morning low            | NQ-implied ES move         | ES/NQ corr break                                      |
| 3   | `overnight-extreme-sweep`       | First 15m RTH sweeps ETH high/low AND closes back inside ETH range    | Fade sweep                | 1pt past swept extreme | Opposite side of ETH range | Econ-calendar event during window                     |
| 4   | `basis-stress-fade`             | ES-SPX basis ≥ +5pts AND SPX dealer γ ≥ 0                             | Short ES (compression)    | +5pts beyond entry     | Basis returns to ±2pts     | VIX spike >2pts in 5m OR CL move >2% in 30m           |
| 5   | `zero-gamma-magnet`             | Price within 0.25 ATR of ZG AND dealer γ < 0 on price's side          | Toward ZG                 | Other side of ZG       | ZG ± 1σ                    | NQ 1h OFI opposing                                    |
| 6   | `cvd-divergence-fade`           | New session price high AND CVD lower-high (or inverse)                | Fade extreme              | Beyond extreme         | VWAP or POC                | News catalyst within 5m                               |
| 7   | `flight-to-safety-continuation` | ZN +0.5% AND GC +0.5% AND ES −0.3% within same 30m AND <2hr into move | Short ES on retest        | Beyond breakdown level | Day S1/S2                  | None — primary trend continuation                     |
| 8   | `mega-cap-earnings-fade`        | AAPL/MSFT/NVDA/GOOG/META reported overnight AND NQ gap ≥ ±0.5% at RTH | Fade open in NQ           | First 10m IB extreme   | VWAP                       | Earnings beat-and-raise (qualitative; default = take) |

## Cost model

| Contract             | Slippage assumption                   | Commission       |
| -------------------- | ------------------------------------- | ---------------- |
| ES (1 tick = $12.50) | 1.5 ticks at entry, 1.5 ticks at exit | $2.50 round-trip |
| NQ (1 tick = $5.00)  | 1.5 ticks at entry, 1.5 ticks at exit | $2.50 round-trip |

1.5-tick slippage is a middle ground: tight enough for mid-day liquid hours, generous enough to cover first/last 15min and most news prints. Reported metrics are net of cost.

## Metrics (computed identically for every setup)

For each setup we report on the test split:

- **N signals** (count of fires)
- **Win rate** (target hit before stop, %)
- **Avg R** (mean R-multiple; loss = −1R by definition)
- **Expectancy per signal** ($ per signal after costs)
- **Profit factor** (gross win $ / gross loss $)
- **Max consecutive losers**
- **Hit-rate by time-of-day bucket** (15/15/30/60/60/60/30 across RTH)
- **Sharpe on signal-day returns** (annualized)
- **Max drawdown ($ and % of cumulative $)**

Plus per-signal trade log (parquet) so we can drill in afterward.

## File layout

```
ml/src/setups_backtest/
  __init__.py
  harness.py            # Run loop, time-series walk, stop/target sim
  data_loaders.py       # TBBO, OHLCV, Neon DB pulls (point-in-time)
  features.py           # OFI, CVD, spread z, basis, regime, ZG bands (PIT)
  metrics.py            # All metrics + report formatter
  evaluators/
    __init__.py
    setup_1_nq_ofi_extreme.py
    setup_2_nq_leads_es.py
    setup_3_overnight_sweep.py
    setup_4_basis_stress.py
    setup_5_zg_magnet.py
    setup_6_cvd_divergence.py
    setup_7_flight_to_safety.py
    setup_8_mega_cap_earnings.py
  cli.py                # `python -m setups_backtest run --setup N --out DIR`

ml/experiments/futures-setups-2026-05-15/
  README.md             # Summary + comparative table (filled at Phase 9)
  setup-1-nq-ofi-extreme/
    results.json
    trades.parquet
    report.md
  setup-2-nq-leads-es/...
  ...

ml/tests/setups_backtest/
  test_harness.py       # Stop/target sim correctness on synthetic bars
  test_features.py      # OFI/CVD/spread-z PIT correctness
  test_evaluator_setup_1.py
  ...                   # One test file per setup, asserting rule on known synthetic days
```

## Phases (sequential — one setup at a time per `feedback_per_phase_loop`)

### Phase 0 — Shared harness (one-time)

Build the data loaders, feature computers, harness loop, metrics, and CLI. Includes a synthetic-bars test for stop/target simulation and a small dry-run on Setup 1's rule to sanity-check the wiring.

**Verify:** `python -m setups_backtest run --setup 1 --dry-run --days 5` exits clean and writes a results.json with N_signals > 0.

### Phase 1 — Setup 1: `nq-ofi-extreme`

Implement evaluator. Run full test split. Save results + trade log.
**Verify:** results.json populated, win-rate / expectancy printed, report.md written.

### Phases 2–8 — Setups 2 through 8

Same pattern, one at a time. After each: commit + push, then move on. Code-reviewer subagent runs at end of each phase per `feedback_always_reviewer_subagent`.

### Phase 9 — Comparative report

Build `ml/experiments/futures-setups-2026-05-15/README.md` with a single comparison table (all 8 setups, all metrics). Recommendation: rank by expectancy × signal frequency. Flag any setup where N_signals < 20 (insufficient for inference).

## Thresholds and constants (frozen)

These are not parameters to tune — they are part of the rule:

- NQ 1h OFI p95 (rolling 252d) — computed from train split, fixed for test
- ES/NQ correlation window — 30m
- ETH range definition — 17:00 ET (prior day) to 09:30 ET
- IB window — first 60m of RTH
- ATR window — 14 × 1m bars
- VAH/VAL — yesterday's volume profile from 1m bars
- Basis stress threshold — ±5pts (matches existing prompt rule)
- ZG distance threshold — 0.25 × ATR(14)
- Earnings list — AAPL, MSFT, NVDA, GOOG, GOOGL, META, AMZN, TSLA

## Open questions

1. **Where do we get the earnings calendar for Setup 8?** UW has an endpoint; need to confirm coverage 2026-01 onward. **Default if no data:** skip Setup 8 in this pass, mark `data_unavailable`.
2. **ZN/GC/CL coverage for Setup 7.** Sidecar ingests these to `futures_bars`. TBBO archive may not include them. **Default:** use 1m OHLCV from Neon `futures_bars` for cross-asset, only TBBO for ES/NQ.
3. **News catalyst detection for Setup 6 disqualifier.** Hard to do retrospectively. **Default:** skip the disqualifier, accept that some signals will be news-driven and count as part of the noise.
4. **0DTE SPX dealer γ historical reconstruction** for Setups 4/5. We have `zero_gamma_levels` from 2026-03 onward; earlier ZG state is missing. **Default:** test window for Setups 4/5 is 2026-03-01 → 2026-04-17 only; flag the shorter window in the report.

## Anti-bias checklist (verified before reporting each setup)

- [x] Point-in-time data only (`ts <= decision_ts`)
- [x] No parameter tuning between train and test
- [x] Survivorship N/A (continuous front-month futures; rolls handled by Databento parent symbol)
- [x] Transaction costs included
- [x] Test window kept untouched until rule frozen
- [x] No selection bias — all 8 setups committed in this spec before any results are seen
- [x] Setups flagged `data_unavailable` are reported, not silently dropped

## Done criteria

- All 8 setups have a `results.json` + `report.md` (or `data_unavailable` flag)
- Phase 9 comparative README written
- Top 2–3 candidates identified with expectancy, signal frequency, and a one-line "why this might fail in production"
- Honest negative results recorded for setups that fail — these are valuable too
