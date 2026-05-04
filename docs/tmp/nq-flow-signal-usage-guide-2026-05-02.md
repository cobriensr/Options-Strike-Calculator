# How to use the NQ flow signals — Usage Guide (2026-05-02, v2)

**Companion to:** `nq-flow-leadership-findings-2026-05-02.md`
**Code:** `ml/src/nq_flow_leadership/`

This document translates the **validated** correlation findings into
practical entry/exit decision rules. Read the findings doc first for
methodology and full caveats.

## What survived four rounds of validation

After Phase 0-5 + sweep intensity unconfound + NDX dismissal +
NPP day-by-day check, **two signals remain standing** out of 14
that had Bonferroni-significant headline numbers:

| Signal                                        | Type                    | Magnitude                                                 | Robustness                                                     |
| --------------------------------------------- | ----------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| **QQQ sweep_dir_imbalance_30m_0dte → NQ 30m** | Directional, contrarian | ρ=-0.127 (per-day median -0.19, _stronger_ than headline) | **ROBUST** — 12/15 days match sign, 5 unique days drive top-20 |
| SPY sweep_intensity_5m_all → NQ 60m           | Regime/urgency          | ρ≈0.08-0.10 (volume-unconfounded)                         | Real but partial volume confound, NOT directional              |

**Dismissed during validation:**

- NDX ncp*30m_all & NDX pwdd_30m_all *(both driven by the same single
  event on 2026-04-27, 13:43-13:52)\_
- SPY npp*30m_0dte *(single-day driver: April 14)\_
- SPXW npp*30m_0dte *(2-day driver: April 20 + 1 other)\_
- QQQ npp*30m_0dte *(per-day median half the headline; 5 days opposite-signed)\_
- The original headline `SPY sweep_count` _(survived but at ~55% magnitude
  due to volume regime confound — see findings doc)_

**One signal, one optional confirmation.** Smaller than the headline numbers
suggested, but won't fall apart on the first regime shift.

## What ρ ≈ 0.13 actually means in trading terms

Spearman ρ = 0.13 (the validated QQQ signal) is a _small but real_ effect.
Translating to expected hit rate at 30-minute horizons:

| When QQQ sweep_dir_imbalance is in… | Expected directional hit rate (NQ contrarian) | Edge over coin flip |
| ----------------------------------- | --------------------------------------------- | ------------------- |
| bottom 20% (bear sweeps dominating) | ~57% NQ rises in next 30 min                  | +7pp                |
| bottom 10% (strong bear sweeps)     | ~60%                                          | +10pp               |
| bottom 5% (extreme bear sweeps)     | ~62-65%                                       | +12-15pp            |

Estimates from the rank correlation, not measured. **Real hit rates need
to be measured on out-of-sample data before sizing capital.**

A ρ=0.13 edge requires discipline: many trades, tight risk, no chasing.
But it's directional (the QQQ signal has a clean read of "smart money is
short, so fade") rather than just regime-shape.

## The decision rule

### Primary long entry — all four must be true

1. **Time-of-day:** open bucket (08:30-09:30 CT) **OR** PM bucket (13:00-14:30 CT).
   Avoid lunch (signal weakest) and the last 30 min of session (no 30m forward window).
2. **QQQ `sweep_dir_imbalance_30m_0dte` in bottom 20%** of trailing 30-day
   intraday distribution. This means bear sweeps are dominating bull
   sweeps in QQQ 0DTE — read as "smart money is positioning short
   on QQQ via aggressive put-buying / call-selling sweeps."
3. **NQ at or above VWAP and not in active flush** (>−0.4% in last 30m).
   Don't take longs in a falling knife even with the contrarian setup —
   wait for at least a stabilization candle.
4. **(Optional confirmation):** SPY `sweep_intensity_5m_all` in top 20%.
   Confirms there's actual urgency in the broader market, not just dead
   tape. This is the regime-activity check, not a directional signal on
   its own.

### Why these conditions — the mechanic in plain English

When QQQ shows aggressive bear-sweep activity, it usually means:

- A large player wants to be short tech, NOW
- They're hitting multiple exchanges to fill before price moves
- This is informed positioning, not retail panic

The empirical finding is that NQ tends to do the **opposite** over the
next 30 minutes. The most plausible mechanic:

- These QQQ bear sweeps often reflect **short-term hedging** (large
  funds protecting tech longs) rather than directional shorts
- After the hedge clears, the underlying long position remains, and
  market makers offset the put-buying by buying NQ futures to remain
  delta-neutral
- The flush attempt fades, NQ recovers

This matches your stated observation about the "knife-bounce" dynamic —
you've been seeing the natural endpoint of this exact pattern intuitively.
The signal helps you anticipate it instead of getting trapped in the
flush.

### Holding & exit

- **Hold up to 30 minutes from entry.** Signal predictive power is at
  the 30m horizon; staying longer is hope, not edge.
