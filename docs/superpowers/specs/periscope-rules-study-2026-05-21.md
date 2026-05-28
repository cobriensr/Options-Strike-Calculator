# Periscope Rules Study — empirical derivation of dealer-mechanic trigger/stop/target rules

**Date:** 2026-05-21
**Status:** Spec (study not yet run)
**Output target:** Validated rules constants for `periscope-analyzer.ts` + a study findings doc

---

## Goal

Replace the per-slice Claude auto-playbook call with a deterministic rules engine that produces a "trader's map" (entry triggers, stops, targets, trade structures) updated every minute from GEXBot's per-strike Greek payloads.

The current system has 4–6 minutes of compound latency (10-min scrape slot + 2–3 min scrape lag + 2–3 min Claude lag). The replacement runs in <60 seconds, costs ~0 per slice, and removes Claude from the intraday hot path entirely.

This document is the **study spec, not the implementation**. Run this study first; the rules it produces feed the analyzer.

## Why empirical, not prose-derived

The Periscope skill (`.claude/skills/periscope/SKILL.md`) encodes several rules with magic numbers — "5–10 SPX points below the floor," "after 12:30 CT," "30% magnitude drop." Those numbers are prose, not validated thresholds.

The repo holds **130 trading days × ~40 slices/day = ~5,200 historical Periscope snapshots** joined to per-minute SPX candles. That's enough data to derive each threshold from outcomes rather than guess.

User direction (verbatim from 2026-05-21 conversation):

- "I would prefer this be based on dealer mechanics and price action not just an arbitrary number"
- "Whatever the data says"

## Hypothesis

For each candidate rule (trigger arming, stop firing, target selection), there exists a threshold range that produces materially better precision/recall than the prose default in SKILL.md. Specifically:

1. A **floor-break** rule that combines candle close + dealer-inventory-drop produces fewer false breaks than candle close alone.
2. A **trigger-arming** rule with a hold-time component reduces fakeouts vs. instantaneous break.
3. A **target ordering** rule (nearest +γ wall vs. magnet vs. charm-zero) has a predictable median time-to-touch that lets us order T1 vs. T2.
4. **Trade-structure mapping** from gamma topology to spread strikes is mechanical (no judgment).

## Datasets

All data is already in the production Neon DB.

| Table                                                | Use                                                               | Date range              |
| ---------------------------------------------------- | ----------------------------------------------------------------- | ----------------------- |
| `periscope_snapshots`                                | per-strike dealer GEX/charm/vanna/positions, 10-min slice cadence | 2025-11-10 → 2026-05-20 |
| `index_candles_1m`                                   | SPX + NDX 1-min OHLCV — primary truth for "what price did"        | full window             |
| `lottery_finder_fires`                               | 0DTE alert fires with realized peak/EOD outcomes                  | full window             |
| `silent_boom_alerts`                                 | per-strike volume-spike alerts with realized outcomes             | full window             |
| `flow_data` (source = market_tide / spx_flow / etc.) | macro flow context                                                | full window             |
| `spot_exposures` (ticker='SPX')                      | SPX gamma_oi / charm_oi / vanna_oi minute-cadence                 | full window             |

### Slice ↔ candle join

```sql
-- For each Periscope slice, get the 1-min candles for the 30-min look-forward window.
SELECT
  ps.captured_at AS slice_ts,
  ic.timestamp AS candle_ts,
  ic.high, ic.low, ic.close, ic.volume,
  ic.spx_schwab_price AS spot
FROM periscope_snapshots ps
JOIN index_candles_1m ic
  ON ic.symbol = 'SPX'
 AND ic.timestamp BETWEEN ps.captured_at
                       AND ps.captured_at + INTERVAL '30 minutes'
WHERE ps.captured_at >= '2025-11-10'
GROUP BY ps.captured_at, ic.timestamp, ic.high, ic.low, ic.close, ic.volume, ic.spx_schwab_price
```

### Per-slice structural features

For each slice, derive (cached as a CTE or staging table for the study):

- `spot_at_slice` (from index_candles_1m at captured_at boundary)
- `gamma_floor` — nearest +γ strike below spot, magnitude > threshold
- `gamma_ceiling` — nearest +γ strike above spot, magnitude > threshold
- `gamma_floor_magnitude`, `gamma_ceiling_magnitude`
- `magnet` — strike with largest |γ| within ±$30 of spot
- `charm_zero` — strike where signed charm crosses zero (linear interp between adjacent strikes)
- `charm_tally` — signed sum across strikes within ±$30 of spot
- `prior_slice_gamma_floor_mag` — same strike's gamma magnitude in the 10-min prior slice (for inventory-drop detection)

