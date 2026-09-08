# backend-state audit — 2026-09-08

Theme: Rule R1 (server side) — module-level state and tracked-state leaks on failure paths in `api/**` (Vercel Fluid Compute, instances reused) and the long-lived Python processes `uw-stream/src/**` and `sidecar/src/**`.

Read-only audit of the clean `origin/main` worktree. Five files are being edited in another session (`api/_lib/uw-rate-limit.ts`, `api/_lib/uw-fetch.ts`, `api/_lib/sentry.ts`, two tests); anything touching them is tagged **IN-FLIGHT**.

## Method

**Scope scanned:** 348 TypeScript files under `api/` (excluding `__tests__`), 50 Python files under `uw-stream/src` + `sidecar/src`.

**TypeScript greps (column-0 / module scope):**
- `^let ` → 14 hits (all read)
- `^(export )?const X = new Map|new Set|[]|{}` → 24 hits; 19 are immutable constant tables (`VALID_SYMBOLS`, `SEP_DATES`, `TICKER_OVERRIDES`, etc.), 5 are mutable caches (read)
- `globalThis`, `WeakMap/WeakRef`, `process.on(`, module-scope `setInterval/setTimeout`, `export let` → 0 hits
- `^let .*Promise` → 1 hit (`schwab.ts:124`)
- top-level `Record<` consts → 18 hits, all constant lookup tables except `takeit-bundle-loader.ts:98 CACHE` (read)
- module-scope factory/IIFE state → 1 hit (`redis.ts:43`, singleton)
- rate-limiter names → confirmed all three limiters (`auth-helpers.ts`, `uw-rate-limit.ts`, `uw-concurrency.ts`) are Redis-backed, not in-process
- 1–2-space-indented container decls (formatting oddities) → only function locals

**Python greps:**
- column-0 `dict/set/list/deque/defaultdict` → 5 hits (all read)
- `self.* = {}|set()|[]|deque(` in classes → 13 hits (all read)
- `asyncio.Queue(` → 2 construction sites, both `maxsize=` (read)
- `create_task/ensure_future` → 9 sites, reconnect path read for task leaks
- `global ` → 14 sites, each reassignment read

**Files read in full or in the relevant region:** `schwab.ts`, `flow-regime-baseline-live.ts`, `gex-strike-expiry.ts`, `gex-target-history.ts`, `db-gex-strike-expiry.ts`, `takeit-bundle-loader.ts`, `multileg-client.ts`, `uw-rate-limit.ts`, `uw-concurrency.ts`, `uw-fetch.ts` (slot release region), `redis.ts`, `env.ts`, `cron-instrumentation.ts`, `axiom.ts`, `embeddings.ts`, `push.ts`, `auth-helpers.ts`, `guest-auth.ts`, `db.ts`, `sentry.ts` (metrics region), `validation/market-data.ts` (query schema), `cron/takeit-fill-shap.ts`, `takeit-detect.ts` (version stamping); `uw-stream`: `handlers/base.py`, `handlers/interval_ba.py`, `handlers/recent_fires.py`, `notify.py`, `state.py`, `router.py`, `connector.py`, `main.py`, `db.py`, `logger_setup.py`, `health.py`, `config.py`; `sidecar`: `takeit_server.py`, `theta_launcher.py`, `theta_fetcher.py`, `databento_client.py`, `options_router.py`, `batched_writer.py`, `db.py`, `main.py`; plus `.github/workflows/ml-pipeline.yml` (bundle upload cadence).

**Counts:** ~45 candidates examined → **10 findings** (0 P1, 4 P2, 6 P3) + 26 "already good" entries.

## Findings

### BS-01: `timestampsCache` grows without eviction; sibling caches evict, this one was missed  [P2] [confidence: high] [effort: S]
- Where: `api/_lib/db-gex-strike-expiry.ts:37` (decl), `:518` (read), `:555` (write); key built at `:516`
- What: Module-level `Map<string, {data: string[]; expiresAt}>` keyed by `` `${ticker}:${expiry}:${at ?? 'live'}` ``. Entries are checked for TTL on read but nothing ever deletes them — the only `.delete`/`.clear` is the test-only `_resetTimestampsCache()` at `:41`. `at` is user-supplied (`gexStrikeExpiryQuerySchema.at`, `api/_lib/validation/market-data.ts:83`, `z.string().datetime({offset:true})`), passed through unnormalized, and the scrubber UI sends a distinct `at` per scrub position. Each entry holds up to ~390 ISO strings (~10 KB). The two endpoint-level caches that sit in front of this one (`api/gex-strike-expiry.ts:92`, `api/gex-target-history.ts:171`) both got an `evictExpiredCacheEntries()` on-write sweep in the 2026-05-19 audit; this inner cache did not.
- Failure scenario: A warm Fluid Compute instance serving the GEX Landscape panel; the owner scrubs across a session for 4 tickers → up to 4 × 390 new keys/day (more if the client emits `.000Z` and `Z` variants of the same minute), ~10 KB each → ~15 MB/day of never-freed entries; multi-day warm instances accumulate tens of MB. No crash, just monotonic RSS growth until Vercel recycles the instance.
- Fix: Reuse the sibling pattern — call an on-write sweep (`for ([k,v] of timestampsCache) if (v.expiresAt <= now) delete`) before `timestampsCache.set(...)` at `:555`; additionally normalize the key's `at` via `new Date(at).toISOString()`.

