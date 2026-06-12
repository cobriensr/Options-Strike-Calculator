# A3 — model vs on-path baselines (month walk-forward, OOS, mid basis)

- OOS test fires: 53,306  (train sample/fold: 60,000)

| policy | stats |
| --- | --- |
| MODEL thr=0.3 | mean= -13.9  median= -61.6  win%=24.2 |
| MODEL thr=0.4 (best) | mean= -12.7  median= -53.4  win%=25.1 |
| MODEL thr=0.5 | mean= -13.4  median= -41.4  win%=26.0 |
| MODEL thr=0.6 | mean= -16.5  median= -21.3  win%=26.4 |
| MODEL thr=0.7 | mean= -23.3  median= -10.3  win%=19.1 |
| eod | mean= -30.0  median= -69.9  win%=22.7 |
| trail30_10 | mean= -28.0  median= -12.4  win%=43.4 |
| hard30m | mean= -25.0  median= -10.1  win%=19.8 |
| tier50_holdeod | mean= -21.6  median= -31.7  win%=29.5 |
