# Multileg Classifier — Split to Dedicated Railway Service + O(N²) Mitigation

**Date:** 2026-05-28
**Status:** Spec — pending approval
**Driver issue:** SENTRY-EMERALD-DESERT-8Q (`multileg.classify.sidecar_non_2xx`, 768 events since 2026-05-18, regressed). Co-resident sidecar (Databento relay + Theta Data Terminal JRE + polars classifier) OOMs and Railway edge proxy 502s downstream calls from `detect-lottery-fires` and `detect-silent-boom`.

## Goal

Eliminate classifier-induced 502s on the detect crons by moving the polars matcher into its own Railway service with bounded concurrency, and harden the matcher itself against pathological windows so SPY/SPXW workloads become tractable.

**Status:** All three open decisions resolved 2026-05-28. Ready to execute.

## Why this shape

The diagnostic evidence (Sentry events with `count: 1947, durationMs: 228, status: 502`) shows the failures are **downstream of an OOM-induced container restart**, not a single huge polars frame. The OOM trigger is cumulative pressure on a shared box: JVM (Theta Terminal, ~8–12 GB resident) + Databento relay buffers + N concurrent polars cross-joins via `ThreadingHTTPServer`.

Splitting the service gives the classifier:

- A dedicated memory ceiling no longer competing with the JVM
- A fault domain that doesn't kill futures-relay / Theta when it blows up (the existing four nullable columns on `lottery_finder_fires` / `silent_boom_alerts` from migration #160 already encode fail-open at the caller)
- A simpler concurrency model — bounded semaphore in front of the polars matcher
- A smaller image (~46 MB polars; no Java, no Theta jar, no Databento SDK)

Phase 3 (algorithmic O(N²) mitigation) is **defense in depth** for production and a **prerequisite for SPY/SPXW**. Per the matcher's own docstring, the lottery/silent-boom ticker universe is below the cross-type join blowup threshold, so Phase 1+2 alone should eliminate the production OOMs we're seeing today. We ship Phase 3 to unlock future ML/backfill use cases on dense expiries.

## Phases

### Phase 1 — New `classifier/` Railway service (split-only, no behavior change)

**Files to create:**

- `classifier/Dockerfile` — `python:3.12-slim` base, **no Java, no Theta jar**. Strip everything but polars + pydantic + sentry-sdk + the matcher code.
- `classifier/pyproject.toml`, `classifier/requirements.txt` — minimal deps: `polars`, `pydantic`, `sentry-sdk`, `numpy` (transitively required by matcher).
- `classifier/railway.toml` — `watchPatterns = ["classifier/**", "ml/src/multileg_*.py"]`.
- `classifier/src/main.py` — entrypoint; binds `0.0.0.0:8080`, starts the HTTP server.
- `classifier/src/server.py` — bounded-concurrency HTTP server (see Phase 2 for concurrency control). Single route: `POST /multileg-classify`. Health: `GET /health`.
- `classifier/src/sentry_setup.py` — Sentry init tagged `server_name=classifier` (mirrors uw-stream pattern).
- `classifier/_vendored_ml/` — byte-identical copies of `ml/src/multileg_assembler.py` and `ml/src/multileg_patterns.py`. Sync test relocates here.
- `classifier/tests/test_multileg_routes.py` — port `handle_classify_payload` tests from sidecar.
- `classifier/tests/test_vendored_ml_sync.py` — port byte-equality test (now compares `classifier/_vendored_ml/` vs `ml/src/`).
- `classifier/conftest.py` — adds `classifier/src/` and `classifier/_vendored_ml/` to `sys.path`.
- `classifier/README.md` — service overview, env vars, deploy notes.

**Files to modify:**