### BS-02: Sidecar SHAP bundle cache never refreshes — explanations drift from the model that produced the score  [P2, borderline P1] [confidence: high] [effort: M]
- Where: `sidecar/src/takeit_server.py:50` (`_bundle_cache`), `:83–126` (`_load_bundle`: fill-once, no TTL); Vercel counterpart `api/_lib/takeit-bundle-loader.ts:36` (`BUNDLE_REFRESH_TTL_MS = 15 min`); caller `api/cron/takeit-fill-shap.ts:152–160`; producer `.github/workflows/ml-pipeline.yml:205`
- What: The Vercel loader re-reads the Blob manifest every 15 min and re-downloads the bundle when the version changes. The Railway sidecar loads the joblib bundle + builds a `shap.TreeExplainer` once per `alert_type` and holds it for the process lifetime — there is no TTL, no manifest re-check, no invalidation endpoint, and the ML pipeline does not restart the sidecar after uploading. The SHAP request body is `{alert_type, rows}` (no version) and the response is `{results}` (no version), so nothing detects the mismatch. `_explain_rows` builds the matrix with `feats.get(c, np.nan)` over the *stale* bundle's `feature_cols`, so a feature added in the new bundle is silently NaN-filled.
- Failure scenario: Nightly retrain uploads `lottery_classifier_v2026-09-09`; within 15 min Vercel scores new fires with it and stamps `takeit_model_version = 'v2026-09-09'` (`api/_lib/takeit-detect.ts:230,281`). Two minutes later `takeit-fill-shap` asks the sidecar for top-3 flags; the sidecar answers from the bundle it loaded days ago. Rows now carry a `takeit_top_features` JSON computed by a different model than the `takeit_prob` next to it, labelled with the new version — silent wrong data every day until the sidecar happens to restart.
- Fix: Give `_bundle_cache` entries a `fetched_at` and re-check the manifest pathname after the same 15-min TTL (mirror `takeit-bundle-loader.ts`); have the cron send the row's `takeit_model_version` and the sidecar return `bundle["version"]`, and skip/flag rows whose versions disagree.

### BS-03: `inMemoryTokenCache` is only filled on the refresh path, so the Redis-blip fallback almost never has a value  [P2] [confidence: high] [effort: S]
- Where: `api/_lib/schwab.ts:132` (decl), `:276` (only write), `:335–342` (fallback read), `:70–78` (`getStoredTokens` swallows Redis errors to `null`)
- What: The comment promises "during a Redis blip inside an active invocation it prevents cascading auth failure", but the cache is populated only inside the lock-holder branch of `refreshAccessTokenOnce`. The Redis distributed lock guarantees that exactly one instance performs each ~30-min refresh; every other warm instance only ever *reads* tokens from Redis and never writes the in-memory cache. The comment at `:127–131` ("module-scoped variables don't survive cold starts / only helps within the same invocation") also under-describes the lifetime under Fluid Compute, where the cache persists across invocations on a warm instance and would be genuinely useful if populated.
- Failure scenario: Upstash returns an error for 30 s. `getStoredTokens()` → `null`. On any warm instance that did not win the last refresh (the common case), `getAccessToken()` falls to `:343` and returns `{type:'expired_refresh', message:'No tokens found. Run /api/auth/init to authenticate.'}` for every Schwab-backed endpoint. The UI shows a re-authenticate prompt for a transient Redis blip; the state that was built to absorb exactly this is empty.
- Fix: In `getAccessToken`, after the `stored` validity check succeeds (`:361`), set `inMemoryTokenCache = { accessToken: stored.accessToken, expiresAt: stored.expiresAt }` so every successful read arms the fallback; update the comment to say the cache lives for the warm instance.

