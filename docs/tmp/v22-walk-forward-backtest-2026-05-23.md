# V2.2 Walk-Forward Backtest — 2026-05-23

## Method
- Training: 60 days (2026-02-22 to 2026-04-22), n=92,951 aligned fires
- Test: 30 days (2026-04-23 to 2026-05-23), n=71,989 aligned fires
- Strict no-leakage: models trained on training only, scored on test only
- Cutoffs t1=95th pct, t2=85th pct derived from training window score distribution
- Composite bonuses: top-5 winning + 5 losing combos mined from training window (10 total)
- Cluster bonus: computed from test-window temporal proximity (±5 min), tier1-gated
- Context features: 7 macro features (charm/vanna/gamma OI, mkt tide variants), boundaries from training window
- Direction gate: calls gated when mkt_tide_otm_diff signals counter-trend; puts NOT gated (reversed finding from 2026-05-22 audit)

## Cutoffs derived from training window
- V2 base: t1=10, t2=7
- V2.2 full: t1=14, t2=9

## Test-window results

### Tier 1 (score >= t1, top 5%)

| Model | n | mean_pct | median_pct | win_rate | hit_50 | sharpe |
| --- | --- | --- | --- | --- | --- | --- |
| V1 baseline | 8,645 | +45.9% | +17.6% | 62.5% | 30.3% | 0.324 |
| V2 base (OOS) | 2,411 | +26.9% | +8.2% | 59.0% | 23.8% | 0.285 |
| V2.2 full (OOS) | 3,736 | +21.7% | +7.4% | 57.4% | 22.1% | 0.227 |

### Tier 2+ (score >= t2, top 15%)

| Model | n | mean_pct | median_pct | win_rate | hit_50 | sharpe |
| --- | --- | --- | --- | --- | --- | --- |
| V1 baseline | 16,170 | +37.9% | +12.5% | 60.0% | 27.6% | 0.303 |
| V2 base (OOS) | 8,426 | +23.1% | +8.0% | 58.1% | 22.0% | 0.280 |
| V2.2 full (OOS) | 12,112 | +21.1% | +6.3% | 56.0% | 21.3% | 0.228 |

### Overall (all aligned fires in test window)

| Model | n | mean_pct | median_pct | win_rate | hit_50 | sharpe |
| --- | --- | --- | --- | --- | --- | --- |
| V1 baseline | 71,989 | +11.7% | -0.7% | 48.0% | 15.9% | 0.121 |
| V2 base (OOS) | 71,989 | +11.7% | -0.7% | 48.0% | 15.9% | 0.121 |
| V2.2 full (OOS) | 71,989 | +11.7% | -0.7% | 48.0% | 15.9% | 0.121 |

## Decision

- V2.2 Sharpe (tier1): 0.227
- V2 base Sharpe (tier1): 0.285
- V1 baseline Sharpe (tier1): 0.324
- V2.2 lift over V2 on tier1 Sharpe: -0.059
- V2.2 lift over V1 on tier1 Sharpe: -0.098

**Verdict: NOISE**
- Real: lift > +0.3 Sharpe | Marginal: 0 to +0.3 | Noise: <= 0

## Caveats

- 30-day test window is short (single split, not rolling walk-forward)
- Composite patterns mined on training window may still over-fit specific tickers
- Cluster bonus is computable from DB but the live detect cron uses an in-memory window — minor differences may exist for concurrent fires
- Direction gate (call-side only) is encoded in the alignment filter (cum_ncp > cum_npp for calls) — the relaxed put gate is implicit in the training/test data already
- Real trading P&L not measured here (no bid/ask spread, slippage, or position sizing)
