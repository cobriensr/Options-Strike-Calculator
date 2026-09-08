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
| `_BUTTERFLY_PAIR_CAP` | `400_000` (250_000 in Task 1; raised in Task 5 per the replay) | `ml/src/multileg_assembler.py` (new) | Same family as `_SELF_JOIN_PAIR_CAP` / `_CROSS_JOIN_PAIR_CAP`. `bodies × wings` above this → skip the stage for that batch. In a single bucket that is ~500 rows, already the regime where verticals saturate. |
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
3. Run the GATED vendored matcher (Task 1 merged; `_BUTTERFLY_PAIR_CAP = 250_000` as
   shipped) from a snapshot copy of `classifier/_vendored_ml/` (so Task 2 edits cannot
   race) once per window, capturing `RuntimeWarning`s. The production label is already
   the ungated result, so there is no ungated replay (and none may be run — memory).
   Report: window size distribution, how many of the 100 anchor trades keep the
   `butterfly` label under the gate, and how many windows tripped the gate. Write the
   table to `docs/tmp/classifier-butterfly-replay-2026-09-08.md`.
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

## Task 4 results (2026-09-08 14:10 CT) and the resulting Task 5

Replay of the 100 most recent `butterfly` lottery fires through the GATED matcher
(`docs/tmp/classifier-butterfly-replay-2026-09-08.md`, gitignored):

- Only **26/100 windows were replayable** — `cleanup-ws-option-trades` purges rows older
  than ET-date − 2 days, so 74 windows are gone. Replayable: today's 19 plus 7 from
  2026-07-09 that survived an incomplete sweep. No window exceeded the caller's 10 K cap
  (max 1,805 rows; median 358).
- **Retention 21/26 (80.8 %)**; today-only 17/19 (89.5 %). Every retained anchor reproduced
  the identical triple (`pattern_group_id`) and confidence.
- **Gate-attributable loss: 2/26.** Both were META on 2026-07-09 with single-cell products
  of 372,100 and 350,464 pairs (~600-row cells); both lost the label (→ isolated_leg,
  vertical), stable 5/5 on rerun. So the Task 1 comment's "output-identical in every
  measured run" is false at ~600-row cell density: verticals do not fully saturate there.
- **The other 3 losses are not the gate.** (a) The matcher is run-to-run nondeterministic on
  identical input, even at `POLARS_MAX_THREADS=1` (INTC fire 889248 over 5 runs: isolated
  ×3, vertical ×1, butterfly ×1) — a ~12 % noise floor under any single-shot retention
  metric and a data-quality defect in its own right (Phase C, alongside review §3.3; likely
  cause is join/unique output order feeding `rank(method="ordinal")` tie-breaks in
  `_prune_top_k_per_trade`). (b) The two today-losses were the only fires classified
  < 30 s after trigger (19.9 s and 24.7 s); production labelled them from a
  forward-truncated window, and re-cutting the window at trigger + 0–10 s reproduces the
  stored label and group id. `multileg-classify-batch.ts` should not classify until
  `trigger + HALF_WINDOW_SEC` has elapsed (Phase B).
- Peak RSS for the whole replay: 178 MB; per-window wall median 0.12 s, max 0.27 s.

**Decision (spec rule: < 90 % → smallest cap restoring the gate-caused losses):**
`_BUTTERFLY_PAIR_CAP` **250_000 → 400_000** (covers the observed 372,100 with a margin;
single-bucket cells up to ~632 rows now enumerate). No cap value reaches 90 % on this
sample because of the nondeterminism floor, so 400 K is the value that removes every
gate-attributable loss observed. Memory check: the OOM regime is 5–10 K-row cells
(25 M–100 M pairs), 60–250× above either cap, so the fix is unaffected; the ungated cost
of a 632-row cell is a few hundred MB (probe: ~850 MB at a 1,000-row cell at 20 % mid).

