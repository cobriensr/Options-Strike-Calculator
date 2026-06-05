# Classifier cross-type join sub-batching (OOM fix)

**Date:** 2026-06-04
**Status:** Spec → implementation
**Owner:** classifier service (Railway)

## Goal

Stop the multileg Classifier service from OOM-crashing at the market open
by bounding the peak memory of a single cross-type (calls × puts) join,
so a dense 0DTE window no longer materializes a multi-GB intermediate.
Detection accuracy must be **unchanged** — every call/put pair evaluated
today is still evaluated.

## Root cause (confirmed 2026-06-04)

- `multileg.classify.sidecar_unreachable` Sentry alerts are a symptom of
  the Classifier Railway service OOM-crashing + restarting in a loop at
  the open (3 restarts in 9 min this morning: 08:31/08:35/08:40 CT; 4×
  "Out of memory" Railway alerts).
- The 8→4 concurrency cap (commit `687bac53`, live since 06-03 00:47 CT)
  did **not** fix it: the crashes happened on the 4-way build. Per-minute
  Railway memory metric peaked at only 2.82 GB — the real spike is
  sub-minute and the 60s sampler misses it.
- The matcher's cross-type step
  (`_two_leg_cross_type_from_batch` in `multileg_assembler.py`) calls
  `_cross_join_two_leg(a=calls, b=puts)` and again `(a=puts, b=calls)` on
  the **whole** per-batch frames. When a single 90s time bucket holds
  thousands of calls and thousands of puts (open-burst QQQ/SPY 0DTE), the
  join materializes `|calls| × |puts|` rows **before** the existing
  `_PER_BATCH_PRUNE_THRESHOLD` (which acts on the join *output*) can prune.
- The `_MAX_CELL_ROWS_PER_CLASSIFY = 500_000` cell guard is the wrong
  granularity: a ±30s caller window's cell is only ~2.6–4.6 K rows, three
  orders of magnitude under 500 K, so it never trips.

### Measured worst-case (06-04, 08:25–09:00 CT, `ws_option_trades`)

| Ticker | Expiry | ~60s window | Calls | Puts | Cross-product |
|---|---|---|---|---|---|
| QQQ | 0DTE | 08:45 | 2,601 | 4,411 | 11.5M |
| SPY | 0DTE | 08:45 | 2,457 | 4,087 | 10.0M |
| SPXW | 0DTE | 08:32 | 3,497 | 3,294 | 11.5M |

QQQ/SPY (the detect-cron universe) alone hit ~10–11.5M pairs/request; the
matcher runs **two** such joins per batch → ~20M+ intermediate rows, and
polars' hash-join transiently allocates 2–3× during the build → multi-GB
per request. Concurrency 4 → transient > 24 GB → kernel OOM-kill.

## Approach — Option 3: sub-batch (keep full detection)

Inside `_two_leg_cross_type_from_batch`, when
`a.height * b.height > _CROSS_JOIN_PAIR_CAP`, iterate side **A** in
row-chunks of `chunk = max(1, _CROSS_JOIN_PAIR_CAP // max(1, b.height))`,
call `_cross_join_two_leg(a=a_chunk, b=b)` per chunk, prune each chunk's
output if it exceeds `_PER_BATCH_PRUNE_THRESHOLD`, and concat. Apply to
**both** orientations (calls-as-A chunked vs puts; puts-as-A chunked vs
calls).

This is **output-identical**: a cross/size-band join is row-independent in
A, so `(A1 ∪ A2) ⋈ B == (A1 ⋈ B) ∪ (A2 ⋈ B)`. The window/size filter and
`_is_anchor` filter are per-row and applied after concat exactly as today.
Total work is unchanged; only the **peak** per-`_cross_join_two_leg`
materialization drops to ≤ ~`_CROSS_JOIN_PAIR_CAP` rows.

### Threshold

- New constant `_CROSS_JOIN_PAIR_CAP` near the other join knobs. Start at
  **1_000_000** (single-request intermediate ~1M rows → sub-GB; 4
  concurrent comfortably < 24 GB). Tunable; dial in during implementation.
- Below the cap, behavior is byte-for-byte the current single-shot path
  (no chunking overhead for the common case).

### Observability (count trips so we can retune)

- When sub-batching triggers, emit a `warnings.warn(..., RuntimeWarning)`
  (consistent with the existing cell-skip guard) including ticker,
  bucket range, `n_calls`, `n_puts`, and number of sub-chunks. Visible in
  Railway logs.
- Optional follow-up (not required this PR): wrap the `classify_trades`
  call in `multileg_routes.py` with `warnings.catch_warnings(record=True)`
  and forward sub-batch warnings as a Sentry breadcrumb tagged
  `classifier.cross_type_subbatch` so trip frequency is queryable.

## Files

- `ml/src/multileg_assembler.py` — **source of truth**. Add
  `_CROSS_JOIN_PAIR_CAP`; rewrite `_two_leg_cross_type_from_batch` to
  sub-batch.
- `classifier/_vendored_ml/multileg_assembler.py` — **byte-identical
  copy**. Re-vendor after the source change (enforced by
  `classifier/tests/test_vendored_ml_sync.py`).
- `ml/tests/` — matcher unit tests: add cases proving (a) output identity
  vs single-shot on a dense synthetic bucket, (b) the cap triggers
  chunking, (c) a small bucket is untouched.
- `classifier/tests/` — keep the 95% branch-coverage gate green
  (`pyproject.toml addopts`). Cover the new chunk loop + warning path.

## Verification

- `ml/.venv/bin/python -m pytest ml/tests/ -k multileg` green.
- `cd classifier && pytest` green **including** `--cov-fail-under=95` and
  `test_vendored_ml_sync.py` (both copies identical).
- Synthetic equivalence test: classify a 3000-call × 3000-put 0DTE bucket
  with `_CROSS_JOIN_PAIR_CAP` large (single-shot) vs small (chunked) →
  identical `inferred_structure` / `pattern_group_id` assignment.

## Out of scope

- Concurrency cap stays at 4.
- No caller (`multileg-classify-batch.ts` / `MAX_WINDOW_TRADES`) change —
  the N² density, not total window size, is the problem.
- polars streaming/lazy rewrite (heavier; revisit only if 1M cap proves
  insufficient under production soak).

## Deploy

Railway redeploys the Classifier on push (watchPatterns include
`classifier/**` and `ml/src/multileg_*.py`). After-hours deploy is safe
(market closed). Confirm a clean boot + next-open memory stays flat.
