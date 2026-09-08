# Classifier Phase A — butterfly density gate, timeout alignment, delta fix

> **For agentic workers:** execute via superpowers:subagent-driven-development, one
> commit per task on branch `fix/classifier-butterfly-gate-2026-09-08`
> (worktree `.worktrees/classifier-phase-a`). Every matcher edit lands in
> `ml/src/` first and is re-vendored byte-identically to BOTH
> `classifier/_vendored_ml/` and `sidecar/_vendored_ml/`.

**Goal:** Stop the classifier Railway service from OOM-crashing and from running
multi-minute requests, by gating the one uncapped stage of the matcher (butterfly
enumeration), aligning the server's queue/compute budget with the TypeScript client's
15 s abort, and removing a live 500 caused by polars schema inference on `delta`.

**Evidence:** `docs/tmp/classifier-code-review-2026-09-08.md` §1–§3 and the probe
`docs/tmp/classifier-memory-probe-2026-09-08.py`. Headline numbers (macOS,
`POLARS_MAX_THREADS=2`, production-shaped single-ticker 60 s window):

| trades | 2-leg paths only | full incl. butterfly |
|-------:|-----------------:|---------------------:|
| 2,000  | 142 MB / 0.6 s   | 897 MB / 1.0 s       |
| 5,000  | 329 MB / 1.1 s   | 3.1 GB / 17 s (6.2 GB at 45 % mid) |
| 10,000 | 1.15 GB / 4.0 s  | 8.0 GB / 204 s       |

Output was byte-identical with and without the butterfly stage in every run. Production
has 416 butterflies in ~198 K classified rows (0.21 %). The greedy assigner hands
confidence ties to 2-leg candidates (`two_conf >= three_conf`), so in a dense window —
where every print has a 1.0-confidence vertical partner — a butterfly cannot win.

---

## Thresholds / constants

| Constant | Value | Where | Rationale |
|---|---|---|---|
| `_BUTTERFLY_PAIR_CAP` | `250_000` | `ml/src/multileg_assembler.py` (new) | Same family as `_SELF_JOIN_PAIR_CAP` / `_CROSS_JOIN_PAIR_CAP`. `bodies × wings` above this → skip the stage for that batch. In a single bucket that is ~500 rows, already the regime where verticals saturate. |
| `_QUEUE_WAIT_TIMEOUT_SEC` | `30.0 → 8.0` | `classifier/src/multileg_routes.py` | Client aborts at 15 s (`multileg-client.ts:165`). 8 s queue + ≤ ~5 s matcher (post-gate) fits inside it. |
| `_REQUEST_BUDGET_SEC` | `13.0` (new) | `classifier/src/multileg_routes.py` | Hard deadline for parse+queue+matcher measured from `handle_classify_payload` entry; 2 s slack under the client's 15 s. |
| `classify_trades(..., deadline=None)` | monotonic float | `ml/src/multileg_assembler.py` | Checked at the top of every per-ticker, per-cell and per-batch loop; raises `MatcherDeadlineExceeded` (subclass of `TimeoutError`). |
| Client timeout | 15 s, unchanged | `api/_lib/multileg-client.ts` | No TS changes in Phase A. |

No new tables, migrations, env vars or external APIs.

---

## Task 1 — Butterfly pair gate (the fix that stops the crashes)

**Files:** modify `ml/src/multileg_assembler.py`; re-vendor to
`classifier/_vendored_ml/multileg_assembler.py` and `sidecar/_vendored_ml/multileg_assembler.py`;
tests in `ml/tests/test_multileg_assembler.py`.

**Design (skip, not sub-chunk):** `_butterfly_candidates_for_bodies` has two unbounded
products: body×wing (`_BUTTERFLY_BODY_CHUNK` bounds bodies, not pairs) and the per-body
`lo.join(hi, on="ridx_body")` cartesian, which no body chunking can bound. Given the greedy
tie rule, the correct Phase A behaviour above the cap is to skip enumeration for that batch,
warn once per batch, and let the 2-leg stages proceed. A top-K-wings-per-body prune is the
Phase C alternative if Task 4 shows meaningful retention loss.

