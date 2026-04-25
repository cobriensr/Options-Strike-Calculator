# IV-Anomaly Stratification — 2026-04-25
**Sample:** 14749 backfill alerts, sliced by 8 detector-gate dimensions.

**Strategy used:** the per-ticker best non-oracle strategy from Phase B (NDXP/MSFT/META/MU/QQQ/SPY/SPXW/NVDA → hold-to-EOD; IWM/TSLA/MSTR/SNDK/SMH → sell-on-ITM-touch).

Each table groups alerts by gate dimension and reports the win rate + PnL stats on the best-strategy outcome — directly answers "does this gate value concentrate winners?"

**Caveats:** 10-day sample; per-bucket subsets get small fast. Treat as directional. Live data thickens the population over time.

## Q1. Per-ticker — already shown in Phase B report
See `ml/reports/iv-anomaly-backtest-2026-04-25.md` for the per-ticker leaderboard. Ranking summary: NDXP (53.9% win, +3.9% median) is the only ticker with positive median PnL; MSFT (32%) and META (30%) are the runners-up; SPY/QQQ/SPXW dominate volume but cluster at ~10% win rate; single names (TSLA/NVDA/MSTR/MU/SNDK/SMH) at <5%.

## Q2. Signal-stack count (more reasons = better signal?)
### All tickers

| signal_count | n | win% | 30%+ win | mean | median | max loss | max gain |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 10761 | 10.6% | 6.6% | -51.7% | -99.7% | -100.0% | +5604.8% |
| 2 | 3988 | 9.4% | 6.5% | -53.5% | -100.0% | -100.0% | +4579.4% |
### Per ticker

| ticker | signal_count | n | win% | 30%+ win | mean | median | max loss | max gain |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IWM | 1 | 315 | 7.6% | 4.8% | -28.9% | -88.5% | -100.0% | +2731.4% |
| IWM | 2 | 42 | 7.1% | 7.1% | +82.7% | -100.0% | -100.0% | +2843.6% |
| META | 1 | 118 | 27.1% | 23.7% | -13.9% | -68.5% | -100.0% | +698.4% |
| META | 2 | 44 | 38.6% | 34.1% | +16.5% | -88.0% | -100.0% | +514.8% |
| MSFT | 1 | 133 | 31.6% | 18.8% | +5.9% | -98.2% | -100.0% | +1536.7% |
| MSFT | 2 | 36 | 33.3% | 22.2% | +16.1% | -74.8% | -100.0% | +975.0% |
| MSTR | 1 | 6 | 0.0% | 0.0% | -83.9% | -99.8% | -99.8% | -4.7% |
| MSTR | 2 | 2 | 0.0% | 0.0% | -51.6% | -51.6% | -99.8% | -3.3% |
| MU | 1 | 22 | 9.1% | 4.5% | -69.6% | -96.9% | -100.0% | +197.2% |
| MU | 2 | 9 | 0.0% | 0.0% | -79.1% | -100.0% | -100.0% | -4.5% |
| NDXP | 1 | 97 | 55.7% | 11.3% | +0.8% | +4.0% | -100.0% | +366.7% |
| NDXP | 2 | 18 | 44.4% | 5.6% | -10.9% | -4.6% | -100.0% | +62.5% |
| NVDA | 1 | 141 | 2.8% | 0.7% | -78.2% | -97.2% | -100.0% | +36.1% |
| NVDA | 2 | 18 | 0.0% | 0.0% | -90.6% | -97.4% | -100.0% | -80.0% |
| QQQ | 1 | 3248 | 11.3% | 7.1% | -52.7% | -99.4% | -100.0% | +4123.0% |
| QQQ | 2 | 1508 | 9.0% | 6.8% | -45.7% | -100.0% | -100.0% | +2862.1% |
| SMH | 1 | 2 | 0.0% | 0.0% | -100.0% | -100.0% | -100.0% | -100.0% |
| SMH | 2 | 1 | 0.0% | 0.0% | -100.0% | -100.0% | -100.0% | -100.0% |
| SNDK | 1 | 17 | 0.0% | 0.0% | -66.0% | -95.0% | -99.9% | -1.4% |
| SPXW | 1 | 2675 | 9.1% | 6.4% | -42.3% | -100.0% | -100.0% | +5604.8% |
| SPXW | 2 | 444 | 10.4% | 6.3% | -47.6% | -100.0% | -100.0% | +4579.4% |
| SPY | 1 | 3452 | 10.4% | 6.5% | -59.7% | -99.6% | -100.0% | +2866.7% |
| SPY | 2 | 1594 | 8.7% | 5.8% | -65.3% | -100.0% | -100.0% | +1188.0% |
| TSLA | 1 | 535 | 2.8% | 0.2% | -78.3% | -100.0% | -100.0% | +144.8% |
| TSLA | 2 | 272 | 5.1% | 4.0% | -78.4% | -100.0% | -100.0% | +155.9% |

