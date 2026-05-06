# Flow-inversion per-mode parameter tuning

Dataset: 63,285 fires (11 train days, 6 test days)

Frozen defaults: prom=0.05, window=5min, persist=3min

## A_intraday_0DTE

Train n=10,601 Test n=12,027

**Default** (prom=0.05, win=5, per=3):
train: n=9,462 mean=+12.03% med=-10.97% win=39.4% Sharpe=+0.0720
test: n=11,485 mean=+7.44% med=-7.29% win=41.3% Sharpe=+0.0656

36 combos searched in 316.5s. Top 10 by train Sharpe:

    prom win per        n   mean%    med%  win%   Sharpe
     0.1   3   2    9,005 +18.12%  -5.94% 43.0%  +0.1067
     0.1   5   2    9,005 +16.73%  -7.50% 41.7%  +0.0966
    0.05   3   2    9,462 +15.98%  -7.10% 42.1%  +0.0960
    0.03   3   2    9,512 +15.94%  -7.13% 42.1%  +0.0959
    0.07   3   2    9,326 +16.05%  -7.15% 42.1%  +0.0959
     0.1   3   3    9,005 +16.30%  -7.89% 41.7%  +0.0958
    0.07   5   2    9,326 +14.68%  -8.58% 40.8%  +0.0860
    0.03   5   2    9,512 +14.54%  -8.54% 40.9%  +0.0859
    0.05   5   2    9,462 +14.56%  -8.50% 40.9%  +0.0858
    0.07   3   3    9,326 +14.27%  -9.12% 40.8%  +0.0850

**Held-out test (top-3 train picks):**

    prom win per  |  train Sharpe | test n test mean% test Sharpe
     0.1   3   2  |       +0.1067 | 11,032     +6.92%     +0.0652
     0.1   5   2  |       +0.0966 | 11,032     +4.37%     +0.0438
    0.05   3   2  |       +0.0960 | 11,485    +10.20%     +0.0859

Best combo: prom=0.1, window=3, persist=2
Train Sharpe: +0.1067
Test Sharpe: +0.0652
Default test Sharpe: +0.0656
Test mean lift over default: -0.52pp
Stable (|train−test| < 0.05)? YES

## B_multi_day_DTE1_3

Train n=22,597 Test n=18,060

**Default** (prom=0.05, win=5, per=3):
train: n=21,393 mean=+7.52% med=-2.58% win=46.4% Sharpe=+0.1363
test: n=17,490 mean=+4.62% med=-0.60% win=48.8% Sharpe=+0.0975

48 combos searched in 1010.7s. Top 10 by train Sharpe:

    prom win per        n   mean%    med%  win%   Sharpe
    0.07   5   3    21,106  +7.71%  -2.48% 46.5%  +0.1388
     0.1   5   3    20,294  +7.63%  -2.29% 46.7%  +0.1381
    0.05   5   3    21,393  +7.52%  -2.58% 46.4%  +0.1363
    0.03   5   3    21,495  +7.47%  -2.58% 46.3%  +0.1354
    0.07   7   3    21,106  +6.78%  -2.73% 46.1%  +0.1255
     0.1   7   3    20,294  +6.64%  -2.58% 46.4%  +0.1238
    0.05   7   3    21,393  +6.62%  -2.77% 46.0%  +0.1232
    0.03   7   3    21,495  +6.56%  -2.78% 46.0%  +0.1224
    0.07   5   5    21,106  +6.25%  -3.01% 45.9%  +0.1168
     0.1   5   5    20,294  +6.11%  -2.85% 46.1%  +0.1149

**Held-out test (top-3 train picks):**

    prom win per  |  train Sharpe | test n test mean% test Sharpe
    0.07   5   3  |       +0.1388 | 17,172     +4.71%     +0.0991
     0.1   5   3  |       +0.1381 | 16,438     +4.93%     +0.1047
    0.05   5   3  |       +0.1363 | 17,490     +4.62%     +0.0975

Best combo: prom=0.07, window=5, persist=3
Train Sharpe: +0.1388
Test Sharpe: +0.0991
Default test Sharpe: +0.0975
Test mean lift over default: +0.09pp
Stable (|train−test| < 0.05)? YES
