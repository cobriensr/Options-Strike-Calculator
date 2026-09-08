# di-complexity audit — 2026-09-08

Theme: Rule R3 — unnecessary dependency injection, factories, and indirection introduced for testability.
Scope audited: `api/**` (incl. `__tests__`), `src/hooks/**`, `src/utils/**`, `uw-stream/src|tests`, `sidecar/src|tests`, `ml/src` (light).
Read-only; worktree at origin/main. No source files modified.

## Method — what you grepped, what you read, counts

Greps (TypeScript, excluding `__tests__` unless noted):

- Parameter names `deps|dependencies|overrides|inject|container|services` → 1 real hit (`TakeitContextDeps`); rest were locals.
- Default-parameter function injection (`= fetch`, `= getDb`, `= Date.now`, `= () => new Date()`, `sleep =`) → 0 hits in signatures.
- `create*/make*/build*` exported functions → 30 hits; 29 are domain builders (SQL statements, payloads, BWB legs), 1 is a factory (`createRedis`).
- Test-only exports: `_reset*ForTests`-style → 13; `export const _internal = {...}` bags → 2; "Exported for tests" named re-exports → 3.
- DB-handle type aliases / local interfaces (`type Sql = ReturnType<typeof getDb>`, `NeonQueryFunction<false,false>`, `interface DbClient`, `DbHandle`, `Pick<..., 'query'>`) → 14 distinct declarations across 14 files.
- `typeof fetch` / `typeof getDb` parameters → 1 (`wrapFetch`).
- `class` declarations → 9 (8 `Error` subclasses + `HttpError`); none are single-method wrappers.
- `interface I*` / `*Port` / `*Adapter` / `*Gateway` → 0.
- Optional `now?:`/`nowMs?:`/`clock` fields in option bags → 1 (`EvaluateOpeningFlowOptions.now`).
- Function-typed fields in option bags (`fetch*`, `now`, `sleep`, `logger`, `query`) → 6 (3 in `TakeitContextDeps`, `CronContext.logger`, `DbHandle.query`, `usePolledWindowSignal.inWindow`).
- Comments justifying a design by testability (`testab|so tests can|for tests|unit-testable|without touching`) → 35 hits; read the surrounding code for every non-`_reset` hit (~22 sites).
- Tests that both `vi.mock('../_lib/db')` AND hand a fake `sql` directly to a function → 60+ files matched the loose grep; sampled 14 helper-module tests to see whether the module also calls `getDb()` (double seam) — none did except via a handler that passes the handle down.

Greps (Python): `class` (55), `Protocol|ABC|abstractmethod` (4 declarations), `def __init__(` (21, read the 3 with injected collaborators), `Callable[` params (12), default-param injection (1 value-typed `now`), `monkeypatch|patch(` usage in tests (20 files — confirms module-boundary patching is the norm).

Files read in full or in the relevant region: `takeit-detect.ts`, both `detect-*.ts` call sites + both cron tests + `takeit-detect.test.ts`; `wave2-confirmation.ts`; `detect-lottery-fires.ts:1146-1200`; `flow-regime-rows.ts` (runner layer + pglite integration test); `rollup-ws-gex-strike-expiry.ts` + test; `cron-instrumentation.ts:395-470`; `opening-flow-evaluator.ts` + endpoint + cron + test; `redis.ts` + test; `authInterceptor.ts` + test; `bulk-upsert.ts`; `gex-target-features.ts:880-914`; `db-claude-tools.ts` + `claude-tools.test.ts`; `analyze-precheck.ts` + `analyze.ts:96,165` + both tests; `periscope-extract.ts:20-50`; `interval-ba-alerts.ts` / `interval-ba-feed.ts` (`_internal` + `deriveSeverity` diff); `usePolledWindowSignal.ts` / `useRegime0dte.ts` / `useOpeningFlowSignal.ts`; `select-target.ts:80-110`; uw-stream `router.py`, `handlers/base.py`, `ws_lease.py`, `connector.py`, `main.py:120-160,330-405`, `test_router.py`, `test_ws_lease.py`; sidecar `databento_client.py:77-135,738-752`, `quote_processor.py:280-300`, `main.py:148-165`, `health.py:187-203`, `stat_writer.py`, `options_router.py`, `symbol_manager.py:151`, `test_databento_client.py:84-90,456-470`, `test_quote_processor.py:420-435`; ml `setups_backtest/harness.py:120-170` + evaluators dir.

