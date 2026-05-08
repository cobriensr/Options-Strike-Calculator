# Silent-Boom Scoring + Tier System

**Created:** 2026-05-08 (after-hours, Thursday)
**Owner:** Charles
**Status:** Spec — not yet implemented
**Related:** [silent-boom-detector-2026-05-08.md](./silent-boom-detector-2026-05-08.md), [lottery-finder-2026-05-02.md](./lottery-finder-2026-05-02.md)

## Goal

Add a 3-tier conviction badge (🔥 / 🔥🔥 / 🔥🔥🔥) to silent-boom alerts, mirroring the lottery_finder tiering UX. Score is a composite of empirically-calibrated feature buckets — every weight comes from the historical peak distribution, never hand-tuned.

## Why

The 14,100-alert empirical sample shows a wide spread on peak ceiling — 91% are positive but only 15.9% reach ≥50%. The user trades discretionarily off the panel; without conviction filtering, every row looks the same and the user must visually scan all chips (spike_ratio / vol_oi / ask% / OI / DTE / TOD) to decide whether the setup is worth a click. A pre-computed tier collapses that into one glanceable badge plus a filter chip.

The lottery_finder tiering pattern is proven: Tier 1 (~80% high-peak rate) vs Tier 3 (~32%) — a 2.5× lift on a discretionary signal. Replicating the methodology rather than reinventing it.

## Non-goals

- **Not** a backtested profitable strategy. Tier 1 alerts can still lose; the score raises the prior, it doesn't make the trade automatic.
- **Not** a per-ticker conviction system. 14.1k across ~50 tickers is ~280 alerts/ticker on average — too thin for ticker-level Wilson CIs to be meaningful. Defer per-ticker stats until ≥6 months of cron-padded sample (~50k+).
- **Not** a model-based prediction. Linear feature scoring keeps the explanation trivially auditable in the row tooltip.

## Phases

### Phase 0 — Feature audit (no code change, ~30 min)

Standalone Python script `scripts/silent_boom_feature_audit.py` that stratifies the existing 14.1k sample by each candidate feature and reports the peak ≥50% rate plus mean peak per stratum. Output is a markdown report in `docs/tmp/silent-boom-feature-audit-2026-05-08.md` with one section per feature.

Candidate features (all already in `silent_boom_alerts`):

| Feature | Stratification |
|---|---|
| `spike_ratio` | 5–10×, 10–25×, 25–50×, 50–100×, 100×+ |
| `vol_oi` | 0.25–0.5, 0.5–1.0, 1.0–2.0, 2.0+ |
| `ask_pct` | 0.70–0.85, 0.85–0.95, 0.95+ |
| `open_interest` | <500, 500–2k, 2k–10k, 10k+ |
| `dte` | 0DTE, 1–3D, 4–7D, 8–30D, 30D+ |
| `option_type` | C vs P |
| Time-of-day | AM_open (08:30–10:00 CT), MID (10:00–12:00), LUNCH (12:00–13:00), PM (13:00–15:00) |
| `entry_price` | <$0.50, $0.50–1.00, $1.00–5.00, $5.00+ |
| `baseline_volume` | <50, 50–200, 200–500 |

For each stratum the audit computes:
- `n` (sample count)
- `pct_high_peak` = % with peak_ceiling_pct ≥ 50
- `mean_peak` = average peak %
- `lift` = `pct_high_peak / 15.9%` (the global baseline)
- 95% Wilson CI on `pct_high_peak`

Report sorts by `lift` within each feature so the strongest predictors surface first. Strata with `n < 100` are flagged as low-confidence.

**Output deliverable:** ranked feature list — which buckets actually predict peak, which are noise.

### Phase 1 — Score library + DB column + cron wiring (1 file new, 4 modified)

Translate the audit findings into an additive integer score, mirroring `api/_lib/lottery-score-weights.ts`.

**New file:** `api/_lib/silent-boom-score.ts`
- `SILENT_BOOM_SCORE_WEIGHTS` — frozen const, points-per-bucket per feature, calibrated from Phase 0
- `SILENT_BOOM_TIER_THRESHOLDS = { tier1: ?, tier2: ? }` — calibrated to land Tier 1 ≈ top 5/day, Tier 2 ≈ bulk of day, matching lottery proportions
- `computeSilentBoomScore(alert) → { score, tier }` — pure function

**Migration #135** (in `api/_lib/db-migrations.ts`):
- `ALTER TABLE silent_boom_alerts ADD COLUMN score smallint`
- `ALTER TABLE silent_boom_alerts ADD COLUMN score_tier text` (`'tier1' | 'tier2' | 'tier3'`)
- Index on `(date, score_tier)` for the tier-filter API path

**Cron wiring:** in `api/cron/detect-silent-boom.ts`, compute score before INSERT and bind into the new columns.

**Backfill rerun:** add `score` / `score_tier` to `scripts/backfill_silent_boom_from_parquet.py` so the existing 14.1k get scored without a separate pass.

**Tests:**
- `api/__tests__/silent-boom-score.test.ts` — score correctness, tier boundary cases, frozen constants
- Update `api/__tests__/db.test.ts` for migration #135 (mock count + sequence)

### Phase 2 — API + UI tier surface (3 files)

**API** (`api/silent-boom-feed.ts`):
- Return `score: number` and `scoreTier: 'tier1' | 'tier2' | 'tier3'` per row
- Accept `?minScore=N` query param — filters to score ≥ N
- Validation in `silentBoomFeedQuerySchema`

