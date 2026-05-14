# Silent Boom: OTM Market Tide gate + Trail-30/10 enrichment — 2026-05-13

## Goal

Two related fixes for the silent_boom_alerts pipeline so we can ship a directional gate and a peak-trail exit policy backed by real data, both for silent boom and (where applicable) lottery finder.

## Why now

Today's review (2026-05-13) showed tier1 silent boom fires averaging peak +297% but EOD **-40.8%** — entry signal is fine, hold-to-EOD is wrong. Backed by 15,095 historical fires the proposed fixes test cleanly:

- Direction gate at T=100 (all-in mkt_tide_diff): demotes 34% of fires, +39pp lift on tier1
- Trail-30/10: tier1 -30% EOD → +147% (lower-bound estimate); validated across up/flat/down regimes
- Today's 17 SPY puts all fired with mkt_tide_diff between 129M and 400M (strongly bullish) — gate would have caught every one

The all-in variant works, but Periscope notes (and the lottery + tape-confirmation modules) prefer the OTM variant for direction reads. We can't compare today because `mkt_tide_otm_diff` is null on every row even though the source data lives in `flow_data` already.

## Phases

### Phase 1 — OTM Tide column + population (1 day)

`silent_boom_alerts` does NOT currently have a `mkt_tide_otm_diff` column at all — add it via migration, then wire the detector to write it, then backfill historical rows.

Lottery already has the column but is only populated 2026-05-04+ for the all-in `mkt_tide_diff` and 0% for OTM — same fix applies (write going forward + backfill).

**Data confirmed via psql**:

- `flow_data` source='market_tide_otm' exists with OTM data in the regular `ncp`/`npp` columns (NOT in `otm_ncp`/`otm_npp` — those are vestigial). 5,277 rows back to 2026-02-09 → backfill is feasible for every existing fire.
- Lottery's April fires have NULL `mkt_tide_diff` because the detector wasn't writing the field, not because flow_data was missing.

**Files**:

- `api/_lib/db-migrations.ts` — new numbered migration: `ALTER TABLE silent_boom_alerts ADD COLUMN mkt_tide_otm_diff NUMERIC;`
- `api/__tests__/db.test.ts` — add migration id + expected mock sequence
- `api/cron/detect-silent-boom.ts` — fetch `source='market_tide_otm'` flow rows alongside the existing `market_tide` fetch, mirror the binary-search `lookupAt()` pattern, store on insert
- `api/cron/detect-lottery-fires.ts` — confirm the INSERT path actually writes `mkt_tide_otm_diff` (it queries it at line 492; verify it ends up on the inserted row). Patch if missing.
- `scripts/backfill_otm_tide_on_alerts.py` — new script. For each existing `silent_boom_alerts` and `lottery_finder_fires` row missing one or both fields, look up the latest `flow_data` row of each source at or before `bucket_ct`, compute `ncp - npp`, write. Idempotent (skip if already populated). Per [feedback_batched_inserts.md](../../.claude/projects/-Users-charlesobrien-Documents-Workspace-strike-calculator/memory/feedback_batched_inserts.md) → batch UPDATEs at 500/query.

**Verification**:

- `SELECT date, COUNT(*) FILTER (WHERE mkt_tide_otm_diff IS NOT NULL) AS with_otm FROM silent_boom_alerts GROUP BY date ORDER BY date;` — should hit ~100% on every date
- Same query on `lottery_finder_fires` for both `mkt_tide_diff` and `mkt_tide_otm_diff`
- Sample-check 3 fires manually: confirm the backfilled value matches a hand-computed point-in-time lookup against `flow_data`
- Re-run the direction gate analysis from this session against the OTM variant. Compare optimal T and lift vs all-in. Pick the better signal per detector → feeds Phase 4.

### Phase 2 — Trail-30/10 column + enrichment (1 day)

Add `realized_trail30_10_pct` to `silent_boom_alerts`, adapt the existing Python enrichment script to compute it, run one-time backfill on 15,094 historical fires.

**Files**:

- `api/_lib/db-migrations.ts` — new numbered migration: `ALTER TABLE silent_boom_alerts ADD COLUMN realized_trail30_10_pct NUMERIC;`
- `api/__tests__/db.test.ts` — add migration id + expected mock sequence (per CLAUDE.md migration pattern)
- `scripts/enrich_silent_boom_outcomes.py` — import `realized_trail_act30_trail10` from `ml/src/lottery_exit_policies.py`, compute per-fire, include in `execute_values()` UPDATE

**Verification**:

- `SELECT date, COUNT(*) FILTER (WHERE realized_trail30_10_pct IS NOT NULL) FROM silent_boom_alerts GROUP BY date ORDER BY date;` — should hit 99%+ for all enriched dates
- Sample-check 5 rows manually against the ws_option_trades tape to confirm trail math
- Compare avg `realized_trail30_10_pct` vs `realized_eod_pct` by tier — expect the lift table from today's bounded estimate to hold within ±20% (real fills are noisier than the upper-bound model)

### Phase 3 — Nightly enrichment cron (½ day)

Currently no silent boom enrichment cron exists — `scripts/enrich_silent_boom_outcomes.py` is run manually. Add a TS cron that mirrors `api/cron/enrich-lottery-outcomes.ts`.

**Confirmed**: `api/cron/enrich-lottery-outcomes.ts` is a clean TS port that imports trail/hard-stop/tier-50/peak/min-to-peak functions from `api/_lib/lottery-exit-policies.ts`. New silent-boom cron is a near-copy of this file with three changes: table name (`lottery_finder_fires` → `silent_boom_alerts`), column list (drop hard30m / tier50_holdeod / flow_inversion — silent boom only needs trail-30/10, eod, peak, min-to-peak), and the entry-time field name (`entry_time_ct` → `bucket_ct`, since silent boom uses bucket_ct as entry).

**Files**:

- `api/cron/enrich-silent-boom-outcomes.ts` — new cron handler. Copy `enrich-lottery-outcomes.ts` and trim. Import only `realizedTrailAct30Trail10`, `peakCeiling`, `minutesToPeak` from `lottery-exit-policies.ts`. No flow-inversion code.
- `vercel.json` — add cron entry. Schedule: align with the existing lottery cron at **21:30 UTC Mon-Fri** (30 min after market close) so both detectors enrich on the same cadence: `30 21 * * 1-5`.
- Test file: `api/__tests__/enrich-silent-boom-outcomes.test.ts` — mirror the existing enrich-lottery test pattern with mocked `getDb` (per CLAUDE.md cron test pattern)

**Verification**:

- Trigger the cron locally with `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/enrich-silent-boom-outcomes` — confirm it enriches the day's fires
- Compare 5 sample rows enriched by the new TS cron vs the existing Python script — values should match within floating-point precision
- `npm run review` passes (tsc + eslint + prettier + vitest)
- Watch first scheduled run in Sentry / Vercel logs

### Phase 4 — Re-run direction gate analysis with OTM (½ day)

After Phase 1 backfill completes, re-run the historical analysis from this session against `mkt_tide_otm_diff`. Decide final gate thresholds for each detector and document them. **Do not ship the gate code yet** — that's a separate spec following this one.

## Data dependencies

- `flow_data` table: source='market_tide_otm' rows (already populated by `fetch-flow.ts`)
- `ws_option_trades`: tick-level option price data (used by enrichment script, already in production)
- `silent_boom_alerts` table: 15,095 historical fires Apr 13 → May 13
- `lottery_finder_fires` table: 96,781 total, 29,717 with mkt_tide_diff (mkt_tide_otm_diff at 0%)

## Open questions — RESOLVED 2026-05-13

1. ~~**Lottery enrichment cron architecture**~~ → **TS port**, imports from `api/_lib/lottery-exit-policies.ts`. Phase 3 cron is a near-copy of `enrich-lottery-outcomes.ts`.
2. ~~**Lottery's 30.7% mkt_tide_diff coverage**~~ → it's a contiguous date range: all dates 2026-04-13 → 2026-05-01 have 0% coverage (detector wasn't writing the field), 2026-05-04+ has 70%–100%. flow_data has both sources back to 2026-02-09 so full backfill is feasible. **silent_boom_alerts has 100% all-in coverage but is missing the `mkt_tide_otm_diff` column entirely** — Phase 1 adds it.
3. **Trail-30/10 slippage caveat**: the bounded estimate assumes 1-tick fill at peak − 10pp. Real fills lag the peak by 1-5 min on illiquid OTM options. After backfill we should run a 25% / 50% giveback variant alongside to quote a realistic range. **Default decision**: ship the 10pp variant first (matches lottery's existing column), add giveback variants later if needed.

## Thresholds / constants

- Direction gate (deferred to a follow-up spec, but Phase 1 unblocks it):
  - Silent boom proposed T = 100M (all-in); re-validate with OTM in Phase 4
  - Lottery proposed T = 150M (all-in); re-validate with OTM
- Trail-30/10 activation: peak ≥ +30% (matches lottery)
- Trail-30/10 giveback: 10pp from running peak (matches lottery)

## Out of scope

- Round-trip cooldown (META 620C re-fire pattern) — separate small spec
- Frontend changes to display trail-30/10 in the silent boom UI — follow-up spec after data lands
- Wiring the direction gate into the detector tier logic — follow-up spec after Phase 4 validates OTM