**Steps (TDD):**

1. Add tests (all must FAIL first because `_BUTTERFLY_PAIR_CAP` does not exist):
   - `test_butterfly_gate_skips_enumeration_above_cap`: monkeypatch
     `multileg_assembler._butterfly_candidates_for_bodies` to a sentinel that raises
     `AssertionError("must not be called")`; build `_dense_butterfly_cell(n_flies=300)`
     (900 rows, bodies×wings = 810 K > cap); with `_BUTTERFLY_PAIR_CAP = 250_000` assert
     `classify_trades` completes, emits `RuntimeWarning` matching
     `"skipping butterfly enumeration"`, and no row is labelled `butterfly` (documented
     trade-off). With `_BUTTERFLY_PAIR_CAP = 10**12` assert the sentinel IS called.
   - `test_butterfly_gate_below_cap_is_unchanged`: `_dense_butterfly_cell(n_flies=120)`
     (360 rows, 43 K pairs) → identical output with cap = 250 K vs 10**12, no gate
     warning (use `warnings.simplefilter("error", RuntimeWarning)` around the capped run
     as `test_butterfly_small_cell_no_subbatch_warning` does), and butterflies present.
   - `test_butterfly_gate_dense_same_type_window_output_identical`: a NEW calls-only
     fixture `_dense_calls_mixed_sizes(n=800)` — one expiry, one 90 s bucket, strikes
     cycling over 30 integer values, sizes cycling over `(1, 2, 1, 2, 4, 2)`, sides
     alternating buy/sell via nbbo so verticals are abundant and body=2×wing shapes exist.
     Assert `classify_trades` output is identical with cap = 250 K vs 10**12. Calls-only
     keeps the assignment deterministic (cross-type mid pairs are nondeterministic — review
     §3.3 — do NOT use a mixed call/put fixture here).
2. Implement: add `_BUTTERFLY_PAIR_CAP: Final = 250_000` next to `_BUTTERFLY_BODY_CHUNK`
   with a comment citing the review numbers; in `_butterfly_from_batch`, after `bodies` is
   computed and the empty check, add
   `if bodies.height * batch.height > _BUTTERFLY_PAIR_CAP: warnings.warn(...); return _empty_candidates_3leg()`.
   Below the cap the function is byte-for-byte unchanged.
3. Run `cd ml && <MAIN>/ml/.venv/bin/python -m pytest tests/test_multileg_assembler.py tests/test_multileg_patterns.py -q`
   and `<MAIN>/ml/.venv/bin/python -m ruff check src/multileg_assembler.py tests/test_multileg_assembler.py`.
4. Re-vendor: `cp ml/src/multileg_assembler.py classifier/_vendored_ml/ && cp ml/src/multileg_assembler.py sidecar/_vendored_ml/`;
   run `cd classifier && <MAIN>/classifier/.venv/bin/python -m pytest -q` and
   `cd sidecar && <MAIN>/sidecar/.venv/bin/python -m pytest tests/test_vendored_ml_sync.py -q`
   (if the sidecar venv is missing, `cmp` the two files and say so).
5. Re-run the probe from the worktree for 10 K trades in `full` mode and record peak/wall in
   the commit body (expected ≈ 1.2 GB / ~4 s, was 8.0 GB / 204 s).
6. Commit: `perf(matcher): gate butterfly enumeration by bodies×wings pair cap`.

## Task 2 — Timeout alignment + matcher deadline

**Files:** `ml/src/multileg_assembler.py` (+ re-vendor ×2), `ml/tests/test_multileg_assembler.py`,
`classifier/src/multileg_routes.py`, `classifier/src/server.py` (comments only),
`classifier/README.md`, `classifier/tests/test_concurrency.py`.

**Depends on:** Task 1 and Task 3 merged into the branch (same files).

**Steps (TDD):**

1. Matcher deadline tests (ml): `classify_trades(df, deadline=time.monotonic() - 1)` on any
   2-row fixture raises `MatcherDeadlineExceeded`; `deadline=None` unchanged;
   `deadline=time.monotonic() + 60` unchanged output.
