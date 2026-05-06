<stdin>:10: UserWarning: pandas only supports SQLAlchemy connectable (engine/connection) or database string URI or sqlite3 DBAPI2 connection. Other DBAPI2 objects are not tested. Please consider using SQLAlchemy.

# Lottery exit-policy analysis

Dataset: 63,285 enriched fires across 17 trading days (2026-04-13 → 2026-05-05), 51 tickers.

## 1. Headline: aggregate across all enriched fires

    trail30/10      n=63,285  mean=  -1.39%  med= +7.59%  win= 56.7%  Sharpe=-0.033
    hard30m         n=63,285  mean=  -1.33%  med= -4.17%  win= 40.2%  Sharpe=-0.028
    tier50_hold     n=63,285  mean=  -3.59%  med= -7.88%  win= 40.2%  Sharpe=-0.049
    flow_inv        n=59,831  mean=  +7.04%  med= -3.43%  win= 44.8%  Sharpe=+0.076
    EOD_hold        n=63,285  mean=  -3.85%  med=-12.04%  win= 36.2%  Sharpe=-0.032
    peak_ceiling*   n=63,285  mean= +62.22%  med=+26.11%  win= 94.5%  Sharpe=+0.459

    *peak_ceiling is look-ahead, NOT tradeable — shown as ceiling reference.

## 2. By mode

### A_intraday_0DTE (n=22,628)

    trail30/10      n=22,628  mean=  -2.43%  med=+15.62%  win= 61.6%  Sharpe=-0.047
    hard30m         n=22,628  mean=  -1.96%  med=-10.11%  win= 35.6%  Sharpe=-0.027
    tier50_hold     n=22,628  mean=  -6.51%  med=-17.50%  win= 33.2%  Sharpe=-0.062
    flow_inv        n=20,948  mean=  +8.80%  med= -8.98%  win= 40.0%  Sharpe=+0.062
    EOD_hold        n=22,628  mean=  -7.49%  med=-33.33%  win= 30.2%  Sharpe=-0.041
    peak_ceiling*   n=22,628  mean= +96.01%  med=+35.72%  win= 94.0%  Sharpe=+0.466

### B_multi_day_DTE1_3 (n=40,657)

    trail30/10      n=40,657  mean=  -0.82%  med= +4.05%  win= 53.9%  Sharpe=-0.023
    hard30m         n=40,657  mean=  -0.99%  med= -2.56%  win= 42.8%  Sharpe=-0.038
    tier50_hold     n=40,657  mean=  -1.96%  med= -4.09%  win= 44.1%  Sharpe=-0.043
    flow_inv        n=38,883  mean=  +6.09%  med= -1.50%  win= 47.3%  Sharpe=+0.118
    EOD_hold        n=40,657  mean=  -1.83%  med= -7.46%  win= 39.5%  Sharpe=-0.031
    peak_ceiling*   n=40,657  mean= +43.41%  med=+22.58%  win= 94.8%  Sharpe=+0.690

## 3. By tier

### T1 (n=9,000)

    trail30/10      n= 9,000  mean=  -1.82%  med=+19.82%  win= 67.1%  Sharpe=-0.033
    hard30m         n= 9,000  mean=  -2.03%  med=-25.10%  win= 31.8%  Sharpe=-0.025
    tier50_hold     n= 9,000  mean=  -4.23%  med=-24.00%  win= 31.6%  Sharpe=-0.035
    flow_inv        n= 8,840  mean= +15.51%  med=-14.58%  win= 39.9%  Sharpe=+0.089
    EOD_hold        n= 9,000  mean=  -1.95%  med=-66.67%  win= 30.3%  Sharpe=-0.009
    peak_ceiling*   n= 9,000  mean=+127.50%  med=+50.00%  win= 95.4%  Sharpe=+0.528

### T2 (n=11,939)

    trail30/10      n=11,939  mean=  -0.47%  med=+18.87%  win= 62.9%  Sharpe=-0.010
    hard30m         n=11,939  mean=  -1.64%  med= -7.80%  win= 39.1%  Sharpe=-0.028
    tier50_hold     n=11,939  mean=  -1.74%  med=-14.29%  win= 38.6%  Sharpe=-0.017
    flow_inv        n=10,856  mean= +12.56%  med= -3.22%  win= 46.7%  Sharpe=+0.113
    EOD_hold        n=11,939  mean=  +0.20%  med=-23.85%  win= 33.9%  Sharpe=+0.001
    peak_ceiling*   n=11,939  mean= +88.13%  med=+38.89%  win= 94.8%  Sharpe=+0.487

