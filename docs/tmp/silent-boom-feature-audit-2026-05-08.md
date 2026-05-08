# Silent-Boom Feature Audit

**Generated:** by `scripts/silent_boom_feature_audit.py`  
**Sample:** silent_boom_alerts where peak_ceiling_pct IS NOT NULL  
**n:** 14,100  
**Baseline high-peak rate** (peak ≥ 50%): **15.9%**

Stratifies the enriched silent-boom sample by each candidate
score feature. "lift" is the bucket's high-peak rate divided
by the global baseline — values >1 mean the bucket beats the
baseline; the 95% Wilson CI shows whether the lift is real.

The Phase 1 score library translates the strongest-lift
buckets into integer score points. Buckets with overlapping
CIs that span 1.0 should not get differentiating weights.

---

## Summary — features ranked by within-feature lift spread

| Feature                                   | Best bucket              | Best lift | Worst lift | Spread (pp) | Best n |
| ----------------------------------------- | ------------------------ | --------: | ---------: | ----------: | -----: |
| Days-to-expiry                            | 1) 0DTE                  |     3.03× |      0.11× |     +46.5pp |  1,542 |
| Baseline median volume (silence depth)    | 3) 200–500               |     2.33× |      0.74× |     +25.4pp |    918 |
| Spike ratio (multiple of baseline median) | 1) 5–10×                 |     2.11× |      0.64× |     +23.4pp |  1,065 |
| Entry price (vwap of spike bucket)        | 1) <$0.50                |     1.64× |      0.25× |     +22.1pp |  5,577 |
| Time of day (CT)                          | 1) AM_open (08:30–10:00) |     1.65× |      0.50× |     +18.4pp |  3,262 |
| Ask-side share of spike bucket            | 1) 0.70–0.85             |     1.43× |      0.87× |      +8.9pp |  1,758 |
| Open interest at spike                    | 3) 2k–10k                |     1.09× |      0.82× |      +4.4pp |  6,647 |
| Vol / OI in spike bucket                  | 2) 0.5–1.0               |     1.07× |      0.88× |      +3.1pp |  3,727 |
| Option type (C vs P)                      | C                        |     1.06× |      0.93× |      +2.0pp |  7,969 |

Spread is the percentage-point gap between the best and worst buckets within a feature — a high spread means the feature genuinely segments. Use this to pick which features get meaningful score weights vs. which collapse into noise.

---

## Spike ratio (multiple of baseline median)

| Bucket     |     n | high-peak% | 95% CI     | mean peak | median peak |  lift |
| ---------- | ----: | ---------: | ---------- | --------: | ----------: | ----: |
| 1) 5–10×   | 1,065 |      33.6% | 30.8–36.5% |    +85.9% |      +26.1% | 2.11× |
| 2) 10–25×  | 1,503 |      27.7% | 25.5–30.1% |    +68.5% |      +20.4% | 1.74× |
| 3) 25–50×  | 1,325 |      22.3% | 20.1–24.6% |    +47.7% |      +15.4% | 1.40× |
| 4) 50–100× | 1,503 |      18.7% | 16.8–20.7% |    +35.8% |      +12.5% | 1.17× |
| 5) 100×+   | 8,704 |      10.3% | 9.6–10.9%  |    +21.5% |       +6.7% | 0.64× |

_Baseline high-peak rate: 15.9%. Strata flagged ⚠️ have n < 100._

## Vol / OI in spike bucket

| Bucket      |     n | high-peak% | 95% CI     | mean peak | median peak |  lift |
| ----------- | ----: | ---------: | ---------- | --------: | ----------: | ----: |
| 1) 0.25–0.5 | 4,373 |      16.4% | 15.4–17.5% |    +38.5% |       +9.9% | 1.03× |
| 2) 0.5–1.0  | 3,727 |      17.1% | 15.9–18.3% |    +36.5% |       +9.9% | 1.07× |
| 3) 1.0–2.0  | 2,310 |      16.2% | 14.8–17.8% |    +33.9% |      +10.3% | 1.02× |
| 4) 2.0+     | 3,690 |      14.0% | 12.9–15.1% |    +31.4% |       +9.1% | 0.88× |

_Baseline high-peak rate: 15.9%. Strata flagged ⚠️ have n < 100._

## Ask-side share of spike bucket

| Bucket       |      n | high-peak% | 95% CI     | mean peak | median peak |  lift |
| ------------ | -----: | ---------: | ---------- | --------: | ----------: | ----: |
| 1) 0.70–0.85 |  1,758 |      22.8% | 20.9–24.8% |    +49.2% |      +14.3% | 1.43× |
| 2) 0.85–0.95 |  1,951 |      20.5% | 18.8–22.4% |    +43.1% |      +14.3% | 1.29× |
| 3) 0.95+     | 10,391 |      13.9% | 13.2–14.6% |    +31.5% |       +8.1% | 0.87× |

_Baseline high-peak rate: 15.9%. Strata flagged ⚠️ have n < 100._

