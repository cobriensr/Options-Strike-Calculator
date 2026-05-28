# Classifier Service Phase 1.5 Hardening — Red-Team Findings

**Date:** 2026-05-28
**Status:** Spec — execution starting immediately
**Parent spec:** `docs/superpowers/specs/multileg-classifier-service-split-2026-05-28.md` (Phase 1 shipped earlier today)
**Driver:** Four-agent red-team review surfaced 22 fixable findings across HTTP/network, Pydantic/JSON validation, polars matcher correctness, and wire-contract observability. Three classes of silent-wrong outputs and three operational time bombs identified. Tier 0 items are needed before tomorrow's soak window starts (8:30 AM CT) so the rollout isn't blind.

## Goal

Close all Tier 0, Tier 1, Tier 2, and Tier 3 findings from the red-team review before the production soak window completes. Preserves the Phase 1 deploy already live; this is purely additive hardening with no behavior change for happy-path traffic.

## Why these specifically

Across the four independent red-team agents, three findings showed **cross-agent convergence** (multiple agents found the same root from different angles) — strongest signal that they're real:

1. **Overload-skip null contract gap** (Agents C+D): matcher emits null structure columns; Pydantic doesn't validate output; Zod rejects → real overload events surface as opaque `schema_mismatch`.
2. **Expiry/datetime timezone fragility** (Agents B+C): naive datetime relabeled UTC; expiry tz drift fragments cross-type partitions silently.
3. **NBBO synthesis brittleness** (Agents C+D+B): all-or-nothing column predicate + synthetic 1¢×$9999 spread on mid/no_side → silent misclassification when contract changes.

Plus three operational time bombs:
- SIGTERM doesn't translate to KeyboardInterrupt (Agent A) → every Railway redeploy currently loses in-flight Sentry events. My main.py comment was wrong.
- No Sentry alarm on `SIDECAR_URL` fallback firing (Agent D) → soak could silently un-happen.
- No multileg null-rate metric in detect crons (Agent D) → fail-open path is invisible.

## Tasks (sequential, each independently shippable)

### Task 1 — Classifier HTTP/server hardening

**Files:** `classifier/src/server.py`, `classifier/src/main.py`, `classifier/tests/test_server.py`, `classifier/tests/test_main.py`

- **0.3** SIGTERM handler raising KeyboardInterrupt; `sentry_sdk.flush(timeout=2)` in finally. Fix the wrong comment in main.py.
- **1.7** Socket timeout (`timeout = 30` on `ClassifierHandler`) — Slowloris defense.
- **2.6** `block_on_close = False` on `_QuietThreadingHTTPServer` — shutdown drain hygiene.
- **3.1** Reject `Transfer-Encoding: chunked` with 411 Length Required.
- **3.2** Reject duplicate `Content-Length` headers with 400.
- **3.3** Sentry capture before `return 2` in PORT-misconfig path (Sentry is up by then).
- **2.2** New `GET /version` route returning `{matcher_sha, release, patterns}`.

**Done when:** All `npm run review`-style verification passes on `classifier/`. New tests for each path. Curl smoke against the new `/version` endpoint returns a valid response.

### Task 2 — Classifier Pydantic/validation hardening

**Files:** `classifier/src/multileg_routes.py`, `classifier/tests/test_multileg_routes.py`

- **1.2** `allow_inf_nan=False` on all `float` fields; `json.loads(parse_constant=...)` to reject bareword `NaN`/`Infinity` at JSON-parse time.
- **1.3** `@field_validator` rejecting `tzinfo is None` on `executed_at`.
- **1.8** Upper bound caps: `window_seconds le=600`, `strike_tolerance le=0.5`, `size_tolerance le=1.0`.
- **3.5** Switch to strict mode (`strict=True` in `ConfigDict`) — rejects `bool` → `float` coercion and string → number coercion.
- **1.1 (server side)** `MultilegClassification` response fields become `Optional` (`inferred_structure: str | None`, etc.) to match what the matcher actually emits for skipped tickers. Document the null contract.

**Done when:** Tests cover each new validation path. Boundary tests for the new caps. Mixed null/non-null delta test added.

### Task 3 — Matcher defensive fixes

**Files:** `ml/src/multileg_assembler.py` (source of truth), `classifier/_vendored_ml/multileg_assembler.py` (re-sync), `ml/tests/test_multileg_assembler.py`, `classifier/tests/test_multileg_routes.py`

