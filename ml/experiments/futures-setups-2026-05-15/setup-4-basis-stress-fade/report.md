# Setup: `basis-stress-fade`

**Test window:** 2026-03-01 → 2026-04-17
**Generated:** 2026-05-16T20:15:41Z

**No signals fired in the test window.**

Either the rule's thresholds are too strict for the current regime,
or required data (e.g., earnings calendar, dealer gamma history) is
missing for this period. See `results.json` for `data_unavailable`
flags if applicable.

## Notes

**Restricted test window**: 2026-03-01 → 2026-04-17 (~33 trading days). `greek_exposures_0dte` history before 2026-03 isn't reliably populated, per spec open question #4.

**Data dependencies**: SPX index 1m close (for ES-SPX basis), `greek_exposures_0dte` from Neon (for SPX dealer γ sign), VIX 1m, CL 1m (for disqualifier). When `DATABASE_URL` is not set, all four load empty and the evaluator reports `data_unavailable=True` in metadata. No signals fire.

**Conservative stop/target geometry**: fixed +5pts stop (1R = $250 on ES), target = basis ±2 (variable distance — typically 3pts of ES compression). Reward-to-risk ~0.6:1, so this setup needs ~62% WR to break even on raw R; expectancy depends on dealer-γ filter actually flushing the bad fades.