### BS-04: Handler queues drop silently under a Neon stall — bounded memory, but no log/Sentry when the backpressure policy engages  [P2] [confidence: high] [effort: S]
- Where: `uw-stream/src/handlers/base.py:80–123` (`enqueue`; drop counters at `:91`, `:97`, `:99`, `:121` have no log/capture — only the `block` policy at `:111–118` logs); readers of `drop_count`: only `uw-stream/src/health.py:143` (`/metrics`); `uw-stream/src/config.py:109` (`ws_queue_size = 50_000`, default policy `drop_oldest`)
- What: Each handler owns a bounded `asyncio.Queue(maxsize=50_000)`; `_safe_flush` awaits the DB write on the consumer task, so a slow Neon blocks the consumer while the producer keeps filling the queue. Memory is bounded (50k payloads × ~1–2 KB ≈ 50–100 MB per handler; ~8 handler instances), which satisfies the letter of R1. But once full, `drop_oldest` evicts a payload per incoming frame and only increments `state.channel(...).drop_count`. Nothing in-process watches that counter; there is no rate-limited warning and no `capture_message`.
- Failure scenario: Neon HTTP path stalls for 10 min during the open (a recorded incident class — see memory `neon-transient-outages`). `option_trades` frames arrive at thousands/min; after ~50k queued, every further frame evicts the oldest. When Neon recovers, tens of thousands of `ws_option_trades` rows are gone, the Lottery/Silent Boom detectors see a thinner tape, and the only evidence is a `drop_count` number on `/metrics` that nobody polls. Contrast: the receive-queue overflow path in `connector.py:294–298` at least logs its "impossible" branch.
- Fix: In `enqueue`, on the first drop per window emit `rate_limited_log.warning(scope=self.name, kind="queue_drop", ...)` and a `capture_message("uw-stream handler queue dropping", level="warning", context={channel, drop_count, queue_depth})`; the existing `RateLimitedLogger` (`logger_setup.py:173`) already bounds the spam.

### BS-05: `state.channels` is populated from server-provided channel names before the handler check  [P3] [confidence: high] [effort: S]
- Where: `uw-stream/src/router.py:103` (`state.channel(channel).subscribed = True`) and `:116` (`state.touch(channel)`) run before `self.handlers.get(channel)` at `:128`; `uw-stream/src/state.py:110–114` creates on demand
- What: Any channel string UW sends creates a `ChannelMetrics` entry. In practice the server only pushes subscribed channels (~150–300 keys), so this is bounded by the universe; it would only grow if the provider emitted unexpected channel names, and then only by one small dataclass per distinct name.
- Fix: Move `state.touch(channel)` after the handler lookup (or only touch when `channel in self.handlers`), keeping the join-ack path as-is since acks are for channels we joined.

### BS-06: Take-it bundle loader has no single-flight and no negative cache  [P3] [confidence: high] [effort: S]
- Where: `api/_lib/takeit-bundle-loader.ts:98` (`CACHE`), `:118–177` (`getBundle`); called from `api/_lib/takeit-detect.ts:128` by both every-minute detect crons
- What: `CACHE` is a fixed two-key object (bounded), but when an entry is stale every concurrent caller on the same warm instance fetches manifest + bundle independently, and during a Blob outage every call re-hits Blob through `withRetry` and emits `takeit.bundle.manifest_fetch_failed` per call — there is no in-flight promise reuse and no short back-off after a failure. Falls back to the stale bundle, so no wrong data; cost and Sentry noise only.
- Fix: Keep a `Partial<Record<AlertType, Promise<TakeitBundle|null>>>` in-flight map cleared in `finally`; on manifest failure bump `fetchedAt` by a 60 s negative-cache window before returning the fallback.

### BS-07: `versionChecked` is set before the probe completes, so a timed-out probe is never retried  [P3] [confidence: high] [effort: S]
- Where: `api/_lib/multileg-client.ts:191` (decl), `:370–371` (`if (versionChecked) return; versionChecked = true;` precedes the fetch)
- What: Intended as a once-per-process cold-start probe, but the flag flips before the network call, so an `AbortController` timeout or a 5xx from the classifier (`:385–397`) permanently disables `pattern_set_drift` detection for that instance. Warn-once semantics for a *successful* probe are fine; for a failed one it is a lost signal.
- Fix: Set `versionChecked = true` only after a definitive result (2xx JSON parsed, or a non-2xx that indicates the endpoint exists); leave it `false` on network/timeout so the next classify call retries.

