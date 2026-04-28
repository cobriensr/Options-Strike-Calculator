# Vega Spike EDA Findings

**Sample**: 38 total spike events.

- 28 with computable 15m forward return (for reference).
- 28 with computable EOD forward return (primary horizon — requires a close bar at 16:00 ET on the spike's date).
- 27/28 EOD-computable spikes have a per-hour value (one near-close spike excluded by the <1 min guard).

> **Primary horizon**: EOD (end-of-day / 16:00 ET close). Captures the full directional arc.

> **Metrics — two versions reported**:
>
> - `fwd_return_eod`: raw % return from spike bar to 16:00 ET close.
> - `fwd_return_per_hour`: `fwd_return_eod / hours_to_close` — time-normalized return rate (%/hour).
>
> **Why per-hour is the primary magnitude metric**: A spike at 09:35 ET has ~6.4 hours to close;
> a spike at 15:30 ET has only 0.5 hours. Median time-to-close: **258 min (4.3h)**.
> Absolute EOD returns conflate spike quality with time-of-day luck. Per-hour removes this confound
> and makes early- vs late-session spikes comparable on a velocity basis.
> Directionality (sign test) is IDENTICAL under both metrics — sign(per_hour) == sign(eod).
> Spikes with < 1 min to close are excluded from per-hour calculations.
>
> **Bottom line on the per-hour result**: removing the time confound does not produce signal — the
> Mann-Whitney comparison vs control remains a clean null (see Section 1). Per-hour is the cleaner
> _null_ result, not a path to detecting an effect that wasn't there at the absolute scale.

> NOTE: sample is small (~38 events). All p-values and CIs are directional indicators only.

## 1. Distribution Comparison (spike vs control, per-hour primary)

**Per-hour** — spike median: **-0.006%/h**, control median: **0.017%/h**. Mann-Whitney U=7257, p=0.7253 (two-sided). n_spike=27, n_control=560. A p-value below 0.05 indicates the spike per-hour return distribution is meaningfully different from random same-ticker, same-time-of-day baseline minutes.

**EOD (context only)** — spike median: **-0.014%**, control median: **0.043%**. EOD absolute returns are shown for context; they are confounded by time-of-day and should not be the primary distribution comparison.

## 2. Directionality (EOD horizon)

Overall hit rate: **15/28 = 53.6%**, 95% Wilson CI [35.8%, 70.5%], binomial p=0.8506 vs 50% null. Hit rate > 50% means spikes correctly predict the EOD price direction (whether the close is higher/lower than the spike bar). A CI entirely above 50% would be a tradeable directional signal.

- SPY: 8/17 = 47.1%, CI [26.2%, 69.0%], p=1.000
- QQQ: 7/11 = 63.6%, CI [35.4%, 84.8%], p=0.549

## 3. Time-to-peak (arc across 5m / 15m / 30m / 60m / EOD)

**Positive spikes** (n=10, n_eod=10): median fwd_5m=-0.011%, fwd_15m=0.020%, fwd_30m=0.050%, fwd_60m=0.067%, fwd_eod=0.009%.
**Negative spikes** (n=18, n_eod=18): median fwd_5m=0.008%, fwd_15m=0.055%, fwd_30m=0.121%, fwd_60m=0.122%, fwd_eod=-0.087%.

If returns compound monotonically (5m → EOD growing in absolute terms), the spike effect persists and strengthens through the session. If EOD < 30m in absolute terms, there is intraday mean reversion.

## 4. Magnitude Effect (z_score vs |fwd_return_per_hour|, time-normalized)

Theil-Sen slope: **-0.0000014** per unit z-score (95% CI [-0.0000088, 0.0000029]), n=27. Metric: |fwd_return_per_hour| — this is the time-normalized view where each spike's magnitude is measured as return-velocity (%/hour) rather than total EOD displacement. A positive slope means larger z-scores are associated with faster-moving returns; a CI excluding 0 would confirm the relationship is robust after removing the time confound.

## 5. Time-of-Day Stratification (per-hour horizon)

**Positive spikes**: AM n=2, median=0.096%/h; midday n=4, median=-0.035%/h; PM n=3, median=0.052%/h.
**Negative spikes**: AM n=11, median=-0.071%/h; midday n=5, median=0.005%/h; PM n=2, median=-0.202%/h.

Per-hour normalization makes cross-stratum comparison valid: AM spikes had 4-6h to close, PM spikes had <1.5h. A higher per-hour rate in PM would indicate late-session spikes are more efficient (faster-moving), not simply that they had less time to regress. A flat or declining per-hour rate across AM → PM would suggest early-session spikes have better velocity-adjusted impact.

**Headline reframing vs absolute EOD**: under absolute EOD, the PM stratum looked muted because PM spikes have <1.5h to close — small absolute returns by construction. Under per-hour, PM negative spikes emerge as the _fastest-moving_ stratum on a velocity basis. This reversal is exactly the kind of finding the time-confound was hiding; whether it's signal or sample variance (n=2 in PM positive, n=2 in PM negative) needs more events to resolve.

Note: positive-spike count here may be 1 lower than the directionality count in Section 2, because one positive spike fired within 1 minute of close and is excluded from per-hour analysis. It still contributes to the directionality test (which uses sign of EOD return).

## 6. Confluence vs Solo (per-hour horizon)

Confluence events: n=2. Solo events: n=25. Confluence median return rate: -0.138%/h. Solo median return rate: -0.002%/h. With only 2 confluence events, statistical testing is not meaningful — treat as an observation for future data collection.

## Caveats

- Total spike events: 38.
- Events with computable 15m fwd return: 28 (reference only).
- Events with computable EOD fwd return: 28 (primary horizon).
  Spikes on dates where etf_candles_1m has no bar at or before 20:00 UTC are excluded.
- The QQQ spike on 2026-03-17 predates candle coverage (candles start 2026-03-18) and produces NaN — correctly excluded.
- EOD horizon is VARIABLE: a spike at 09:35 ET has ~390 min to close; a spike at 15:55 ET has only ~5 min. This heterogeneity is inherent to the EOD measure.
- This analysis is exploratory. The 4-gate algorithm was calibrated on this same data; independent out-of-sample validation is required before drawing trading conclusions.
- All forward returns are computed from 1-minute close prices. Slippage and bid-ask spread are not modelled.

**Generated by** `ml/src/vega_spike_eda.py`