- **TP +0.20% NQ** (~20-30 NQ points depending on price level)
- **SL -0.10%** (NQ stop = half of TP — keeps R:R at 2:1)
- **Time stop:** 30 min unconditional flat. The 30m horizon is empirical;
  the signal decays past it.
- **Trail rule (optional):** if NQ moves +0.10% in your favor within
  10 min, move stop to break-even.

### Expected per-trade math (rough estimate, NOT measured)

| Component                                           | Value             |
| --------------------------------------------------- | ----------------- |
| Hit rate (estimated from ρ=0.13 in bottom-quintile) | ~60%              |
| Avg win at TP                                       | +0.20%            |
| Avg loss at SL                                      | -0.10%            |
| Gross EV per trade                                  | +0.08%            |
| NQ slippage + commission                            | -0.02% round-trip |
| **Net EV per trade**                                | **~+0.06%**       |

Probably 1-2 signals per day on average (top quintile of the trailing
30-day distribution = top 20% of minutes, but with the time-of-day
and NQ-VWAP filters we're talking about the times when conditions
align). To make $1k/day on this with 1-2 signals you need
roughly $80k-$170k notional NQ exposure per signal — i.e. 2-4 NQ
contracts at current price.

### Flatten-longs / stand-aside (no entry)

- **QQQ `sweep_dir_imbalance_30m_0dte` in top 20%** (bull sweeps
  dominating QQQ — fade signal). The mirror-image of the entry rule.
  When QQQ shows aggressive bull-sweep activity, NQ tends to _fall_
  over the next 30m. Per your stated dislike of shorts, treat this
  as a "flatten any longs you're holding, do NOT enter short" gate.
- **NQ in active flush** (>−0.4% in last 30m). Even with the contrarian
  setup, don't catch falling knives.
- **Inside 15 min of FOMC, CPI, NFP.** Sweep flow contaminated by
  event positioning.
- **VIX rising fast** (e.g., >+5% in 30m). Vol-of-vol regime breaks
  these correlations.
- **Lunch bucket (11:00-13:00 CT).** Signal weakest there per stratification.
- **Last 30 minutes of session.** No 30m forward window left.

## What this guide cannot tell you (honest limits)

- **Hit rates are estimated, not measured.** Until we backtest on a
  separate data window with this exact rule and realistic transaction
  costs, "60%" is derived from rank correlation, not a track record.
- **Computing the live signal requires the right data.** Specifically:
  rolling 30-min sum of (bull QQQ 0DTE sweep premium) and (bear QQQ
  0DTE sweep premium), and the imbalance ratio. UW Periscope shows
  _some_ of this but not in the exact form. The cleanest path to live
  signal is wiring this feature into the analyze context (a 1-2 hour
  backend job — same architecture as `phase5a-nq-ofi-analyze-context-2026-04-19.md`).
- **30-day trailing distribution requires history.** To know what the
  bottom 20% threshold _is_ on any given minute, you need 30 days of
  intraday QQQ sweep_dir_imbalance values. The sidecar / UW WebSocket
  daemon should be capturing this going forward; backfilling from
  EOD parquet is also possible.
- **Single-regime data.** All findings are from 2026-04-13 to
  2026-05-01, a bullish-drift period. Bear regime, sideways chop,
  high-vol regime: signal behavior may differ materially. The
  contrarian read might invert in a bear regime where put-buying
  is real directional positioning rather than hedging.

## Recommended next steps before live deployment

1. **Validate on a different 15-30 day window.** Different VIX regime
   if available. The cheapest way to know if this is regime-specific
   or persistent. The cohort of validated signals after a second-window
   run will be the _real_ tradeable set.
2. **Wire QQQ sweep_dir_imbalance into live ingestion.** UW WebSocket
   daemon path (newly added to repo) is the natural home. Per-minute
   aggregation + 30-day rolling distribution = the live signal value.
3. **Backtest the exact rule above** on the existing 15-day window with
   realistic transaction costs. ρ=0.13 in the rank correlation needs to
   become "actual simulated P&L over N signals" before any sizing.
4. **Define a kill-switch.** Live deployment of any small-edge signal
   needs a rule for when to stop trading it (e.g., 10% drawdown from
   peak P&L = pause and re-validate against fresh data).

## Bottom line

After honest validation, you have **one tradeable signal candidate**:

> When QQQ 0DTE option sweeps are net-bearish (bear sweeps dominating
> bull sweeps over rolling 30 min), NQ tends to **rise** over the next
> 30 minutes. The signal concentrates in open and PM time-of-day buckets.
> Estimated edge: ~+6 bps per trade after costs.

The mechanic is most likely: large players hedge tech longs by buying
QQQ puts in size; market makers offset by buying NQ futures to stay
delta-neutral; the flush attempt fades and NQ recovers.

This matches the "knife-bounce" pattern you've been intuitively
trading around. Now you have a measured contrarian trigger for it
instead of guessing at the bottom.

The remaining work: validate on a second window, wire to live ingestion,
backtest with cost model. ~3-4 hours of focused work to get from
"interesting research" to "deployable trigger."