## Q3. Session phase (open / morning / midday / afternoon)
### All tickers

| session_phase | n | win% | 30%+ win | mean | median | max loss | max gain |
| --- | --- | --- | --- | --- | --- | --- | --- |
| midday | 12953 | 10.6% | 6.8% | -52.6% | -100.0% | -100.0% | +5604.8% |
| afternoon | 1796 | 8.0% | 4.6% | -49.4% | -98.5% | -100.0% | +4123.0% |

## Q4. Vol/OI bucket (gate is currently ≥5×)
### All tickers

| vol_oi_bucket | n | win% | 30%+ win | mean | median | max loss | max gain |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <5× | 9 | 11.1% | 11.1% | -34.7% | -98.1% | -100.0% | +285.7% |
| 5-10× | 5100 | 14.5% | 8.8% | -42.6% | -99.7% | -100.0% | +4618.7% |
| 10-50× | 5822 | 11.6% | 7.9% | -38.6% | -99.7% | -100.0% | +5604.8% |
| 50-200× | 2001 | 3.3% | 2.4% | -82.0% | -100.0% | -100.0% | +441.4% |
| 200×+ | 1817 | 1.7% | 0.6% | -89.9% | -100.0% | -100.0% | +55.0% |

## Q5. OTM distance bucket
### All tickers

| otm_distance_bucket | n | win% | 30%+ win | mean | median | max loss | max gain |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <0.5% | 10927 | 11.7% | 7.5% | -44.4% | -100.0% | -100.0% | +5604.8% |
| 0.5-1% | 2766 | 6.7% | 4.2% | -74.6% | -100.0% | -100.0% | +2843.6% |
| 1-2% | 897 | 4.5% | 3.0% | -75.7% | -98.2% | -100.0% | +630.8% |
| 2-5% | 136 | 8.8% | 3.7% | -72.2% | -94.0% | -100.0% | +135.3% |
| 5-10% | 9 | 0.0% | 0.0% | -93.3% | -99.8% | -99.8% | -79.8% |
### Per ticker