**UI** (`src/components/SilentBoom/SilentBoomRow.tsx`):
- Tier badge component identical to LotteryRow's (🔥 / 🔥🔥 / 🔥🔥🔥)
- Tooltip surfaces the score breakdown (which features contributed)

**UI** (`src/components/SilentBoom/SilentBoomSection.tsx`):
- Conviction filter chip group (`all` / `Tier 2+` / `Tier 1`) — same UX as LotteryFinderSection
- localStorage-persisted

**Tests:**
- Extend `src/__tests__/useSilentBoomFeed.test.ts` for the new `minScore` URL param

## Files to create/modify

| Path | Action | Phase |
|---|---|---|
| `scripts/silent_boom_feature_audit.py` | new | 0 |
| `docs/tmp/silent-boom-feature-audit-2026-05-08.md` | new (audit output) | 0 |
| `api/_lib/silent-boom-score.ts` | new | 1 |
| `api/__tests__/silent-boom-score.test.ts` | new | 1 |
| `api/_lib/db-migrations.ts` | +migration #135 | 1 |
| `api/__tests__/db.test.ts` | mock count update | 1 |
| `api/cron/detect-silent-boom.ts` | score + bind columns | 1 |
| `scripts/backfill_silent_boom_from_parquet.py` | score + bind columns | 1 |
| `api/silent-boom-feed.ts` | return score/tier; accept minScore | 2 |
| `api/_lib/validation.ts` | minScore in schema | 2 |
| `src/components/SilentBoom/types.ts` | score/scoreTier on alert type | 2 |
| `src/hooks/useSilentBoomFeed.ts` | minScore arg → URL param | 2 |
| `src/components/SilentBoom/SilentBoomRow.tsx` | tier badge | 2 |
| `src/components/SilentBoom/SilentBoomSection.tsx` | conviction filter | 2 |
| `src/__tests__/useSilentBoomFeed.test.ts` | minScore URL test | 2 |

## Data dependencies

- Existing 14.1k sample in `silent_boom_alerts` with `peak_ceiling_pct` populated. ✅ already enriched.
- No new external API calls — all features are already in the row.
- No new tables — existing table gains 2 columns.

## Open questions

1. **Score scale** — lottery uses ~0–25 with thresholds at 12 and 18. Silent boom has fewer features (no flow_quad, no mode classifier), so the natural ceiling will be lower. **Default pick:** ~0–18 with thresholds at 9 and 14, calibrated post-audit.
2. **Asymmetry C vs P** — if the audit shows calls have a meaningfully higher peak rate than puts (which 0DTE typically does), do we encode that in the score, or surface it as a chip filter only? **Default pick:** encode in score (mirrors lottery's `optionType` weight). Asymmetry is real signal.
3. **Per-ticker weights** — defer (sample too thin), per non-goal above.
4. **Score recompute on weight change** — if Phase 0 surfaces a feature we didn't anticipate and we revise weights post-launch, do we backfill-rescore the historical 14.1k or only score new rows forward? **Default pick:** always rescore historical via a one-shot script that runs on every weight bump. Mirrors lottery's `rescore_lottery_fires.py`.
5. **Tier 1 day-cap** — lottery's tier definitions land ~5 Tier 1 fires/day. Silent boom's 14.1k / 19 days = 742/day baseline; a Tier 1 rate of ~0.7% would land ~5/day. Confirm post-audit.

## Acceptance criteria

- [ ] Phase 0 audit produces a markdown report ranking each feature's predictive power with sample-size and Wilson CI annotations.
- [ ] Phase 1 score library has ≥10 parity tests covering each feature bucket and tier boundary.
- [ ] Tier 1 historical high-peak rate ≥ 1.8× the global baseline (15.9%) on the existing sample. (Lottery's threshold is 2.5× — silent boom's signal is weaker so we're more permissive.)
- [ ] Tier proportions land near 5% / 30% / 65% (Tier 1 / Tier 2 / Tier 3) — matches lottery's distribution.
- [ ] Frontend tier badge + conviction filter functional in localhost dev; localStorage persists across reload.
- [ ] `npm run review` green; code-reviewer subagent verdict: pass.
- [ ] All work fixed in-session per the no-defer rule (no Phase N punt list).

## Threshold pick rationale

Lottery's Tier 1 is 80% high-peak vs 32% Tier 3 — a 2.5× lift on a 50% threshold. That benchmark assumes the signal source has enough information to drive a strong calibration. Silent boom's signal is narrower (single 5-min ask-side burst, no cumulative-flow context, no macro context, no mode classification), so the achievable lift will be lower. Acceptance bar of 1.8× lift = ~29% high-peak Tier 1 vs 15.9% baseline is realistic and still useful — a Tier 1 alert on the silent-boom feed becomes ~30% likely to hit ≥50% peak vs ~10% for Tier 3.

If Phase 0 surfaces a feature that pushes Tier 1 past 2× lift (e.g., spike_ratio ≥ 50× combined with vol/OI ≥ 1.0 might genuinely segment), great — but we don't engineer the score to hit a target lift; we calibrate from data and accept what the data gives.

## Constants reference

Calibration anchors from the 14.1k sample (2026-04-13 → 2026-05-07):

- Mean peak: 35.4%
- Median peak: 9.7%
- Peak > 0%: 91.0%
- Peak ≥ 25%: 29.1%
- **Peak ≥ 50%: 15.9%** ← global baseline for tier calibration
- Peak ≥ 100%: 7.5%
- Median minutes-to-peak: 20 min