2. Implement: `class MatcherDeadlineExceeded(TimeoutError)`; `classify_trades(..., deadline: float | None = None)`
   threads `deadline` into `_classify_ticker`; a tiny `_check_deadline(deadline)` helper is
   called at the top of the per-ticker loop, the per-cell loop, every batch iteration in the
   three batch loops, and each anchor-chunk / body-chunk loop. Re-vendor ×2.
3. Route tests (classifier, `test_concurrency.py`): (a) `_QUEUE_WAIT_TIMEOUT_SEC == 8.0`;
   (b) when `_classify_with_polars` raises `MatcherDeadlineExceeded`, the route returns
   503 with `retry_after_sec` and `error` mentioning "deadline", and does NOT hit the
   500/Sentry-exception path (assert `capture_exception` not called; a
   `capture_message`/breadcrumb at warning level is fine); (c) the deadline passed to the
   matcher is `entry_monotonic + _REQUEST_BUDGET_SEC` — assert via a monkeypatched
   `classify_trades` that records its `deadline` kwarg.
4. Implement in `multileg_routes.py`: record `t_entry = time.monotonic()` at the top of
   `handle_classify_payload`; `_QUEUE_WAIT_TIMEOUT_SEC = 8.0`; `_REQUEST_BUDGET_SEC = 13.0`;
   pass `deadline=t_entry + _REQUEST_BUDGET_SEC` into `classify_trades`; catch
   `MatcherDeadlineExceeded` before the generic `except Exception` and return the 503 shape
   with `"error": "classifier deadline exceeded; retry in a few seconds"` plus
   `n_trades`; emit `sentry_setup.capture_message(..., level="warning", extra={n_trades, elapsed_sec})`.
5. Replace every "the TS client retries on 503 with jitter" claim with the truth
   (`multileg_routes.py` ~L87–99, `server.py` ~L170–172 and ~L383–384, `README.md` ~L53):
   *the TS client aborts at 15 s and does not retry; `multileg-classify-batch.ts` returns
   null and caches the null for that (ticker, chain, minute).* Also fix `server.py:9–13`
   ("no BoundedSemaphore yet") to describe the shipped semaphore.
6. Verify: classifier suite, ml multileg suite, sidecar sync test, ruff on both. Commit:
   `fix(classifier): align queue timeout with the 15 s client budget and add a matcher deadline`.

## Task 3 — Drop `delta` from the polars frame; catch RecursionError

**Files:** `classifier/src/multileg_routes.py`, `classifier/tests/test_multileg_routes.py`.

**Steps (TDD):**

1. Tests (must FAIL first): (a) 150 trades with `delta` absent followed by one with
   `delta: 0.42` → `handle_classify_payload` returns 200 (currently 500 with
   `could not append value: 0.42 of type: f64`); this test must NOT mock
   `_classify_with_polars` (mirror `test_handle_payload_mixed_null_delta_round_trips_through_real_matcher`);
   (b) a body of 200 000 `[` bytes → 400 `"body must be valid JSON"` (currently
   `RecursionError` escapes and no response is written).
2. Implement: remove `"delta": t.delta` from the `rows` dict in `_classify_with_polars`
   (the matcher's `_REQUIRED_FIELDS` and `legs` projection never read it; keep the field in
   `MultilegTradeInput` for wire compatibility, note why in a comment). Add
   `RecursionError` to the `json.loads` except tuple.
3. Verify: `cd classifier && pytest -q` + ruff. Commit:
   `fix(classifier): stop passing unused delta into polars (schema-inference 500) and map RecursionError to 400`.

## Task 4 — Production replay gate (measurement only, no code shipped)

**Depends on:** Task 1. Read-only against prod Neon (`DATABASE_URL` from `.env.local`,
`SET statement_timeout='60s'`, SELECT only, ≤ 100 windows).

1. Sample the 100 most recent `lottery_finder_fires` rows with `inferred_structure = 'butterfly'`
   (columns: `underlying_symbol`, `option_chain_id`, `trigger_time_ct`) — check the exact
   column names via `information_schema.columns` first.
