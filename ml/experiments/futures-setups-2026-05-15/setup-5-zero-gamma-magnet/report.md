# Setup: `zero-gamma-magnet`

**Test window:** 2026-03-01 → 2026-04-17
**Generated:** 2026-05-16T20:23:35Z

**No signals fired in the test window.**

Either the rule's thresholds are too strict for the current regime,
or required data (e.g., earnings calendar, dealer gamma history) is
missing for this period. See `results.json` for `data_unavailable`
flags if applicable.

## Notes

**Restricted test window**: 2026-03-01 → 2026-04-17 per spec open question #4. `zero_gamma_levels` history before March is unreliable.

**Data dependencies**: SPX ZG per minute (`zero_gamma_levels`), SPX dealer γ (`greek_exposures_0dte`), NQ TBBO for the opposing-OFI disqualifier. Without `DATABASE_URL`, the first two load empty and the evaluator reports `data_unavailable=True`; no signals fire.

**The trade thesis**: in negative-γ regime, dealers hedge in the direction of the move (pro-cyclical). When price is near ZG, dealer hedging accelerates the move _toward_ ZG (price passes through, dealers flip to long-γ on the other side, hedging reverses).

**Stop geometry deviation from spec.** The spec says 'Stop: Other side of ZG' — taken literally this puts stop and target on the SAME side of entry, which is geometrically impossible. We use a standard adverse-move stop (0.25 × ATR against entry — same proximity gate as the trigger) and a target 1 × ATR past ZG. The 'other side' phrasing is likely a profit-protection exit; we capture the same intent with a tight stop on the magnet-failure side.
