# PAC Exit Trigger Finding — OPPOSITE_CHOCH beats ATR_TARGET

**Date:** 2026-04-22
**Owner:** @cobriensr
**Status:** findings — config change applied to Pine indicator, backtest Config B replaces Config A as baseline
**Trigger:** user question "Did we ever test letting the winners run instead of hard take profit stops?"

## TL;DR

The v4 Optuna sweep selected `ATR_TARGET` with `target_atr_multiple=2.0` as the winning exit rule for fold 9's NQ config. That sweep ran **before** the [swing-lookahead fix](../../ml/src/pac/engine.py#L161), so Optuna was optimizing against a backtest that systematically favored hard-TP configs (tight targets hit easily when swing levels had 5-bar lookahead).

Re-running 5 exit-trigger variants on the same fold 9 config with all post-fix plumbing:

| Config | Exit rule          | Trades | WR    | Avg/trade  | 3yr Total    | Stop hits     | Worst trade |
| ------ | ------------------ | ------ | ----- | ---------- | ------------ | ------------- | ----------- |
| A      | ATR_TARGET 2.0     | 2,729  | 89.7% | $32.65     | $89,089      | 230 (8%)      | −$306       |
| **B**  | **OPPOSITE_CHOCH** | 1,840  | 88.5% | **$59.45** | **$109,389** | **14 (0.8%)** | **−$87**    |
| C      | OPPOSITE_BOS       | 1,707  | 68.8% | $42.37     | $72,320      | 286 (17%)     | −$285       |
| D      | ATR_TARGET 4.0     | 2,199  | 74.9% | $41.58     | $91,424      | 279 (13%)     | −$237       |
| E      | SESSION_END only   | 1,707  | 68.8% | $42.37     | $72,320      | 286 (17%)     | −$285       |

**Config B wins by every metric except trade count.** +23% total P&L vs A, 93% fewer stop-outs, biggest avg trade, smallest worst trade, matching WR.

## Why B wins

- **CHoCH fires on the right-sized reversal.** A CHoCH (change of character = new lower-low for a long, new higher-high for a short) confirms a minor swing failure — early enough to lock in partial gains before the move unwinds to the swing-extreme stop. `OPPOSITE_BOS` waits for the prior swing to BREAK entirely (much larger move), by which time many trades have already given back to the stop. The data: only 14 of 1,840 trades (0.8%) in B reach the hard stop, vs 286/1,707 (17%) in C. B's structural exit beats the stop to the punch.
- **Hard TP leaves money on the table on trend days.** A's tight 2.0 × ATR target closes 77% of trades at that level. When price continues for 4 ATR of clean trend, A takes $20 and watches the next $20 walk away. B rides the trend until structure fails.
- **`ATR_TARGET 4.0` (D) confirms the target is saturated around 2.0.** Doubling the target only improves total P&L by 3% while sacrificing 15pp of WR. Can't compensate for target-distance increases linearly — only captured winners matter.
- **`SESSION_END` (E) is indistinguishable from `OPPOSITE_BOS` (C).** When `exit_trigger=SESSION_END`, `detect_exit()` returns None every bar, so all exits flow through the `on_opposite_signal` handler + `exit_after_n_bos` + intrabar stops. Since `on_opposite_signal=EXIT_ONLY` with `entry_trigger=BOS_BREAKOUT` fires on opposite-direction BOS, the effective behavior is identical to explicit OPPOSITE_BOS. Bit-for-bit same numbers (1707 / 68.8% / $72,320).

## Why the v4 sweep picked the wrong exit rule

The v4 sweep ran with `engine.py` pre-lookahead-fix. With `pivothigh(5)` peeking 5 bars into the future, "confirmed" swings were sometimes not-yet-confirmed at the time the sweep thought they were. The effect amplified tight-target configs: a 2 ATR target hits EASIER when the backtest "knows" future price action than when it truly doesn't.

After the fix was applied in `89b0677`, the engine shifts structure columns forward by `swing_length`. Re-running fold 9 with the same Optuna-selected params (which included `ATR_TARGET 2.0`) gave 90.2% WR / $34.08 avg — looked even better than the pre-fix result. Only when we stepped outside Optuna's local optimum and tried OPPOSITE_CHOCH did the real winner emerge.

Lesson: Optuna found a local optimum in the pre-fix search space that doesn't carry over to the post-fix space. For future sweeps, re-run the entire Optuna search against the corrected engine rather than trust the pre-fix winners.

## Changes applied

1. **Pine indicator** ([pine/pac-bos.pine](../../pine/pac-bos.pine), renamed from `pac-bos-config-a.pine`): added `Exit Mode` dropdown, defaulting to `OPPOSITE_CHOCH`. `CHOCH` exit reason added to the label set. Target line hidden in CHoCH mode.
2. **Pine README** ([pine/README.md](../../pine/README.md)): Config B is the new default, comparison table added, `CHOCH` exit documented.
3. **Python backtest**: no code change needed — the OPPOSITE_CHOCH exit path was already implemented in `loop.py`, just wasn't the chosen setting.

## Follow-on work (not done tonight)

- **Re-run the full v4 Optuna sweep with the fixed engine** and see what params the TPE picks now. It should prefer OPPOSITE_CHOCH but may find additional tuning (different stop_atr_multiple, session, or min_z_vwap thresholds).
- **Cohort analysis on Config B's 1,840 trades**. The Config A cohort analysis showed ADX≥25 + NY_OPEN concentrated edge. Whether the same sub-regimes dominate under B is an open question.
- **Acceptance.yml v5 bump**: record the config change (A → B default) with a fresh commit-hash stamp so the audit trail shows the legacy A baseline vs. the new B baseline as distinct locks.

## File references

- Pine indicator: [pine/pac-bos.pine](../../pine/pac-bos.pine)
- Pine README: [pine/README.md](../../pine/README.md)
- Backtest engine: [ml/src/pac/engine.py](../../ml/src/pac/engine.py)
- Backtest loop (exit dispatch): [ml/src/pac_backtest/loop.py](../../ml/src/pac_backtest/loop.py)
- Variant deep-dive script: `/tmp/fold9_deepdive.py` (ephemeral, reproducible via params)