| ticker | otm_distance_bucket | n | win% | 30%+ win | mean | median | max loss | max gain |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IWM | <0.5% | 281 | 5.7% | 2.5% | -61.5% | -80.0% | -100.0% | +92.4% |
| IWM | 0.5-1% | 51 | 19.6% | 19.6% | +269.5% | -98.1% | -100.0% | +2843.6% |
| IWM | 1-2% | 19 | 0.0% | 0.0% | -91.6% | -96.8% | -99.4% | +0.0% |
| IWM | 2-5% | 6 | 16.7% | 16.7% | -58.0% | -91.9% | -98.0% | +31.6% |
| META | <0.5% | 128 | 35.9% | 32.0% | +2.8% | -68.5% | -100.0% | +698.4% |
| META | 0.5-1% | 14 | 7.1% | 0.0% | -55.9% | -50.0% | -100.0% | +0.7% |
| META | 1-2% | 12 | 0.0% | 0.0% | -32.1% | -50.0% | -84.9% | +0.0% |
| META | 2-5% | 8 | 25.0% | 25.0% | -13.1% | -3.9% | -98.9% | +100.0% |
| MSFT | <0.5% | 107 | 45.8% | 29.9% | +56.5% | -15.1% | -100.0% | +1536.7% |
| MSFT | 0.5-1% | 44 | 4.5% | 0.0% | -85.7% | -100.0% | -100.0% | +4.2% |
| MSFT | 1-2% | 10 | 0.0% | 0.0% | -52.7% | -64.6% | -100.0% | +0.0% |
| MSFT | 2-5% | 7 | 42.9% | 14.3% | -40.8% | -94.4% | -99.5% | +81.4% |
| MSTR | 2-5% | 3 | 0.0% | 0.0% | -36.0% | -4.7% | -99.8% | -3.3% |
| MSTR | 5-10% | 5 | 0.0% | 0.0% | -99.8% | -99.8% | -99.8% | -99.8% |
| MU | <0.5% | 17 | 11.8% | 5.9% | -60.0% | -100.0% | -100.0% | +197.2% |
| MU | 0.5-1% | 7 | 0.0% | 0.0% | -80.6% | -100.0% | -100.0% | -4.5% |
| MU | 1-2% | 5 | 0.0% | 0.0% | -92.7% | -96.9% | -100.0% | -83.3% |
| MU | 2-5% | 2 | 0.0% | 0.0% | -98.4% | -98.4% | -99.8% | -96.9% |
| NDXP | <0.5% | 40 | 67.5% | 25.0% | +34.5% | +16.0% | -100.0% | +366.7% |
| NDXP | 0.5-1% | 64 | 54.7% | 3.1% | -7.1% | +2.5% | -100.0% | +68.7% |
| NDXP | 1-2% | 11 | 0.0% | 0.0% | -95.5% | -100.0% | -100.0% | -50.0% |
| NVDA | <0.5% | 24 | 0.0% | 0.0% | -91.7% | -100.0% | -100.0% | -80.0% |
| NVDA | 0.5-1% | 76 | 2.6% | 1.3% | -76.0% | -80.0% | -100.0% | +36.1% |
| NVDA | 1-2% | 47 | 4.3% | 0.0% | -77.5% | -97.3% | -99.5% | +2.5% |
| NVDA | 2-5% | 12 | 0.0% | 0.0% | -86.0% | -92.4% | -94.3% | -8.6% |
| QQQ | <0.5% | 3497 | 12.2% | 7.8% | -42.3% | -99.8% | -100.0% | +4123.0% |
| QQQ | 0.5-1% | 927 | 5.6% | 4.3% | -75.5% | -100.0% | -100.0% | +2375.2% |
| QQQ | 1-2% | 295 | 7.1% | 5.8% | -65.6% | -96.7% | -100.0% | +429.5% |
| QQQ | 2-5% | 33 | 6.1% | 0.0% | -78.8% | -88.9% | -99.0% | +7.5% |
| SMH | <0.5% | 1 | 0.0% | 0.0% | -100.0% | -100.0% | -100.0% | -100.0% |
| SMH | 1-2% | 2 | 0.0% | 0.0% | -100.0% | -100.0% | -100.0% | -100.0% |
| SNDK | <0.5% | 5 | 0.0% | 0.0% | -89.5% | -99.9% | -99.9% | -74.0% |
| SNDK | 0.5-1% | 2 | 0.0% | 0.0% | -37.7% | -37.7% | -74.0% | -1.4% |
| SNDK | 1-2% | 5 | 0.0% | 0.0% | -21.7% | -3.3% | -95.0% | -3.3% |
| SNDK | 2-5% | 4 | 0.0% | 0.0% | -98.1% | -99.1% | -99.1% | -95.0% |
| SNDK | 5-10% | 1 | 0.0% | 0.0% | -99.0% | -99.0% | -99.0% | -99.0% |
| SPXW | <0.5% | 2429 | 10.6% | 7.2% | -30.9% | -100.0% | -100.0% | +5604.8% |
| SPXW | 0.5-1% | 531 | 4.0% | 3.0% | -88.1% | -100.0% | -100.0% | +729.1% |
| SPXW | 1-2% | 131 | 6.9% | 4.6% | -80.0% | -98.3% | -100.0% | +269.4% |
| SPXW | 2-5% | 23 | 8.7% | 4.3% | -73.7% | -96.0% | -98.8% | +135.3% |
| SPXW | 5-10% | 3 | 0.0% | 0.0% | -80.7% | -81.1% | -81.2% | -79.8% |
| SPY | <0.5% | 4045 | 10.7% | 6.6% | -56.3% | -100.0% | -100.0% | +2866.7% |
| SPY | 0.5-1% | 852 | 6.8% | 5.3% | -85.9% | -100.0% | -100.0% | +153.0% |
| SPY | 1-2% | 137 | 2.9% | 2.9% | -63.6% | -95.0% | -100.0% | +630.8% |
| SPY | 2-5% | 6 | 0.0% | 0.0% | -60.3% | -63.1% | -97.3% | -11.2% |
| TSLA | <0.5% | 353 | 5.7% | 3.1% | -58.5% | -76.1% | -100.0% | +155.9% |
| TSLA | 0.5-1% | 198 | 1.5% | 0.5% | -94.1% | -100.0% | -100.0% | +32.8% |
| TSLA | 1-2% | 223 | 1.8% | 0.0% | -95.1% | -100.0% | -100.0% | +12.5% |
| TSLA | 2-5% | 32 | 6.2% | 0.0% | -84.0% | -100.0% | -100.0% | +4.3% |

