# Charm Pressure Pin Study — Spec

**Date:** 2026-04-25
**Status:** scoped, awaiting capture
**Owner:** single-owner research project (not a code feature)
**Related skill:** `.claude/skills/charm-pressure/SKILL.md`

## Goal

Determine, via EDA on n≈100 days of SpotGamma TRACE Charm Pressure screenshots, whether the chart's predicted EoD pin location agrees with the realized SPX close, **conditional on regime**. Specifically: does the chart show measurable accuracy on calm/range-bound days with high Stability %, and does that accuracy disappear on trending/event days?

This is an **EDA-only** project. No model training, no CNNs. The goal is to learn the tool, not deploy a forecaster.

## Background

The skill `.claude/skills/charm-pressure` encodes the SpotGamma semantics: red = dealer selling (passive value gain), blue = dealer buying (passive value loss), pin candidate = white/black neutral band between red and blue near a strong +gamma strike. SpotGamma claims spot drifts toward the red/blue intersection at EoD and moves strongly _through_ blue zones in that process.

A 1-day test pass (2026-04-24) showed:

- Stability rises during the day (11% open → 18% midday → 23% close) — confirming the time-gate.
- The 8:30 chart's pin candidate (~7125) was 30+ pts away from the realized close (7163).
- The 12:00 and 15:00 charts converged on a 7150 intersection, but price closed _inside_ the upper red pocket at 7163 — a directional rally overwhelmed dampening.

That single observation suggests the edge is _conditional_ on regime, not unconditional. This study is designed to test that conditionality with stratified sampling.

## Phases

1. **Sample construction** — generate candidate-days pool, enrich with SPX OHLC, classify regime, select stratified n=100. Independently shippable: produces `selected-days.csv` to drive capture.
2. **Capture campaign** — manually screenshot 100 days × 3 captures (open / midday / close) from TRACE date picker. Independently shippable: produces 300 image files + populated metadata rows.
3. **Manual feature scoring** — for each day, eyeball-grade pin band centroid, pin band width, +gamma node strike from each capture; record realized pin outcome. Independently shippable: produces fully-populated `study-data.csv`.
4. **EDA** — pin-rate × stability tertile × regime contingency tables, distribution plots, drift analysis (does pin band migrate?). Outputs: `findings.md` and PNG plots.
5. **Decision** — if a conditional edge emerges in Phase 4, decide whether to scale (n=300, automate capture, optionally model). If no edge, write up and stop.

## Sampling design

**Constraint:** TRACE Charm Pressure history goes back to **June 2024**. Latest available is yesterday (2026-04-24). Window: ~22 months ≈ 482 trading days.

**Stratification target:**

- 50 range-bound days (low realized range, no scheduled event, mid-week)
- 30 trending days (high realized range, no scheduled event)
- 20 event days (FOMC, CPI, NFP, OpEx, quad-witch)

Range/trending classification deferred until Phase 1 enrichment (needs SPX OHLC).

**Why stratify:** at n=100 sequential, the binomial MOE on a 60% pin rate is ±10% — barely enough to distinguish from a 50% null. Stratifying triples effective power for the conditional hypotheses (pin works on calm days, fails on event days), which is the question that matters.

## Capture protocol

For each selected day, three captures from the TRACE date picker:

| Time (CT) | Time (ET) | Stability ~    | Purpose                                                  |
| --------- | --------- | -------------- | -------------------------------------------------------- |
| 08:30     | 09:30     | low (~10–15%)  | Cash open — earliest valid Stability% reading.           |
| 12:00     | 13:00     | mid (~15–20%)  | Mid-session; does the pin candidate migrate?             |
| 14:30     | 15:30     | high (~20–30%) | EoD signal — last valid Stability% reading.              |
| 15:00     | 16:00     | n/a (invalid)  | Post-close visual — actual settle vs predicted pin band. |

**Do not capture at 15:00 CT / 16:00 ET** — Stability% is only valid 9:30–3:30 PM ET per SpotGamma's tooltip. A 15:00 CT read returns a stale value and corrupts any feature derived from it.

The PNG export (camera button) gives a clean, fixed-rectangle crop of the heatmap + GEX sidebar, so HSV thresholding is reliable across captures without window-size-dependent calibration. Stability%, capture time, and SPX spot are NOT in the export — log them by hand or via the automation script (see Phase 2 below).

**Frame settings (must be identical across all captures):**

- Chart type: Charm Pressure
- Mode: Market Makers
- Theme: dark (pick once, never change)
- Time Cutoff: ON
- Heatmap Zoom: default
- Strike Plot Zoom: default
- y-axis: spot ± $50 SPX (consistent zoom)
- Browser window size: fixed (so cropping rectangles work)

## CSV schema

One row per candidate day. See `scripts/charm-pressure-capture/candidate-days.csv` for the pre-filled file.

**Identity (pre-filled):**

- `date` — YYYY-MM-DD
- `day_of_week` — Mon..Fri

**Event flags (pre-filled, calendar-deterministic):**

- `is_monthly_opex` — 3rd Friday of any month
- `is_quarterly_opex` — 3rd Friday of Mar/Jun/Sep/Dec (quad-witch)
- `is_half_day` — early-close session (1pm ET)

