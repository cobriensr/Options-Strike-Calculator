# Phase 5a — NQ OFI in Analyze Context — 2026-04-19

Part of the max-leverage roadmap. Phase 5a operationalizes the
Phase 4d finding that NQ 1h OFI predicts next-day NQ return at
Spearman ρ=0.31, p_bonf<0.001, n=312 days. Goal: surface this signal
to Claude every analyze call.

Full empirical basis: `ml/docs/MICROSTRUCTURE-OFI-FINDING.md`.

## Goal

Widen Phase 2a + 2b's ES-only microstructure pipeline to dual-symbol
(ES + NQ). The compute layer already exists; Phase 5a removes the
"ES only" scope lock and adds NQ-specific interpretation rules to
Claude's cached system prompt.

## Design: widening, not adding

The architecture is already in place from Phase 2a/2b:

- `futures_trade_ticks` + `futures_top_of_book` tables both carry a
  `symbol` column that differentiates ES vs NQ
- `sidecar/src/quote_processor.py` already handles trade + book
  snapshots per-symbol; the only restriction is an `if symbol != "ES"
  return` guard added in Phase 2a as explicit scope
- `api/_lib/microstructure-signals.ts` computes OFI + spread + TOB
  with symbol hardcoded to `ES` in SQL; needs parameterization

Phase 5a pulls out the ES-only constraints and extends the
compute-layer SQL + analyze-context formatter to dual-symbol.

## Files

### Modified

**Sidecar (Python):**

- `sidecar/src/databento_client.py` — add `NQ.FUT` to the existing
  `tbbo` subscription. Currently subscribes only to `ES.FUT` via
  `stype_in=parent`. The Databento Live client handles multiple
  parent symbols in one subscribe call.
- `sidecar/src/quote_processor.py` — remove the `if symbol != "ES":
  return` guard in the TBBO handler. Both ES and NQ events flow
  through the same `batch_insert_top_of_book` + `batch_insert_trade_ticks`
  writers; the tables already carry the symbol column.
- `sidecar/tests/test_quote_processor.py` — update the regression
  guard that asserts non-ES symbols are dropped (it was intentional
  scope enforcement in Phase 2a). Replace with an assertion that NQ
  events ARE processed.
- `sidecar/tests/test_databento_client.py` — update the "subscribe
  asserts ES.FUT only" regression guard to allow both `ES.FUT` and
  `NQ.FUT` in the subscription. Keep the MBP-1 exclusion assertion
  from Phase 2a's rework.

**Compute layer (TypeScript):**

- `api/_lib/microstructure-signals.ts` — generalize compute functions
  to accept a `symbol` parameter. The existing exports `computeMicrostructureSignals(now)` should
  be extended to `computeMicrostructureSignals(now, symbol)`. Keep
  a back-compat wrapper or default `symbol='ES'` if existing callers
  rely on no-arg form. New convenience export
  `computeAllSymbolSignals(now): Promise<{es: Signals | null, nq: Signals | null}>`
  that runs ES + NQ in parallel.
- `api/__tests__/microstructure-signals.test.ts` — add NQ variants
  of the existing ES test cases. Add a cross-symbol test that
  verifies both are computed in parallel and independently.

**Analyze context wiring:**

- `api/_lib/analyze-context-fetchers.ts` — update the existing
  microstructure fetcher to call the dual-symbol compute function
  and format both symbols. Structure the output so ES and NQ are
  clearly distinguished.
- `api/_lib/analyze-context-formatters.ts` — add
  `formatMicrostructureDualSymbolForClaude(result)` that renders the
  ES + NQ block with cross-asset call-outs (e.g., divergence warnings
  when ES and NQ OFI signs disagree).
- `api/__tests__/analyze-context.test.ts` — regression tests for the
  new dual-symbol block format.

**Prompt interpretation rules (cached stable section):**

