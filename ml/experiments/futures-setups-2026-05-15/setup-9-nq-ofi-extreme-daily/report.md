# Setup: `nq-ofi-extreme-daily`

**Test window:** 2026-01-01 → 2026-04-17
**Generated:** 2026-05-16T22:47:33Z

**No signals fired in the test window.**

Either the rule's thresholds are too strict for the current regime,
or required data (e.g., earnings calendar, dealer gamma history) is
missing for this period. See `results.json` for `data_unavailable`
flags if applicable.

## Notes

**Daily-aggregate threshold variant of Setup 1.** Same rule, only the threshold derivation differs. Setup 1 uses p95 over every-minute |OFI| samples (loose, ~0.04). This variant uses p95 over one value per day — the day's MAX trailing-1h |OFI|.

**Run-time observation: regime shift between train and test.** Training (2025-04-20 → 2025-12-31, 182 days) daily-max |OFI| distribution: median 0.045, p90 0.067, p95 0.0784, max 0.133. Test (2026-01-01 → 2026-04-17, 75 days) daily-max |OFI| distribution: median 0.049, p90 0.066, **MAX 0.0760** — the test window's single biggest daily |OFI| reading didn't even reach the training-window p95 threshold of 0.0784. So 0 signals fired.

**What this means**: the threshold derived from training is too high for the test regime by ~0.003. Two interpretations:
1. Regime shift — Q1 2026 was structurally quieter in OFI than 2025. A daily-aggregate rule frozen from 2025 won't fire in this regime. The frozen-rule discipline is keeping us out of a potentially-overfit setup; this is a feature, not a bug.
2. The threshold from training is at the very edge of normal — with only 75 test days, it's plausible we just missed by sampling luck. A longer test window would tell us.

**Recommendation**: re-run on a wider test window (e.g., split the 400-day archive 60/40 instead of 75/25). Or accept that the daily-aggregate version is a 'rare extreme' setup that genuinely may not fire in a given quarter, and that's OK.
