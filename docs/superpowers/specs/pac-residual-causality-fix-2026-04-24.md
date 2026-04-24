# PAC residual causality fix — causal OB + causal swing_highs_lows

**Parent:** [pac-a2-causality-fix-addendum-2026-04-24.md](./pac-a2-causality-fix-addendum-2026-04-24.md)
**Date:** 2026-04-24
**Status:** planning

## Goal

Close the two remaining causality residuals in the PAC engine — `smc.ob`
reset and `smc.swing_highs_lows` dedup erasure — by replacing the upstream
functions with streaming, causal reimplementations. Then re-run the 1m
NQ sweep to check whether any systematic edge emerges that the prior
(labeling-peek-fixed-but-under-counted) version was hiding.

If post-fix numbers still sit at ~0 Sharpe, pure PAC entries are
definitively dead and we move to branch (2) of the strategy roadmap
(regime-gated entries).

## Background

The `a8eeb00` / `f2989fa` fix closed the two over-counting lookahead
bugs in `smc.bos_choch` (labeling peek + broken-filter peek). Two
under-counting bugs remain, both documented as `xfail(strict=True)` in
[test_pac_engine_causality.py](../../ml/tests/test_pac_engine_causality.py):

**Residual 1 — `smc.ob` reset step.** `smc.ob` lines 427–439 zero out
an OB at position `idx` when a future bar's high crosses above its top.
Causes the live-visible OB to vanish from the post-hoc output. A live
trader would have seen that OB between detection and mitigation; the
backtest misses those trading windows entirely.

**Residual 2 — `smc.swing_highs_lows` dedup erasure.** The dedup loop
at lines 165–193 removes same-type consecutive swings when a later
one is more extreme. Endpoint fixup at lines 197–205 additionally
forces the first and last swings to alternate types regardless of
what was actually detected. Both transforms use future data.

Both residuals bias the engine output _down_ (fewer signals than a
live trader would have), so they can't manufacture a fake Sharpe —
but they CAN hide a real small edge. If the actual Sharpe is 0.5,
the under-counting could drag it to 0.0, which is what we're
currently reporting.

## Phases

Each phase is independently shippable. Phase A adds capability, Phase B
adds more, Phase C measures impact on sweep numbers.

### Phase A — causal order-block tracker (~4–6 hours)

Add a streaming OB detector that matches `smc.ob`'s detection rule
but never mutates history:

- Pre-compute swing indices from the (already shifted in engine.py)
  swing_highs_lows output.
- Walk bars forward: at each bar T, if `close[T] > high[last_swing_high_idx]`
  and that swing hasn't been "crossed" yet, detect a bullish OB on
  bar T−1. Symmetric for bearish.
- Track per-OB state: `{idx, top, bottom, volume, mitigated_at, broken}`.
- On each subsequent bar: check if the OB gets mitigated (price enters
  zone). Set `mitigated_at = T − 1` when triggered. Keep the OB in the
  state list forever once detected. **Never zero.**
- Emit per-bar columns: `OB`, `OB_Top`, `OB_Bottom`, `OBVolume`,
  `OB_Percentage`, `OB_MitigatedIndex`. The raw column values at
  position `idx` are set at detection time and never changed.

**Files to create/modify:**

- `ml/src/pac/causal_smc.py` — NEW. Contains `causal_order_blocks()`.
- `ml/src/pac/engine.py` — swap `smc.ob(...)` call for `causal_order_blocks(...)`.
- `ml/tests/test_pac_causal_smc.py` — NEW. Unit tests against small
  synthetic fixtures where the reset would fire.

**Test updates:**

- `test_pac_engine_causality.py` — move `OB`, `OB_Top`, `OB_Bottom`,
  `OBVolume`, `OB_Percentage`, `OB_MitigatedIndex` from `KNOWN_RESIDUAL_COLS`
  into `STRICT_CAUSAL_COLS`.
- Convert `test_ob_reset_residual_is_known` from `@xfail(strict=True)`
  to a regular passing test (flip its assertion sense).

### Phase B — causal swing_highs_lows (~3–4 hours)

Add a streaming swing detector that keeps all locally-extreme swings:

- Same centered-window detection rule as upstream
  (`high[T] == high[T-swing_length : T+swing_length+1].max()` → swing high),
  but the shift-by-`swing_length` in engine.py already handles the
  forward peek, so the DETECTION part is unchanged.
- Drop the dedup loop (lines 165–193 of smc.py). Let consecutive HHs
  or LLs both survive. Downstream `bos_choch` labeling uses
  `last_positions[-2]` which works fine on a non-alternating sequence
  (it'll pick the right neighbors by position regardless of type
  pattern).
- Drop the endpoint fixup (lines 197–205). If the first detected
  swing is a HH, keep it as HH. Don't force it to LL.

**Files to modify:**

- `ml/src/pac/causal_smc.py` — add `causal_swing_highs_lows()`.
- `ml/src/pac/engine.py` — swap `smc.swing_highs_lows(...)` for the
  causal version.
