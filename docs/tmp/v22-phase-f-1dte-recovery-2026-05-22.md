# V2.2 Phase F — 0DTE-Failure → 1DTE-Recovery Pattern Analysis

Run date: 2026-05-22

## Method

- 90-day aligned non-structure window (same gate as all Phase A/B/C scripts)
- Failure: DTE=0, outcome <= -30.0%
- Recovery candidate: same ticker + option_type, strike ±2%, DTE=1, trigger_time_ct within 30h after failure
- Outcome: COALESCE(realized_flow_inversion_pct, realized_eod_pct)
- Enrichment-bug rows (flow_inv > peak*1.05) excluded

## Failure cohort

- Total 90-day aligned fires: 164,940
- 0DTE failures (outcome <= -30.0%): 29,270
- Failures with a recovery 1DTE fire in window: 1,018 (3.5%)

## Recovery fire outcomes vs DTE=1 baseline

| metric | recovery fires | all DTE=1 baseline | lift |
| --- | --- | --- | --- |
| n | 27448 | 42577 | — |
| mean_pct | -4.4% | 14.8% | -19.2pp |
| win_rate (>0%) | 41.2% | 48.3% | -7.2pp |
| hit_50_pct (>=50%) | 8.4% | 18.3% | -9.9pp |

## Decision

**DROP** — No lift detected. The 0DTE failure does not predict better 1DTE outcomes on the same ticker/type/strike. The user's observation is likely selection bias. Do not implement recovery signal.

## Sensitivity check (strike band ±5%)

| metric | recovery fires (±5%) | all DTE=1 baseline | lift |
| --- | --- | --- | --- |
| n | 70954 | 42577 | — |
| mean_pct | -1.7% | 14.8% | -16.4pp |
| win_rate (>0%) | 42.8% | 48.3% | -5.5pp |
| hit_50_pct (>=50%) | 9.9% | 18.3% | -8.4pp |

## Caveats

- 90-day window only; wider window may change conclusion
- Strike-proximity threshold (±2%) is somewhat arbitrary — sensitivity check with ±5% included above if MARGINAL
- 'Recovery' does not imply causation; the baseline check controls for 'DTE=1 is just generally better'
- Recovery window (30h) spans same-session fires AND next-day opens; no distinction made between intra-day vs next-day recoveries in this version