**Event flags (pre-filled, training-knowledge — VERIFY):**

- `is_fomc` — scheduled FOMC decision day (verify at federalreserve.gov)
- `is_cpi` — BLS CPI release day (verify at bls.gov)
- `is_nfp` — BLS Employment Situation release day (verify at bls.gov)
- `is_event` — any of fomc/cpi/nfp/quarterly_opex

**Price + regime (user-filled in Phase 1 enrichment):**

- `spx_open, spx_high, spx_low, spx_close, spx_prev_close`
- `realized_range_dollars` = high − low
- `realized_range_pct` = (high − low) / prev_close × 100
- `regime` ∈ {`range_bound`, `trending`, `event`}

**Selection (user-filled in Phase 1):**

- `selected` — Y/N
- `selection_bucket` — which stratum

**Charm Pressure features (user-filled in Phase 3 from screenshots):**

- `stability_open, stability_mid, stability_close` — read from gauge
- `spot_at_open_capture, spot_at_mid_capture, spot_at_close_capture`
- `pin_band_centroid_open, pin_band_centroid_mid, pin_band_centroid_close` — predicted pin strike (white/black band centroid)
- `pin_band_width_close` — dollar width of the neutral band at close capture
- `nearest_pos_gamma_strike_close, nearest_pos_gamma_magnitude_close`

**Outcome (user-filled, post-close):**

- `pin_realized` — Y if `|spx_close − nearest_25pt_strike| ≤ 5`, else N
- `pin_realized_strike` — which 25pt strike if Y
- `pin_distance_close` — `spx_close − pin_band_centroid_close` (signed; positive = closed above prediction)
- `notes` — free text

## Pin definition (committed)

**Soft pin:** `|spx_close − nearest_integer_strike_on_25pt_grid| ≤ $5`.

Rationale: SPX 25-pt grid is the dealer-relevant strike spacing. ±$5 captures real pinning without being so tight that no day qualifies. Tight ±$2 definition can be computed as a secondary metric in EDA, but primary classification uses ±$5.

**Drift-to** (secondary metric): direction of `spx_close − spx_at_2pm` matches sign of `pin_band_centroid_close − spx_at_2pm`. Useful for evaluating directional usefulness when the pin strike was wrong.

## Thresholds / constants

- **Stability gate:** ignore pin claims when `stability_close < 20%` (per skill).
- **Pin tolerance:** $5 (primary), $2 (secondary).
- **Strike grid:** 25-pt SPX (5800, 5825, 5850...).
- **Capture spot band:** ±$50 SPX from spot at capture.

## EDA plan (Phase 4)

Required tables:

1. **Pin rate × stability tertile** — does accuracy rise with stability?
2. **Pin rate × regime** — does it work on range-bound, fail on trending/event?
3. **Pin rate × stability × regime** — the joint table; this is the actual answer.
4. **Pin band drift (open → close)** — distribution of `pin_band_centroid_close − pin_band_centroid_open`. Big drift = chart was directionally wrong early.
5. **`pin_distance_close` distribution** — symmetric around 0, or biased? Bias means dealer-flow assumption breaks systematically.

Required plots:

- Histogram of `pin_distance_close` overall and by regime.
- Scatter of `stability_close` vs `|pin_distance_close|`.
- Scatter of `pin_band_width_close` vs `|pin_distance_close|`.

## Data dependencies

- **TRACE access** — already have it. Date picker goes back to June 2024.
- **SPX daily OHLC** — needed for Phase 1 regime classification. Sources: project DB (`spx_daily_ohlc` if it exists), Schwab API, or any free source.
- **No new env vars, no new DB tables, no Vercel changes.**

## Open questions

- **Half-day handling.** On Thanksgiving Friday / Christmas Eve / Jul 3, the close is 12pm ET (1pm CT) not 3pm CT. Should the 15:00 capture shift to the early close, or should we exclude these from the sample? **Default:** exclude from sample; charm dynamics on half-days aren't comparable.
- **Coincident events.** Some days are both FOMC and CPI (e.g., 2024-06-12). Bucket as `event` regardless; don't double-count.
- **OpEx + quad-witch.** Quarterly OpEx is a _superset_ of monthly OpEx (every quarterly is also a monthly). Treat as `event`; flag both for completeness.
- **HSV automation.** Skipped at first per skill. Revisit only if Phase 4 finds a signal worth scaling.

## Files

Created by this spec:

- `docs/superpowers/specs/charm-pressure-pin-study-2026-04-25.md` (this file)
- `scripts/charm-pressure-capture/README.md`
- `scripts/charm-pressure-capture/generate-candidate-days.mjs`
- `scripts/charm-pressure-capture/candidate-days.csv` (output of the script)

Will be created in later phases:

- `scripts/charm-pressure-capture/screenshots/<YYYY-MM-DD>/{open,mid,close}.png`
- `scripts/charm-pressure-capture/study-data.csv` (after Phase 3)
- `scripts/charm-pressure-capture/findings.md` (after Phase 4)
- `scripts/charm-pressure-capture/plots/*.png` (after Phase 4)