- `ml/tests/test_pac_causal_smc.py` — add fixtures exercising the
  dedup case (three consecutive HHs where the second is the extreme).

**Test updates:**

- Move `HighLow`, `Level_shl` from `KNOWN_RESIDUAL_COLS` into
  `STRICT_CAUSAL_COLS`.
- Convert `test_swing_dedup_residual_is_known` from xfail to passing.

**Open question:** Does `bos_choch`'s 4-swing pattern check actually
work on a non-deduplicated swing sequence? The upstream
`highs_lows_order[-4:]` compare against `[-1, 1, -1, 1]` REQUIRES
alternating types. If we keep HH → HH → LL → HH, the pattern
`[1, 1, -1, 1]` won't match even though structurally valid swings
are present. We may need to run `bos_choch` against a deduplicated
view OF the causal swings, where "dedup" means "skip same-type
entries going backwards until we hit an alternation". That's a
causal dedup, not a retroactive one. Will decide during Phase B
implementation based on what the tests reveal.

### Phase C — re-run 1m sweep, update addendum (~2.5 hours wall-clock)

Fire the same 3 chunks (1m_2022/2023/2024 × NQ × 30 trials) against
the fully-causal engine. Compare against the Phase A–B fix (current
NEW baseline) — not the original OLD numbers.

**Likely outcomes:**

- **Post-residual-fix Sharpe ~0 across all years** → pure PAC entries
  are definitively dead. Promote branch (2) of the strategy roadmap.
- **Sharpe 0.3–1.0 on 1+ year, positive P&L, 1+ config promoted** →
  there's a small real edge that the residuals were hiding. Worth
  expanding to cross-market (ES) and longer horizons before calling
  it a systematic strategy, but the door is open.
- **Sharpe > 1.5 on multiple years** → unlikely given the scale of
  the under-counting correction, but if it happens, recheck the
  causality test's strict columns — we'd want to rule out that we
  over-corrected and reintroduced a peek.

**Files to create/modify:**

- `ml/experiments/pac_a2/1m_{2022,2023,2024}_v3.json` — NEW results.
- `docs/superpowers/specs/pac-a2-causality-fix-addendum-2026-04-24.md`
  — append "Phase 2 — residual fix applied" section.

## Thresholds / constants

None new. All existing PACParams defaults preserved (`swing_length=5`,
etc.). This is a semantics fix, not a tuning fix.

## Data dependencies

No new data. Uses existing Databento archive on Railway volume.

## Deploy considerations

- railway.toml already has `ml/src/**/*` in watchPatterns (the `/*`
  suffix fix from `f2989fa`), so pushes to
  `ml/src/pac/causal_smc.py` and `ml/src/pac/engine.py` will
  auto-deploy correctly this time.
- One-at-a-time sweep lock in ml-sweep means Phase C chunks must run
  sequentially (~55 min each = ~2h 45min total).
- No commits to `ml/src/**/*` or `ml-sweep/**` during a running
  sweep — otherwise redeploy would bounce the sweep. Same rule as
  the A2 chain.

## Open questions

- **Q1 (Phase B):** does `bos_choch` work with non-alternating swings?
  See Phase B note above. Tentative answer: add a causal "skip
  same-type" helper in the dedup step, so the downstream pattern-check
  still sees alternation without the future-peeking dedup.
- **Q2 (Phase A):** `smc.ob`'s volume calculation includes `+ 2 last
volumes` of the OB candle. Need to verify our causal reimplementation
  matches that volume semantics exactly, otherwise OBVolume comparisons
  between pre/post-fix will be noise.
- **Q3 (Phase C):** if post-fix numbers still show zero edge, should
  we consider this the definitive "PAC is not a systematic strategy"
  verdict, or is there one more thing to try before branching? My
  current view: yes, this is the definitive test of pure-PAC. If it
  fails, next step is explicitly branch (2) (regime-gated PAC).

## Non-goals

- **Fixing the FVG mitigation future-bar-index.** Low priority: loop.py
  consumes `FVG_MitigatedIndex` as `mit <= signal_idx` which is
  naturally causal. The raw value differing between views doesn't
  change trading decisions.
- **Reimplementing the `smc.bos_choch` 4-swing pattern.** Already
  fixed via `_relocate_bos_events_causally` in `a8eeb00`. Phase B
  just feeds it a better swing input.
- **Changing acceptance gate thresholds.** The gate is calibrated for
  3-year robustness; we're running 1-year chunks to isolate residual
  impact, not to get passes. Phase C's success criterion is "Sharpe
  direction changes," not "configs promoted."

## Reference

- Upstream source: `ml/.venv/lib/python3.14/site-packages/smartmoneyconcepts/smc.py`
- Current engine: `ml/src/pac/engine.py`
- Causality test: `ml/tests/test_pac_engine_causality.py`
- Original A2 findings: `docs/superpowers/specs/pac-a2-sweep-results-2026-04-23.md`
- Causality-fix addendum: `docs/superpowers/specs/pac-a2-causality-fix-addendum-2026-04-24.md`
