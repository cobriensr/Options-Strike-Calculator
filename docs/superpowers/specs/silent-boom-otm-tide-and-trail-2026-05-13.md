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

**Prod deploy ordering** (OWNER_SECRET is empty in prod per [feedback_owner_secret_empty_in_prod](../../.claude/projects/-Users-charlesobrien-Documents-Workspace-strike-calculator/memory/feedback_owner_secret_empty_in_prod.md) — migrations require direct psql):

1. Apply migration #149 in prod via psql FIRST (`ALTER TABLE silent_boom_alerts ADD COLUMN IF NOT EXISTS mkt_tide_otm_diff NUMERIC;` + `INSERT INTO schema_migrations (id, description, applied_at) VALUES (149, '...', NOW()) ON CONFLICT (id) DO NOTHING;`)
2. THEN merge / deploy the detector patch. If the order is reversed, the next `detect-silent-boom` cron run will fail on `column "mkt_tide_otm_diff" does not exist`.
3. Run `scripts/backfill_otm_tide_on_alerts.py` against prod after the migration to fill historical rows.

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

#### Phase 2 RESULTS — 2026-05-13 backfill complete

Backfill ran in 17.7s across 15,013 historical fires. Real per-tier outcomes (vs the bounded-estimate projections from earlier in this session):

| Tier | n | EOD avg | Trail avg (REAL) | Trail avg (bounded est, LB) | Trail win-rate (≥+30%) | Trail loss-rate (≤-30%) | EOD loss-rate |
| ---- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tier1 | 766 | -30.5% | **-5.5%** | +147.5% | 18% | **30%** | **78%** |
| tier2 | 2,355 | -5.3% | -1.1% | +44.6% | 17% | 24% | 40% |
| tier3 | 11,973 | -1.4% | -1.3% | +6.9% | 7% | 9% | 11% |

**Reality vs the bounded estimate**: trail-30/10 trails on the RUNNING peak, exits on the first 10pp giveback, and misses subsequent runs. Hand-checked example: SPY 746C 2026-05-13 peaked at 342% and finished EOD +147%, but trail-30/10 exited at +29% because price hit an earlier intermediate peak, gave back 10pp, and tripped the stop before the bigger move. The bounded estimate's "exit at peak − 10pp" model assumed there is ONE peak; reality has many.

**Net effect on the tier1 catastrophe**:

- Loss rate (≤-30%) drops from 78% → 30% — a real 48pp reduction in tail risk
- Win rate (≥+30%) rises from 12% → 18% — modest
- Average return lifts from -30.5% → -5.5% — a meaningful +25pp swing per fire on the highest-conviction tier

trail-30/10 is **defensive, not offensive**: it cuts catastrophic round-trips far more than it captures runners. That fits the entry signal — tier1 fires DO peak hard (avg peak +180%) but round-trip catastrophically; the trail stops the bleed without claiming the absolute max.

**Recommended use** for the follow-up display/decision spec:

- Surface trail-30/10 as the **default displayed exit policy** for tier1 + tier2 (where the lift is meaningful)
- Tier3 trail vs EOD is statistically indistinguishable (-1.3% vs -1.4%); display either
- Add a 25%/50% giveback variant later if the 10pp model proves too sensitive to intermediate peaks

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

### Phase 4 — Re-run direction gate analysis with OTM — RESULTS 2026-05-13

Coverage achieved post-backfill:

- `silent_boom_alerts`: 100.0% (15,095/15,095) on both fields
- `lottery_finder_fires`: 99.8% (96,563/96,781) — 218 pre-flow_data rows on 2026-04-14 acceptable

**OTM vs all-in head-to-head at optimal thresholds**:

| Detector    | Variant | T        | Demoted n        | Demoted avg EOD | Kept avg EOD | Verdict                                        |
| ----------- | ------- | -------- | ---------------- | --------------- | ------------ | ---------------------------------------------- |
| silent_boom | all-in  | 100M     | 5,166 (34%)      | **-4.84%**      | -2.73%       | Surgical demote                                |
| silent_boom | OTM     | 100M     | 3,977 (26%)      | -1.74%          | -4.06%       | Demote bucket cleaner but kept set worse       |
| lottery     | all-in  | 150M     | 21,621 (22%)     | -2.69%          | -1.88%       | Modest signal                                  |
| lottery     | **OTM** | **150M** | **15,016 (16%)** | **+6.71%**      | **-3.63%**   | **Decisive — 24.75pp spread vs trend-aligned** |

**Tier1 silent boom deep-dive** (n=766): both variants fail to cleanly demote tier1 losers — counter-trend loss-rate is 79.6% (OTM) vs 82.2% (all-in), statistically indistinguishable. Tier1 may need a different policy (e.g. trail-30/10 from Phase 2) rather than a directional gate.

**Today's tier1 side-by-side**: OTM was bearish (-26M to -111M) early-session when all-in was bullish (+92M to +162M); SPY 746C +147% and AMZN 270C +117% wins both landed in buckets where OTM disagreed with all-in. OTM was over-bearish today.

**Final recommendations for the follow-up gate-implementation spec**:

- **silent_boom**: gate on `mkt_tide_diff` (all-in) at T = ±100M
- **lottery_finder_fires**: gate on `mkt_tide_otm_diff` (OTM) at T = ±150M

The detectors should diverge on which variant feeds the gate. Periscope's claim that OTM filters dealer-hedging noise validates for lottery (longer-horizon, multi-day positioning) but NOT for silent boom (5-min spike anomalies) — the all-in variant is more decisive on short-window setups where dealer flow IS the signal, not noise.

**Out of scope for this spec**: actual gate implementation (demote vs hard-block; tier3 demotion vs skip-insert). A follow-up spec will design that based on these thresholds.

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