### BS-08: Cache keys embed unnormalized timestamps, doubling entries for the same instant  [P3] [confidence: high] [effort: S]
- Where: `api/gex-strike-expiry.ts:105–110` (`cacheKey` uses raw `at`), `api/gex-target-history.ts:183–189` (`ghKey` uses raw `ts`), `api/_lib/db-gex-strike-expiry.ts:516` (same for `at`)
- What: `2026-09-08T14:30:00Z`, `2026-09-08T14:30:00.000Z`, and `2026-09-08T09:30:00-05:00` are three keys for one snapshot. The two endpoint caches evict on write so this is not growth, only hit-rate loss and extra Neon calls; for `timestampsCache` it multiplies BS-01.
- Fix: Normalize with `new Date(at).toISOString()` inside the key builders.

### BS-09: Stale lifetime comments on the Schwab in-memory state  [P3] [confidence: high] [effort: S]
- Where: `api/_lib/schwab.ts:119–123` and `:126–131`
- What: Both comments describe `refreshInFlight` / `inMemoryTokenCache` as scoped to "the same serverless invocation" and say module variables "don't survive cold starts". Under Fluid Compute they survive across *invocations* on a warm instance (which is exactly why the single-flight dedupe works across concurrent requests). The code is correct; the comment misleads the next reader about why `.finally` clearing at `:303–305` is load-bearing.
- Fix: Reword to "persists for the life of the warm Fluid Compute instance; cleared in `finally` so a rejected refresh never pins a dead promise."

### BS-10: Sidecar psycopg2 pool lazy-init is not lock-guarded across threads  [P3] [confidence: medium] [effort: S]
- Where: `sidecar/src/db.py:54–58` (`get_pool`: `if _pool is None or _pool.closed:` → create), callers on the SDK callback thread, `BatchedWriter` flush threads (`batched_writer.py:151–160`), and the health server thread (`main.py:123`); no `get_pool()` warm-up in `main()` before those threads start
- What: Two threads hitting the first DB call simultaneously can both see `_pool is None` and both construct a `ThreadedConnectionPool(minconn=1)`; the loser's pool is overwritten and its connection leaks until GC. Only possible on the very first DB op after boot, so a one-off, not growth.
- Fix: Guard the check-and-create with a module `threading.Lock()` (the sibling `theta_fetcher.start_scheduler` at `theta_fetcher.py:98` already does this), or call `get_pool()` once in `main()` before spawning threads.

## Already good — compliant patterns worth protecting

**Single-flight / promise caches (clear on failure)**
- `api/_lib/schwab.ts:259–307` — `refreshInFlight` set once, cleared in `.finally`; lock holder is the only caller of Schwab; loop bounded by `LOCK_MAX_ATTEMPTS`.
- `api/_lib/flow-regime-baseline-live.ts:176–217` — single-entry cache keyed by ET date; deliberately stores the *promise* (so concurrent ticks share one query) and drops it via `promise.catch` only if it is still the cached promise. This is correct and should not be "fixed" to clear on success.
- `api/gex-strike-expiry.ts:92–104, 137–170` and `api/gex-target-history.ts:171–183, 421–433` — TTL cache + `evictExpiredCacheEntries()` on every write + `inFlight.finally(() => inFlight.delete(key)).catch(() => {})`. This is the reference pattern for the repo.

**Warn-once booleans (exempt by rule)**
- `api/_lib/push.ts:53` (`vapidConfigured`, set only after `setVapidDetails` succeeds), `api/_lib/auth-helpers.ts:82`, `api/_lib/guest-auth.ts:29`, `api/_lib/multileg-client.ts:181, 189`.

**Lazy singletons (exempt by rule)**
- `api/_lib/db.ts:35`, `api/_lib/env.ts:97`, `api/_lib/axiom.ts:18`, `api/_lib/embeddings.ts:23`, `api/_lib/cron-instrumentation.ts:64` (tri-state `undefined|null|parts` is intentional), `api/_lib/redis.ts:43`, `api/analyze.ts:96`, `api/ml/analyze-plots.ts:32`; `uw-stream/src/db.py:47` (init once from `main`), `uw-stream/src/notify.py:65` (session recreated if closed), `sidecar/src/theta_fetcher.py:88` (lock-guarded).

**Bounded throttle maps keyed by a closed literal set**
- `api/_lib/multileg-client.ts:202` — 8 literal message names (`:426–704`).
- `uw-stream/src/notify.py:58` — keys are `status:<code>` / `exc:<ClassName>`.
- `uw-stream/src/logger_setup.py:173` — keyed by `(scope, kind)` literals from the router.
- `sidecar/src/theta_launcher.py:88` — keyed by regex capture (`_ERROR_SIGNATURES` at `:52`: Java exception class names / FATAL / SEVERE).

