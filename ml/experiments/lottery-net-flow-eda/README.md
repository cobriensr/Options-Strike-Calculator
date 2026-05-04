# Lottery Net Flow — EDA

Phase 2 of `docs/superpowers/specs/lottery-net-flow-eda-2026-05-03.md`.

## Question

Does ticker-level net flow (NCP / NPP) carry predictive signal for
`lottery_finder_fires` profitability — and if so, which feature?

## Pipeline

```
Postgres (lottery_finder_fires + net_flow_per_ticker_history)
        ↓ extract_features.py
features.parquet  (one row per fire + 10 net-flow features + outcomes)
        ↓ analyze.py
report.md + plots/*.png
```

## Run

```bash
# From repo root
ml/.venv/bin/python ml/experiments/lottery-net-flow-eda/extract_features.py
ml/.venv/bin/python ml/experiments/lottery-net-flow-eda/analyze.py
```

`extract_features.py` reads `DATABASE_URL` from env. Use the same
`.env.local` you'd source for the backfill script.

## Features (computed for the ticker's fire-side flow series)

| Feature | Definition |
|---------|------------|
| `ncp_at_fire` / `npp_at_fire` | Cumulative through `trigger_time_ct` |
| `ncp_slope_5m` / `_15m` / `_30m` | Δcumulative / window minutes |
| `asymmetry` | NCP / (NCP + NPP) at fire — 0.5 = balanced |
| `direction_match` | bool — call fire & matched-side slope > 0 |
| `level_pct_of_day_high` | matched-side at fire / max so far that day |
| `pre_fire_variance` | std of per-min deltas over prior 30 min |
| `lead_time_to_peak_min` | minutes since most recent matched-side local max (scipy.find_peaks, prominence ≥ 5% of day range) |

For call fires the **matched side is NCP**; for put fires it's NPP.
One feature vector per fire — no aggregation across sides.

## Decision rule for the report

Per `feedback_uniform_lift_is_leakage`: lift that is uniform across all
strata (cheap-call-PM, mode, TOD, top tickers) is a leakage fingerprint,
not signal. The findings memo flags features whose lift fails this test.