## Q6. Side-skew bucket (gate is currently ≥0.65)
### All tickers

| side_skew_bucket | n | win% | 30%+ win | mean | median | max loss | max gain |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.65-0.75 | 22 | 13.6% | 9.1% | +139.8% | -99.4% | -100.0% | +2617.4% |
| 0.75-0.85 | 4715 | 11.9% | 8.1% | -51.4% | -100.0% | -100.0% | +3593.7% |
| 0.85-0.95 | 3826 | 10.2% | 6.8% | -51.0% | -100.0% | -100.0% | +4618.7% |
| 0.95-1.0 | 3517 | 8.9% | 5.1% | -56.0% | -100.0% | -100.0% | +5604.8% |
| 1.0+ | 2669 | 9.3% | 5.5% | -51.9% | -100.0% | -100.0% | +5242.7% |

## Q7. flow_phase classifier output
### All tickers

| flow_phase | n | win% | 30%+ win | mean | median | max loss | max gain |
| --- | --- | --- | --- | --- | --- | --- | --- |
| early | 5084 | 6.2% | 4.2% | -61.6% | -100.0% | -100.0% | +5604.8% |
| mid | 4692 | 11.9% | 7.4% | -49.9% | -99.3% | -100.0% | +5242.7% |
| reactive | 4973 | 12.8% | 8.1% | -44.8% | -99.5% | -100.0% | +4618.7% |
### Per ticker

| ticker | flow_phase | n | win% | 30%+ win | mean | median | max loss | max gain |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IWM | early | 54 | 20.4% | 20.4% | +260.8% | -95.8% | -100.0% | +2843.6% |
| IWM | mid | 164 | 4.9% | 3.0% | -67.5% | -95.7% | -100.0% | +92.4% |
| IWM | reactive | 139 | 5.8% | 1.4% | -62.1% | -85.1% | -100.0% | +58.9% |
| META | early | 17 | 29.4% | 23.5% | -16.3% | -2.3% | -98.9% | +100.0% |
| META | mid | 89 | 21.3% | 21.3% | -37.0% | -92.9% | -100.0% | +267.4% |
| META | reactive | 56 | 44.6% | 35.7% | +47.4% | -50.0% | -100.0% | +698.4% |
| MSFT | early | 46 | 10.9% | 2.2% | -68.1% | -100.0% | -100.0% | +81.4% |
| MSFT | mid | 85 | 38.8% | 23.5% | -27.0% | -53.3% | -100.0% | +272.3% |
| MSFT | reactive | 38 | 42.1% | 31.6% | +178.6% | -49.1% | -100.0% | +1536.7% |
| MSTR | early | 8 | 0.0% | 0.0% | -75.8% | -99.8% | -99.8% | -3.3% |
| MU | early | 17 | 5.9% | 0.0% | -74.3% | -96.9% | -100.0% | +28.1% |
| MU | mid | 13 | 7.7% | 7.7% | -69.6% | -100.0% | -100.0% | +197.2% |
| MU | reactive | 1 | 0.0% | 0.0% | -76.3% | -76.3% | -76.3% | -76.3% |
| NDXP | early | 54 | 42.6% | 3.7% | -16.8% | -8.1% | -100.0% | +326.4% |
| NDXP | mid | 54 | 63.0% | 16.7% | +13.3% | +7.5% | -100.0% | +366.7% |
| NDXP | reactive | 7 | 71.4% | 14.3% | +8.9% | +13.5% | -19.4% | +41.2% |
| NVDA | early | 54 | 7.4% | 1.9% | -61.7% | -93.1% | -100.0% | +36.1% |
| NVDA | mid | 82 | 0.0% | 0.0% | -88.0% | -97.2% | -100.0% | -56.1% |
| NVDA | reactive | 23 | 0.0% | 0.0% | -91.3% | -100.0% | -100.0% | -80.0% |
| QQQ | early | 1652 | 6.8% | 5.4% | -57.4% | -100.0% | -100.0% | +2862.1% |
| QQQ | mid | 1478 | 10.4% | 6.6% | -48.2% | -98.8% | -100.0% | +4123.0% |
| QQQ | reactive | 1626 | 14.6% | 8.9% | -45.5% | -99.4% | -100.0% | +1319.3% |
| SMH | early | 2 | 0.0% | 0.0% | -100.0% | -100.0% | -100.0% | -100.0% |
| SMH | mid | 1 | 0.0% | 0.0% | -100.0% | -100.0% | -100.0% | -100.0% |
| SNDK | early | 10 | 0.0% | 0.0% | -64.9% | -84.5% | -99.1% | -3.3% |
| SNDK | mid | 4 | 0.0% | 0.0% | -43.5% | -38.7% | -95.0% | -1.4% |
| SNDK | reactive | 3 | 0.0% | 0.0% | -99.9% | -99.9% | -99.9% | -99.9% |
| SPXW | early | 1107 | 5.8% | 3.5% | -58.0% | -100.0% | -100.0% | +5604.8% |
| SPXW | mid | 986 | 9.6% | 7.0% | -40.7% | -100.0% | -100.0% | +5242.7% |
| SPXW | reactive | 1026 | 12.7% | 8.9% | -29.3% | -100.0% | -100.0% | +4618.7% |
| SPY | early | 1650 | 5.3% | 4.1% | -72.5% | -100.0% | -100.0% | +2292.4% |
| SPY | mid | 1544 | 13.3% | 8.2% | -54.2% | -98.8% | -100.0% | +2866.7% |
| SPY | reactive | 1852 | 10.9% | 6.6% | -57.7% | -99.6% | -100.0% | +1413.5% |
| TSLA | early | 413 | 1.0% | 0.2% | -92.2% | -100.0% | -100.0% | +32.8% |
| TSLA | mid | 192 | 5.2% | 0.0% | -77.5% | -100.0% | -100.0% | +13.3% |
| TSLA | reactive | 202 | 7.4% | 5.4% | -51.0% | -71.7% | -100.0% | +155.9% |

