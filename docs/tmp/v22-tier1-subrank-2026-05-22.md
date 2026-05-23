# V2.2 Tier1 Intra-Day Sub-Ranking — 2026-05-22

## Method
- 30-day window (excluding today)
- Tier1 definition: score >= 9 (per A.6 spec)
- **Approach A** — intra-day rank by score descending (ties broken by fire id ascending)
- Outcome: `realized_trail30_10_pct` (primary) or `realized_eod_pct` fallback
- Days in window: 21 market days, 21 with ≥1 tier1 fire
- Total tier1 fires: 5,754

## Score distribution within tier1 (all fires)
  - score=17: 15 fires
  - score=16: 16 fires
  - score=15: 29 fires
  - score=14: 182 fires
  - score=13: 489 fires
  - score=12: 732 fires
  - score=11: 1,091 fires
  - score=10: 1,012 fires
  - score=9: 2,188 fires

## Results — rank bucket vs outcome

| Rank within day | n | mean_pct | win% | hit_50% |
| --- | --- | --- | --- | --- |
| Top 3 | 61 | +0.7% | +67.2% | +4.9% |
| 4-10 | 131 | +6.4% | +63.4% | +6.1% |
| 11+ | 5,562 | +6.2% | +69.0% | +6.4% |
| **Rest (4+)** | 5,693 | +6.2% | — | — |

## Per-day coverage
- Days with ≥1 tier1 fire: 21
- Days with ≥3 tier1 fires (top-3 fully populated): 19
- Median tier1 fires/day: 109
- Max tier1 fires/day: 1117

## Decision
- Top-3 mean uplift over rest: **-5.6 pp**
- Recommendation: **DROP** tier1_priority badge (uplift -5.6 pp < 15 pp threshold)