### Task 5 — raise the cap to 400 K and correct the comment (after Task 2 lands)

**Files:** `ml/src/multileg_assembler.py` (+ re-vendor ×2). No test changes required: the
gate tests monkeypatch the cap explicitly (250 K / 10**12) and the fixtures sit at 810 K
and 640 K pairs (still above 400 K) and 129.6 K (still below).

1. `_BUTTERFLY_PAIR_CAP: Final = 400_000`.
2. Replace the "In dense windows the skip has been output-identical in every measured run …"
   sentence with the replay evidence: identical at 5 K / 10 K prints and in the 800-print
   fixture; in the 2026-09-08 production replay, 2 of 26 replayable butterfly fires sat in
   ~600-row cells (350–372 K pairs) and lost the label under a 250 K cap, hence 400 K.
   Keep "Measured, not guaranteed".
3. Re-run the ml multileg suite, ruff, re-vendor, `cmp`, classifier + sidecar sync tests, and
   the probe at 5 K then 10 K `full` (expect ≈ unchanged: the 10 K cells are far above
   either cap). Commit: `perf(matcher): Raise butterfly pair cap to 400K per production replay`.

## Phase A.1 — PR #202 review fixes (added 2026-09-08 15:30 CT)

Source: the ten-angle `code-review` pass on PR #202. Six Important items plus the cheap
Minor ones. Deferred to Phase B (touch `api/` or the sidecar): the TypeScript Sentry
branch on the new `reason` field; deleting the `SIDECAR_URL` fallback route.

### Task 6 — Matcher: exact gates, deadline coverage, countable skips

**Files:** `ml/src/multileg_assembler.py` (+ re-vendor ×2), `ml/tests/test_multileg_assembler.py`.

1. **Exact body×wing pair count** (review item 2). Replace `bodies.height * batch.height`
   in `_butterfly_from_batch` with `_butterfly_pair_count(batch)`: per-bucket counts
   `nb_b` (rows with `_is_body`) and `nw_b` (all rows) from one `group_by("tbk")`, then
   `Σ_b nb_b × (nw_{b−1} + nw_b + nw_{b+1})` over buckets present in the batch. In a
   single-bucket batch this equals `bodies × batch`, so the replay-validated production
   behaviour is unchanged; multi-bucket batches stop over-firing by up to 2×.
2. **Exact triple gate** (review item 1). In `_butterfly_candidates_for_bodies`, after the
   `bw` window/size/side filter and before `lo`/`hi` are built, compute
   `_butterfly_triple_count(bw)` = `Σ_body n_lo × n_hi` via one `group_by("ridx_body")`.
   If it exceeds new `_BUTTERFLY_TRIPLE_CAP: Final = 5_000_000` (the production ceiling of
   632 rows measured 3.3 M triples / ~700 MB; 5 M ≈ 1 GB), warn and return
   `_empty_candidates_3leg()`. This is the join the pair cap never bounded (a 12-body
   batch beside a 30 K-row bucket passes 400 K pairs and builds 713 M triples).
3. **Deadline coverage** (review item 6). `_check_deadline` inside
   `_butterfly_candidates_for_bodies` immediately before the `tri` join (thread
   `deadline` from `_butterfly_from_batch`), and once in `_classify_ticker` before the
   final `_prune_top_k_per_trade` / `_greedy_assign`. Correct the module docstring: the
   body-chunk loop check is unreachable at default constants; the single-shot butterfly
   path is now checked before its largest join.
4. **Countable skips** (review item 5). New keyword-only `stats: dict[str, int] | None = None`
   on `classify_trades`, threaded like `deadline` down to `_butterfly_from_batch` and
   `_butterfly_candidates_for_bodies`; increment `butterfly_pair_gate_skips` /
   `butterfly_triple_gate_skips` via a tiny `_bump(stats, key)` helper. Make both gate
   warnings' text CONSTANT (no embedded counts; ASCII only — drop the `×`) so Python's
   warning registry stays bounded and repeats are not silently suppressed; the counts live
   in `stats`. Leave the four pre-existing sibling warnings as they are.
