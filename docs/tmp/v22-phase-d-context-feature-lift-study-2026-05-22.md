# V2.2 Phase D Pre-Work — Pre-Fire Context Feature Lift Study

## Method

- 90-day aligned non-structure window (total rows in window: 165,755)
- Alignment filter: score IS NOT NULL + inferred_structure IS NULL
  + cum_ncp/npp present + option_type-aligned + outcome available
- Per-feature quintile bucketing (P20/P40/P60/P80 boundaries)
- Lift = (max_bucket_mean - min_bucket_mean) / |overall_mean| × 100%
- Monotonicity = fraction of consecutive quintile pairs moving same direction
- outcome_pct = COALESCE(realized_flow_inversion_pct, realized_eod_pct)

## Per-feature lift table

| Feature | n_non_null | overall_mean | min_mean | max_mean | lift_pct | monotonicity | verdict |
|---------|-----------|-------------|---------|---------|---------|-------------|---------|
| mkt_tide_otm_diff | 165,384 | 24.0 | -3.0 | 54.3 | 238.9% | 0.50 | **MODERATE** |
| mkt_tide_diff | 165,384 | 24.0 | 5.8 | 50.8 | 187.6% | 0.50 | **MODERATE** |
| spx_spot_gamma_oi | 132,002 | 27.2 | 4.5 | 58.9 | 200.1% | 0.50 | **MODERATE** |
| spx_spot_charm_oi | 132,002 | 27.2 | -2.9 | 57.2 | 221.0% | 0.75 | **STRONG** |
| spx_spot_vanna_oi | 131,846 | 27.3 | 3.8 | 81.7 | 286.0% | 0.75 | **STRONG** |
| mkt_tide_ncp | 131,808 | 27.2 | 7.2 | 54.1 | 172.8% | 0.75 | **STRONG** |
| mkt_tide_npp | 131,808 | 27.2 | 0.4 | 70.0 | 256.1% | 0.50 | **MODERATE** |

## Per-feature quintile detail

### mkt_tide_otm_diff

n_non_null=165,384  overall_mean=24.0%  lift=238.9%  mono=0.50

Boundaries: P20=-136308101.500  P40=-60541546.000  P60=-5119983.000  P80=38392703.100

| Quintile | n | mean_pct | win_rate | hit_50_pct |
|---------|---|---------|---------|-----------|
| Q0 (lowest) | 33,031 | -3.0% | 39.7% | 10.5% |
| Q1 (q1) | 32,957 | 34.9% | 45.1% | 14.5% |
| Q2 (q2) | 33,201 | 18.5% | 46.1% | 16.1% |
| Q3 (q3) | 33,118 | 54.3% | 46.3% | 19.8% |
| Q4 (highest) | 33,077 | 15.2% | 49.7% | 16.5% |

**Verdict: MODERATE**

### mkt_tide_diff

n_non_null=165,384  overall_mean=24.0%  lift=187.6%  mono=0.50

Boundaries: P20=-111967280.000  P40=-6085438.000  P60=54661710.500  P80=164854566.000

| Quintile | n | mean_pct | win_rate | hit_50_pct |
|---------|---|---------|---------|-----------|
| Q0 (lowest) | 33,058 | 5.8% | 41.9% | 12.4% |
| Q1 (q1) | 33,067 | 34.2% | 45.4% | 17.0% |
| Q2 (q2) | 33,041 | 50.8% | 46.2% | 16.7% |
| Q3 (q3) | 33,123 | 17.2% | 46.4% | 17.4% |
| Q4 (highest) | 33,095 | 12.0% | 47.1% | 13.9% |

**Verdict: MODERATE**

### spx_spot_gamma_oi

n_non_null=132,002  overall_mean=27.2%  lift=200.1%  mono=0.50

Boundaries: P20=-42974159187.480  P40=12479701228.090  P60=55219760567.180  P80=92746279925.340

| Quintile | n | mean_pct | win_rate | hit_50_pct |
|---------|---|---------|---------|-----------|
| Q0 (lowest) | 26,362 | 4.5% | 40.1% | 17.7% |
| Q1 (q1) | 26,397 | 33.7% | 43.7% | 14.9% |
| Q2 (q2) | 26,441 | 58.9% | 43.3% | 12.0% |
| Q3 (q3) | 26,396 | 22.6% | 49.1% | 16.9% |
| Q4 (highest) | 26,406 | 16.2% | 47.4% | 17.5% |

**Verdict: MODERATE**

### spx_spot_charm_oi

n_non_null=132,002  overall_mean=27.2%  lift=221.0%  mono=0.75

Boundaries: P20=-29556158889248.590  P40=-19625710841769.559  P60=-15437140045872.180  P80=-12950119474939.721

| Quintile | n | mean_pct | win_rate | hit_50_pct |
|---------|---|---------|---------|-----------|
| Q0 (lowest) | 26,392 | -2.9% | 39.4% | 8.5% |
| Q1 (q1) | 26,407 | 6.8% | 40.8% | 13.9% |
| Q2 (q2) | 26,388 | 41.9% | 47.0% | 18.6% |
| Q3 (q3) | 26,384 | 33.0% | 50.1% | 19.5% |
| Q4 (highest) | 26,431 | 57.2% | 46.3% | 18.4% |

**Verdict: STRONG**

