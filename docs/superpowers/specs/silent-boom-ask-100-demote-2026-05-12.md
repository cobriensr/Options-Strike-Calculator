# Silent Boom — multi-leg drop + ask=100% tier3 demotion + 5-band UI filter

**Date:** 2026-05-12
**Trigger:** Two stacked empirical findings on `silent_boom_alerts`:

1. `ask_pct = 1.0` exact is a sharp performance cliff: median peak +4.51%, win > 0% = 77.0% (vs ≥99% in every other band). The cliff replicates inside every tier (`tier1`: 81.4%, `tier2`: 71.3%, `tier3`: 77.7%). ρ_spearman(ask_pct, peak) = −0.270 across the full sample.

2. Multi-leg attribution (per UW OPRA `trade_code`: `mlat`/`mlet`/`mlft`/`mfto`/`masl`/`mesl`/`mfsl`/`mlct`) is over-represented in the ask=100% band (33% of fires there are ≥90% multi-leg by size) AND is a **separate, orthogonal** performance drag in every band: 95-99% control band shows multi-leg fires win > 100% at 3.8% vs 11.7% for single-leg.

Trader's goal is directional high-probability flow only. Multi-leg fires (spread legs, hedges) carry no directional thesis even when their leg prints aggressively at the ask.

## Goal

1. **Drop multi-leg-dominated fires at the detector level** so they never enter `silent_boom_alerts`. Threshold: bucket's multi-leg size share ≥ 50% → reject.
2. **Force `ask_pct = 1.0` fires to `score_tier = tier3`** for the single-leg cliff that remains after the multi-leg drop.
3. **Add a 5-band ask% chip filter to the SilentBoom UI toolbar** (70-80 / 80-90 / 90-95 / 95-99 / 100%) so the user can slice the feed analytically.

## Empirical basis

### Ask% cliff (full 15,013-fire sample)

| ask % band |         n | median peak |  win > 0% | win > 100% |
| ---------- | --------: | ----------: | --------: | ---------: |
| 70-80%     |     1,245 |     +16.52% |     99.0% |      12.6% |
| 80-90%     |     1,535 |     +14.03% |     99.0% |      10.3% |
| 90-95%     |     1,271 |     +13.83% |     99.1% |       9.3% |
| 95-99%     |     5,839 |     +12.51% |     98.9% |       7.2% |
| **100%**   | **5,123** |  **+4.51%** | **77.0%** |   **4.3%** |

### Multi-leg attribution (2,316-fire May 4-12 overlap window)

Inside the ask=100% cohort (n=545 with tape coverage):

| ML share |   n | median peak | win > 0% | win > 100% |
| -------- | --: | ----------: | -------: | ---------: |
| <10%     | 353 |      +7.24% |    78.2% |       7.4% |
| ≥90%     | 181 |      +4.88% |    87.3% |       2.8% |

Both subsets are below normal-band performance — confirming the cliff is real for single-leg fires too, AND multi-leg is independently worse.

Control band 95-99% (n=944):

| ML share |   n | median peak | win > 100% |
| -------- | --: | ----------: | ---------: |
| <10%     | 684 |     +18.07% |  **11.7%** |
| ≥90%     | 236 |      +6.53% |   **3.8%** |

Same multi-leg drag, completely independent of the ask=100% cliff.

## Decisions (locked from 2026-05-12 conversation)

- **Multi-leg drop predicate:** `multi_leg_share >= 0.50`. The size distribution is bimodal (most fires at ~0% or ~100% ML), so 50% is a clean separator. Drops ~33% of ask=100% fires + ~25% of 95-99% fires.
- **Multi-leg codes:** `('mlat', 'mlet', 'mlft', 'mfto', 'masl', 'mesl', 'mfsl', 'mlct')`.
- **Drop layer:** detector (`api/_lib/silent-boom.ts`). Rejected fires never enter `silent_boom_alerts`.
- **Schema:** add nullable `multi_leg_share NUMERIC` column to `silent_boom_alerts`. Surviving fires carry their attribution for tooltip display + future analysis.
- **Ask=1.0 demotion:** `ASK_PCT_SATURATED_PENALTY = -30` in `silent-boom-score.ts`. Max positive score = +33; with −30 saturation, ceiling is +3, well below tier2 threshold of 8.
- **Ask=1.0 predicate:** `ask_pct >= 1.0` exact (the [0.9999, 1.0) band performs normally — no fuzz).
- **Backfill scope:** full backfill via parquet for `multi_leg_share` on existing rows where parquet data is available + recompute scores for all rows under the new ASK rule.
- **UI:** 5-band server-side chip filter (mirrors tod/dte/burst pattern). No "hide 100%" toggle (redundant with the new ask=1.0 → tier3 default behavior).