Counts: **~135 candidate sites examined → 11 verified findings (1 P1, 1 P2, 9 P3) → 15 legitimate cases listed under "Already good".** The five IN-FLIGHT files (`uw-rate-limit.ts`, `uw-fetch.ts`, `sentry.ts`, and their two tests) were grepped for injected/defaulted function params — `withUWRetry(fn)`, `mapWithConcurrency(worker)`, `extract?:` are higher-order utilities, not DI seams. No findings there.

## Findings

### DI-1: `TakeitContextDeps` fetch-closure bag — the real SQL runs in no test, and is duplicated across two crons  [P1] [confidence: high] [effort: M]

- Where: `api/_lib/takeit-detect.ts:97-110` (interface + comment), `:122-125` (`loadTakeitDetectContext(alertType, deps)`); call sites `api/cron/detect-lottery-fires.ts:406-470` and `api/cron/detect-silent-boom.ts:413-475`; tests `api/__tests__/takeit-detect.test.ts:51-60`, `api/__tests__/detect-lottery-fires.test.ts:84-94`, `api/__tests__/detect-silent-boom.test.ts:68-73`.
- What: `loadTakeitDetectContext` takes a `deps` object of three async fetchers. The comment says the shim exists "so this module is unit-testable without pulling neon-serverless into the test." Each of the two consuming crons builds the three closures inline (~65 lines each) with the real `db\`...\`` SQL, mirror-image copies differing only in table (`lottery_finder_fires` vs `silent_boom_alerts`) and time column (`trigger_time_ct` vs `bucket_ct`). `takeit-detect.test.ts` drives the function with three `vi.fn()` deps. Both cron tests `vi.mock('../_lib/takeit-detect.js')` and replace `loadTakeitDetectContext` with `() => Promise.resolve(null)`.
- Cost: Double mechanism. The unit test exercises fake fetchers; the cron tests mock the whole function away — so the 130 lines of production closures (SQL text, `withDbRetry` wrapping, the `as Array<{...}>` row-shape casts that must agree with `RecentFireRow`/`RecentCofireRow`) execute in zero tests. A column rename in either query, or a drift between the two mirror copies (e.g. one cron's `fetchRecentOtherTypeByChain` pulling a different column set), would pass CI and surface only as `Sentry.captureException` + silent `takeit_prob = null` in production — exactly the fail-open path the code is designed to hide. The `deps` shape also forces both crons to carry the row-type casts that `takeit-detect.ts` already declares.
- Fix: Move the three queries into `takeit-detect.ts` as `fetchRecentSameType(alertType, lookbackMin)` etc., parameterised by a small `{ table, timeCol, otherTable, otherTimeCol }` lookup keyed on `AlertType`; call `getDb()` inside. Delete the `deps` parameter and both inline closure blocks. In `takeit-detect.test.ts`, `vi.mock('../_lib/db.js')` and drive `vi.mocked(getDb)` with three `mockResolvedValueOnce` calls in query order (the established cron-test pattern). Cron tests keep their existing module mock.

### DI-2: `DatabentoClient(quote_processor=None)` — a silent-drop production branch that exists only for test fixtures  [P2] [confidence: medium] [effort: S]

- Where: `sidecar/src/databento_client.py:89-100` (constructor, comment "Optional to keep older callers (and test fixtures) compatible"), `:743-744` (`_handle_tbbo` early-return when `None`), `:866-867` (flush guard); production wiring `sidecar/src/main.py:152-155`; test `sidecar/tests/test_databento_client.py:88` (constructs without it), `:456-469` (then assigns `client._quote_processor = ...` directly), `:461` (`test_no_quote_processor_is_noop`).
- What: The only production caller always passes a real `QuoteProcessor`. The `| None = None` default is documented as being for "older callers and test fixtures"; no older caller exists. The test fixture constructs without it and later pokes the private attribute, and a dedicated test asserts the `None` branch is a no-op.
- Cost: Production carries — and CI protects — a branch in which every ES/NQ TBBO record is dropped with no log, no metric and no Sentry event. If a future edit to `main.py` (or a second entrypoint) omits the argument, top-of-book and trade-tick ingestion stops silently; the "no quote processor is noop" test would still pass. The test also bypasses the constructor to swap the collaborator, so the constructor's own contract is not what the tests exercise.
- Fix: Make `quote_processor: QuoteProcessor` required; have the fixture pass a `MagicMock()` for it (as it already does for `trade_processor`); delete `test_no_quote_processor_is_noop` and the two `is None` guards.

### DI-3: Fourteen private spellings of "the Neon handle type", two of them justified by a mock story that isn't true  [P3] [confidence: high] [effort: S]

- Where: `api/cron/wave2-confirmation.ts:78-84` and `api/cron/detect-lottery-fires.ts:1146-1152` (`interface DbClient` — "so tests can mock with a plain `vi.fn()`"); `api/_lib/rollup-ws-gex-strike-expiry.ts:79-81` (`DbHandle = NeonQueryFunction & { query: ... }` — the intersection adds nothing; `NeonQueryFunction` already has `.query`); plus `type Sql|DbSql|Db|SqlClient = ReturnType<typeof getDb>` or `NeonQueryFunction<false,false>` in `analyze-context-formatters.ts:20`, `multileg-classify-batch.ts:42`, `gex-strike-day.ts:3`, `ticker-flow-snapshot.ts:41`, `lottery-suppression.ts:46`, `futures-context.ts:16`, `gamma-stats.ts:24`, `gamma-detector.ts:31`, `build-features-phase2.ts:75`, `cron/fetch-strike-iv.ts:74`, `db-migrations.ts:18-26`.
- What: Every consuming test already does `vi.mock('../_lib/db.js')` with `getDb: vi.fn(() => mockSql)` and casts `as unknown as ReturnType<typeof getDb>` where needed (e.g. `cron-wave2-confirmation.test.ts:23`, `rollup-ws-gex-strike-expiry.test.ts:16-19`). The local interfaces are not what makes mocking work; the cast is.
- Cost: The comment in two crons documents a false reason, which invites the next author to add a fifteenth alias. `DbHandle.query` widens the return to `Promise<unknown>` and `DbClient` returns `Promise<any[]>` — drift from the driver's real types that silently disables type-checking of row shapes at those call sites.
- Fix: `export type Sql = ReturnType<typeof getDb>;` once in `api/_lib/db.ts`; replace all 14 declarations with an `import type { Sql }`; delete the two "so tests can mock" comments.

### DI-4: `export const _internal = {...}` test bags hide a copy-pasted `deriveSeverity`/`shapeRow` across two endpoints  [P3] [confidence: high] [effort: S]

- Where: `api/interval-ba-alerts.ts:268-269` and `api/interval-ba-feed.ts:414`; definitions `interval-ba-alerts.ts:79,143` vs `interval-ba-feed.ts:103,164`; consumers `api/__tests__/interval-ba-alerts.test.ts:44`, `api/__tests__/interval-ba-feed.test.ts:39,416-433`.
- What: Both endpoints define their own `deriveSeverity` (bodies identical modulo a comment) and their own `shapeRow`, then export them to tests through an `_internal` bag rather than by name.
- Cost: Because neither module exports the functions by name, the second file could not import from the first, so the logic was duplicated instead. A threshold change to severity in one endpoint will not reach the other; the tests exercise each copy separately and cannot catch the divergence.
- Fix: Move `deriveSeverity` (and the shared `toNumber`) to `api/_lib/interval-ba-shape.ts` as named exports, import in both endpoints, delete both `_internal` bags; tests import the named functions.

### DI-5: `EvaluateOpeningFlowOptions.now` is documented as a replay override but no production caller overrides it  [P3] [confidence: high] [effort: S]

- Where: `api/_lib/opening-flow-evaluator.ts:57-68,125-129`; callers `api/opening-flow-signal.ts:62,77,80` (`now = new Date()`), `api/cron/capture-opening-flow-signal.ts:60` (`evaluateOpeningFlow(date)`); test `api/__tests__/opening-flow-evaluator.test.ts:28,36,66,83,95,107`.
- What: The docstring says `now` is "used by historical replays AND tests". Historical replay is driven by `date` (the evaluator forces `effectiveNow` to open+1h for non-today dates); the endpoint passes wall-clock, the cron passes nothing. Only the test passes fixed instants.
- Cost: Small — one option that exists for tests and a docstring that will mislead the next reader into thinking replays thread a clock. The endpoint's pass-through is a mild consistency win (same instant for `today` and the evaluator), which is why this is P3 rather than P2.
- Fix: Either drop `opts.now` and switch the test to `vi.useFakeTimers(); vi.setSystemTime(...)`, or keep it and correct the comment to "tests + same-instant consistency with the caller's `today`".

### DI-6: `createRedis()` is an exported one-call-site factory  [P3] [confidence: high] [effort: S]

- Where: `api/_lib/redis.ts:27-36` (export), `:43` (sole call: `export const redis = createRedis()`); no importer of `createRedis` in `api/**` or `api/__tests__/**` (`redis.test.ts` imports only `safeRedis`).
- What: A factory extracted from the singleton initialiser and exported, but nothing constructs a second client.
- Cost: Advertises a construction seam nobody uses; a reader will look for the second caller.
- Fix: Un-export (or inline into the `redis` const with the try/catch).

### DI-7: `router.Handler(Protocol)` duplicates `handlers.base.Handler(ABC)` under the same name  [P3] [confidence: medium] [effort: S]

- Where: `uw-stream/src/router.py:29-33` (Protocol: `name` + `enqueue`), `uw-stream/src/handlers/base.py:44` (ABC, every production handler subclasses it); `uw-stream/src/main.py:28,31` imports both modules; `uw-stream/tests/test_router.py:15-23` passes a duck-typed `FakeHandler`.
- What: The Protocol exists so `Router.__init__(handlers: dict[str, Handler])` type-checks against the test double without importing `handlers.base`. Python does not enforce it at runtime; the ABC is the only real implementer family.
- Cost: Two classes named `Handler` in one small package; `from router import Handler` and `from handlers.base import Handler` are both valid and mean different things. The Protocol also pins the router's contract to two members while the ABC evolves (`drain`, `run`, `_stopping`), so the "interface" understates what `main.py` actually relies on.
- Fix: Delete the Protocol; type the router with `handlers.base.Handler` under `TYPE_CHECKING`; keep `FakeHandler` (duck typing still works) or subclass the ABC with no-op `_transform/_flush`.

### DI-8: `QuoteProcessor._lock` is a production property kept for one legacy test assertion  [P3] [confidence: high] [effort: S]

- Where: `sidecar/src/quote_processor.py:287-296` ("Compatibility shim for tests that observed the legacy single-lock layout"); consumer `sidecar/tests/test_quote_processor.py:434` (`processor._lock.locked()`).
- What: After the split into `_TopOfBookWriter` / `_TradeTickWriter`, a property was added that returns the TOB writer's lock so an old assertion still passes.
- Cost: The property's own docstring says it lies (there is no single lock); it exposes an inner writer's private state on the public object and asserts only half the invariant the test name claims ("releases lock before DB write" — the trade writer's lock is not observed).
- Fix: Delete the property; have the test observe both `processor._tob_writer._lock` and `processor._trade_writer._lock`.

### DI-9: `Handler._safe_flush` tolerates `_flush` returning `None` for "legacy in-test handlers" only  [P3] [confidence: high] [effort: S]

- Where: `uw-stream/src/handlers/base.py:326` (`written = inserted if isinstance(inserted, int) else len(rows)`), `:347-359` (abstract signature `-> int | None` with the backwards-compat note). All six production handlers return `int` (`flow_alerts.py:188`, `gex_strike_expiry.py:193`, `interval_ba.py:463`, `net_flow.py:129`, `off_lit_trades.py:218`, `option_trades.py:176`).
- What: The `None` fallback silently substitutes `len(rows)` for the accepted-row count.
- Cost: The docstring on the same method is about "honest write-count reporting"; the fallback defeats it for any future handler that forgets the `return` — `write_count` over-reports and the dedup/failure-rate metric the comment describes becomes wrong with no signal. The only beneficiaries are test stub handlers.
- Fix: Make the abstract signature `-> int`, drop the `isinstance` branch, and update the in-test stub handlers to `return len(rows)`.

### DI-10: `WsLease` takes seven constructor args plus an `aiohttp` session that `main.py` must create, thread and close  [P3] [confidence: medium] [effort: M]

- Where: `uw-stream/src/ws_lease.py:44-52` (design note: "Dependency-injected ... so tests inject a fake REST seam"), `:162-184` (constructor); plumbing `uw-stream/src/main.py:139-153,332,355-357,367,404-405` (`lease_session` create / pass to `_shutdown` / two guarded closes); test `uw-stream/tests/test_ws_lease.py:70-92` (`FakeSession.post`).
- What: Every non-session argument comes from `settings` in the only production caller; the session is created solely to be injected and its lifecycle leaks into `_shutdown()`'s signature. The class already isolates I/O in one method (`_command`), which is the natural monkeypatch seam.
- Cost: Eight lines of lifecycle plumbing in `main.py` (including a second close guard in the `finally`) exist only because the class does not own its session. The test double reimplements `aiohttp`'s `post()`/context-manager surface instead of patching `WsLease._command`.
- Fix: Let `WsLease` read `settings` and open/close its own `ClientSession` in `acquire()`/`release()`; tests `monkeypatch.setattr(WsLease, "_command", fake)`. Keep `instance_id` as the one constructor arg (it is per-process state). Borderline: passing a session is idiomatic `aiohttp`, so this is hygiene, not a bug.

### DI-11: `usePolledWindowSignal` is a 265-line generic with one consumer; its intended second consumer re-forked  [P3] [confidence: medium] [effort: M]

- Where: `src/hooks/usePolledWindowSignal.ts:1-30` (header: "collapses the previously-forked machinery shared by `useRegime0dte` and (formerly) `useOpeningFlowSignal`"); sole consumer `src/hooks/useRegime0dte.ts:83`; `src/hooks/useOpeningFlowSignal.ts:183-289` hand-rolls its own `inPollingWindow` + interval + `isWindowOpen` state.
- What: The `inWindow` callback is fine (normal React). The issue is a primitive extracted to de-duplicate two hooks, after which one of the two stopped using it.
- Cost: The header's cache-staleness guard ("never surface yesterday's payload as today's") is enforced for regime-0dte and not for opening-flow — the exact divergence the primitive was written to prevent. Two test files (`usePolledWindowSignal.test.ts`, `OpeningFlowSignal.test.tsx`) now cover two implementations of one behaviour.
- Fix: Either re-migrate `useOpeningFlowSignal` onto the primitive (and diff its cache semantics against the primitive's), or inline the primitive back into `useRegime0dte` and delete it. Do not leave a one-consumer generic.

## Already good — legitimate injection / wrappers worth protecting

- `api/_lib/request-scope.ts:171` `withDbReader(path, label, auth, handler, opts?)` — sanctioned request-scope wrapper (given).
- `api/_lib/flow-regime-rows.ts:85-92,272-305` `FlowAggRunner` + `runAggWindow/runAggSlot` + `aggregateFlowWindow(sql)` — a real second executor exists: `api/__tests__/flow-regime-sql-integration.test.ts:129` runs the identical production SQL text against pglite (`db.query` returns `{rows}`; neon returns `Row[]`; `runnerRows` at `:163` normalises both). This is the one place a "runner port" earns its keep — it lets the SQL algebra be tested for real rather than mocked. Protect it.
- `src/utils/authInterceptor.ts:90` `wrapFetch(original: typeof fetch)` — a decorator's input is by definition the thing it wraps; `installAuthInterceptor` (`src/main.tsx:11`) wraps `window.fetch`. Not DI.
- `api/_lib/analyze-precheck.ts:44` and `api/_lib/periscope-extract.ts:26-30` — an already-constructed `Anthropic` client is passed in so `api/analyze.ts:96` owns apiKey/timeout/maxRetries once. That is client sharing, not a test seam; `periscope-extract.ts` documents it correctly. `analyze-precheck.ts:33`'s "(injected for testability)" docstring is the wrong justification — fix the comment, keep the parameter. (`analyze.test.ts` mocks both `@anthropic-ai/sdk` and the precheck module; `analyze-precheck.test.ts` hands in a fake client — no double at the same seam.)
- The "handler calls `getDb()` once and threads `sql` into helpers" convention — `api/_lib/bulk-upsert.ts:47`, `gex-target-features.ts:890`, `db-claude-tools.ts:55,221`, `dark-pool-query.ts:122` (`queryPrints` internal; exports call `getDb()`), `multileg-classify-batch.ts:193`, `build-features-{gex,flow,monitor}.ts`, `gamma-detector.ts`, `lottery-suppression.ts`, and ~15 more. Tests mock `getDb` once (`vi.mock('../_lib/db.js')`) and the handle flows down; helper-module tests that pass `mockSql` directly do so without a second seam in the module. Plumbing, not injection.
- `_reset*ForTests` / `_resetDb` / `_resetClient` singleton resets — `api/_lib/db.ts:47`, `env.ts:120`, `embeddings.ts:31`, `axiom.ts:21`, `push.ts:184`, `takeit-bundle-loader.ts:220`, `cron-instrumentation.ts:113`, `gex-target-history.ts:194`, `gex-strike-expiry.ts:116`, `db-gex-strike-expiry.ts:40`, `flow-regime-baseline-live.ts:182`, `src/utils/alert-chime.ts:74`, `anomaly-sound.ts:54` — the convention R3 explicitly sanctions.
- `api/_lib/cron-instrumentation.ts:421-422` `CronContext.logger` — the module singleton passed through for import convenience; not swappable, not a seam (`cron-instrumentation.test.ts:272` asserts identity).
- `src/hooks/usePolledWindowSignal.ts:68` `inWindow: (now: Date) => boolean`, `src/hooks/useAlertPolling.ts:53` `requestPermission` — hooks taking callbacks is normal React (the single-consumer issue is DI-11, not the callback).
- `src/utils/gex-target/select-target.ts:95` `weights = GEX_TARGET_CONFIG.weights` and `sidecar/src/symbol_manager.py:151` `get_nearest_es_expiry(now=None)` — value-typed defaults (config / a date), not function injection; harmless.
- `sidecar/src/batched_writer.py:80` `BatchedWriter(ABC, Generic[T])` — five real subclasses (`TradeProcessor`, `StatWriter`, `BarWriter`, `_TopOfBookWriter`, `_TradeTickWriter`).
- `ml/src/setups_backtest/harness.py:132` `SetupEvaluator(Protocol)` — eleven evaluator modules implement it.
- `sidecar/src/health.py:187-203,946-954` `Callable[[], ...]` probes — cross-component wiring (`main.py` hands the health server live predicates without import cycles). Real composition.
- `sidecar/src/stat_writer.py:80` `on_write_failure`, `sidecar/src/options_router.py:137` `is_shutting_down`, `uw-stream/src/ws_lease.py:341` `on_lost` — production callbacks wired by real callers (`options_router.py:185`, `databento_client.py:123`).
- `sidecar/src/databento_client.py:89-91` `trade_processor: TradeProcessor` (required) — composition of collaborators `main.py` owns; only the `quote_processor=None` default is the finding (DI-2).
- Python DB access in both services — module-level pool singletons (`uw-stream/src/db.py`, `sidecar/src/db.py`) with `monkeypatch.setattr(db, ...)` in 20 test files. Already the R3 shape.
- IN-FLIGHT `api/_lib/uw-fetch.ts:89,128,214` `withUWRetry(fn)`, `mapWithConcurrency(worker)`, `extract?:` — higher-order utilities over a caller-supplied operation, not injected dependencies; `uw-rate-limit.ts` and `sentry.ts` use the `redis`/`Sentry` singletons directly.

## Rule tweaks — how to reword R3 if it would misfire on legitimate code here

1. Exempt decorators/wrappers whose parameter *is* the wrapped thing (`wrapFetch(original)`), and hooks/functions taking behavioural callbacks. The smell is a parameter that only ever receives the module's own default.
2. Reword "SDK clients": passing an already-constructed client from the module that owns its configuration (`analyze.ts` → precheck/extract) is sharing, not a seam. The rule should target *constructing a second way to obtain* the client (a factory/param with a default of `new Anthropic()`), not passing one along.
3. Exempt handle threading: a helper taking `sql: ReturnType<typeof getDb>` from a handler that called `getDb()` once is plumbing, provided the module does not *also* call `getDb()` internally (two seams) and tests mock `getDb` at the boundary. Add: "declare the handle type once (`Sql` in `db.ts`); never re-declare it locally 'so tests can mock'."
4. "A real second implementation" should include an integration-test executor that runs the *production* SQL/text against a real engine (pglite in `flow-regime-sql-integration.test.ts`). A runner port backed by that is worth more than a `vi.mock`, not less.
5. Add the tell that found every P1/P2 here: a comment justifying a parameter with "testable / so tests can / for test fixtures / legacy callers" is the trigger to check whether (a) a `vi.mock`/`monkeypatch` of the same thing exists elsewhere (double seam → the real path runs nowhere) or (b) a `| None = None` / `?:` default introduces a production branch nothing but tests exercise.
6. Python phrasing: constructor injection of collaborators that `main.py` wires is composition; the R3 concern is defaults-for-fixtures (`quote_processor=None`), compat shims kept for old assertions (`_lock`), and tolerance branches for test-only subclasses (`_flush -> None`). Prefer `monkeypatch.setattr(Class, "_io_method", fake)` over hand-built fake sessions/clients.