### spx_spot_vanna_oi

n_non_null=131,846  overall_mean=27.3%  lift=286.0%  mono=0.75

Boundaries: P20=405295448.493  P40=689506707.847  P60=1316242699.368  P80=2025551582.517

| Quintile | n | mean_pct | win_rate | hit_50_pct |
|---------|---|---------|---------|-----------|
| Q0 (lowest) | 26,360 | 22.5% | 45.2% | 15.8% |
| Q1 (q1) | 26,377 | 19.4% | 47.8% | 16.3% |
| Q2 (q2) | 26,353 | 81.7% | 47.5% | 14.8% |
| Q3 (q3) | 26,319 | 8.9% | 43.0% | 15.4% |
| Q4 (highest) | 26,437 | 3.8% | 40.1% | 16.7% |

**Verdict: STRONG**

### mkt_tide_ncp

n_non_null=131,808  overall_mean=27.2%  lift=172.8%  mono=0.75

Boundaries: P20=-68810031.000  P40=1899398.000  P60=61589767.500  P80=155715573.000

| Quintile | n | mean_pct | win_rate | hit_50_pct |
|---------|---|---------|---------|-----------|
| Q0 (lowest) | 26,360 | 24.0% | 40.4% | 12.8% |
| Q1 (q1) | 26,318 | 38.1% | 44.2% | 18.4% |
| Q2 (q2) | 26,405 | 54.1% | 46.6% | 17.3% |
| Q3 (q3) | 26,358 | 7.2% | 45.4% | 15.4% |
| Q4 (highest) | 26,367 | 12.4% | 46.7% | 14.8% |

**Verdict: STRONG**

### mkt_tide_npp

n_non_null=131,808  overall_mean=27.2%  lift=256.1%  mono=0.50

Boundaries: P20=-45505432.000  P40=-6931816.000  P60=17668906.000  P80=55500453.000

| Quintile | n | mean_pct | win_rate | hit_50_pct |
|---------|---|---------|---------|-----------|
| Q0 (lowest) | 26,352 | 0.7% | 41.7% | 10.4% |
| Q1 (q1) | 26,345 | 45.0% | 47.1% | 19.1% |
| Q2 (q2) | 26,387 | 70.0% | 45.6% | 20.2% |
| Q3 (q3) | 26,277 | 19.8% | 47.0% | 16.0% |
| Q4 (highest) | 26,447 | 0.4% | 41.9% | 13.0% |

**Verdict: MODERATE**

## Shape caveats

- `spx_spot_charm_oi` — cleanly ascending Q0→Q4 (means: -2.9, 6.8, 41.9, 33.0, 57.2%). Linear encoding is appropriate.
- `spx_spot_vanna_oi` — humped: peaks at Q2 (81.7%) then collapses (Q3=8.9%, Q4=3.8%). Not linearly monotonic; the real signal is "avoid extreme values in either direction." Implementation should use [w0, w0, w_peak, w_low, w_low] shaped weights rather than a linear ramp.
- `mkt_tide_ncp` — ascending through Q2 (24.0, 38.1, 54.1%) then drops (Q3=7.2%, Q4=12.4%). Humped like vanna. Same implication: mid-quintile is best, not highest quintile. Use non-linear weight array.
- `mkt_tide_diff` — peaking at Q2 (50.8%) then dropping. Same humped shape; MODERATE because monotonicity=0.50, consistent with the hump reading.
- `mkt_tide_npp` — peaks at Q2 (70.0%) then drops to near-zero at Q4 (0.4%). Strong hump; the "moderate" call comes from the monotonicity=0.50 score (2/4 pairs ascending), not from lift deficiency.
- `spx_spot_gamma_oi` — peaks at Q2 (58.9%) then falls. Same humped pattern.
- `mkt_tide_otm_diff` — non-monotonic with Q3 being the outlier high (54.3%). Noisy shape; MODERATE is appropriate.

**Key implementation insight for humped features**: a naive linear quintile weight (increasing from Q0 to Q4) will misfire on these. Use a custom weight array that assigns maximum weight to Q2 and lower weights to the tails. This is still just a 5-element array in the weights JSON — same infrastructure, different values.

## Recommended next-step features

- **STRONG** (3): spx_spot_charm_oi, spx_spot_vanna_oi, mkt_tide_ncp
- **MODERATE** (4): mkt_tide_otm_diff, mkt_tide_diff, spx_spot_gamma_oi, mkt_tide_npp
- **SKIP** (0): 

## Phase D scope recommendation

- Total new features to add: 7
- Estimated implementation effort: ~14h (2h per quintile-encoded feature)
- Baseline comparison: Monday TOD overlay = ~3h
- Whether full Phase D is worth doing: **Full Phase D justified** (7 features). Expected lift is meaningful; proceed.

### Implementation notes for passing features

Each feature would be added as a quintile-encoded score component, identical to the existing `vol_oi_q`, `gamma_q`, `ask_pct_q` pattern:

1. Add quintile boundaries to `lottery_score_weights.json`
2. Add weight array `[w0, w1, w2, w3, w4]` for each quintile bucket
3. Update `computeLotteryScoreV2` in `api/_lib/lottery-score-weights.ts`
4. Re-backfill scores
5. Compare tier1 hit rate on held-out window (≥3pp improvement gate)
