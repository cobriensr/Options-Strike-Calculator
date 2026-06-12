# A3 — model vs on-path baselines (month walk-forward, OOS, mid basis)

- OOS test fires: 572,308  (train sample/fold: 60,000)

| policy | stats |
| --- | --- |
| MODEL thr=0.3 (best) | mean=  +1.7  median= -82.6  win%=30.9 |
| MODEL thr=0.4 | mean=  +0.2  median= -78.1  win%=31.1 |
| MODEL thr=0.5 | mean=  -2.0  median= -65.3  win%=31.2 |
| MODEL thr=0.6 | mean=  -8.1  median= -33.4  win%=31.6 |
| MODEL thr=0.7 | mean=  -9.3  median= -11.9  win%=31.9 |
| eod | mean=  +2.9  median= -86.3  win%=30.4 |
| trail30_10 | mean=  -8.7  median= +11.9  win%=58.5 |
| hard30m | mean=  -7.2  median=  -8.2  win%=34.3 |
| tier50_holdeod | mean=  -3.0  median= -25.1  win%=35.0 |
