# V2.2 Direction Gate Audit — 2026-05-22

## Background

`direction_gated` marks counter-trend fires:
- **Put fires** when `mkt_tide_otm_diff > +150M` (bull OTM tide, put is bearish = counter-trend)
- **Call fires** when `mkt_tide_otm_diff < -150M` (bear OTM tide, call is bullish = counter-trend)

The UI overrides the displayed score tier to `tier3` for all gated fires regardless of raw score. Tier1 = combined_score >= 18. Analysis window: last 30 calendar days. Outcome: `COALESCE(realized_flow_inversion_pct, realized_eod_pct)`.

**Tier1 note**: Only **10 tier1 fires** (combined_score >= 18) exist in the 90-day window, zero of which are gated. Tier1 fires are extremely rare and the gate audit cannot be conducted at that score level. Results below cover all scores (primary) and tier2+ (score >= 12, secondary).

## Aggregate outcomes (all scores, last 30 days)

| direction_gated | n | mean_pct | win% | hit_50% |
| --- | --- | --- | --- | --- |
| false (trend-aligned, ungated) | 161612 | +66.33% | 45.5% | 13.8% |
| true (counter-trend, gated) | 12488 | +254.76% | 54.8% | 17.4% |

**Gated vs ungated mean delta: +188.43pp**

## Tier2+ outcomes (combined_score >= 12, last 30 days)

| direction_gated | n | mean_pct | win% | hit_50% |
| --- | --- | --- | --- | --- |
| false (ungated) | 2721 | +242.63% | 67.0% | 30.9% |
| true (gated) | 83 | +85.17% | 79.5% | 36.1% |

## Split by option_type (all scores, last 30 days)

| direction_gated | option_type | n | mean_pct | win% | hit_50% |
| --- | --- | --- | --- | --- | --- |
| false | C | 85566 | +83.12% | 52.6% | 17.1% |
| true | C | 10980 | +21.90% | 56.5% | 16.1% |
| false | P | 76046 | +47.44% | 37.6% | 10.1% |
| true | P | 1508 | +1950.25% | 42.6% | 26.9% |

## Split by mkt_tide_otm_diff bucket (all scores, last 30 days)

Gate threshold is ±150M. Calls gated when otm_diff < -150M; puts gated when otm_diff > +150M. Within each band, rows show both gated (where applicable) and ungated fires.

| otm_diff range | type | gated | n | mean_pct |
| --- | --- | --- | --- | --- |
| -inf to -300M | C | false | 2894 | +13.13% |
| -inf to -300M | C | true | 2797 | +8.83% |
| -inf to -300M | P | false | 4306 | -10.23% |
| -300M to -150M | C | false | 6373 | +20.91% |
| -300M to -150M | C | true | 8183 | +26.36% |
| -300M to -150M | P | false | 12012 | -15.02% |
| -150M to 0 | C | false | 50097 | +57.27% |
| -150M to 0 | P | false | 36841 | +19.36% |
| 0 to +150M | C | false | 22829 | +113.03% |
| 0 to +150M | P | false | 19465 | +164.74% |
| +150M to +300M | C | false | 3214 | +463.76% |
| +150M to +300M | P | false | 3119 | -26.45% |
| +150M to +300M | P | true | 1508 | +1950.25% |

## Decision

**Recommendation: RELAX — gated fires outperform ungated by 188.4pp (gate is over-aggressive)**

Gated fires (n=12488) mean +254.76% vs ungated (n=161612) mean +66.33%. The gate is suppressing alerts that actually perform better than trend-aligned fires. The puts bucket (+150M to +300M) is the sharpest violation: gated puts have a dramatically higher mean outcome than ungated puts in the same band (see bucket table). Recommend raising the put gate threshold to +250M or +300M and re-auditing.

### Interpretation guide
- Gated fires UNDERPERFORM by >5pp: gate is doing its job. **KEEP.**
- Gated fires OUTPERFORM by >10pp: gate is over-aggressive. **RELAX** (raise threshold).
- Gated fires roughly EQUAL (delta ≤ 5pp): gate is noise. **CONSIDER REMOVING.**
