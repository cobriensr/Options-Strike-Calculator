# Precision-Stack Overlay for Gamma Squeeze Detector — 2026-04-30

## Goal

Layer two precision-discriminating filters (cross-strike HHI + morning IV-vol correlation) on top of the existing `gamma_squeeze_events` table to lift precision from ~17% (base rate) to ~45% (2.6× lift) at ~17% recall, on the in-sample 12-day backtest. Apply to historical events for retrospective analysis and wire into live cron so future events are auto-tagged with the precision flag.

## Background

The 2026-04-30 evening EDA session (per-trade parquet conversion + multi-feature analysis) produced the following clean (non-leaky) result on 757 0DTE Index/ETF strike-days, 12 days, 129 winners (+100% opt_ret = "winner"):

| Filter                           | n   | Winners | Precision | Recall    | Lift      |
| -------------------------------- | --- | ------- | --------- | --------- | --------- |
| V≥5× alone (current detector)    | 371 | 65      | 17.5%     | 50.4%     | 1.03×     |
| + low HHI ≤ p30                  | 133 | 47      | **35.3%** | **36.4%** | **2.07×** |
| + high iv_morning_vol_corr ≥ p80 | 41  | 20      | **48.8%** | **15.5%** | **2.86×** |

Both new filters beat the base rate at p < 10⁻⁶. IV-vol-corr must be **morning-only** (≤11:00 CT) — full-day version was confirmed leaky (winning strikes' IV blows up at expiry from intrinsic-value approach, contaminating the signal).

## Definitions

- **HHI (cross-strike Herfindahl)**: `Σ (strike_premium / band_premium)²` across all 0DTE strikes within ±0.5% of spot, same ticker + side. Lower = diffuse band (winner). Higher = concentrated whale (loser).
- **iv_morning_vol_corr**: Pearson correlation of per-minute (Δ implied_volatility, Δ cumulative_volume) for the strike, restricted to executed_at ≤ 11:00 CT. Higher = real demand bidding IV up (winner). Computed only when ≥5 minutes of data and both deltas have non-zero std.
- **precision_stack_pass**: boolean. True iff `(velocity gate fired) AND (HHI ≤ p30 of universe-day) AND (iv_morning_vol_corr ≥ p80 of universe-day)`. Per-day percentiles to neutralize regime confound.

## Phases

### Phase 1 — Backfill + DB enrichment (3 files)

Goal: every existing `gamma_squeeze_events` row gets the new fields populated; user can pull a per-day report to use Friday morning.

- `api/_lib/db-migrations.ts` — migration N+1: `ALTER TABLE gamma_squeeze_events` add `hhi_neighborhood NUMERIC`, `iv_morning_vol_corr NUMERIC`, `precision_stack_pass BOOLEAN`. No backfill in migration; backfill happens via script.
- `api/__tests__/db.test.ts` — bump migration count, applied-list, expected output count.
- `scripts/backfill-precision-stack.py` — reads `gamma_squeeze_events`, queries `strike_iv_snapshots` per event, computes HHI + iv_morning_vol_corr, computes per-day percentiles, sets `precision_stack_pass`. Outputs CSV report at `docs/tmp/precision-stack-backfill-<date>.csv` plus per-day summary printed to stdout.

Verify: `npm run review` passes; backfill script runs end-to-end against current DB; CSV report has expected row count (= total events).

### Phase 2 — Live cron computes features at fire time (5 files)

Goal: events fired tomorrow auto-populate `hhi_neighborhood`, `iv_morning_vol_corr`, and `precision_stack_pass`. Same logic as backfill but runs once per detector tick.

- `api/_lib/gamma-squeeze.ts` — extend `SqueezeFlag` interface with the three new fields. Detector itself doesn't compute them (separation of concerns: detector = velocity/proximity/trend; precision stack = post-detection enrichment).
- `api/_lib/precision-stack.ts` — NEW pure module. Two exports: `computeHhi(strikesInBand)` and `computeIvMorningVolCorr(perMinuteSamples, ctCutoffHour)`. Pure: caller provides data, module returns numbers. Same formulas the backfill uses.
- `api/cron/fetch-strike-iv.ts` — after `detectGammaSqueezes()` returns flags, for each flag query the same `strike_iv_snapshots` window (already in scope) for neighborhood + morning IV trajectory, call the precision-stack functions, stamp the flag, then `INSERT` with the new columns.
- `api/__tests__/precision-stack.test.ts` — unit tests for both pure functions. Edge cases: empty band, single-strike band, missing IV samples.
- `api/__tests__/cron-fetch-strike-iv.test.ts` — extend the existing happy-path test to assert the new columns are populated.

Verify: `npm run review`; live cron writes a complete row.

### Phase 3 — Read API + frontend filter (3 files)

Goal: user can hit `/api/gamma-squeezes?strict=1` to get only precision-stack-pass events; frontend gets a "★ precision pass" badge.

- `api/_lib/validation.ts` — extend the existing query schema with `strict: z.coerce.boolean().optional().default(false)`.
- `api/gamma-squeezes.ts` — when `strict` is true, filter `WHERE precision_stack_pass = true`. Return new fields in the row payload.
- `src/components/GammaSqueezes/GammaSqueezeRow.tsx` — render the precision-pass badge when set.
- Tests for endpoint + component.

Verify: `npm run review`; manual curl with and without `?strict=1`.

## Data dependencies

- **gamma_squeeze_events** (existing) — 186 rows as of 2026-04-30T20:30 CT, growing ~60/day during market hours.
- **strike_iv_snapshots** (existing) — minute-level snapshots for 17 watchlist tickers, sufficient density for both HHI (cross-strike at fire time) and IV-vol-corr (per-minute IV trajectory through 11 AM CT).
- No new external API calls. Pure derivation from existing tables.

## Thresholds / constants (Phase 1 + 2)

Defined in `api/_lib/precision-stack.ts`:

```ts
export const PROXIMITY_BAND_PCT = 0.005; // ±0.5% of spot for HHI band
export const IV_MORNING_CUTOFF_HOUR_CT = 11; // ≤ 11:00 CT
export const HHI_PASS_PERCENTILE = 0.3; // strike must be in bottom 30% of universe-day HHI
export const IV_VOL_CORR_PASS_PERCENTILE = 0.8; // strike must be in top 20% of universe-day iv_morning_vol_corr
export const MIN_IV_SAMPLES = 5; // need ≥5 minutes of IV data to compute corr
export const MIN_BAND_STRIKES = 3; // need ≥3 strikes in the band to compute HHI meaningfully
```

## Open questions / default picks

1. **Per-day percentile computation**: the precision-stack-pass flag depends on percentiles within a day. At fire time we don't yet know the full day's distribution. Default pick: **stamp HHI and IV-vol-corr at fire time, compute pass flag in a daily after-close cron** that runs once per trading day at 16:00 ET. Alternative considered (stamp pass at fire time using yesterday's percentiles) — rejected as it shifts goalposts during live trading.
2. **Recall trade-off acknowledgment**: 17% recall means we miss 83% of winners. Display in UI as "high-precision filter" not "all winners." Out of scope for Phase 1.
3. **Out-of-sample warning**: in-sample N=12 days. Production filter should be re-evaluated weekly until ≥30 days of data is available. Not implemented as code; a manual check.

## Out of scope

- Cross-asset coherence (SPY ↔ SPXW co-fire) as a 4th feature — option D from the EDA, deferred.
- Per-strike base-rate normalization — defer.
- Frontend visualization changes beyond the badge — defer.
- Periodic re-tuning of the percentile cutoffs (HHI p30, IV-corr p80) as more data accrues — manual for now, automate later.

## Risk register

- **Migration adds columns to a hot table**: ALTER TABLE ADD COLUMN with NULL default is non-blocking on Postgres and Neon serverless. Acceptable. Backfill is a separate UPDATE pass batched by event id.
- **Backfill script touches 186 rows**: trivial; runs in seconds.
- **Daily after-close cron for pass flag computation**: new cron job, must be in vercel.json with CRON_SECRET. Implement in Phase 2.
- **In-sample bias**: filter cutoffs (p30, p80) were derived from the same 12 days they're being applied to. Real out-of-sample precision will be lower. Document in UI.