### T3 (n=42,346)

    trail30/10      n=42,346  mean=  -1.56%  med= +2.19%  win= 52.7%  Sharpe=-0.044
    hard30m         n=42,346  mean=  -1.10%  med= -2.38%  win= 42.3%  Sharpe=-0.033
    tier50_hold     n=42,346  mean=  -3.97%  med= -4.74%  win= 42.4%  Sharpe=-0.089
    flow_inv        n=40,135  mean=  +3.68%  med= -2.53%  win= 45.3%  Sharpe=+0.068
    EOD_hold        n=42,346  mean=  -5.40%  med= -7.75%  win= 38.1%  Sharpe=-0.093
    peak_ceiling*   n=42,346  mean= +41.04%  med=+20.72%  win= 94.3%  Sharpe=+0.627

## 4. By time of day

### AM_open (n=18,583)

    trail30/10      n=18,583  mean=  -1.35%  med=+18.49%  win= 60.1%  Sharpe=-0.030
    hard30m         n=18,583  mean=  -3.46%  med= -8.66%  win= 37.3%  Sharpe=-0.078
    tier50_hold     n=18,583  mean=  -5.20%  med=-13.56%  win= 38.9%  Sharpe=-0.068
    flow_inv        n=18,325  mean=  +9.44%  med= -5.16%  win= 44.8%  Sharpe=+0.083
    EOD_hold        n=18,583  mean=  -5.41%  med=-21.85%  win= 33.9%  Sharpe=-0.044
    peak_ceiling*   n=18,583  mean= +75.03%  med=+36.44%  win= 96.0%  Sharpe=+0.532

### MID (n=20,710)

    trail30/10      n=20,710  mean=  -1.70%  med=+14.81%  win= 58.2%  Sharpe=-0.038
    hard30m         n=20,710  mean=  -1.49%  med= -4.68%  win= 39.6%  Sharpe=-0.037
    tier50_hold     n=20,710  mean=  -3.42%  med=-11.59%  win= 39.9%  Sharpe=-0.046
    flow_inv        n=20,411  mean= +10.01%  med= -2.69%  win= 46.4%  Sharpe=+0.113
    EOD_hold        n=20,710  mean=  -3.23%  med=-15.77%  win= 36.6%  Sharpe=-0.028
    peak_ceiling*   n=20,710  mean= +68.31%  med=+30.75%  win= 95.5%  Sharpe=+0.512

### LUNCH (n=7,045)

    trail30/10      n= 7,045  mean=  +0.14%  med=+12.07%  win= 59.2%  Sharpe=+0.004
    hard30m         n= 7,045  mean=  +2.28%  med= -1.76%  win= 45.0%  Sharpe=+0.056
    tier50_hold     n= 7,045  mean=  -4.20%  med= -5.77%  win= 43.5%  Sharpe=-0.066
    flow_inv        n= 6,857  mean=  +6.29%  med= -1.57%  win= 47.4%  Sharpe=+0.090
    EOD_hold        n= 7,045  mean=  -8.26%  med=-11.38%  win= 38.2%  Sharpe=-0.081
    peak_ceiling*   n= 7,045  mean= +59.05%  med=+28.57%  win= 95.4%  Sharpe=+0.502

### PM (n=16,947)

    trail30/10      n=16,947  mean=  -1.71%  med= +0.00%  win= 50.0%  Sharpe=-0.049
    hard30m         n=16,947  mean=  -0.31%  med= -1.87%  win= 42.2%  Sharpe=-0.005
    tier50_hold     n=16,947  mean=  -1.76%  med= -3.51%  win= 40.5%  Sharpe=-0.025
    flow_inv        n=14,238  mean=  +0.04%  med= -3.62%  win= 41.1%  Sharpe=+0.001
    EOD_hold        n=16,947  mean=  -1.06%  med= -5.17%  win= 37.4%  Sharpe=-0.008
    peak_ceiling*   n=16,947  mean= +42.05%  med=+14.29%  win= 91.4%  Sharpe=+0.307