5. Tests (TDD): unit tests for `_butterfly_pair_count` (single-bucket == bodies×batch;
   a 3-bucket frame with known counts) and `_butterfly_triple_count`; the review's
   12-bucket × 130-row fixture must NOT trip the 400 K pair gate (sentinel called) where
   the old proxy would have; a sparse-bodies/dense-wings fixture (3 size-2 bodies + ~800
   size-1 wings, ≤ 800 rows) trips the triple gate at a lowered cap and enumerates at
   10**12; the frame spy gains rows for `_butterfly_candidates_for_bodies` and the
   pre-prune `_classify_ticker` check (assert it is the last recorded frame on a
   non-tripping run); `stats` counts skips and `stats=None` is a no-op; both gate
   messages contain no digits.

### Task 7 — Route/server: budget origin, `reason`, narrowed except, drift test, ruff

**Files:** `classifier/src/server.py`, `classifier/src/multileg_routes.py`,
`classifier/tests/test_server.py`, `classifier/tests/test_concurrency.py`,
`classifier/tests/test_client_timeout_contract.py` (new), `classifier/pyproject.toml`.

1. **Budget origin** (review item 3). `do_POST` takes `t_entry = time.monotonic()` before
   `self.rfile.read(...)` and calls `handle_classify_payload(body_bytes, t_entry=t_entry)`;
   the route's signature gains keyword-only `t_entry: float | None = None` (defaults to
   now, so existing callers/tests are unchanged). Test in `test_server.py` with a
   monkeypatched clock: the handler receives the pre-read timestamp.
2. **`reason` field** (review item 4, server half). Queue-timeout 503 body gains
   `"reason": "queue_timeout"` plus `elapsed_sec` and `budget_sec`; deadline 503 body
   gains `"reason": "deadline"`. Assert in both tests. (TS branch on `reason` → Phase B.)
3. **Narrow `except TimeoutError`** (Minor). Re-raise unless
   `type(exc).__name__ == "MatcherDeadlineExceeded"` (keeps the matcher import lazy).
   Test: a bare `TimeoutError` from the stub reaches the 500 path with `capture_exception`.
4. **Comment honesty** (Minor). The `_QUEUE_WAIT_TIMEOUT_SEC` paragraph must say the
   8 s wait sheds a request that would have completed inside 15 s (a queued third request
   at ~9 s wait) and that this is the intended trade at concurrency 1.
5. **Drift test** (Minor). `test_client_timeout_contract.py` reads
   `api/_lib/multileg-client.ts` (path relative to the repo root, skip with a clear
   message if absent) for `DEFAULT_TIMEOUT_MS = (\d[\d_]*)` and asserts
   `_QUEUE_WAIT_TIMEOUT_SEC < _REQUEST_BUDGET_SEC < DEFAULT_TIMEOUT_MS / 1000`, replacing
   the literal `< 15.0` in `test_concurrency.py`.
6. **Ruff** (Minor). Add `exclude = ["_vendored_ml"]` under `[tool.ruff]` in
   `classifier/pyproject.toml` (the copy is byte-identical to `ml/src`, which has its own
   config); `ruff check .` from `classifier/` must then be clean.

### Task 8 — Route: surface the skip counters (after Tasks 6 and 7)

**Files:** `classifier/src/multileg_routes.py`, `classifier/tests/test_concurrency.py`.
`_classify_with_polars(request, *, deadline, stats)` passes a caller-owned dict into
`classify_trades`; `handle_classify_payload` creates it and, when any
`butterfly_*_gate_skips` is non-zero, prints one structured line
(`classifier: butterfly gate skipped pair=<n> triple=<n> n_trades=<n>`) and drops a
Sentry breadcrumb with the same fields. Tests via a stub that fills `stats`.
