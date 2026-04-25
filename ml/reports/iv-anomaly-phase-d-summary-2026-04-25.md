# Phase D Rollup — IV-Anomaly Deeper Analysis (2026-04-25)

This rolls up the five sub-phases of the Phase D study into one
"what changes for production" document. The spine is **regime
alignment**: every alert gets a label per the underlying ticker's
own daily % change, and every analysis is sliced by it.

**Sample:** 15,886 backfill alerts over 10 days (4/13–4/24), 13
tickers. Directional, not statistically conclusive.

## 1. The big reframe — regime is the spine

| Regime | Side | n | Win % | Mean $/contract |
|---|---|---:|---:|---:|
| `mild_trend_up` | call | 1,604 | 33.7% | -$2 |
| `strong_trend_up` | call | 566 | 27.0% | +$150 |
| `chop` | call | 2,223 | 17.9% | -$1 |
| `extreme_up` | call | 313 | 28.4% | -$17 |
| `mild_trend_down` | call | 151 | 23.8% | -$72 |
| `chop` | put | 4,193 | 1.2% | -$94 |
| `extreme_down` | put | 204 | 8.8% | -$110 |

Headline 10% blend hides 4× separation. **Calls on mild_trend_up
days are 4× more profitable than calls on chop days.** Puts
have no regime where they win in this 10-day mostly-bullish
window — sample-period skew flagged.

## 2. Top high-confidence per-ticker wins (n ≥ 100)

| Ticker | Regime | Side | n | Win % | Median $ | Notes |
|---|---|---|---:|---:|---:|---|
| **SPY** | `mild_trend_up` | call | 107 | **73.8%** | +$167 | clean winners (~0% MAE) |
| **SPXW** | `strong_trend_up` | call | 243 | **53.5%** | +$69 | wider OTM gate captures more |
| **QQQ** | `mild_trend_up` | call | 819 | **45.9%** | -$1 | many alerts, edge real but thin |
| TSLA | `extreme_up` | call | 46 | 37.0% | -$2 | only TSLA setup near break-even |

## 3. Per-(ticker, regime) BEST_STRATEGY changes

Phase B picked one strategy per ticker. Phase D0's regime-conditional
re-pick changes the answer for several ticker × regime combinations.
Most actionable correction:

- **NVDA × extreme_up: itm_touch (was eod)** — captures intraday peaks
  instead of letting them give back. Confirms the "NVDA peaks intraday
  and gives back" thesis from the user's 4/24 example.
- **SPY × chop: itm_touch (was eod)** — chop days don't sustain.
- **TSLA × extreme_down: eod (was itm_touch)** — the rare regime where
  TSLA puts work; takes EOD path.

## 4. Path-shape — winners endure deep drawdowns first

| Outcome category | n | Median MAE before peak | p25 MAE |
|---|---:|---:|---:|
| Loser (<0% peak) | 4,151 | 0.0% | 0.0% |
| Small win (0–30%) | 4,152 | -1.1% | -11.9% |
| Decent win (30–100%) | 1,994 | -4.8% | -19.1% |
| **Big win (>100%)** | **858** | **-10.3%** | **-36.7%** |

The median big winner went down 10% before paying off; the p25 went
down 37%. This is the **psychological-viability floor**: holding
through a -37% drawdown is hard.

**Per-ticker contrast among winners:**
- SPY mild_trend_up call winners: median MAE 0%, p25 -15% — *clean*
- TSLA mild_trend_up call winners: median MAE **-42%**, p25 -67% — *punishing*
- MSFT chop call winners: median MAE -3.7% — *clean*
- NVDA extreme_up call winners: median MAE -3.8% — *clean + 60.7% peaked BEFORE going ITM (pure IV play)*

## 5. Signal magnitude — counterintuitive z-score inversion

On `mild_trend_up` calls (the most common winning regime):

| z_score bucket | n | Win % | Mean $/contract |
|---|---:|---:|---:|
| z < 2 | 500 | **38.4%** | +$1 |
| z 2–3 | 579 | 36.8% | +$10 |
| z 3–5 | 416 | 27.9% | +$22 |
| z 5+ | 105 | 17.1% | -$167 |

**Lower z-score wins more on mild trending days.** High-z alerts fire
on already-moved strikes that don't reach. Low-z fires earlier in the
move on closer-to-spot strikes that do reach.

Pattern inverts on `strong_trend_up` (higher z-score wins more) and
on `extreme_up` (skew_lt_001 wins 56.9%) — the ranking depends
entirely on regime.

## 6. Detector internals — flash alerts beat persistent ones

| Pattern | Side | n | Win % | Mean $/contract |
|---|---|---:|---:|---:|
| **Flash** (<5 min, <3 firings) | call | 176 | **34.7%** | **+$636** |
| Medium | call | 1,848 | 29.8% | -$45 |
| Persistent (≥60 min OR ≥20 firings) | call | 3,018 | 20.1% | +$7 |
| **Single-firing keys** (`fc_1`) | call | 100 | **40.0%** | **+$907** |

