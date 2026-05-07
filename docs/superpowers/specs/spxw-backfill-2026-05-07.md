# SPXW backfill from parquet

**Status**: in-progress
**Date**: 2026-05-07

## Goal

Add `SPXW` to the lottery universe and backfill all historical lottery_finder_fires + their enrichment from the local EOD parquets (April 13 → present, ~18 trading days). Reason: the WS daemon doesn't subscribe to SPXW, so `ws_option_trades` is permanently blind to it — but the parquets carry full SPXW coverage (1.2M trades on 2026-05-06 alone).

## Why now

User flagged that no SPXW fires appear in the dashboard despite SPXW being the user's primary 0DTE traded chain. Investigation showed:

- SPXW absent from `LOTTERY_V3_TICKERS`
- WS daemon not subscribing to SPXW (zero rows in `ws_option_trades` for last 3 days)
- Parquet has 1.2M SPXW trades on a single day — historical data is fully available
- Adding SPXW to the universe alone is insufficient: the production cron reads from `ws_option_trades`, so retroactive fires won't appear without parquet replay

## Phases

### Phase 1 — Universe + score weights (~5 min)

- Add `'SPXW'` to `LOTTERY_V3_TICKERS` in [api/_lib/lottery-finder.ts](../../../api/_lib/lottery-finder.ts).
- Run `make refit` so SPXW gets a tier weight if its history justifies one (will happen automatically once Phase 4 fires are in DB; for now, weights stay unchanged).

### Phase 2 — Python port of detector (~45 min)

New file: `scripts/lottery_detector_py.py`.

Faithful port of the following from [api/_lib/lottery-finder.ts](../../../api/_lib/lottery-finder.ts):

- `LOTTERY_SPEC_V4` constants — frozen
- `getTimeOfDay`, `getTimeOfDayFromCtHourMin`
- `getDominantSide`, `buildFlowQuad`
- `classifyMode`
- `isReload`, `isCheapCallPm`
- `detectChainFires` — the hot loop; ~150 LOC of mechanical translation
- `enrichFires` — the per-fire metadata munging

Imports the existing `LOTTERY_V3_TICKERS` and `LOTTERY_EXTENDED_TICKERS` lists by re-declaring as Python sets/frozensets (canonical JSON would be safer but adds runtime DB roundtrip; freeze-and-mirror matches `lottery-score-weights.ts` pattern).

### Phase 3 — Parity tests (~20 min)

New file: `scripts/test_lottery_detector_py.py`.

Mirrors [api/__tests__/lottery-finder.test.ts](../../../api/__tests__/lottery-finder.test.ts) 1:1 by name and shape. ~50 cases covering all helpers + detector edge cases (DTE boundaries, OI=0, cooldown, eviction at 5-min boundary, mid-window IV/delta gates).

Run via `ml/.venv/bin/pytest scripts/test_lottery_detector_py.py -q`.

### Phase 4 — Backfill driver (~30 min + ~10 min compute)

New file: `scripts/backfill_lottery_fires_for_ticker.py`.

CLI:

```
ml/.venv/bin/python scripts/backfill_lottery_fires_for_ticker.py \
  --ticker SPXW \
  [--from-date 2026-04-13] [--to-date 2026-05-06]
```

For each parquet:

1. Load filtered ticks (ticker + canceled=false + price>0)
2. Group by `option_chain_id`
3. For each chain: walk minute-by-minute through the 13:30–19:40 UTC range with a 7-min scan window — exact mirror of `detect-lottery-fires.ts` cron + the existing TS replay script
4. Compute `dte` from trigger date + expiry
5. Apply the cooldown across cron-tick boundaries (the `priorLastFireMs` parameter)
6. INSERT each fire with `ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING`

Macro snapshot: best-effort, like the cron — if `flow_data` / `spot_exposures` / `strike_exposures` have rows for the trigger time, fetch them; otherwise insert with NULLs in the macro columns. For 18 days back, those tables should be ~complete.

### Phase 5 — Enrichment + research refresh (~5 min)

`make enrich` — automatically picks up the new SPXW fires via `WHERE enriched_at IS NULL` and `WHERE realized_flow_inversion_pct IS NULL`. No change needed to the existing pipeline.

`make update` — refit (now will have SPXW data, may bump SPXW into the ticker weights table), exit_policy_search, feature_audit, flow_inversion_timing, daily_tracker. Day-over-day diff will show SPXW joining the dataset.

## Open questions

**Q: SPX (cash-settled) and XSP (mini)?**
A: Out of scope for this spec. Add them in a follow-up only if the SPXW backfill validates the approach. SPX is monthly-settled (low overlap with 0DTE), XSP is much lower volume.

**Q: NDXP fires-zero-despite-data?**
A: Out of scope — that's a detector calibration question, not a data plumbing one. Document as a known limitation in the runbook.

**Q: Going-forward WS daemon subscription?**
A: Out of scope. Once the historical SPXW fires are in the DB and the user has visibility into how they look, a separate decision can be made about WS subscription. For now, daily `make nightly update` will pick up new SPXW data via parquet replay.

## Acceptance criteria

- [ ] SPXW in `LOTTERY_V3_TICKERS`
- [ ] Python detector matches TS on all parity tests (50+)
- [ ] Backfill driver runs cleanly on all 18 parquets, produces N > 0 fires (estimate: 1K–20K based on SPXW chain density vs SPY's ~94 fires/day)
- [ ] `make enrich` populates `realized_*_pct` + `peak_ceiling_pct` + `realized_flow_inversion_pct` on the new SPXW fires
- [ ] `make update` includes SPXW in the daily tracking CSV and feature_audit ranking
- [ ] No regressions to the existing 67K+ fires (ON CONFLICT DO NOTHING ensures idempotency)

## Risks

- **TS↔Python parity drift**: mitigated by mirroring the test suite 1:1.
- **Parquet schema drift across dates**: mitigated by reusing the existing `bool/string canceled` handling from `enrich_lottery_outcomes.py`.
- **Missing macro snapshots for older dates**: acceptable; macro is display-only per the original spec, NULL is tolerated.
- **Per-strike GEX absent for SPXW** (`TICKERS_WITH_GEX_STRIKE` covers SPX/SPXW/NDX/NDXP/SPY/QQQ — SPXW is in this set, so fires WILL get strike-level macro). Good.