- `api/_lib/analyze-prompts.ts` — extend the `microstructure_signals_rules`
  block (cached in `SYSTEM_PROMPT_PART1`) with the Phase 4d finding:

  ```
  <microstructure_signals_rules>
  Validated signal (Phase 4d, 2026-04-19, n=312 days):
  - NQ 1h OFI carries Bonferroni-significant predictive power for
    next-day NQ return (Spearman ρ=0.31, p_bonf<0.001).
  - ES OFI carries NO Bonferroni-significant predictive power.
    Treat ES microstructure as qualitative tape flavor only.
  - Cross-asset divergence (NQ buying, ES neutral or selling) is a
    classic tech-leading signal. Weight in directional SPX decisions.
  - Same-direction alignment (both positive or both negative) is
    stronger than either symbol alone.

  Interpretation guardrails:
  - OFI in [-0.2, +0.2] = BALANCED, ignore as signal
  - NQ OFI > +0.3 with ES confirmation = AGGRESSIVE_BUY regime
  - NQ OFI < -0.3 with ES confirmation = AGGRESSIVE_SELL regime
  - Effect size ρ=0.31 is factor-level, not standalone. Combine
    with GEX, dark pool, and IV term structure before sizing.
  - Signal weakens intraday after morning OFI has been absorbed.
    Pre-11:00 ET OFI is more predictive than post-14:00 ET OFI.
  </microstructure_signals_rules>
  ```

### Not modified

- `sidecar/src/db.py` — writers are already symbol-agnostic
- DB migrations — no schema change (tables already carry symbol column)
- Analyze endpoint (`api/analyze.ts`) — no change to the prompt
  assembly or cache boundary; only the contents of the existing
  cached block
- Phase 4c/4d ML code — out of scope for runtime

## Constraints

- **No new DB tables or migrations.** The plumbing exists.
- **No new cron jobs.** Compute stays on-demand at analyze time.
- **No new external APIs.** All data already flows through the sidecar.
- **Memory and runtime discipline:** each analyze call currently
  includes ES microstructure in ~100ms. Adding NQ in parallel should
  add <100ms — don't let it go sequential.
- **Cache boundary:** interpretation rules go in
  `SYSTEM_PROMPT_PART1` (cached), signal values stay in the dynamic
  per-call context (uncached). Same pattern as Phase 2b.
- **Backwards compatibility:** existing ES-only callers of
  `computeMicrostructureSignals` should continue to work. Either
  via default-param `symbol='ES'` or a back-compat wrapper.

## Done when

- `npm run review` passes with zero errors.
- Sidecar Python tests pass; the "NQ is processed, not dropped"
  regression test exists and is green.
- `api/__tests__/microstructure-signals.test.ts` has NQ-variant tests
  alongside ES tests and a dual-symbol parallelization test.
- Analyze context, when mocked with known OFI values, renders both
  ES and NQ blocks with the cross-asset divergence call-out logic.
- The cached `microstructure_signals_rules` block in
  `analyze-prompts.ts` reflects the Phase 4d empirical finding with
  the exact ρ and p-values.
- Smoke test: after merge and sidecar redeploy, a Monday-morning
  analyze call includes the NQ block with real intraday OFI.

## Out of scope for Phase 5a

- Backfilling historical NQ TBBO live-stream data into the
  production tables (would create join semantics between backfill
  and live; decided against in Phase 4b paused status).
- UW data deltas (original Phase 5 scope).
- Model training on the validated features.
- Frontend UI surfacing of NQ OFI.

## Open questions

- **Cross-asset divergence threshold:** when exactly does the analyze
  context fire a "divergence" warning? Default proposal: `|NQ_OFI -
  ES_OFI| > 0.4 AND sign(NQ_OFI) != sign(ES_OFI)`. If that's too
  conservative or too chatty, adjust after a week of live observation.
- **Back-compat shape for `computeMicrostructureSignals`:** prefer
  `computeMicrostructureSignals(now, symbol='ES')` with positional
  symbol default, or a separate `computeAllSymbolSignals(now)`? The
  latter is cleaner architecturally; the former is less churn. Pick
  whichever reads best given existing caller surface.
