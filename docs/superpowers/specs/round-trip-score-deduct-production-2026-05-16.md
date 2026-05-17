---
status: Likely Shipped
date: 2026-05-16
---

# Round-Trip Score Deduct — Production Spec (2026-05-16)

## Goal

Wire the `post_fire_net_pct_of_volume` signal validated in Phase 1 into the live Lottery + Silent Boom scoring path as a **score deduct**, not a binary suppressor. Surfacing as a score component preserves audit trail, keeps low-confidence alerts visible behind filter chips, and lets future tuning happen on numeric weights rather than thresholds.

**Phase 1 result reference:** [docs/tmp/round-trip-suppression-cohort-results-2026-05-15.md](../../tmp/round-trip-suppression-cohort-results-2026-05-15.md)

## Why score-deduct (not suppression)

Phase 1 EDA against 641,638 enriched alerts × 92 days of fulltape showed:

- **AUC = 0.59** for `post_fire_net_pct_of_volume` across all 3 cohorts (A/B/C). Real signal, but moderate.
- No clean binary cutoff: to get +5pp lift you must suppress 60%+ of alerts; clean-noise cutoffs (≤30% suppressed-win-rate) only affect 5–8% of alerts.
- Uniform AUC across cohorts (0.590 / 0.592 / 0.593) — per `feedback_uniform_lift_is_leakage.md` this is _suspicious_, so binary suppression on a signal we can't fully explain is too aggressive.
- **Survivor win rates improve monotonically with threshold**, but at a slope consistent with a _score component_ rather than an _exclusion gate_.

## Decisions

1. **Stepped deduct, not binary.** Three brackets matching the Phase 1 sweep cliffs: `-1` / `-2` / `-3`.
2. **Compute post-fire only.** The feature is forward-looking — the cron evaluates alerts 60 min after fire, then the deduct is frozen.
3. **Lottery + Silent Boom both.** Same feature, same brackets, different score-weight registries.
4. **Frozen at write time.** Once the cron computes the deduct, it's stored on the alert row. Re-evaluation doesn't happen (no resurrection mechanic).
5. **Filter chip in UI**, not hard-hide. User can toggle "show round-tripped" on the dashboard, defaults OFF.
6. **DTE ≤ 7 only.** Per the per-DTE AUC slice (2026-05-16), signal is meaningful only for 0–7 DTE; collapses to ~random (AUC 0.49–0.53) for DTE ≥ 8. Cron skips alerts with `dte > 7`. ~99.6% of historical alerts qualify; the long-DTE tail is excluded as a deliberate design choice.

## Score Bracket

Based on Phase 1 Cohort A threshold sweep, sized to demote the noisy tail without gutting the panel:

| `post_fire_net_pct_of_volume` |        Deduct | % alerts hit (Cohort A) | Suppressed-win-rate Phase 1 |
| ----------------------------- | ------------: | ----------------------: | --------------------------: |
| `< -0.50`                     |        **−3** |                    5.4% |       18.9% (clearly noise) |
| `[-0.50, -0.30)`              |        **−2** |                    7.1% |                        ≈22% |
| `[-0.30, -0.10)`              |        **−1** |                   17.4% |                        ≈25% |
| `≥ -0.10`                     | 0 (no deduct) |                   70.1% |                    baseline |

Total impact: ~30% of alerts get some deduct; only 5% get the maximum.

## Files to Create / Modify

### Migration (new — `db-migrations.ts`)

```sql
-- lottery_finder_fires
ALTER TABLE lottery_finder_fires
  ADD COLUMN IF NOT EXISTS round_trip_net_pct NUMERIC,
  ADD COLUMN IF NOT EXISTS round_trip_score_deduct SMALLINT DEFAULT 0;
CREATE INDEX IF NOT EXISTS lottery_finder_fires_rt_score_idx
  ON lottery_finder_fires (round_trip_score_deduct)
  WHERE round_trip_score_deduct < 0;

-- silent_boom_alerts (same shape)
ALTER TABLE silent_boom_alerts ...
```

### Cron handler (new — `api/cron/evaluate-round-trip.ts`)

- Runs every 10 min during market hours (14:00–21:00 UTC, weekdays)
- Selects alerts fired 60–75 min ago with `round_trip_net_pct IS NULL`
- For each, pulls `ws_option_trades` for that contract since `trigger_time_ct` / `bucket_ct`
- Computes `net_pct` using same per-print `tags` parse as Phase 1 features.py
- UPDATE alerts with `round_trip_net_pct` + `round_trip_score_deduct`

