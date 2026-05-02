# Per-Ticker TTP Reference (15 trade days, v3 alerts only)

| Ticker |   n | Median TTP | Median peak ret | Pre-peak DD | % noise <5m | % dev ≥15m | % late ≥60m | Category    |
| ------ | --: | ---------: | --------------: | ----------: | ----------: | ---------: | ----------: | ----------- |
| USAR   |  18 |     76 min |           +169% |        -10% |          6% |        94% |         56% | patient     |
| WMT    |  22 |     51 min |           +105% |        -28% |         14% |        73% |         41% | standard    |
| STX    |  15 |     22 min |           +103% |        -27% |         13% |        80% |          7% | standard    |
| WDC    |  30 |     17 min |            +87% |        -12% |         30% |        57% |         10% | fast_clean  |
| XOM    |  25 |     64 min |            +80% |        -25% |         16% |        68% |         52% | patient     |
| SNDK   | 122 |     40 min |            +73% |        -28% |         28% |        60% |         40% | standard    |
| SOUN   |  16 |    128 min |            +72% |        -40% |         12% |        81% |         62% | patient     |
| SNOW   |  30 |     17 min |            +70% |         -4% |         37% |        50% |         23% | fast_clean  |
| TSM    |  38 |     22 min |            +70% |        -21% |         29% |        60% |         40% | standard    |
| SMCI   |  27 |     29 min |            +67% |         -4% |         30% |        59% |         48% | standard    |
| RIVN   |  15 |    115 min |            +65% |        -22% |         20% |        80% |         67% | patient     |
| TNA    |  21 |     18 min |            +65% |        -16% |         29% |        67% |         48% | fast_clean  |
| USO    | 101 |     71 min |            +65% |        -22% |         16% |        77% |         56% | patient     |
| NDXP   | 100 |     25 min |            +62% |        -23% |         17% |        75% |         25% | standard    |
| TSLL   |  20 |     22 min |            +60% |        -18% |         30% |        60% |         40% | bimodal     |
| RKLB   |  37 |     65 min |            +58% |        -18% |         24% |        57% |         51% | patient     |
| TEAM   |  15 |     12 min |            +54% |        -17% |         33% |        40% |         33% | fast_clean  |
| SOFI   |  20 |     42 min |            +50% |        -21% |         20% |        70% |         45% | standard    |
| SQQQ   |  15 |     30 min |            +50% |        -18% |          7% |        80% |         33% | standard    |
| RDDT   |  33 |     25 min |            +50% |        -35% |         33% |        52% |         48% | bimodal     |
| TSLA   | 240 |     25 min |            +43% |         -9% |         28% |        56% |         42% | standard    |
| RUTW   |  69 |     24 min |            +42% |          0% |         32% |        56% |         30% | bimodal     |
| SMH    |  30 |     37 min |            +42% |        -20% |         17% |        70% |         30% | standard    |
| SOXS   |  19 |     23 min |            +41% |        -12% |         32% |        53% |         42% | bimodal     |
| WULF   |  16 |    101 min |            +40% |        -13% |         19% |        75% |         62% | patient     |
| SLV    | 118 |     41 min |            +39% |        -12% |         14% |        72% |         36% | standard    |
| SOXL   |  58 |     27 min |            +38% |        -14% |         28% |        60% |         38% | standard    |
| MSTR   |  17 |     65 min |            +38% |         -3% |         18% |        82% |         65% | standard    |
| TQQQ   |  34 |     74 min |            +36% |         -5% |         24% |        74% |         50% | standard    |
| UNH    |  26 |     14 min |            +33% |         -5% |         35% |        50% |         31% | bimodal     |
| RIOT   |  22 |     50 min |            +30% |         -1% |         32% |        64% |         46% | bimodal     |
| QQQ    | 187 |     95 min |            +29% |         -9% |         20% |        74% |         58% | standard    |
| RBLX   |  29 |      2 min |            +16% |          0% |         59% |        34% |         17% | noise_heavy |
| UBER   |  15 |     15 min |            +16% |          0% |         33% |        53% |         20% | standard    |

## Categories

- **fast_clean**: median TTP < 20min AND median peak ≥ 50% — fast pop, decent size
- **patient**: median TTP ≥ 60min AND median peak ≥ 40% — slow grinder, big winner
- **noise_heavy**: ≥50% of alerts peak in <5min — likely tradeable rarely
- **bimodal**: ≥30% noise AND ≥30% late peakers — needs a filter to separate the two
- **standard**: everything else