- `api/_lib/multileg-client.ts` — change env var from `SIDECAR_URL` to **`CLASSIFIER_URL`**. Keep `SIDECAR_URL` working as a fallback for one deploy cycle (rollout sequence below).
- `api/__tests__/multileg-client.test.ts` — update env var mock.
- `sidecar/src/health.py` — delete the `POST /takeit/multileg-classify` route dispatch (lines that import `handle_classify_payload`).
- `sidecar/src/multileg_routes.py` — **delete** (moved to classifier).
- `sidecar/_vendored_ml/` — **delete** (moved to classifier).
- `sidecar/tests/test_multileg_routes.py` — **delete**.
- `sidecar/tests/test_vendored_ml_sync.py` — **delete**.
- `sidecar/pyproject.toml` / `sidecar/requirements.txt` — remove polars dep.
- `sidecar/Dockerfile` — remove `COPY _vendored_ml/` line.
- `vercel.json` — no change (CRON_SECRET, env vars handled per-environment in Vercel).
- `CLAUDE.md` — add classifier service to the architecture section alongside sidecar/uw-stream.

**Rollout sequence:**

1. Create classifier service, deploy to Railway. New `CLASSIFIER_URL` env var set in Vercel preview only.
2. Smoke-test by curl'ing `https://<classifier-railway-url>/multileg-classify` with a synthetic payload from a preview deploy.
3. Promote `CLASSIFIER_URL` to Vercel production env. TS client prefers `CLASSIFIER_URL` and falls back to `SIDECAR_URL` for one deploy cycle.
4. Watch Sentry for one trading day — confirm `multileg.classify.sidecar_*` events drop to zero.
5. Remove `SIDECAR_URL` fallback from TS client. Delete classifier route from sidecar in a separate commit. Sidecar redeploys without polars.

**Done when:** `CLASSIFIER_URL` is set in Vercel prod, the new service is serving `detect-lottery-fires` and `detect-silent-boom` calls successfully (visible in classifier service logs), and no `multileg.classify.sidecar_non_2xx` events fire for a full trading day.

### Phase 2 — Bounded concurrency in the classifier service

**Goal:** Cap parallel polars matcher runs so peak memory is predictable. Drop `MAX_WINDOW_TRADES` in line with the existing code comment.

**Files to modify:**