**Rate limiting and concurrency are Redis-backed, not in-process**
- `api/_lib/auth-helpers.ts:241–259` (INCR+EXPIRE), `api/_lib/uw-rate-limit.ts:97–111` (INCR+EXPIRE, no module state — **IN-FLIGHT**), `api/_lib/uw-concurrency.ts:122–182` (ZSET leases with 30 s TTL, self-healing), released in `finally` at `api/_lib/uw-fetch.ts:221–222` (**IN-FLIGHT**).

**uw-stream bounded structures**
- `handlers/base.py:51` — `asyncio.Queue(maxsize=settings.ws_queue_size)` with documented drop/block policy; `_batch` bounded by `ws_batch_size`.
- `main.py:195` + `_receive_queue_size()` — bounded receive queue; `connector.py:274–298` drop-oldest with counter.
- `handlers/interval_ba.py:158–177, 326–338, 376, 426–447, 461–526` — three amortised caps (`_FIRED_PRUNE_THRESHOLD`, `_CHAINS_PRUNE_THRESHOLD`, `_PENDING_ALERTS_MAX`), per-chain bucket prune, and failure-path re-queue that keeps newest rows and never touches the dedupe set.
- `handlers/recent_fires.py:39–61` — `deque(maxlen=200)` per `(ticker, option_type)`; key space is the fixed ticker universe.
- `notify.py:51, 132–134` — background task set with `add_done_callback(discard)`; `drain_pending` bounded by timeout.
- `state.py:53` — `reconnect_times: deque(maxlen=512)`.
- `connector.py:264–321` — reconcile task cancelled + awaited in `finally` on every disconnect; no task leak across reconnects.

**sidecar bounded structures**
- `options_router.py:148, 230, 264, 450–500` — `option_definitions` pruned of past-expiry entries on a throttled cadence (M7).
- `batched_writer.py:98–105` — `max_buffer_size` trims oldest on persistent write failure with a Sentry message (`_capture_message` at `:65`).
- `databento_client.py:142, 581–621` — `_resolved_cache` keyed by futures `instrument_id`s from the OHLCV/TBBO handlers only (`:628`, `:746`), not option contracts; bounded by outrights in the parent subscription.
- `databento_client.py:132–135, 539–541` — `_last_close_before_disconnect` / `_reconnect_sanity_check_pending` keyed by the 7 configured symbols.
- `sidecar/src/takeit_server.py:240–242` — `alert_type` validated against `("lottery","silentboom")` before reaching `_bundle_cache`, so the cache is 2 keys max (its staleness is BS-02, not growth).

## Rule tweaks

1. **"pending marker must be cleared in `finally` (not only on success)"** misfires on `flow-regime-baseline-live.ts:176–217`, where the promise *is* the cached value and is meant to persist on success for the ET day. Reword: "An in-flight marker must be dropped on rejection (via `finally` or `.catch`). A promise deliberately cached as the value may persist after it resolves, but must still be dropped if it rejects."

2. **Exemptions should include closed-key maps.** Add to the exempt list: "Maps/dicts keyed by a closed set of string literals or enum values (Sentry/log throttles keyed by message name, per-`(scope, kind)` buckets) and per-key bounded deques" — otherwise `multileg-client.ts:202`, `notify.py:58`, `logger_setup.py:173`, `recent_fires.py:42` all look like violations.

3. **A TTL check on read is not a bound.** `db-gex-strike-expiry.ts` checks `expiresAt` on read and still leaks (BS-01). State explicitly: "A TTL only bounds memory if something deletes expired entries — an on-write sweep, a size cap with eviction, or a scheduled purge. Read-time expiry alone does not count."

4. **Bounded-but-silent is still a finding.** The Python clause ("asyncio queues need a maxsize or a documented backpressure story") was satisfied by `handlers/base.py` and the real gap was observability (BS-04). Append: "…and a log/Sentry signal the first time the policy engages, so a bounded drop is not an invisible drop."

5. **Cross-service cache parity.** BS-02 is a module-level cache that is fine in isolation and wrong in context. Add a clause: "When the same artifact is cached on both sides of a service boundary (Vercel ↔ Railway), the refresh policies must match or a version handshake must exist; a cache with no refresh on one side is a drift bug, not a singleton."

6. **State that exists but is under-populated** (BS-03) is worth naming under item 4 ("unnecessary state"): "Also flag state that is written on only one path and therefore cannot serve the fallback it was written for."
