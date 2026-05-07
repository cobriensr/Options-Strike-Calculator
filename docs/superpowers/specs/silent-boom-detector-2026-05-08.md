# Silent → Boom alert detector

**Status**: in-progress
**Date**: 2026-05-08

## Goal

Surface a new class of intraday option-flow alerts on the dashboard that the lottery_finder v4 detector misses: chains that trade silently for 15-20 minutes, then exhibit a single 5-min ask-side block much larger than their own baseline. Exemplar: SPY 727P 0DTE on 2026-05-07, where the user manually traded a UW flow alert for profit but the lottery_finder rejected the chain on three single-bps threshold misses.

## Empirical basis

[scripts/silent_boom_audit.py](../../../scripts/silent_boom_audit.py) replayed the pattern across 19 parquet days. **13,958 fires.** Aggregate at fixed horizons: ~0% mean realized return. **Peak ceiling: +26.15% mean, 71.7% win rate, +0.227 Sharpe.** Conclusion: pattern is real but not blindly tradeable — the spike pops then mean-reverts. **Discretionary signal, not systematic strategy.** Surface it as "look here," let the user manage the exit.

Full audit at `docs/tmp/silent-boom-audit-2026-05-07.md`.

## Architecture

Mirrors the existing `lottery_finder_fires` pattern.

### Backend

- New table `silent_boom_alerts` with columns: id, date, bucket_ct (5-min bucket), option_chain_id, underlying_symbol, option_type, strike, expiry, dte, spike_volume, baseline_volume, spike_ratio, ask_pct, vol_oi, entry_price (vwap of spike bucket), open_interest, inserted_at. Unique on (option_chain_id, bucket_ct).
- New module `api/_lib/silent-boom.ts` — pure TS port of the detector from `silent_boom_audit.py` (mirrors `lottery-finder.ts` ↔ `lottery_detector_py.py` pattern). Parameters frozen as `SILENT_BOOM_SPEC_V1`.
- New cron `api/cron/detect-silent-boom.ts` — runs every 5 min during market hours. Reads last 30 min of `ws_option_trades`, buckets to 5-min, applies detector. INSERT with `ON CONFLICT (option_chain_id, bucket_ct) DO NOTHING`. Enforces cooldown across cron invocations by querying `silent_boom_alerts` for prior fires on the same chain within the last 60 min.
- New endpoint `api/silent-boom-feed.ts` — paginated feed similar to `api/lottery-finder.ts`. Default filter: index/ETF tickers (SPY, QQQ, IWM, SPXW). Sortable by bucket_ct (newest), spike_ratio, vol_oi.

### Frontend

- New hook `src/hooks/useSilentBoomFeed.ts` — polling fetch like `useLotteryFinder`.
- New component `src/components/SilentBoom/SilentBoomSection.tsx` — separate collapsible section below LotteryFinder. Reuses `ContractTapeChart`, `TickerNetFlowChart`, `useContractTape` from LotteryFinder for the per-row expand panel.
- Wire into `App.tsx` alongside LotteryFinderSection.

### Why a separate detector instead of extending lottery_finder

Different _signal class_. lottery_finder is a sustained-burst detector. silent-boom is a step-change anomaly detector. Conflating them would dilute lottery_finder's calibration (already at ~85K validated fires) and corrupt the score weight refit. They're complementary, not overlapping.

## Detection parameters (frozen)

From the audit — these picked up the SPY 727P case and produced ~735 fires/day:

```
BASELINE_BUCKETS    = 4   (× 5min = 20min trailing window)
BASELINE_MEDIAN_MAX = 500 (silence threshold — vol)
MIN_SPIKE_VOL       = 1000
SPIKE_MULTIPLIER    = 5.0
ASK_PCT_MIN         = 0.70
VOL_OI_MIN          = 0.25
COOLDOWN_BUCKETS    = 12  (60 min between fires/chain)
MIN_OI              = 100
```

The dashboard's default `vol_oi ≥ 0.5` filter trims to ~50–100 fires/day on the indexes — actionable density.

## Phases

### Phase 1A — backend foundation (5 files)

1. Add migration to `api/_lib/db-migrations.ts` for `silent_boom_alerts`
2. Update `api/__tests__/db.test.ts` for the new migration
3. New file `api/_lib/silent-boom.ts` — detector logic
4. New file `api/__tests__/silent-boom.test.ts` — parity tests
5. This spec doc

### Phase 1B — cron + endpoint (4 files)

1. New file `api/cron/detect-silent-boom.ts`
2. New file `api/__tests__/detect-silent-boom.test.ts`
3. New file `api/silent-boom-feed.ts`
4. `vercel.json` — register the cron at `*/5 13-21 * * 1-5`

### Phase 2 — frontend (4 files)

1. New file `src/hooks/useSilentBoomFeed.ts`
2. New file `src/components/SilentBoom/types.ts`
3. New file `src/components/SilentBoom/SilentBoomSection.tsx`
4. `src/App.tsx` — wire below LotteryFinderSection

Commit between phases. Each phase verified with `npm run review` before commit.

## Acceptance criteria

- [ ] Detector parity tests pass (TS ↔ Python audit script behavior matches on canonical cases)
- [ ] Cron runs cleanly in dev (no Sentry errors)
- [ ] Endpoint returns paginated feed; default filter to SPY/QQQ/IWM/SPXW returns ≤100 rows/day
- [ ] Dashboard panel renders alerts with expand/collapse + tape chart, mirrors LotteryFinder UX
- [ ] No regressions to `lottery_finder_fires` (separate table, separate detector, no shared logic)

## Open questions / deferred

- **Forward-going coverage**: cron will pick up fires only on tickers `ws_option_trades` covers. Currently the WS daemon subscribes to LOTTERY_V3 ∪ LOTTERY_EXTENDED ∪ {SPXW}. If/when expansion needed, route via uw-stream config update + Railway redeploy (same workflow as the recent universe expansion).
- **Backfill from parquet**: not in this spec. Could add `scripts/backfill_silent_boom_from_parquet.py` later if user wants historical fires populated.
- **Score / tier system**: deferred. silent-boom is a binary alert (fired or not), not a graded score like lottery_finder. The realized-return distribution makes a tier system unhelpful.
- **Exit policy enrichment**: not in v1. The audit showed ~0% mean realized return at fixed horizons, so adding flow_inv-style exits is a separate research project. v1 surfaces the alert; user manages exit manually.

## Risks

- **TS↔Python detector drift**: mitigated by parity tests on canonical fixtures (mirror what we did for `lottery_detector_py.py`).
- **Cron noise**: at default parameters, ~735 fires/day across all tickers. Default dashboard filter (indexes only, vol_oi ≥0.5) trims to ~50-100/day. If still too noisy, tighten parameters (raise SPIKE_MULTIPLIER or VOL_OI_MIN).
- **DB write volume**: ~735 INSERTs/day at `ON CONFLICT DO NOTHING` is trivial.