These features are the inputs every candidate rule operates on.

## Candidate rules

Each rule is evaluated against historical outcomes. Pick the variant with the best metric per rule family.

### A. Floor-break rules (when does a +γ floor _structurally_ fail?)

A floor "fails" when price continues materially below it without mean-reverting. Define "failure" empirically: SPX close drops ≥10 pts below floor strike within the next 30 min AND does not reclaim within 60 min.

| Rule | Trigger condition                                                               |
| ---- | ------------------------------------------------------------------------------- |
| F1   | 1-min candle close < floor strike                                               |
| F2   | 1-min candle close < floor strike, hold ≥ 2 bars                                |
| F3   | 1-min candle close < floor strike, hold ≥ 5 bars                                |
| F4   | F1 AND gamma_floor_magnitude at the floor strike dropped > 30% slice-over-slice |
| F5   | F1 AND adjacent strike below shows dominant −γ                                  |
| F6   | F2 AND volume on the breaking bar > 1.5 × trailing-10-min average               |

For each: precision (% of fires that became genuine failures), recall (% of genuine failures the rule caught), F1.

### B. Trigger-arming rules (when does an entry trigger become legit?)

A "legit" trigger is one where price continues in the direction for at least 1 ATR or reaches the next +γ wall. Define empirically: from trigger fire, did price travel ≥ 0.3% in the trigger direction before retracing past the trigger level?

| Rule | Trigger condition                                          |
| ---- | ---------------------------------------------------------- |
| T1   | 1-min close past trigger                                   |
| T2   | 3-min hold past trigger                                    |
| T3   | T1 AND volume > 1.5 × trailing-10-min average              |
| T4   | T1 AND charm_tally direction agrees with trigger direction |
| T5   | T1 AND spot is outside the cone (vol-expansion regime)     |

### C. Target-selection rules (which target hits first?)

Targets per direction:

- **nearest +γ wall** (the +γ floor below for shorts, +γ ceiling above for longs)
- **magnet** (largest |γ| within ±$30 of spot)
- **charm-zero** (signed-charm crossing strike)

For each historical slice with a directional setup, record:

- which target was touched first
- minutes-to-touch
- whether the trade made it to T2 or stopped first

Output: a regime-conditional table (e.g., "in pin regime, magnet is T1 73% of the time; in trend regime, nearest +γ wall is T1 81% of the time"). The analyzer uses this to order T1 vs. T2.

### D. Stop-firing rules (when is the stop actually broken?)

A stop "broke" if price continued ≥ 10 pts adverse in the next 30 min. A "false stop" is a wick + reversal that didn't continue.

| Rule | Trigger condition                                               |
| ---- | --------------------------------------------------------------- |
| S1   | 1-min close below stop level                                    |
| S2   | 1-min close below stop level, hold ≥ 2 bars                     |
| S3   | 5-min low pierces stop AND charm_tally flipped against position |
| S4   | Stop level's +γ magnitude dropped > 50% from entry              |
| S5   | S1 AND no recovery candle within 5 bars                         |

## Success metrics per rule

Compute on the slice population:

- **Precision** = TP / (TP + FP)
- **Recall** = TP / (TP + FN)
- **F1** = 2 × (P × R) / (P + R)
- **Expectancy in R units** = (P × avg_win_R) − ((1 − P) × avg_loss_R), where 1R = stop distance
- **Median time-to-resolution** (for triggers and targets)

Where TP/FP/FN are defined per rule family (failure detected/missed, trigger predicted continuation/fakeout, target ordering matched/missed, stop predicted continuation/false stop).

## Decision criteria

1. **F1 > 0.6 OR expectancy > 0.5R** to qualify
2. Tie-break: simpler rule wins (one condition beats compound condition unless F1 lifts ≥ 10%)
3. **Out-of-sample validation** required: split data 80/20 chronologically (train through 2026-03, test 2026-04 onward), require test F1 within 15% of train F1
4. **Regime stability check**: compute F1 separately on (pin, drift-and-cap, trap, chop) regime subsets. Reject rules where any regime has F1 < 0.4 — those rules don't generalize

## Trade-structure mapping (Phase 2 — after rules study)

Given trigger + stop + targets are validated, the next layer maps structure type to gamma topology. This is mechanical (no separate backtest needed) — the structure follows the level locations:

| Setup                         | Structure                              | Strike selection                                                         |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| LONG arm at trigger           | debit_call_spread                      | long = trigger, short = gamma_ceiling                                    |
| SHORT arm at trigger          | debit_put_spread                       | long = trigger, short = max(gamma_floor − 5, next −γ strike)             |
| WAIT zone                     | iron_condor                            | short legs = trigger boundaries, long legs = gamma_floor / gamma_ceiling |
| Pin regime + magnet near spot | broken_wing_butterfly                  | body = magnet, wings asymmetric per cone skew                            |
| Cone-breach + vol expansion   | directional_long_call OR long_strangle | strike = cone breach level                                               |
| Asymmetric cone               | credit spread on the cheap side        | short = nearest +γ wall on cheap side                                    |

Reference: existing `trade_types_recommended` enum in `periscope_analyses` schema. Reference `api/_lib/analyze-prompts.ts` for how Claude currently picks structures — the rules above codify that mapping.

## Open questions

1. **Slice timing gaps.** Some days the 10-min scrape was 12–15 min apart (retry path on scraper). For the inventory-drop detection (F4, S4), need to handle "prior slice" not being exactly 10 min back. Decision: use the most recent slice within a 5–15 min lookback window; mark slices with no prior within 20 min as "no prior" and skip the F4/S4 rules for them.

2. **"Genuine move" threshold.** Currently set at 10 pts for failure and 0.3% for trigger continuation. These are pre-set guesses; should sensitivity-test by also running at 5/15 pts and 0.2%/0.5% to confirm rule rankings are stable to threshold choice.

3. **Cone data availability.** `cone_lower` and `cone_upper` live on `periscope_analyses`, not `periscope_snapshots`. Need to join through (trading_date) — but not every slice has a corresponding analysis row. Decision: for T5 (cone-breach trigger variant), require analysis row in scope; skip slices without one.

4. **NDX vs SPX.** Study runs SPX-only; NDX has different liquidity / dealer book structure. NDX gets its own study later (or assume same rules with re-tuned thresholds).

5. **Vanna inclusion.** Vanna is captured but not heavily used in current Periscope skill rules. The study should record whether Vanna features (e.g., wing-strike vanna magnitude) materially improve any rule's F1. If yes, include in the analyzer; if no, drop for simplicity.

## Deliverables

1. **`docs/tmp/periscope-rules-study-findings-2026-05-21.md`** — full report:
   - Rule-by-rule precision/recall/F1/expectancy tables
   - Out-of-sample validation results
   - Regime-conditional breakdowns
   - Picked rule per family with chosen thresholds
   - Charts where useful (magnitude-drop distribution, time-to-target histograms)

2. **`api/_lib/periscope-analyzer-rules.ts`** — exported constants:

   ```ts
   export const FLOOR_BREAK_RULE = 'F4' as const;
   export const FLOOR_BREAK_THRESHOLDS = {
     minHoldBars: 2,
     minMagnitudeDropPct: 0.3,
   };
   export const TRIGGER_ARM_RULE = 'T4' as const;
   // ...etc
   ```

3. **`scripts/study_periscope_rules_2026-05-21.py`** — the runnable study script (Python in ml/.venv). Outputs both #1 and #2.

## Phasing after this spec

| Phase        | Scope                                                        | Time     |
| ------------ | ------------------------------------------------------------ | -------- |
| 1            | Run this study, produce deliverables above                   | 1–2 days |
| 2            | Spec `periscope-analyzer.ts` using validated thresholds      | 0.5 day  |
| 3            | Build `periscope-analyzer.ts` + trade-recommendation overlay | 1–2 days |
| 4            | Wire intraday panel to update from GEXBot 1-min via analyzer | 1 day    |
| 5 (optional) | Retire periscope-scraper if GEXBot proves sufficient         | 0.5 day  |

## Non-goals

- Live trading execution. The analyzer outputs a map; the trader executes.
- Pre-trade and debrief modes — keep Claude for those (one call per day each, no latency pressure).
- Long-skew regime detection (SKILL.md "interpretive overlay"). Skip in v1; revisit if VIX-spot correlation tracking lands.
- NDX rule derivation. SPX-only for v1.
- Trade-structure backtest. Phase-2 mapping is mechanical; if the rules-engine pick of structure under-performs, that's a separate study.

## Risk to flag

The convergence of 7/7 reads on 2026-05-19 to nearly identical structured outputs (all "medium" confidence, all "trap" or "drift-and-cap") suggests Claude is already producing mechanical output. The study is most likely to _confirm_ that rules can replicate Claude's output — not to find dramatically new rules. The win is **latency + cost**, not better signal quality. Be honest about that in the findings doc.