## Open interest at spike

| Bucket    |     n | high-peak% | 95% CI     | mean peak | median peak |  lift |
| --------- | ----: | ---------: | ---------- | --------: | ----------: | ----: |
| 1) <500   | 2,058 |      13.0% | 11.6–14.5% |    +28.6% |       +8.3% | 0.82× |
| 2) 500–2k | 4,436 |      15.6% | 14.5–16.7% |    +30.5% |      +10.0% | 0.98× |
| 3) 2k–10k | 6,647 |      17.4% | 16.5–18.3% |    +41.8% |      +10.6% | 1.09× |
| 4) 10k+   |   959 |      13.6% | 11.5–15.9% |    +27.2% |       +7.3% | 0.85× |

_Baseline high-peak rate: 15.9%. Strata flagged ⚠️ have n < 100._

## Days-to-expiry

| Bucket   |     n | high-peak% | 95% CI     | mean peak | median peak |  lift |
| -------- | ----: | ---------: | ---------- | --------: | ----------: | ----: |
| 1) 0DTE  | 1,542 |      48.2% | 45.8–50.7% |   +134.8% |      +48.8% | 3.03× |
| 2) 1–3D  | 3,601 |      23.5% | 22.1–24.9% |    +40.6% |      +17.1% | 1.47× |
| 3) 4–7D  | 2,260 |      13.9% | 12.6–15.4% |    +25.0% |      +10.9% | 0.88× |
| 4) 8–30D | 4,170 |       7.1% | 6.3–7.9%   |    +16.4% |       +7.5% | 0.44× |
| 5) 30D+  | 2,527 |       1.8% | 1.3–2.4%   |     +7.5% |       +3.1% | 0.11× |

_Baseline high-peak rate: 15.9%. Strata flagged ⚠️ have n < 100._

## Option type (C vs P)

| Bucket |     n | high-peak% | 95% CI     | mean peak | median peak |  lift |
| ------ | ----: | ---------: | ---------- | --------: | ----------: | ----: |
| C      | 7,969 |      16.8% | 16.0–17.6% |    +36.1% |      +11.1% | 1.06× |
| P      | 6,131 |      14.8% | 13.9–15.7% |    +34.4% |       +7.6% | 0.93× |

_Baseline high-peak rate: 15.9%. Strata flagged ⚠️ have n < 100._

## Time of day (CT)

| Bucket                   |     n | high-peak% | 95% CI     | mean peak | median peak |  lift |
| ------------------------ | ----: | ---------: | ---------- | --------: | ----------: | ----: |
| 1) AM_open (08:30–10:00) | 3,262 |      26.3% | 24.8–27.8% |    +55.4% |      +19.6% | 1.65× |
| 2) MID (10:00–12:00)     | 4,072 |      17.3% | 16.2–18.5% |    +40.6% |      +11.8% | 1.09× |
| 3) LUNCH (12:00–13:00)   | 1,846 |      15.7% | 14.1–17.4% |    +30.6% |       +9.2% | 0.99× |
| 4) PM (13:00–15:00)      | 4,771 |       7.9% | 7.2–8.7%   |    +19.6% |       +4.5% | 0.50× |
| 5) LATE (15:00+)         |   149 |       8.1% | 4.7–13.5%  |    +14.8% |       +0.6% | 0.51× |

_Baseline high-peak rate: 15.9%. Strata flagged ⚠️ have n < 100._

## Entry price (vwap of spike bucket)

| Bucket        |     n | high-peak% | 95% CI     | mean peak | median peak |  lift |
| ------------- | ----: | ---------: | ---------- | --------: | ----------: | ----: |
| 1) <$0.50     | 5,577 |      26.1% | 25.0–27.3% |    +59.7% |      +16.7% | 1.64× |
| 2) $0.50–1.00 | 2,054 |      13.1% | 11.8–14.7% |    +26.9% |       +9.7% | 0.83× |
| 3) $1.00–5.00 | 4,231 |      10.1% | 9.2–11.1%  |    +19.9% |       +8.2% | 0.64× |
| 4) $5.00+     | 2,238 |       4.0% | 3.2–4.9%   |    +11.7% |       +4.9% | 0.25× |

_Baseline high-peak rate: 15.9%. Strata flagged ⚠️ have n < 100._

## Baseline median volume (silence depth)

| Bucket     |      n | high-peak% | 95% CI     | mean peak | median peak |  lift |
| ---------- | -----: | ---------: | ---------- | --------: | ----------: | ----: |
| 1) <50     | 10,695 |      11.8% | 11.2–12.4% |    +24.2% |       +7.5% | 0.74× |
| 2) 50–200  |  2,487 |      25.8% | 24.1–27.6% |    +60.5% |      +19.1% | 1.62× |
| 3) 200–500 |    918 |      37.1% | 34.1–40.3% |    +97.5% |      +30.3% | 2.33× |

_Baseline high-peak rate: 15.9%. Strata flagged ⚠️ have n < 100._