- `classifier/src/server.py` — wrap matcher invocations behind a `threading.BoundedSemaphore(8)`. Requests beyond the limit queue inside the server thread; if queue time exceeds 30s, return `503` with `Retry-After: 5`. (Sized for a dedicated 24 GB box; 8 × ~500 MB peak matcher RSS = ~4 GB, leaves 20+ GB headroom.)
- `api/_lib/multileg-classify-batch.ts:88` — drop `MAX_WINDOW_TRADES` from `10000` back to `7500` (per the code's own follow-up comment).
- `api/__tests__/multileg-classify-batch.test.ts` — bump the "window too large" boundary test to 7500.
- `api/_lib/multileg-client.ts` — keep the 15s `DEFAULT_TIMEOUT_MS` but verify with classifier-side queue timing. If we observe legitimate queue waits of 8–12s, raise to 30s.
- `classifier/src/server.py` — emit a Sentry breadcrumb when a request waits >5s in the semaphore queue (instrumentation, not an error).

**Done when:** Synthetic load test (10 concurrent requests with realistic 1.5K-trade windows) holds RSS below 8 GB and returns ≤2s p95 latency. Production traffic shows zero OOM container restarts for a full trading day.

### Phase 3a — Algorithmic O(N²) mitigation: adaptive batching + earlier prune (ships with the bundle)

**Goal:** Drive the per-cell intermediate frame size down so dense (expiry, option_type) cells (SPXW 0DTE has ~540K rows) don't materialize O(N²) cross-products. Defense in depth on top of Phase 1+2's fault isolation, and unlocks SPY/SPXW workloads as a side effect.

**Why this approach over bipartite-matching-with-heap (see Phase 3b):** Same join shape, same scoring formula, same bucket-bounded size keys as today — the only output shift is that the per-batch top-K prune lands earlier, which tightens the existing K=8 final prune. Reuses production-validated code paths; failure modes bounded to "slower wall-clock on dense cells", no new correctness risk. Bipartite matching would replace one approximation (bucket-bounded keys) with a different one (top-K-per-call) for unclear net accuracy gain at much higher implementation and validation cost.

**Files to modify:**

- `ml/src/multileg_assembler.py` (and re-vendor to `classifier/_vendored_ml/`):
  - Reduce `_CELL_BATCH_BUCKETS` from `4` to `1` adaptively when cell row count > `_MAX_CELL_ROWS_PER_CLASSIFY * 0.5`. Smaller batch → smaller intermediate frame, more outer-loop passes.
  - Move the per-batch top-K prune **before** writing into the cell accumulator (currently the prune happens at cell-end). Bounds peak accumulator size to `K × batch_count`.
- `ml/tests/test_multileg_assembler.py` — add SPXW-shaped fixture test (synthetic 0DTE expiry with ~10K calls + 10K puts). Assert wall-clock <60s, RSS delta <2 GB.
- `classifier/_vendored_ml/multileg_assembler.py` — byte-equality sync after edits land in `ml/src/`.

**Done when:** SPXW full-day workload (1.33M rows, 1.09M in 0DTE) completes under the 600s budget with peak RSS <12 GB on the classifier service. Existing matcher tests still pass (no scoring regression on the production code path).

### Phase 3b — Bipartite matching with per-call top-K heap (follow-up only — NOT in this bundle)

**Trigger:** Only revisit if (a) Phase 3a turns out to be insufficient under demonstrated production load, OR (b) the matcher's use case expands to continuous full-tape ingestion across all tickers (i.e. running on every print rather than per-alert windows). Neither holds today.

**Sketch (for future reference):** Replace the per-cell calls × puts cross-join with a per-call walk: for each call, build a heap of nearest puts by (strike distance, time distance, size match), keep top-K. Output becomes O(N × K) instead of O(N²). Polars has no native top-K-per-row primitive, so the implementation would use `cumulative_eval` + window functions, or fall to a numpy heap walk. Roughly 150–200 LOC plus equivalence-validation work to guard against scoring drift on the production code path.

## Files touched (summary)

**Phase 1:** 14 new files in `classifier/`, 10 modifications in `sidecar/` + `api/` + `CLAUDE.md`. Plan-doc-worthy by itself.

**Phase 2:** 4 file modifications.

**Phase 3a:** 3 file modifications (matcher + test + vendored sync). Ships with the bundle.

**Phase 3b:** Out of scope. Documented as a follow-up only.

## Open questions / decisions

- ~~**Concurrency cap value (Phase 2).**~~ **Resolved 2026-05-28:** `BoundedSemaphore(8)`. Dedicated 24 GB box with no JVM competing — 8 concurrent matcher runs at ~500 MB peak each = ~4 GB, leaves 20+ GB headroom. Eliminates queue-wait on the 10:00 CT open burst.
- ~~**`SIDECAR_URL` rename in TS client.**~~ **Resolved 2026-05-28:** introduce `CLASSIFIER_URL` for the new classifier service. `SIDECAR_URL` stays unchanged and continues to serve `archive-sidecar.ts` against the existing Databento + Theta sidecar. Two services, two URLs, both names match what they point at.
- ~~**Phase 3 algorithm choice.**~~ **Resolved 2026-05-28:** Phase 3a (adaptive `_CELL_BATCH_BUCKETS=1` + earlier per-batch prune) ships with this bundle. Phase 3b (bipartite matching with per-call top-K heap) is written down as a follow-up but **not** in scope here. Rationale: 3a reuses production-validated code paths and preserves existing scoring semantics; 3b is a new algorithm with new failure modes that would require dedicated equivalence-validation cycles we don't need to spend right now.

## Testing Strategy

This is the load-bearing section. The classifier is a new service writing to production-facing nullable columns (`lottery_finder_fires.multileg_*`, `silent_boom_alerts.multileg_*`) — silent scoring drift would degrade signal quality for weeks before anyone notices. Coverage is non-negotiable.

### Coverage targets

| Module | Tool | Floor | Rationale |
| --- | --- | --- | --- |
| `classifier/src/` (all Python) | pytest + coverage.py | **≥95% line, ≥90% branch** | New code, no production exposure yet. Has to be near-bulletproof out the gate. |
| `classifier/_vendored_ml/` | (existing ml/ tests) | Byte-equal with `ml/src/` | Sync test enforces this — the source of truth tests live in `ml/tests/`. |
| `ml/src/multileg_assembler.py` (Phase 3a edits) | pytest | All new branches ≥95% line | Algorithm change touching production scoring path — every adaptive branch needs a test. |
| `api/_lib/multileg-client.ts` | vitest | ≥95% line | TS client gets the `CLASSIFIER_URL` env-var change; fallback logic needs explicit tests. |
| `api/_lib/multileg-classify-batch.ts` | vitest | unchanged from today | Only the `MAX_WINDOW_TRADES` constant changes; existing test updated. |

Coverage is enforced by `pytest --cov=classifier/src --cov-fail-under=95` in the classifier's CI gate and by `vitest run --coverage` in the existing `npm run review`.

### Phase 1 test plan — new `classifier/` service

**`classifier/tests/test_multileg_routes.py`** — port the sidecar's existing 8 cases AND add 6 new ones:

| Category | Cases (port from sidecar) | Cases (new for the service) |
| --- | --- | --- |
| Happy path | 200 with valid 1-trade payload, 200 with multi-trade payload | 200 with realistic 1500-trade payload (perf smoke) |
| 400 errors | malformed JSON, body not object, missing `trades` key, empty trades list | non-POST methods on `/multileg-classify` → 405 |
| 422 errors | schema validation failure (Pydantic) | extra fields rejected (`model_config = ConfigDict(extra='forbid')` already; verify) |
| 500 errors | matcher raises unexpectedly | matcher raises with Sentry tag presence asserted (`component=classifier`, `route=classify`) |
| Health | (none) | `GET /health` returns 200 with `{"status": "ok"}`; `GET /unknown` returns 404 |

**`classifier/tests/test_server.py`** — NEW. Tests the standalone server:

- Server binds to `$PORT` env var (or 8080 default)
- Server starts/stops cleanly (use `pytest`'s `tmp_path` + a thread-launched server)
- Server handles 10 concurrent requests without crashing (smoke; the semaphore behavior gets a dedicated test in Phase 2)
- Server rejects requests with no `Content-Type: application/json` header
- Server returns `Connection: close` on errors (prevents Railway edge from holding broken sockets)

**`classifier/tests/test_vendored_ml_sync.py`** — port from sidecar; compares `classifier/_vendored_ml/multileg_assembler.py` and `classifier/_vendored_ml/multileg_patterns.py` byte-for-byte against `ml/src/`.

**`classifier/tests/test_sentry_setup.py`** — NEW. Tests:

- `SENTRY_DSN` unset → init is a no-op (no exception)
- `SENTRY_DSN` set → init succeeds with `server_name=classifier` tag
- `capture_exception` includes the right tags when called

**TS-side updates** (`api/__tests__/multileg-client.test.ts`):

- Test: `CLASSIFIER_URL` set → uses it
- Test: `CLASSIFIER_URL` unset, `SIDECAR_URL` set → falls back (during transition window)
- Test: both unset → throws `MultilegClassifyError('config_missing')`
- Test: `CLASSIFIER_URL` with trailing slash → normalized
- Existing happy-path / 4xx / 5xx / network-error / schema-mismatch / length-mismatch cases all still pass

### Phase 2 test plan — concurrency cap + window cap drop

**`classifier/tests/test_concurrency.py`** — NEW. Tests `BoundedSemaphore(8)`:

- Mock `_classify_with_polars` to sleep N seconds. Fire 12 concurrent requests. Assert exactly 8 are in-flight at any moment, the remaining 4 queue.
- Fire 1 request that takes >30s. Assert subsequent requests return 503 with `Retry-After: 5` header after queue timeout.
- Fire requests with queue wait between 5–30s. Assert Sentry breadcrumb is emitted with `category='queue_wait'`.
- Verify no resource leak: after 100 sequential bursts of 12 concurrent calls, the semaphore's permit count returns to 8.

**`api/__tests__/multileg-classify-batch.test.ts`** — update boundary test:

- Window with 7499 trades → call sidecar
- Window with 7500 trades → call sidecar
- Window with 7501 trades → returns null, logs warning, no sidecar call

### Phase 3a test plan — adaptive batching + earlier prune

This is the most important coverage in the spec. The matcher is on the production scoring path; a subtle drift here corrupts downstream signal quality.

**`ml/tests/test_multileg_assembler.py`** — additions:

1. **Equivalence-under-threshold** (regression guard, MUST pass): Fix a deterministic seed, run the existing test fixtures through the matcher both BEFORE and AFTER the Phase 3a changes. For all cells with row count `≤ _MAX_CELL_ROWS_PER_CLASSIFY * 0.5` (the production code path today), assert output is **bit-identical**: same `inferred_structure`, same `match_confidence`, same `pattern_group_id`, same `is_isolated_leg` for every input trade.

2. **Equivalence-above-threshold-quantified**: For dense cells (rows > threshold), the earlier per-batch prune changes which low-confidence candidates survive. Quantify the expected delta: assert that ≥99% of high-confidence (`match_confidence ≥ 0.7`) classifications are unchanged. Document any winners that flip in a snapshot file (`ml/tests/snapshots/phase3a_dense_cell_diffs.json`) so future regressions surface as snapshot mismatches.

3. **SPXW-shaped fixture** (perf + memory): Synthetic 0DTE expiry with 10K calls + 10K puts at varied strikes. Assert:
   - Wall-clock < 60s (was: >600s OOM)
   - `tracemalloc`-measured peak allocation < 2 GB delta from baseline
   - At least 90% of trades classified as something other than `isolated_leg` (sanity — the matcher found real pairs)

4. **Adaptive threshold edge cases**:
   - Cell at exactly `_MAX_CELL_ROWS_PER_CLASSIFY * 0.5` → existing branch
   - Cell at threshold + 1 → adaptive branch
   - Cell at threshold + 10000 → adaptive branch, still completes
   - Threshold + 1 cell produces matched output (sanity)

5. **Per-batch prune correctness**: For a cell with known winners (hand-constructed fixture), assert the early prune does NOT drop any candidate that would have survived the cell-end prune in the existing code.

### Integration / E2E test plan

After each phase, before promoting `CLASSIFIER_URL` in Vercel prod:

1. **Local docker smoke**: `docker build classifier/` and `docker run -p 8080:8080 classifier/`. `curl -X POST localhost:8080/multileg-classify -d @classifier/tests/fixtures/sample-payload.json` returns 200 with valid classifications.
2. **Railway preview**: Deploy classifier to a Railway preview environment. Run `classifier/scripts/smoke.sh` (new — sends 50 realistic payloads, asserts all 200 + reasonable latency).
3. **Vercel preview soak**: Point a Vercel preview deploy at the Railway preview classifier. Trigger detect-lottery-fires manually 10×. Compare classifications written to a scratch table vs. what the existing sidecar would have written for the same inputs. Quantify drift.

### Performance regression guards

These guard against silent perf degradation when Phase 3a's adaptive batching adds outer-loop overhead.

**`ml/tests/test_multileg_assembler_perf.py`** — NEW. Marked `@pytest.mark.slow`, runs on CI but not in `pytest -m "not slow"`:

- AAPL-shaped realistic fixture (2K trades, 50/50 calls/puts, varied strikes): wall-clock <2s. Track p50, p95, p99 across 10 runs.
- QQQ-shaped fixture (6K trades, single expiry hot cell): wall-clock <8s.
- Track peak RSS via `tracemalloc` snapshot on each.
- Fail if any metric regresses by >50% from a baseline file committed at Phase 3a merge.

## Verification (after every phase)

Phases ship only when ALL of these pass:

- `npm run review` (tsc + eslint + prettier + vitest --coverage). Vitest coverage gate ≥95% on `multileg-client.ts`.
- `cd classifier && pytest --cov=src --cov-fail-under=95 --cov-report=term-missing`. Branch coverage ≥90%.
- `cd sidecar && pytest` (no regressions in remaining sidecar surface; the deleted classifier route should NOT leave orphaned test failures).
- `cd ml && .venv/bin/pytest tests/ --cov=src/multileg_assembler --cov=src/multileg_patterns --cov-fail-under=95`.
- Manual smoke: `curl -X POST <classifier-url>/multileg-classify -d @classifier/tests/fixtures/sample-payload.json`
- One-trading-day Sentry soak before declaring each phase complete

## Out of scope

- Moving futures-relay or Theta Data Terminal off the sidecar. Those are stable on the shared box; only the classifier was the OOM culprit.
- Changing the cron schedule. The classifier is called per-alert, not on a cron.
- Migration #160 schema changes. The four nullable columns are already in place from prior work.