## Q8. side_dominant (ask vs bid)
### All tickers

| side_dominant | n | win% | 30%+ win | mean | median | max loss | max gain |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ask | 8668 | 8.7% | 5.7% | -56.3% | -100.0% | -100.0% | +5604.8% |
| bid | 6081 | 12.5% | 7.8% | -46.4% | -99.3% | -100.0% | +4123.0% |

### Drilldown: ticker × option-side × side_dominant
| ticker | option | side_dominant | n | win% | mean | median |
| --- | --- | --- | --- | --- | --- | --- |
| IWM | call | ask | 79 | 17.7% | +98.6% | -49.4% |
| IWM | call | bid | 52 | 17.3% | +70.3% | -29.5% |
| IWM | put | ask | 123 | 2.4% | -81.8% | -100.0% |
| IWM | put | bid | 103 | 1.0% | -68.1% | -85.1% |
| META | call | ask | 26 | 46.2% | +10.3% | -5.0% |
| META | call | bid | 43 | 62.8% | +66.2% | +54.7% |
| META | put | ask | 47 | 10.6% | -55.3% | -68.5% |
| META | put | bid | 46 | 10.9% | -31.1% | -68.5% |
| MSFT | call | ask | 51 | 47.1% | +20.9% | -11.0% |
| MSFT | call | bid | 47 | 57.4% | +133.0% | +5.9% |
| MSFT | put | ask | 37 | 5.4% | -79.2% | -100.0% |
| MSFT | put | bid | 34 | 2.9% | -89.1% | -100.0% |
| MSTR | call | ask | 2 | 0.0% | -99.8% | -99.8% |
| MSTR | call | bid | 4 | 0.0% | -99.8% | -99.8% |
| MSTR | put | ask | 2 | 0.0% | -4.0% | -4.0% |
| MU | call | bid | 1 | 0.0% | -4.5% | -4.5% |
| MU | put | ask | 10 | 10.0% | -71.5% | -79.8% |
| MU | put | bid | 20 | 5.0% | -76.2% | -100.0% |
| NDXP | call | ask | 44 | 59.1% | +7.1% | +4.1% |
| NDXP | call | bid | 52 | 69.2% | +27.2% | +9.4% |
| NDXP | put | ask | 8 | 0.0% | -93.8% | -100.0% |
| NDXP | put | bid | 11 | 0.0% | -100.0% | -100.0% |
| NVDA | call | ask | 16 | 0.0% | -71.2% | -64.9% |
| NVDA | call | bid | 13 | 0.0% | -80.7% | -92.2% |
| NVDA | put | ask | 73 | 2.7% | -85.8% | -97.4% |
| NVDA | put | bid | 57 | 3.5% | -73.6% | -80.0% |
| QQQ | call | ask | 805 | 28.6% | +19.8% | -38.6% |
| QQQ | call | bid | 784 | 34.7% | +45.4% | -26.8% |
| QQQ | put | ask | 1871 | 0.1% | -93.3% | -100.0% |
| QQQ | put | bid | 1296 | 0.0% | -90.3% | -100.0% |
| SMH | put | bid | 3 | 0.0% | -100.0% | -100.0% |
| SNDK | call | ask | 2 | 0.0% | -99.9% | -99.9% |
| SNDK | call | bid | 1 | 0.0% | -99.9% | -99.9% |
| SNDK | put | ask | 6 | 0.0% | -46.0% | -38.7% |
| SNDK | put | bid | 8 | 0.0% | -68.4% | -84.5% |
| SPXW | call | ask | 693 | 20.2% | +2.1% | -100.0% |
| SPXW | call | bid | 343 | 25.9% | -24.9% | -97.3% |
| SPXW | put | ask | 1395 | 2.9% | -55.2% | -100.0% |
| SPXW | put | bid | 688 | 2.9% | -72.9% | -99.7% |
| SPY | call | ask | 976 | 19.4% | -35.7% | -100.0% |
| SPY | call | bid | 785 | 28.4% | +3.3% | -66.6% |
| SPY | put | ask | 1956 | 2.5% | -86.4% | -100.0% |
| SPY | put | bid | 1329 | 2.7% | -82.0% | -99.7% |
| TSLA | call | ask | 216 | 6.9% | -72.1% | -100.0% |
| TSLA | call | bid | 153 | 4.6% | -73.1% | -99.7% |
| TSLA | put | ask | 230 | 1.3% | -80.7% | -100.0% |
| TSLA | put | bid | 208 | 1.9% | -86.1% | -100.0% |