## 5. Best policy per (mode, tier, TOD) cell

    mode                   tier  tod             n   best             best_mean     gap_to_2nd
    B_multi_day_DTE1_3     T3    MID        12,444   flow_inv            +7.49%         +8.57pp
    B_multi_day_DTE1_3     T3    AM_open    10,630   flow_inv            +6.19%         +8.62pp
    B_multi_day_DTE1_3     T3    PM          9,898   hard30m             -0.74%         +0.90pp
    B_multi_day_DTE1_3     T3    LUNCH       4,255   flow_inv            +5.05%         +2.47pp
    A_intraday_0DTE        T1    AM_open     3,703   flow_inv            +6.79%         +9.31pp
    A_intraday_0DTE        T1    MID         3,547   flow_inv           +36.95%         +7.30pp
    A_intraday_0DTE        T2    PM          3,378   EOD_hold           +22.24%         +7.58pp
    A_intraday_0DTE        T2    MID         2,646   trail30/10          -8.46%         +2.02pp
    A_intraday_0DTE        T3    PM          2,235   flow_inv            +1.36%         +0.29pp
    B_multi_day_DTE1_3     T2    AM_open     1,995   flow_inv           +27.52%         +0.36pp
    A_intraday_0DTE        T2    LUNCH       1,468   flow_inv           +15.04%         +8.51pp
    A_intraday_0DTE        T3    AM_open     1,238   flow_inv            -2.60%         +1.30pp
    A_intraday_0DTE        T3    MID         1,140   flow_inv            -4.05%         +0.81pp
    A_intraday_0DTE        T1    PM          1,090   hard30m             -5.09%         +6.36pp
    A_intraday_0DTE        T2    AM_open     1,017   flow_inv           +32.95%        +34.77pp
    B_multi_day_DTE1_3     T2    MID           933   flow_inv           +25.83%        +18.84pp
    A_intraday_0DTE        T1    LUNCH         660   flow_inv            -3.39%         +5.21pp
    A_intraday_0DTE        T3    LUNCH         506   hard30m             +3.71%         +0.46pp
    B_multi_day_DTE1_3     T2    PM            346   flow_inv            +1.78%         +1.77pp
    B_multi_day_DTE1_3     T2    LUNCH         156   flow_inv           +30.91%         +3.47pp

## 6. Composite oracle: best-per-cell vs single-best-everywhere

    Best single-policy across all fires:  flow_inv  mean=+7.04%
    Composite (best-per-stratum oracle):  mean=+8.11%
    Gap (in-sample, look-ahead):          +1.07pp
    ↑ This is an UPPER BOUND on stratified routing — overfit, in-sample.

## 7. minutes_to_peak distribution (signal for hidden exit policy)

    bin           count   cum%
    0-5          14,691  23.2%
    5-10          4,742  30.7%
    10-15         3,210  35.8%
    15-20         2,703  40.1%
    20-30         4,149  46.6%
    30-45         4,648  54.0%
    45-60         3,772  59.9%
    60-90         5,434  68.5%
    90-120        4,182  75.1%
    120-180       6,233  85.0%
    180-240       3,972  91.2%
    240-330       3,876  97.4%
    >330          1,673 100.0%

    median minutes_to_peak = 37 min
    p25 = 6, p75 = 119, p90 = 227

## 8. When do _winning_ fires (peak ≥50%) peak?

    Winners: 20,236 (32.0% of all fires)
    Their median time-to-peak: 100 min
    p10=16, p25=41, p75=201, p90=294

    bin           count   cum%
    0-5             583   2.9%
    5-10            716   6.4%
    10-15           636   9.6%
    15-20           667  12.9%
    20-30         1,250  19.0%
    30-45         1,667  27.3%
    45-60         1,626  35.3%
    60-90         2,348  46.9%
    90-120        1,899  56.3%
    120-180       2,993  71.1%
    180-240       2,255  82.2%
    240-330       2,340  93.8%
    >330          1,256 100.0%

## 9. Does flow_inversion exit close to the peak?

    Among 19,550 winning fires with flow_inv exit:
    Avg upside left on table: +99.37pp (peak − flow_inv)
    Median: +64.23pp,  p25: +33.96,  p75: +122.22
    Frac of peak captured (flow_inv / peak): mean=37.5%

## 10. Per-day variance — are some days outliers?

    Top 5 days where flow_inv > trail by the largest margin:
               n  mean_peak  pct_winners  best_trail  best_flow  flow_minus_trail

date  
2026-04-27 1560 104.91 36.54 4.25 45.74 41.49
2026-05-01 3279 185.36 56.05 1.02 38.73 37.71
2026-04-14 4629 52.37 27.76 -2.67 19.12 21.79
2026-04-15 3661 71.68 31.36 -0.06 19.71 19.77
2026-04-23 4385 70.36 45.02 5.74 17.43 11.69

    Bottom 5 days (trail > flow_inv):
               n  mean_peak  pct_winners  best_trail  best_flow  flow_minus_trail

date  
2026-04-29 6407 34.40 20.76 -3.65 -3.92 -0.27
2026-05-04 7553 69.59 39.81 0.70 -1.09 -1.79
2026-04-24 2574 74.69 40.29 -10.11 -12.08 -1.97
2026-04-16 3174 44.28 27.10 -8.79 -12.10 -3.31
2026-04-20 1619 33.34 20.44 -7.99 -17.59 -9.60