2. For each, pull the window exactly as `multileg-classify-batch.ts` does: `ws_option_trades`
   where `ticker = $1 AND executed_at BETWEEN trigger-30s AND trigger+30s AND canceled = FALSE AND price > 0`,
   convert with the same `synthesizeNbbo` rule (ask→bid 0.01/ask price; bid→bid price/ask
   9999; else 0.01/9999), `option_type 'C'/'P' → 'call'/'put'`.
3. Run the vendored matcher from a snapshot copy of `classifier/_vendored_ml/` (so Task 2
   edits cannot race) twice per window: `_BUTTERFLY_PAIR_CAP = 10**12` vs `250_000`.
   Report: window size distribution, how many of the 100 anchor trades keep the
   `butterfly` label, and how many windows tripped the gate. Write the table to
   `docs/tmp/classifier-butterfly-replay-2026-09-08.md`.
4. Decision rule: retention ≥ 90 % → ship as is. Below that → raise the cap to the
   smallest value that restores ≥ 90 % (re-run the memory probe at that cap; must stay
   under ~3 GB at 10 K) or schedule the top-K-wing prune. Do not change code in this task.

---

## Verification (every task)

```bash
MAIN=/Users/charlesobrien/Documents/Workspace/strike-calculator
cd ml        && $MAIN/ml/.venv/bin/python -m pytest tests/test_multileg_assembler.py tests/test_multileg_patterns.py -q
cd classifier && $MAIN/classifier/.venv/bin/python -m pytest -q          # includes test_vendored_ml_sync
cd sidecar   && $MAIN/sidecar/.venv/bin/python -m pytest tests/test_vendored_ml_sync.py -q
$MAIN/classifier/.venv/bin/python -m ruff check classifier/src classifier/tests
$MAIN/ml/.venv/bin/python -m ruff check ml/src/multileg_assembler.py ml/tests/test_multileg_assembler.py
```

No TypeScript changes in Phase A, so `npm run review` is not required (per the 2026-06-11
rework spec's verification note); run it anyway before merge if the branch ends up touching
anything under `api/` or `src/`.

## Rollout

Merging to main triggers Railway redeploys of **both** the classifier (watchPatterns
`classifier/**`) and the Databento sidecar (`sidecar/_vendored_ml` changes). Merge/push
after the close (15:00 CT) so the sidecar restart does not interrupt futures ingestion. Watch
the next 13:30 UTC open: expected `MEMORY_USAGE_GB` peak ≲ 2 GB, zero restarts, `lazy
import_ms` boot lines only once per replica. After one clean open, shrink the service to
~4 vCPU / 8 GB per replica.

## Open questions (defaults chosen)

1. Gate vs top-K-wing prune — **gate** (Phase A); revisit only if Task 4 retention < 90 %.
2. TS-side retry on 503 — **deferred to Phase B**; the matcher will be ≤ ~5 s so 503s
   should be rare and the cron's 60 s budget is the binding constraint.
3. Sub-chunk parity for the dense mixed window — **not testable byte-for-byte** until the
   strangle/risk_reversal tie-break is made deterministic (review §3.3, Phase C).

## Memory safety on the dev machine (added 2026-09-08 13:35 CT)

The dev box has 16 GB and ~4 GB free; an 8 GB ungated 10 K-trade probe run crashed the
editor. Rules for every implementer and reviewer on this branch:

- Never run the memory probe in `full` mode on the UNGATED matcher above 2,000 trades.
- Run the probe at 10 K only AFTER the Task 1 gate is merged and its tests pass, and run
  5 K first — if the 5 K peak exceeds 2 GB, stop and report instead of running 10 K.
- Test fixtures that exercise the ungated butterfly path (cap = 10**12) stay ≤ 800 rows
  per cell.
- Task 4 runs the GATED matcher only. The production label is already the ungated
  result, so retention = anchors that keep `butterfly` under the gate; no ungated replay.
- Do not run two polars-heavy processes at the same time.
