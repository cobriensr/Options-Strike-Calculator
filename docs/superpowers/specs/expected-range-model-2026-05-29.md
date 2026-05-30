# Calibrated SPX 0DTE expected-range / pin model (idea #2)

**Status:** spec / pre-build, 2026-05-29
**Depends on:** Phase 0 data foundation ([[project_dealer_state_data_foundation]])

## Goal

Turn the one validated relationship we have — **dealer gamma scales realized
range** (+γ compresses to 54–76% of VIX-implied, −γ expands to ~107%;
[[project_dealer_gamma_vol_compression]]) — into a daily, calibrated forecast
of SPX's **expected high-low range**, **EOD close band**, and **pin magnet
level**. Output feeds the existing iron-condor wing and BWB strike-selection
tools, and seeds the later regime engine (#1). Decision-support, not an alert.

## The crux hypothesis (Phase 1 = go/no-go)

VIX already encodes an expected range. The ONLY reason this model can beat
"just use VIX" is if **dealer gamma explains residual range beyond VIX** —
i.e. +γ days realize meaningfully *less* than VIX implies and −γ days *more*,
out-of-sample. If γ adds nothing beyond VIX on the holdout, #2 is just
repackaging VIX and we stop. This is a cheap 1-script test on existing data
and must pass before any modeling.

## Phases

### Phase 1 — Residual-range probe (go/no-go, ~1 script, no UI)
- Build the daily spine: for each trading day, morning dealer-gamma state
  (sign + magnitude from `spot_exposures` and/or Periscope MM gamma, sampled
  at a fixed pre-decision cutoff — e.g. 9:00 CT, NO lookahead) × VIX/VIX-term
  from deduped `market_snapshots` × realized high-low range from
  `index_candles_1m`.
- Test: regress realized range on VIX-implied range; does γ sign/magnitude
  explain the **residual**, OOS (temporal holdout, earliest ~70% train /
  latest 30% test)? Report the γ-conditioned range multiplier per bucket and
  whether the compression/expansion split survives on the holdout.
- **Gate:** ship Phase 2 only if γ beats VIX-alone on residual range OOS.

### Phase 2 — Calibrated range band
- Quantile/conditional model: expected range band (p10–p90) = f(VIX-implied,
  γ state). Calibration metric: does the p10–p90 band contain realized range
  ~80% OOS? Beat baselines (VIX-implied alone; yesterday's range) on pinball
  loss / coverage.

### Phase 3 — Pin / level model
- Use `gex_strike_0dte` walls + `zero_gamma_levels` to predict the close
  magnet. Measure "close within X pts of nearest wall" hit-rate, conditioned
  on +γ (where pinning should be strongest). Report OOS lift over "close ≈
  open."

### Phase 4 — Intraday update + UI surface
- Recompute as the day progresses (`spot_exposures` per-minute). Surface an
  expected-range cone + pin level in the app; wire into condor wing / BWB
  strike pickers. Tests + review loop per CLAUDE.md.

## Data dependencies (all Phase-0-confirmed, UTC-minute joinable)
- Dealer state: `spot_exposures` (per-min SPX γ/charm/vanna, ~75d),
  `periscope_snapshots` (MM γ, 136d, 10-min), `zero_gamma_levels` (~51d),
  `gex_strike_0dte` (per-strike walls, ~69d).
- Implied/regime: `market_snapshots` (VIX + term + daily OHLC, ~98d → dedupe
  1 row/day).
- Outcome spine: `index_candles_1m` (SPX 1-min, ~66d).
- NO GexBot dependency (too thin until late-June reprobe).

## OOS discipline
Temporal holdout, train-to-fit / test-to-confirm; calibration over point
accuracy; always beat a named naive baseline (VIX-implied range). Same
gauntlet that killed conviction/takeit — peak/in-sample numbers don't count.

## Open questions (defaults noted)
- Periscope 10-min vs spot_exposures per-min as the γ source → **default:
  spot_exposures for cadence in Phase 1, cross-check with Periscope's deeper
  136-day history.**
- Feature cutoff time to avoid lookahead → **default 9:00 CT (first 30 min)**;
  revisit for an open-only variant.
- SPX vs SPXW scope → **SPX index spine** (`index_candles_1m`).

## Thresholds / constants (initial, to tune in-sample only)
- Holdout split: latest 30% of dates.
- Band target coverage: 80% (p10–p90).
- γ buckets: sign split first; magnitude tertiles if sign survives.

## Out of scope
- GexBot-based features (#1/#3 will revisit post late-June reprobe).
- Any directional (up/down) call — this models the **distribution**, not direction.
