# Classifier OOM Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the multileg classifier Railway service from OOM-crashing by fixing the *single-request peak memory* (the real cause), instead of tuning the concurrency knob (which six prior fixes already exhausted with no effect).

**Architecture:** The classifier is a single-purpose Python HTTP service running an eager-polars multileg pattern matcher. The crons call it *sequentially*, and the matcher is hard-serialized to one invocation at a time (`_CLASSIFY_CONCURRENCY = 1`), so the box only ever runs ONE matcher call — yet it still peaks at ~29 GB on a 24 GB host. The fix has four layers, shippable independently: (1) cap polars' thread pool (which currently scales to all 24 vCPUs, multiplying peak memory); (2) bound the same-type self-join and butterfly joins the way the cross-type join is already bounded; (3) move the hot joins to polars' streaming engine so memory is bounded by morsel; (4) cap per-time-bucket density at the source so one hot 0DTE bucket can't build a multi-GB cartesian intermediate.

**Tech Stack:** Python 3.12, polars ≥1.40, pydantic v2, http.server `ThreadingHTTPServer`, Railway, pytest.

---

## Background: Why the box crashes (root-cause summary)

Evidence gathered 2026-06-11 (systematic-debugging Phase 1–2):

1. **Traffic is not the cause.** Both detect crons call `classifyAlertMultileg` inside a plain sequential `for` loop ([detect-lottery-fires.ts:705](../../../api/cron/detect-lottery-fires.ts#L705), [detect-silent-boom.ts:881](../../../api/cron/detect-silent-boom.ts#L881)). The matcher is gated by a `BoundedSemaphore(1)` ([multileg_routes.py:95](../../../classifier/src/multileg_routes.py#L95)). At most one matcher invocation runs at any moment.

2. **Therefore the OOM is a single matcher call exceeding the host ceiling.** The 06-09 28.88 GB peak (documented in `multileg_assembler.py` comments) was produced by ONE request. Concurrency knob tuning (8→4→2→1) and the cross-join cap (1M→500K→250K) could never fix a single-request peak — which is why all six fixes failed.

3. **polars thread pool is uncapped.** There is no `POLARS_MAX_THREADS` anywhere in `classifier/src`, `classifier/_vendored_ml`, or the Dockerfile. polars defaults its thread pool to the logical core count. On a 24-vCPU box that's ~24 parallel join build/probe partitions, each holding a slice of the intermediate → **more vCPUs raise peak memory.** This is why scaling the box up made things worse, not better.

4. **The matcher is 100% eager polars** (0 uses of `.lazy()` / `collect(engine=...)` / `scan_` in the 2061-line file). Every `.join()` / `.explode()` materializes its full intermediate with no backpressure or spill.

5. **The same-type self-join and butterfly join have no pair cap.** Only the cross-type calls×puts join got `_CROSS_JOIN_PAIR_CAP` chunking ([line 872](../../../classifier/_vendored_ml/multileg_assembler.py#L872)). `_self_join_two_leg` and `_butterfly_from_batch` rely only on `_PER_BATCH_PRUNE_THRESHOLD = 50_000`, which prunes the join *output* AFTER the giant intermediate is materialized. A dense 0DTE cell (e.g. ~4,000 same-type prints, all `size=1`, in one 90 s bucket) builds a ~16M-row self-join frame eagerly before any prune fires.

6. **Allocator ratchet.** Rust's allocator retains the high-water mark; freed polars memory is not returned to the OS between requests. RSS climbs monotonically across a busy open and never recedes — matching the observed "one bad open crashes the rest of the day" behavior.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `classifier/Dockerfile` | Image/env. Add `POLARS_MAX_THREADS` + streaming chunk config env. | Modify |
| `classifier/src/main.py` | Boot. Log effective `pl.thread_pool_size()` once at startup for observability. | Modify |
| `classifier/_vendored_ml/multileg_assembler.py` | The matcher. Self-join/butterfly cap (Phase 2), streaming engine (Phase 3), per-bucket density cap (Phase 4). | Modify |
| `ml/src/multileg_assembler.py` | Canonical source (vendored copy must stay byte-identical — see `test_vendored_ml_sync.py`). Every matcher edit lands HERE first, then is re-vendored. | Modify |
| `classifier/tests/test_thread_config.py` | New. Assert Dockerfile sets the thread cap + startup log. | Create |
| `classifier/tests/test_multileg_routes.py` | Existing route tests — extend if request shape changes (it does not). | Read |
| `ml/tests/test_multileg_assembler.py` | Existing matcher unit tests — extend with cap + parity tests. | Modify |
| `ml/experiments/multileg-assembler-validation/run.py` | Existing parity oracle over real parquet. Used as the Phase 3 streaming-parity gate. | Read/Run |

**Critical repo rule:** `classifier/_vendored_ml/multileg_assembler.py` is a *vendored copy* of `ml/src/multileg_assembler.py`. `classifier/tests/test_vendored_ml_sync.py` enforces they are byte-identical. **Edit `ml/src/` first, then copy to `classifier/_vendored_ml/`.** Every matcher task below must touch both and keep the sync test green.

---

## Thresholds / Constants (agreed during scoping)

| Constant | Value | Where | Rationale |
|----------|-------|-------|-----------|
| `POLARS_MAX_THREADS` | `2` | Dockerfile ENV + Railway env | Matcher is ~1 s/call and crons are sequential; 2 threads is ample throughput and caps the peak multiplier at 2× instead of 24×. |
| Railway vCPU | `4` (down from 24) | Railway dashboard (ops) | With the thread cap, the service needs ~2–4 vCPU. Fewer cores → lower polars peak. |
| Railway RAM | keep `24 GB` initially, revisit | Railway dashboard (ops) | Hold RAM during soak; reduce only after the streaming engine lands and peak is measured. |
| `_SELF_JOIN_PAIR_CAP` | `250_000` | `multileg_assembler.py` | Mirror `_CROSS_JOIN_PAIR_CAP`; bounds the same-type self-join intermediate per chunk. |
| `_BUTTERFLY_BODY_CHUNK` | `2_000` | `multileg_assembler.py` | Chunk body anchors so body×wing join intermediate stays bounded. |
| `pl.Config.set_streaming_chunk_size` | `50_000` | matcher module import | Morsel size for the streaming engine. |
| `_MAX_BUCKET_ROWS` | `2_000` | `multileg_assembler.py` | Per-(expiry, option_type, tbk) density cap. Buckets above this are down-sampled to top-N-by-premium (Phase 4). |

**Open question (decide before Phase 4):** down-sample a hot bucket to top-N-by-premium vs. skip it entirely (null structure columns). Default pick: **down-sample to top-2000 by premium** — preserves the highest-conviction prints (which is what the detectors care about) instead of nulling the whole bucket. Flag to user before implementing Phase 4.

---

## Phase 1 — Cap polars threads (low risk, deploy first)

**Goal:** Cut the per-request peak-memory multiplier from ~24× to 2× with one env change. This phase alone is expected to stop the daily crashing.

### Task 1: Add thread + streaming config to the image

**Files:**
- Modify: `classifier/Dockerfile`
- Create: `classifier/tests/test_thread_config.py`

- [ ] **Step 1: Write the failing test**

```python
# classifier/tests/test_thread_config.py
"""Guards the polars thread-pool cap that bounds per-request peak memory.

The classifier OOM'd because polars sized its thread pool to the box's
core count (24), fanning each join into ~24 parallel partitions that each
held a slice of the intermediate. POLARS_MAX_THREADS=2 caps that. This is
the highest-leverage line in the whole fix — protect it from a future
Dockerfile rewrite.
"""
from pathlib import Path

_DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"


def test_dockerfile_caps_polars_threads() -> None:
    text = _DOCKERFILE.read_text()
    assert "POLARS_MAX_THREADS=2" in text, (
        "POLARS_MAX_THREADS=2 missing from Dockerfile — peak memory will "
        "scale with the host core count and the box will OOM again."
    )


def test_dockerfile_sets_streaming_chunk_size_env_or_app_sets_it() -> None:
    # The streaming chunk size is set in-app at import (Phase 3); this test
    # just documents that the env override hook exists for ops tuning.
    text = _DOCKERFILE.read_text()
    assert "POLARS_STREAMING_CHUNK_SIZE" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd classifier && .venv/bin/python -m pytest tests/test_thread_config.py -v`
Expected: FAIL — `POLARS_MAX_THREADS=2 missing from Dockerfile`.

- [ ] **Step 3: Add the ENV lines to the Dockerfile**

In `classifier/Dockerfile`, after the existing `ENV PYTHONPATH=...` line (around line 32), add:

```dockerfile
# Cap the polars thread pool. polars defaults to the host core count; on a
# multi-vCPU box each join fans into one build/probe partition per thread,
# each holding a slice of the intermediate, multiplying peak memory. The
# matcher is ~1s/call and the crons call us sequentially, so 2 threads is
# ample throughput while capping the peak multiplier at 2x instead of Nx.
# Must be set BEFORE the process imports polars (read once at import).
ENV POLARS_MAX_THREADS=2
# Streaming-engine morsel size (Phase 3). Overridable for ops tuning.
ENV POLARS_STREAMING_CHUNK_SIZE=50000
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd classifier && .venv/bin/python -m pytest tests/test_thread_config.py -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add classifier/Dockerfile classifier/tests/test_thread_config.py
git commit -m 'perf(classifier): cap POLARS_MAX_THREADS=2 to bound per-request peak memory

The OOM was a single-request peak, not concurrency (matcher is already
serialized to 1). polars sized its thread pool to the 24-vCPU host, fanning
each join into ~24 partitions that each held a slice of the intermediate.
Capping to 2 threads cuts the peak multiplier ~12x. Pairs with a Railway
vCPU reduction (ops). See docs/superpowers/specs/classifier-oom-rework-2026-06-11.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
```

### Task 2: Log effective thread-pool size at startup

**Files:**
- Modify: `classifier/src/main.py`
- Test: covered by manual log inspection + Task 1's static test (no new unit test — startup logging is I/O glue).

- [ ] **Step 1: Add the log line**

In `classifier/src/main.py`, inside `main()`, right after `httpd = server.build_server(port)` and before the `print(f"classifier listening...")` line (~line 78), add:

```python
    # Surface the effective polars thread-pool size at boot so a regressed
    # POLARS_MAX_THREADS (or a Railway env that didn't propagate) is visible
    # in the Railway log stream rather than silently re-inflating peak memory.
    try:
        import polars as pl

        print(
            f"classifier: polars thread_pool_size={pl.thread_pool_size()}",
            flush=True,
        )
    except Exception as exc:  # pragma: no cover - observability only
        print(f"classifier: could not read polars thread_pool_size: {exc}", flush=True)
```

- [ ] **Step 2: Verify locally**

Run: `cd classifier && POLARS_MAX_THREADS=2 PYTHONPATH=src:_vendored_ml .venv/bin/python -c "import polars as pl; print(pl.thread_pool_size())"`
Expected: prints `2`.

- [ ] **Step 3: Run the full classifier test suite**

Run: `cd classifier && .venv/bin/python -m pytest -q`
Expected: PASS (no regressions; `main` is exercised by `test_main.py`).

- [ ] **Step 4: Commit**

```bash
git add classifier/src/main.py
git commit -m 'feat(classifier): log effective polars thread_pool_size at boot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
```

### Task 3 (OPS, no code): Reduce Railway vCPU

- [ ] In the Railway dashboard, set the classifier service to **4 vCPU** (from 24), keep 24 GB RAM for the soak, and set `POLARS_MAX_THREADS=2` + `POLARS_STREAMING_CHUNK_SIZE=50000` as service env vars (belt-and-suspenders with the Dockerfile ENV).
- [ ] Redeploy. Confirm the boot log shows `polars thread_pool_size=2`.
- [ ] Watch `MEMORY_USAGE_GB` across the next market open. **Success criterion: peak stays under ~12 GB** (was 28.88 GB). If it holds, Phase 1 has resolved the crash and Phases 2–4 become hardening rather than emergency.

---

## Phase 2 — Bound the same-type self-join and butterfly join

**Goal:** Apply the cross-type join's chunking discipline to the two un-capped join paths, so no single batch can materialize an unbounded intermediate before the output prune fires.

### Task 4: Cap the same-type self-join

**Files:**
- Modify: `ml/src/multileg_assembler.py` (then re-vendor to `classifier/_vendored_ml/multileg_assembler.py`)
- Test: `ml/tests/test_multileg_assembler.py`

- [ ] **Step 1: Write the failing parity test**

```python
# ml/tests/test_multileg_assembler.py  (add)
def test_self_join_chunking_matches_unchunked(monkeypatch):
    """A dense same-type cell must classify identically whether or not the
    self-join is internally chunked. Mirrors the cross-type parity invariant.
    """
    import multileg_assembler as ma

    df = _dense_same_type_calls(n=1200, size=1, expiry="2026-06-12")  # helper below
    monkeypatch.setattr(ma, "_SELF_JOIN_PAIR_CAP", 10_000_000)  # force single-shot
    expected = ma.classify_trades(df, window_seconds=90)
    monkeypatch.setattr(ma, "_SELF_JOIN_PAIR_CAP", 50_000)  # force chunking
    actual = ma.classify_trades(df, window_seconds=90)
    assert expected.sort("id").to_dicts() == actual.sort("id").to_dicts()
```

Add the `_dense_same_type_calls` fixture helper near the top of the test module (1200 same-expiry same-type call prints in one 90 s window, all `size=1`, strikes spread so verticals can match).

- [ ] **Step 2: Run to verify it fails**

Run: `cd ml && .venv/bin/python -m pytest tests/test_multileg_assembler.py::test_self_join_chunking_matches_unchunked -v`
Expected: FAIL — `_SELF_JOIN_PAIR_CAP` does not exist yet (`AttributeError`).

- [ ] **Step 3: Add the constant + chunk the anchor side**

In `ml/src/multileg_assembler.py`, add near `_CROSS_JOIN_PAIR_CAP` (~line 202):

```python
# Same-type self-join pair cap. Mirrors _CROSS_JOIN_PAIR_CAP for the
# uncapped sibling path: a dense same-type 0DTE cell (e.g. ~4,000 size=1
# prints in one bucket) builds a ~16M-row self-join intermediate eagerly,
# BEFORE _PER_BATCH_PRUNE_THRESHOLD can prune the output. Chunk the anchor
# side so each intermediate stays ~cap-sized; the self-join + filter is
# row-independent in the anchor frame so chunking is output-identical.
_SELF_JOIN_PAIR_CAP: Final = 250_000
```

Refactor `_two_leg_same_type_from_batch` ([line 783](../../../classifier/_vendored_ml/multileg_assembler.py#L783)) so that when `batch.height * batch.height > _SELF_JOIN_PAIR_CAP`, the anchor rows are sliced into chunks of `max(1, _SELF_JOIN_PAIR_CAP // batch.height)` and each chunk is self-joined against the full batch, scored, per-batch-pruned if over `_PER_BATCH_PRUNE_THRESHOLD`, and concatenated — exactly the structure of `_cross_type_scored_one_orientation` ([line 872](../../../classifier/_vendored_ml/multileg_assembler.py#L872)). Keep the single-shot path byte-for-byte when under the cap.

> Implementer note: factor the anchor-chunk loop into a small helper `_self_join_scored_chunked(batch, patterns, window_seconds, size_tolerance)` so the chunking logic is shared and testable, and `_self_join_two_leg` keeps taking a (possibly sliced) anchor frame. The B side of `_self_join_two_leg` is already the full batch; pass the anchor slice as a separate frame instead of re-deriving B from it.

- [ ] **Step 4: Run the parity test + full matcher suite**

Run: `cd ml && .venv/bin/python -m pytest tests/test_multileg_assembler.py -v`
Expected: PASS, including the new test and all existing same-type/vertical tests.

- [ ] **Step 5: Re-vendor and verify sync**

```bash
cp ml/src/multileg_assembler.py classifier/_vendored_ml/multileg_assembler.py
cd classifier && .venv/bin/python -m pytest tests/test_vendored_ml_sync.py -v
```
Expected: PASS (byte-identical).

- [ ] **Step 6: Commit**

```bash
git add ml/src/multileg_assembler.py classifier/_vendored_ml/multileg_assembler.py ml/tests/test_multileg_assembler.py
git commit -m 'perf(matcher): cap same-type self-join intermediate via anchor chunking

The cross-type join was capped (250K) but the same-type self-join was not —
a dense 0DTE same-type cell built a ~16M-row intermediate before the output
prune. Chunk the anchor side like _cross_type_scored_one_orientation;
output-identical under the cap. Parity test added.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
```

### Task 5: Chunk the butterfly body×wing join

**Files:**
- Modify: `ml/src/multileg_assembler.py` → re-vendor
- Test: `ml/tests/test_multileg_assembler.py`

- [ ] **Step 1: Write the failing parity test** — same shape as Task 4 but for a dense butterfly-eligible cell (≤`_BUTTERFLY_CELL_LIMIT` rows), monkeypatching `_BUTTERFLY_BODY_CHUNK` between a huge value (single-shot) and a small value (chunked), asserting identical `classify_trades` output.

- [ ] **Step 2: Run to verify it fails** (`AttributeError: _BUTTERFLY_BODY_CHUNK`).

- [ ] **Step 3: Add `_BUTTERFLY_BODY_CHUNK: Final = 2_000`** near the other caps, and chunk `bodies` in `_butterfly_from_batch` ([line 1556](../../../classifier/_vendored_ml/multileg_assembler.py#L1556)): when `bodies.height` is large, process bodies in slices of `_BUTTERFLY_BODY_CHUNK`, running the three offset joins + filters + scoring per slice and concatenating. Body rows are independent in the body×wing join, so slicing is output-identical (modulo the existing `.unique()` dedup, which must run on the concatenated result — keep the final dedup outside the chunk loop).

- [ ] **Step 4: Run parity + full suite** — Expected PASS.

- [ ] **Step 5: Re-vendor + sync test** (as Task 4 Step 5).

- [ ] **Step 6: Commit** (`perf(matcher): chunk butterfly body×wing join to bound intermediate`).

---

## Phase 3 — Streaming engine for the hot joins (the durable fix)

**Goal:** Convert the same-type self-join, cross-type join, and butterfly join from eager `.join()` to lazy chains collected with `engine="streaming"`, so polars bounds memory by morsel and can spill instead of materializing the full intermediate. This is the architectural fix that lets the service "handle the traffic."

**Parity is non-negotiable:** the classification output must not change. The gate is the existing real-parquet oracle.

### Task 6: Set streaming chunk size at module import

**Files:**
- Modify: `ml/src/multileg_assembler.py` → re-vendor
- Test: `ml/tests/test_multileg_assembler.py`

- [ ] **Step 1: Failing test** — assert that importing the module sets a streaming chunk size honoring `POLARS_STREAMING_CHUNK_SIZE` (default 50_000).

```python
def test_streaming_chunk_size_configured(monkeypatch):
    monkeypatch.setenv("POLARS_STREAMING_CHUNK_SIZE", "12345")
    import importlib, multileg_assembler as ma
    importlib.reload(ma)
    # set_streaming_chunk_size has no getter; assert the module read the env
    assert ma._STREAMING_CHUNK_SIZE == 12345
```

- [ ] **Step 2: Run to verify it fails** (`AttributeError: _STREAMING_CHUNK_SIZE`).

- [ ] **Step 3: Add at module top (after imports):**

```python
_STREAMING_CHUNK_SIZE: Final = int(
    os.environ.get("POLARS_STREAMING_CHUNK_SIZE", "50000")
)
pl.Config.set_streaming_chunk_size(_STREAMING_CHUNK_SIZE)
```

(add `import os` to the imports.)

- [ ] **Step 4: Run to verify it passes.** **Step 5: Re-vendor + sync. Step 6: Commit.**

### Task 7: Convert the same-type self-join to a streaming lazy chain

**Files:**
- Modify: `ml/src/multileg_assembler.py` → re-vendor
- Test: `ml/tests/test_multileg_assembler.py` (reuse Task 4 parity test as the oracle)

- [ ] **Step 1: Confirm the oracle exists.** The Task 4 chunking parity test already asserts identical output across cap settings; extend it (or add a sibling) that asserts identical output before vs. after the streaming conversion by capturing a golden result first.

```python
def test_self_join_streaming_matches_eager():
    import multileg_assembler as ma
    df = _dense_same_type_calls(n=1200, size=1, expiry="2026-06-12")
    # Golden = output committed as a fixture from the eager implementation.
    golden = _load_golden("self_join_dense_1200.json")
    actual = ma.classify_trades(df, window_seconds=90).sort("id").to_dicts()
    assert actual == golden
```

Generate `self_join_dense_1200.json` from the current (eager) implementation BEFORE converting, and commit it as the parity fixture.

- [ ] **Step 2: Run to verify the golden matches the current eager output** (sanity: PASS before conversion).

- [ ] **Step 3: Convert `_self_join_two_leg` to lazy.** Rewrite the body so the projections + the two joins (same-bucket and adjacent) + `ridx_b > ridx` filter are expressed on `LazyFrame`s (`batch.lazy()...`), combined with `pl.concat([...], how="vertical_relaxed")` on lazy frames, and materialized once via `.collect(engine="streaming")` at the return boundary. Keep the size-bucket explode (`_split_b_for_bucket_join`) lazy too (`int_ranges().explode()` is streaming-compatible). Preserve identical column names/dtypes.

> Implementer note: the small-batch fast path (`batch.height < _BUCKET_BATCH_MIN_ROWS`) can stay eager — it's already cheap and streaming overhead would dominate. Only the bucket-bounded path needs streaming.

- [ ] **Step 4: Run parity tests** (`test_self_join_streaming_matches_eager` + `test_self_join_chunking_matches_unchunked` + full suite). Expected PASS — identical output.

- [ ] **Step 5: Re-vendor + sync. Step 6: Commit** (`perf(matcher): stream the same-type self-join (engine=streaming), parity-locked`).

### Task 8: Convert the cross-type join to streaming — same TDD loop as Task 7, oracle = a dense calls×puts fixture + the existing `test_cross_*` tests.

### Task 9: Convert the butterfly join to streaming — same TDD loop, oracle = a dense butterfly fixture + existing butterfly tests.

### Task 10: Full real-parquet parity gate

- [ ] **Step 1:** Run the validation oracle on a real full-day tape BEFORE and AFTER Phases 2–3 and diff the classifications:

```bash
cd ml && .venv/bin/python experiments/multileg-assembler-validation/run.py \
  --date 2026-06-10 --out /tmp/multileg_after.json
# compare against a golden captured from main before the rework
```

Expected: zero classification diffs (structure label, confidence, group id) on the production ticker universe (single stocks; SPX/SPXW are skipped by the overload guard regardless).

- [ ] **Step 2:** If any diff appears, STOP — streaming changed semantics. Do not ship. Open a focused investigation (likely join-ordering or null-handling difference in the streaming engine) before proceeding.

- [ ] **Step 3:** Commit the golden fixture + a `make`-style parity check note in the spec.

---

## Phase 4 — Per-time-bucket density cap (defense in depth)

**Goal:** Stop one ultra-dense time bucket from ever feeding the joins a pathological frame, independent of the join implementation. The existing guard is per-*ticker-cell* (500K rows); a single hot *bucket* of a few thousand same-size 0DTE prints is the actual bomb.

> **DECISION REQUIRED before starting:** down-sample hot buckets to top-N-by-premium (default) vs. skip them (null columns). Confirm with the user.

### Task 11: Cap per-(expiry, option_type, tbk) bucket density

**Files:**
- Modify: `ml/src/multileg_assembler.py` → re-vendor
- Test: `ml/tests/test_multileg_assembler.py`

- [ ] **Step 1: Failing test** — a single bucket with 5,000 prints; assert that after the cap (`_MAX_BUCKET_ROWS = 2_000`) the matcher (a) does not materialize > cap rows for that bucket, and (b) classifies the top-2000-by-premium prints, leaving the rest as `isolated_leg`/null per the agreed policy. Assert the highest-premium prints are retained.

- [ ] **Step 2: Run to verify it fails** (`AttributeError: _MAX_BUCKET_ROWS`).

- [ ] **Step 3: Implement.** In `_classify_ticker` ([line 421](../../../classifier/_vendored_ml/multileg_assembler.py#L421)), after computing `tbk` and before the cell loops, group by `(expiry, option_type, tbk)` and for any group exceeding `_MAX_BUCKET_ROWS`, keep the top-`_MAX_BUCKET_ROWS` rows by premium (`size * price`) and route the dropped rows straight to the skipped/isolated path. Emit a `RuntimeWarning` (matches the existing overload-skip logging style) recording ticker, bucket, dropped count — never silently truncate.

- [ ] **Step 4: Run test + full suite.** **Step 5: Re-vendor + sync. Step 6: Commit.**

### Task 12: Raise the TS-side input cap back up (optional, post-soak)

**Files:** `api/_lib/multileg-classify-batch.ts:88` (`MAX_WINDOW_TRADES`)

- [ ] Once Phases 1–4 hold through a soak, consider raising `MAX_WINDOW_TRADES` (currently 10000, defensively low) since the matcher now bounds its own memory. Gate on measured peak. Add an `api/__tests__` assertion if the constant changes. **Do not do this until the soak confirms the matcher is memory-safe.**

---

## Verification (every matcher task)

`ml/` Python changes are exempt from `npm run review` (TS pipeline). For matcher tasks run:

```bash
cd ml && .venv/bin/python -m pytest tests/test_multileg_assembler.py tests/test_multileg_patterns.py -q
cd classifier && .venv/bin/python -m pytest -q   # includes test_vendored_ml_sync
```

For the Dockerfile/`main.py` tasks, the classifier pytest suite is the gate. There are no TS source changes until Task 12 (which would require `npm run review`).

---

## Rollout order & soak

1. **Phase 1 → deploy immediately** (thread cap + vCPU reduction). Watch one open. Expected: crash stops, peak < ~12 GB.
2. **Phase 2 → deploy.** Closes the un-capped self-join/butterfly paths. Watch one open.
3. **Phase 3 → deploy behind the real-parquet parity gate.** The durable fix. Watch two opens.
4. **Phase 4 → deploy** after the Phase 4 policy decision. Watch one open.
5. **Task 12** only after a clean multi-day soak.

Each phase is independently shippable and independently revertable. If any phase regresses memory or classification output, revert that phase only.

---

## Open Questions

1. **Railway vCPU/RAM final target** — start 4 vCPU / 24 GB, reduce RAM after Phase 3 measurement. (Ops decision.)
2. **`POLARS_MAX_THREADS` = 2 vs 4** — default 2; bump to 4 only if matcher latency becomes a cron-tick bottleneck (unlikely at ~1 s/call, sequential).
3. **Phase 4 hot-bucket policy** — down-sample to top-2000-by-premium (default) vs. skip. Decide before Task 11.
4. **Streaming-engine parity** — Phase 3 is gated on zero classification diffs against the real-parquet oracle. If the streaming engine changes any output, Phase 3 is held and we ship Phases 1+2+4 only (which already bound memory without changing the engine).