### Score integration (`api/_lib/lottery-score-weights.ts`)

Add `round_trip_score_deduct` to the score sum at read time. Negative values reduce the displayed score; tier-tier3 cutoffs stay unchanged so a strong tier1 with a `-1` deduct stays tier1.

### Silent Boom score (`api/_lib/silent-boom-score.ts`)

Mirror change. Existing `score_tier` re-derived from final score.

### Frontend filter chip (`src/components/LotteryFinder/` + `src/components/SilentBoom/`)

New chip: **"Hide round-tripped"** (toggle, default OFF). Filters rows where `round_trip_score_deduct < 0` when ON.

### Backfill (one-shot — `scripts/backfill_round_trip_score.py`)

Read `ml/experiments/round-trip-suppression-eda/alert_features.parquet`, JOIN by `alert_id`, UPDATE Postgres with computed `round_trip_net_pct` + `round_trip_score_deduct`. Idempotent.

## Phases

### Phase 2A — Schema + backfill

- [ ] Write migration with both `ALTER TABLE` statements + partial index → Verify: `npm run test:run -- db.test` passes with updated mock count
- [ ] Run migration on prod via psql (per `feedback_owner_secret_empty_in_prod.md`)
- [ ] Run backfill script against existing alert_features.parquet → Verify: SELECT shows ~30% of rows with non-zero deduct

### Phase 2B — Cron handler

- [ ] Build `evaluate-round-trip.ts` cron + test (mock ws_option_trades sequence) → Verify: `npm run test:run -- evaluate-round-trip` passes
- [ ] Register cron in `vercel.json` (10-min cadence, market hours)
- [ ] Add path to `src/main.tsx` botid protect list

### Phase 2C — Score integration

- [ ] Wire `round_trip_score_deduct` into `lottery-score-weights.ts` sum + test
- [ ] Mirror in `silent-boom-score.ts` + test → Verify: tier downgrade fires correctly on `-3` deduct

### Phase 2D — UI filter chip

- [ ] Add chip to LotteryFinder + SilentBoom sections (Aggressive Premium pattern)
- [ ] Default OFF → Verify: visual smoke + Playwright a11y

### Phase 2E — Soak + measurement

- [ ] After 1 week live, query: of alerts marked deduct ≥ −1, what fraction had `realized_eod_pct < -20`? Compare to baseline.
- [ ] Write `docs/tmp/round-trip-deduct-soak-{date}.md` with the result
- [ ] **Decision gate:** if surviving alerts ≥1pp loss-rate improvement vs baseline → KEEP. Else REVERT (drop the deduct, leave columns for further analysis).

## Open Questions

1. **Window length.** Phase 1 used fixed 60-min look-forward. Worth re-running with 30/90/120 to find the cleanest discriminator before locking the cron schedule.

## Resolved Questions (during 2026-05-16 sanity check)

- **Per-ticker variation** — All top-15 tickers show AUC in [0.563, 0.650] (median 0.590). Signal is broadly distributed, not concentrated. TSLA outlier (0.650) is plausible — highest informed-flow density in the universe. **Greenlight.**
- **0DTE vs longer-DTE** — Per-DTE AUC: 0DTE 0.597 (286K alerts) / 1-2DTE 0.588 (247K) / 3-7DTE 0.563 (81K) / 8-30DTE 0.528 (2K) / >30DTE 0.490 (1K). Signal collapses to random above 7 DTE. **Restricted to DTE ≤ 7.**

## Notes

- **Don't ship Phase 2B-D without Phase 2A backfill validating sample sizes.** If the backfill shows <10% or >50% getting deducted, thresholds are mis-tuned.
- The cron-after-fire latency means freshly-fired alerts always show `deduct = 0` for the first hour. Acceptable — the panel just gradually demotes stale noise.
- This is a **reversible** change at every step. Migration ALTERs are additive. UI chip defaults OFF. Score sum reduces to existing behavior if `round_trip_score_deduct = 0`.

---

**Pre-build sanity check question for you:**

The uniform-AUC-across-cohorts finding from Phase 1 still nags at me. Before kicking off Phase 2A, should we spend ~30 min doing a per-ticker AUC slice on the existing parquet? If NVDA/TSLA/SPXW each independently show 0.58–0.61 AUC, the signal is real. If only one ticker carries it, we're chasing leakage. Cheap insurance before a migration.