- **1.4 + Agent C F8** Add `df = df.with_columns(pl.col("option_type").str.to_lowercase())` at top of `_classify_ticker`. One-line defense against case-sensitivity bug class.
- **1.5** NBBO presence predicate: raise `ValueError` if exactly one of `nbbo_bid`/`nbbo_ask` is present (caller bug, fail loud) instead of silently degrading every trade to `mid`.
- **3.4** Add unit test for mixed null/non-null `delta` in a batch. If matcher misbehaves, either drop the column entirely from row dicts or document the matcher's tolerance contract.
- **Maintain byte-equality** with `classifier/_vendored_ml/`. The sync test enforces this.

**Done when:** Existing matcher tests still pass. New defensive tests pass. Byte-equality test still green.

### Task 4 — BoundedSemaphore (promoted from Phase 2)

**Files:** `classifier/src/server.py` or `classifier/src/multileg_routes.py`, `classifier/tests/test_server.py` or new `test_concurrency.py`

- **1.6** `threading.BoundedSemaphore(8)` in front of `_classify_with_polars`. 30s queue-wait timeout → 503 `Retry-After: 5`. Sentry breadcrumb on queue wait >5s.
- **2.3** Log `import_ms` on first successful call (cold-start visibility).

**Done when:** Concurrency test asserts max 8 simultaneous matcher invocations, 503 on queue timeout. Cold-start import_ms appears in Railway logs.

### Task 5 — TS client hardening

**Files:** `api/_lib/multileg-client.ts`, `api/__tests__/multileg-client.test.ts`

- **0.1** Add `Sentry.captureMessage('multileg.classify.classifier_url_unset_falling_back_to_sidecar', { level: 'warning' })` next to the existing fallback warn log. Same once-per-process gate.
- **1.1 (TS side)** Zod schema: `inferred_structure`, `pattern_group_id` become `nullable()`, `is_isolated_leg` becomes `nullable()`, `match_confidence` becomes `nullable()`. `MultilegClassification` type adjusted accordingly.
- **2.1** Thread `target: 'classifier' | 'sidecar-fallback'` through to every `Sentry.captureMessage(...)` `extra` block — including `sidecar_unreachable`, `sidecar_non_2xx`, `schema_mismatch`, `length_mismatch`.
- **2.4** Distinguish 422 from 400 in `http_4xx` branch: new event `multileg.classify.contract_drift` with the Pydantic `details[].loc` field paths in `extra`.
- **2.5** Per-process throttle on `Sentry.captureMessage('multileg.classify.*')` — track last-emit-ms per message name, suppress if <60s.
- **2.2 (TS side)** Cold-start `/version` fetch on first call; assert `patterns` is superset of TS `MULTILEG_STRUCTURES`. Drift = Sentry capture.

**Done when:** All new event paths tested. Existing tests still pass.

### Task 6 — Cron caller null-rate metric

**Files:** `api/_lib/multileg-classify-batch.ts`, `api/cron/detect-lottery-fires.ts`, `api/cron/detect-silent-boom.ts`, matching tests

- **0.2** Add `multilegHits` / `multilegMisses` counters in both detect crons. Pattern matches existing `gexHits`/`gexMisses`. Log in handler's `ctx.logger.info(...)` payload. Sentry alert at <50% hit rate when `inserted > 10`.
- **1.5 (cron side)** When `side ∈ {mid, no_side}`, null out `match_confidence` server-side before insert (defensive — the matcher's confidence is meaningless on synthetic NBBO for those trades).

**Done when:** Counters appear in cron logs. Both detect cron tests cover the new counter path.

## Testing strategy

Per Phase 1 precedent: `npm run review` (tsc + eslint + prettier + vitest --coverage) for TS-side changes. `pytest --cov` for classifier-side. Coverage gate stays at ≥95% line / ≥90% branch on `classifier/src/`. Vendored ML sync test (`classifier/tests/test_vendored_ml_sync.py`) remains the byte-equality guard for matcher changes.

## Rollout sequence

1. **Tasks 1-4 land first** (classifier Python service). Single Railway redeploy after Task 4. Smoke `/health` and `/version` to confirm boot.
2. **Tasks 5-6 land second** (TS Vercel functions). `vercel build --prod && vercel deploy --prebuilt --prod --archive=tgz`. The TS Zod schema relax (Task 5, 1.1) is backward-compatible because the server already emits null for skipped tickers; making Zod accept it removes the spurious `schema_mismatch` events.
3. **Soak with full Tier 0 observability** through tomorrow's session and one weekend of cron activity. Promote to "stable Phase 1.5" after soak passes.

## Out of scope

- Phase 2 work (`MAX_WINDOW_TRADES` 10000→7500). Separate session.
- Phase 3a (adaptive `_CELL_BATCH_BUCKETS=1`). Separate session.
- The Phase-1 post-soak cleanup commit that removes `SIDECAR_URL` fallback. After full soak completes.
- Findings marked Won't-fix in the red-team report.
