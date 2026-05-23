# V2.2 Co-Fire Amplification Analysis — 2026-05-22

## Method
- 30-day window of tier1 fires only (score >= 9, aligned, outcome present)
- Cluster = N distinct OTHER tickers firing tier1 within ±5 min of this fire
- Total fires analyzed: 5,754

## Cluster size distribution

| cluster_size | n_fires | mean_pct | win% | hit_50% |
| --- | --- | --- | --- | --- |
| 1 (isolated) | 145 | 10.41% | 57.9% | 11.0% |
| 2 | 142 | 49.56% | 77.5% | 39.4% |
| 3-4 | 382 | 79.13% | 66.5% | 39.0% |
| 5+ | 5085 | 32.63% | 61.6% | 26.0% |

## Decision
- Lift (largest cluster vs isolated) = +22.2 pp mean outcome
- Recommendation: SHIP cluster bonus
- Suggested bonus magnitude = +2 pts (proportional to 22.2 pp lift, capped at +3)

## Caveats
- 30-day window only (~22 trading days)
- Tier1 itself is score-gated sparse — cluster opportunities are limited
- Cluster detection is purely temporal; no causal claim about direction
- ±5-min window may conflate market-wide macro moves with option-specific flow
