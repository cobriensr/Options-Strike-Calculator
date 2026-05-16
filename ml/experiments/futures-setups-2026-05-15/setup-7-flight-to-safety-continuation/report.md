# Setup: `flight-to-safety-continuation`

**Test window:** 2026-01-01 → 2026-04-17
**Generated:** 2026-05-16T21:26:16Z

**No signals fired in the test window.**

Either the rule's thresholds are too strict for the current regime,
or required data (e.g., earnings calendar, dealer gamma history) is
missing for this period. See `results.json` for `data_unavailable`
flags if applicable.

## Notes

**Data dependencies**: ZN (10Y note) and GC (gold) 1m bars. Per spec open question #2, these come from Neon `futures_bars` (sidecar-populated) since the TBBO parquet archive doesn't include them. Without `DATABASE_URL`, both load empty and the evaluator reports `data_unavailable`.

**Cross-asset window check**: We require simultaneous ZN ≥+0.5%, GC ≥+0.5%, ES ≤−0.3% within the SAME 30-minute window — a tight joint move signaling coordinated risk-off positioning. The 2-hour freshness gate prevents entering after the trend has already played out.

**Target geometry**: S1 ≈ yesterday's close − 1×ATR(14). Crude approximation of intraday support; a fuller version would use pivot-point math (PP, S1, S2, R1, R2). Acceptable for first pass.
