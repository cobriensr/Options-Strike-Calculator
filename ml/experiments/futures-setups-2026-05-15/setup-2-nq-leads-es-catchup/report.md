# Setup: `nq-leads-es-catchup`

**Test window:** 2026-01-01 → 2026-04-17
**Generated:** 2026-05-16T06:49:01Z

**No signals fired in the test window.**

Either the rule's thresholds are too strict for the current regime,
or required data (e.g., earnings calendar, dealer gamma history) is
missing for this period. See `results.json` for `data_unavailable`
flags if applicable.

## Notes

**Cross-asset evaluator.** Needs both ES (primary) and NQ TBBO + OHLCV data, lazy-loaded per day. NQ data comes from the same DuckDB session stashed in ctx.

**Trigger thresholds (frozen):** NQ 1h OFI ≥ +0.4 (real 'aggressive buy' level per the validated reference), ES 1h OFI ≤ +0.1 (ES has not yet caught up to NQ's flow), ES/NQ 30m correlation ≥ 0.7 (they're still moving together so the catch-up thesis holds).

**Target = NQ-implied ES level.** We extrapolate where ES _would_ be if it tracked NQ's % gain since RTH open. If NQ is up 1% and ES is up 0.4%, target = ES open × 1.01 — i.e., the level ES would trade at to fully match NQ's percentage move.

**Disqualifier — correlation break.** If 30m ES/NQ correlation drops below 0.5 between trigger fire and entry, the catch-up thesis breaks and the signal is rejected. Checked once at decision time.