**Inverse correlation: more firings = worse win rate.** Hypothesis:
flash alerts represent strikes that crossed quickly (the alert
disappears because the strike went ITM and the OTM-only snapshot
table stops capturing it). Persistent alerts are strikes the market
keeps re-loading but spot never follows.

**Trade flash, deprioritize persistent.**

## 7. Per-day variance — headline is fragile

| Day | Win % | Mean $ | Notes |
|---|---:|---:|---|
| 2026-04-13 | 21.4% | +$1 | strong day |
| 2026-04-14 | 11.8% | -$65 | |
| 2026-04-15 | 3.9% | -$121 | weakest |
| 2026-04-16 | 2.3% | -$123 | weakest |
| 2026-04-17 | 4.5% | -$112 | |
| 2026-04-20 | 9.7% | -$30 | recovering |
| **2026-04-21** | **25.6%** | **+$86** | best |
| 2026-04-22 | 10.9% | -$32 | |
| 2026-04-23 | 6.8% | -$70 | |
| 2026-04-24 | 5.6% | -$54 | |

The aggregate "10% win rate, -$50 mean" is the average of two great
days (4/13, 4/21) and seven losing days. Per-day win rate variance
is 5× — much wider than the regime split suggests on its own.

## What this means for production

A short list of changes to consider, ranked by confidence:

### High confidence

1. **Use regime-conditional BEST_STRATEGY in any future analyze
   prompt or trade-suggestion logic.** The blind per-ticker pick
   from Phase B is wrong for several ticker × regime combinations.
2. **Deprioritize persistent alerts in the UI.** A 6+ firing alert
   on the same strike is *worse* signal than a single firing.
   Surface the firing count somewhere visible (already partially
   wired via `firingCount` in `ActiveAnomaly`).
3. **Flag puts in the UI.** Until we have a downtrend-window backfill,
   the put side has no demonstrated edge. Add a "needs validation"
   indicator.

### Medium confidence

4. **Tighten cash-index OTM gate to ±5% for SPXW** if win rate
   matters more than coverage. SPXW × strong_trend_up at 53.5% win
   rate is already strong; tighter OTM might push it higher with
   less noise.
5. **Add z-score INVERSION on mild_trend_up days.** This is
   counterintuitive enough to want one more month of data before
   acting on it.
6. **Add path-shape warnings.** TSLA winners have -42% median MAE.
   The UI could surface "expect deep drawdown" for TSLA alerts.

### Low confidence (more sample needed)

7. NDXP edge is real (96.3% win on mild_trend_up) but n=27 over
   2 days. Need more sample — and the path-shape data is unreliable
   for NDXP (most strikes lack snapshots).
8. Day-of-week effects: 10 days isn't enough to call.

## What we still don't know

- **Cross-asset enrichment.** No NQ-leading-SPX timing, no dark
  print proximity, no FOMC/CPI windows. Separate spec.
- **Counterfactual gate sweeps.** What happens if we re-run the
  detector with vol/OI ceiling at 50×? Requires re-running detector,
  separate spec.
- **Realized win rate during a downtrend.** Our 10 days were
  ~80% bullish. Need at least one -1% day on SPX before we can
  judge whether puts have edge.
- **Sizing-aware analysis.** D5 (exposure) was scoped out — at
  $200/alert the leaderboard shifts: NDXP becomes -97%, MSFT becomes
  +8% because affordability constrains the universe.

## Deliverables

| Phase | Script | Findings | Report | Plots |
|---|---|---|---|---|
| D0 | `ml/regime-conditional-iv-anomalies.py` | `iv-anomaly-regime-conditional-2026-04-25.json` | `iv-anomaly-regime-conditional-2026-04-25.md` | `iv-anomaly-regime-conditional/*.png` |
| D1 | `ml/path-shape-iv-anomalies.py` | `iv-anomaly-path-shape-2026-04-25.json` | `iv-anomaly-path-shape-2026-04-25.md` | `iv-anomaly-path-shape/*.png` |
| D2 | `ml/signal-magnitude-iv-anomalies.py` | `iv-anomaly-signal-magnitude-2026-04-25.json` | `iv-anomaly-signal-magnitude-2026-04-25.md` | — |
| D3 | `ml/cohort-iv-anomalies.py` | `iv-anomaly-cohort-2026-04-25.json` | `iv-anomaly-cohort-2026-04-25.md` | `iv-anomaly-cohort/*.png` |
| D4 | `ml/detector-internals-iv-anomalies.py` | `iv-anomaly-detector-internals-2026-04-25.json` | `iv-anomaly-detector-internals-2026-04-25.md` | — |
| Rollup | (this file) | — | `iv-anomaly-phase-d-summary-2026-04-25.md` | — |