## Phases

### Phase 1 — Detector + migration + cron (5 files)

- `api/_lib/db-migrations.ts` — new migration adding `multi_leg_share NUMERIC` column to `silent_boom_alerts`.
- `api/__tests__/db.test.ts` — mock update for new migration.
- `api/_lib/silent-boom.ts`:
  - Add `multiLegSize: number` to `ChainBucket` interface.
  - Add `multiLegShareMax: 0.5` to `SILENT_BOOM_SPEC_V1` config.
  - In `detectSilentBoomFires`, compute `ml_share = bucket.multiLegSize / bucket.size` and reject the bucket as a spike if `ml_share >= multiLegShareMax`.
  - Expose `multiLegShare` on `SilentBoomFire` output.
- `api/cron/detect-silent-boom.ts`:
  - When aggregating `ws_option_trades` into `ChainBucket`, accumulate `multiLegSize` (sum of size where `trade_code IN multi-leg codes`).
  - Pass `multiLegShare` through to the INSERT.
- `api/__tests__/silent-boom.test.ts` — detector tests for multi-leg rejection.

### Phase 2 — Score + cron test + score test (3 files)

- `api/_lib/silent-boom-score.ts` — split `ASK_PCT_CAP_PENALTY` into `ASK_PCT_HIGH_PENALTY = -1` (0.95 ≤ ask < 1.0) and `ASK_PCT_SATURATED_PENALTY = -30` (ask = 1.0).
- `api/__tests__/silent-boom-score.test.ts` — new cases for ask=1.0 tier3 force.
- `api/__tests__/detect-silent-boom.test.ts` — cron test update for new aggregation.

### Phase 3 — Backfill (2 scripts)

- `scripts/backfill_silent_boom_multileg.py` — pulls per-day parquet for fires where `multi_leg_share IS NULL`, computes from `trade_code`, batched UPDATE in 500-row chunks. Idempotent.
- `scripts/backfill_silent_boom_ask_demote.py` — recomputes `score` + `score_tier` for ALL existing rows using the new ASK_PCT logic.

### Phase 4 — API filter (3 files)

- `api/silent-boom-feed.ts` — accept `askPctBand` query param: `'70-80' | '80-90' | '90-95' | '95-99' | '100'`. Maps to SQL WHERE.
- `api/_lib/validation/lottery.ts` — Zod schema add.
- `api/__tests__/silent-boom-feed.test.ts` — coverage.

### Phase 5 — UI chips (3 files)

- `src/hooks/useSilentBoomFeed.ts` — thread `askPctBand` to query string.
- `src/components/SilentBoom/SilentBoomSection.tsx` — 5-chip band selector + localStorage key. Reset page on change.
- `src/__tests__/SilentBoomSection.test.tsx` — interaction test.

## Constants

- Multi-leg codes: `('mlat', 'mlet', 'mlft', 'mfto', 'masl', 'mesl', 'mfsl', 'mlct')`
- Multi-leg drop threshold: `0.50` (size share)
- ASK saturation threshold: `1.0` (exact)
- ASK saturation penalty: `−30`
- Bands: `70-80` (0.70-0.80), `80-90` (0.80-0.90), `90-95` (0.90-0.95), `95-99` (0.95-1.0), `100` (=1.0)
- localStorage key: `silentBoom.askPctBand`

## Verification

- `npm run review` clean after each phase.
- Phase 1: detector unit test confirms a bucket with ≥50% multi_leg_size is not promoted to a fire.
- Phase 2: score test confirms `computeSilentBoomScore({...perfect, askPct: 1.0})` produces score < 8.
- Phase 3: post-backfill, `SELECT COUNT(*) FROM silent_boom_alerts WHERE ask_pct = 1.0 AND score_tier != 'tier3'` returns 0; `SELECT COUNT(*) WHERE multi_leg_share IS NULL` shows what's left uncovered.
- Phase 5: manual UI — select 100% band → list populates; default Tier1+ view no longer shows ask=1.0 fires.