## Headline interpretation
Decisions to consider for production gate tuning. Each is a hypothesis informed by the strata above — re-evaluate after live data thickens the population (target: 4-6 weeks).

### 1. Vol/OI ratio is COUNTERINTUITIVELY non-monotonic
Win rate by vol/OI bucket: 5-10× = 14.5%, 50-200× = 3.3%, 200×+ = 1.7%. **The highest ratios produce the LOWEST win rates.** Likely interpretation: extreme vol/OI fires on lottery-ticket strikes where smart money is closing inventory or where MMs are absorbing one-sided dump flow — neither of which means 'spot is about to move toward the strike.' Consider a vol/OI CEILING (e.g. ignore alerts > 200×) per ticker.

### 2. OTM distance: closer to ATM wins more
Win rate at <0.5% OTM: 11.7%. At 5-10% OTM: 0.0%. Closer-to-ATM strikes are more likely to finish ITM (need a smaller move). The ±12% cash-index gate captures a lot of unactionable far-OTM lottery tickets — consider tightening to ±5% for SPXW/NDXP if win rate matters more than coverage.

### 3. Signal-stack count NOT predictive on average
Win rate with 1 signal: 10.6%. With 2 signals: 9.4%. Multi-signal alerts are NOT systematically better — and on some tickers (NVDA, MU, MSTR) they're actually worse. Hypothesis: z_score firing on top of skew_delta often indicates the signal is already 'in motion' (mid-phase / late) rather than 'fresh accumulation' (early-phase). Check flow_phase × signal_count × ticker — drives gate weighting in production UI display priority.

### 4. NDXP is structurally different
Across every stratum, NDXP punches above its weight: 55.7% win rate on single-signal alerts vs ~10% for SPXW/SPY/QQQ. Structural candidates: NQ futures spot tracking (cleaner than ETF dealer hedging), wider strikes (less retracement risk), or genuinely different informed-flow population. Worth a deeper look before extrapolating gate changes.

### 5. Single-name 0DTE alerts are the worst class
TSLA / NVDA / MSTR / MU / SNDK / SMH show 0-4% win rates with -66% to -100% mean PnL. The detector is firing on these but the downstream price action doesn't materialize within the 0DTE/short-dated window. Two responses to consider: (a) tighten gates further for these tickers (higher OI floor, tighter vol/OI ceiling), or (b) limit display priority on these tickers in the UI so they don't compete for attention with higher-conviction signals.

### 6. Hold-to-EOD generally beats sell-on-ITM-touch
Hold-to-EOD wins as the best non-oracle on 8 of 13 tickers. The premise that '0DTE retraces require sell-on-touch' isn't broadly supported — when alerts touch ITM, they tend to stay there often enough that holding pays. Exception: IWM, TSLA, MSTR, SNDK, SMH — these prefer ITM-touch exits, which aligns with their high retrace rates in the Phase B 0DTE-retrace plot.

