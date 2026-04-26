# PAC Phase 3 — winner inspection on 5m configs

**Parent:** [pac-regime-gated-results-2026-04-25.md](./pac-regime-gated-results-2026-04-25.md)
**Date:** 2026-04-25
**Status:** complete

## Goal

After the Phase 1 sweep at 150 Optuna trials surfaced two 5m years
(2022, 2024) with positive P&L but no acceptance-gate pass, Phase 3
asks the next question: do those positive numbers come from a
config that's regime-robust, or from year-specific overfit?

The test: take the highest-OOS-Sharpe fold winner from each year's
result, replay that EXACT config trade-by-trade on the OTHER years,
and see whether it stays profitable.

## Method

Single-pass backtest replay via
`ml/scripts/replay_pac_config.py`. No Optuna search; the config is
loaded verbatim from the source result JSON. Same engine
(causality-fixed v3), same fill model, same 5m resample, just a
different year window.

## Configs replayed

**5m_2022 winner** (selected for OOS Sharpe = 10.08 on its training
fold):

```
entry_trigger:        choch_reversal
exit_trigger:         atr_target
stop_placement:       swing_extreme
session:              rth_ex_lunch
session_bucket:       ny_open
stop_atr_multiple:    2.25
target_atr_multiple:  1.75
iv_tercile_filter:    low
min_z_entry_vwap:     1.0
min_ob_pct_atr:       50.0
exit_after_n_bos:     4
```

**5m_2024 winner** — selected from 5m*2024_t150's highest-OOS-Sharpe
fold (raw config preserved in `ml/experiments/pac_replay/5m_2024cfg*\*.json`).

## Results

| Config (source year) | Replay year  | Trades |    WR |         P&L |   PF |
| -------------------- | ------------ | -----: | ----: | ----------: | ---: |
| 5m_2022              | 2022 (IS)    |     11 | 90.9% |       +$886 | 13.1 |
| **5m_2022**          | **2023 OOS** |     14 | 50.0% |   **−$476** | 0.58 |
| **5m_2022**          | **2024 OOS** |     17 | 76.5% | **+$1,112** | 3.17 |
| **5m_2024**          | **2022 OOS** |      4 | 25.0% | **−$1,039** | 0.10 |
| **5m_2024**          | **2023 OOS** |      4 | 50.0% |   **−$170** | 0.52 |

## Verdict

The plan's pass bar was **≥2-of-3 years with Sharpe > 1.0 on replay**.
Neither config clears that strictly.

- **5m_2022 config**: 1 IS positive + 1 OOS positive (2024) + 1 OOS
  negative (2023) = **1-of-2 OOS years profitable**. The 2024 replay
  is clean — 17 trades, 77% WR, PF 3.17 — that's not noise. But 2023
  OOS lost on PF 0.58, almost half. Partial robustness.
- **5m_2024 config**: **0-of-2 OOS years profitable**. Both years
  negative on tiny trade counts (4 trades each). This was overfit to
  its training year — the config is too restrictive to generalize.

## Reading

Two things can both be true:

1. **The 5m_2022 config has real PAC structure behind it.** CHoCH
   reversal + swing-extreme stop + ATR target with RTH_EX_LUNCH /
   ny_open / IV-low / VWAP-z gating describes a coherent setup
   (counter-trend reversal in low-vol morning sessions, with confirm).
   It survives one cleanly-distinct OOS year (2024 was high-vol vs
   2022's chop). That's signal.

2. **It's still fragile.** The 2023 OOS failure means the same
   config doesn't trade well in mid-vol/medium-trend regimes. A
   systematic strategy needs to win in ≥2 of 3 distinct regimes; this
   wins in 2.

The conclusion isn't "PAC is dead." It's "PAC has narrow, regime-
conditional edge that a flat config search can't reliably capture."
That's exactly the failure mode the **event classifier** (Option A,
[pac-event-classifier-2026-04-24.md](./pac-event-classifier-2026-04-24.md))
is designed to address — letting a model learn WHICH regimes
trigger the edge instead of guessing at fixed filter combinations.

## Recommendation

**Pivot to the event classifier.** Specifically:

- Use the 5m_2022 config's setup definition as the **base trigger**
  (CHoCH reversal in RTH_EX_LUNCH / ny_open / IV-low). Every event
  matching that base trigger becomes a row in the dataset.
- Train the classifier (Models A and B per the spec) to predict
  win/loss per event using the broader feature set (ATR rank, VIX,
  cross-asset, trend regime).
- The model essentially learns "when is the 5m_2022 setup
  edge-positive vs edge-negative" — which is what the 2023-vs-2024
  OOS split is asking us.

Concretely the classifier becomes a **regime selector layered on top
of a known-coherent setup** rather than a generic predictor over all
PAC events. That's a cleaner experiment than the "every BOS/CHoCH
event" original spec.

If the classifier can find features that reliably separate 2024-style
regimes (positive replay) from 2023-style regimes (negative replay),
we have an actual systematic strategy: take the setup only when the
model says "this looks like 2024." If not, PAC is a discretionary
context tool and we should redirect ML effort to the IV-anomaly /
flow stack which has a clearer validated edge.

## Files

- `ml/scripts/replay_pac_config.py` — single-config replay tool.
- `ml/experiments/pac_replay/{5m_{2022,2024}cfg_on_{2022,2023,2024}}.json` — 5 result files.

## Reference

- Phase 1 results: `pac-regime-gated-results-2026-04-25.md`
- Event classifier spec: `pac-event-classifier-2026-04-24.md`
- v3 baseline: `pac-v3-residual-fix-results-2026-04-24.md`
