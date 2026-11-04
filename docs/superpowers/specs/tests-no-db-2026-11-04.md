# No test touches a real database

Status: approved by the owner 2026-11-04 (a standing rule, not a proposal). Phase A is in this change; phase B follows after 15:00 CT because it edits Railway service folders.

## Goal

No test, in any suite, may connect to or write to a real database. Each suite has one choke point where a connection attempt fails loudly, up front, instead of being noticed afterwards. In-process pglite stays allowed.

## Why

Several suites ran against whatever the shell exported. `.env.local` points at the production Neon database, and some ml tests read it or the repo-root `.env` file (`utils.load_env`, which overrides `os.environ`), so removing an env var never kept a run off a database. One ml test (`test_live_db_sum_invariant`) connected to whatever `DATABASE_URL` the shell had. `nightly/conftest.py` already forces a fake env and blocks non-loopback sockets; that is the model for the rest.

## The rule per suite

The block is the connect call itself, not the env: an env var can be set again by a loader, a file or a test.

| Suite | Choke point | Block | Self-test |
| --- | --- | --- | --- |
| ml (pytest) | `psycopg2._connect`; `asyncpg.connect` and `create_pool` if installed | `ml/conftest.py` replaces them at import with a stub that records the attempt and raises `DatabaseAccessBlocked`, a `BaseException`, so the `except Exception` wrappers in `utils` cannot swallow it. A session-end fixture fails the run if any attempt was recorded (catches `except BaseException` and bare `except:`). | `ml/tests/test_no_database_guard.py` |
| root `scripts/test_*.py` | same | `scripts/conftest.py`, a twin of the ml guard (the suites run from different roots, so no shared import) | `scripts/test_no_database_guard.py` |
| Vitest (`src/`, `api/`) | `neon()` in `api/_lib/db.ts:41`, the only place a Neon client is built | `src/__tests__/setup.ts` mocks `@neondatabase/serverless` for every test file: `neon`, `Pool` and `Client` record and throw. An `afterEach` fails the test that made an attempt, even if `safeDb` swallowed the throw. A file that mocks the package itself overrides it; pglite is untouched. Guard code in `src/__tests__/db-guard.ts`. | `api/__tests__/no-database-guard.test.ts` |
| Playwright (`e2e/`) | the Vite `/api` proxy | `playwright.config.ts` starts its own dev server (`reuseExistingServer: false`) with `VITE_API_TARGET=http://127.0.0.1:9`, so an unstubbed request is refused. `e2e/tracker.spec.ts` aborts what no route handled instead of `route.fallback()`. | the specs themselves |
| sidecar (phase B) | `psycopg2.connect` and `psycopg2.pool.ThreadedConnectionPool(...)` on the psycopg2 mock | `sidecar/conftest.py` installs the psycopg2 mock unconditionally (it used to skip a driver already in `sys.modules`); `connect` and the pool class record and raise `DatabaseAccessBlocked`, so a test cannot mistake a MagicMock for a connection. `DATABASE_URL` is forced to a fake there, replacing the `setdefault` in `test_db.py` and `test_main.py`. Tests that exercise `db.py` patch the pool class, which replaces the stub. | `sidecar/tests/test_no_database_guard.py` |
| uw-stream (phase B) | `asyncpg.create_pool` (the only connection, `src/db.py`) and `asyncpg.connect` | `uw-stream/conftest.py` forces fake `DATABASE_URL`, `KV_REST_API_URL` and `KV_REST_API_TOKEN` (config validates them at import; they were `setdefault`, so a real exported value won), and patches asyncpg's `connect`, `create_pool`, `connection.connect` and `pool.create_pool` session-wide to record and raise. A connect to a non-loopback address is recorded and raises too, copied from nightly's guard but recorded, so a path around those names fails as well. Per-test patches (`patch("db.asyncpg.create_pool", ...)`) override the stubs. | `uw-stream/tests/test_no_database_guard.py` |
| nightly | sockets | already forces fake env and blocks non-loopback sockets (`nightly/conftest.py`). Left alone. | exists |

The CI job `takeit-retrain` (`.github/workflows/ml-pipeline.yml`) is not a test, but it held `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` at job level. Each is now set only on the step that reads it.

## Env names stripped in every block

`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_PRISMA_URL`, `NEON_DATABASE_URL`, plus the writable remote stores `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `BLOB_READ_WRITE_TOKEN` and the `R2_*` credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL`, `R2_BUCKET_FULLTAPE`). A test that needs a value sets its own fake after the setup has run.

## Phases

- **A (pushable now, no Railway folder touched):** ml, root scripts, Vitest, Playwright, the workflow, the deleted live-DB test, and this doc.
- **B (push after 15:00 CT):** `sidecar/` and `uw-stream/` (conftest, self-test, and the two sidecar tests that set their own `DATABASE_URL`). They are Railway services; a push to them redeploys, which the market-hours hold forbids. The suites run locally in throwaway venvs outside the repo, built from each `requirements-dev.txt`; CI runs them as before (`make review` for sidecar, `pytest --cov=src` for uw-stream).

## Decisions

- `test_live_db_sum_invariant` was deleted, not skipped. Its check (stored lottery scores equal the component sum on 100 random rows) is kept as a manual, read-only script, `scripts/check_lottery_score_sum_invariant.py`, that says in its docstring that it reads production. Pytest does not collect it.
- A second Vitest layer that wraps `globalThis.fetch` to reject `*.neon.tech` was not added. Tests that stub fetch replace the wrapper, and every Neon client goes through the three mocked constructors anyway.
- Only database drivers are blocked in code. Redis, Blob and R2 are covered by stripping their env names; blocking their clients would be a separate change.

## Known gaps

- Python: constructing `psycopg2.extensions.connection(dsn)` directly bypasses `_connect`. Nothing in the repo does that.
- Vitest: a test file that mocks `@neondatabase/serverless` itself replaces the block, by design; its mock must not reach the network.
- The Python guards assume the drivers are imported as `psycopg2` / `asyncpg`. A new driver (psycopg 3, `pg8000`) needs its connect point added to `_CONNECT_POINTS`.

## Acceptance

- Each block's self-test provokes an attempt (`psycopg2.connect("postgresql://x@invalid.invalid/db")`, `neon("postgres://…")`, `asyncpg.create_pool`) and sees it raise and be recorded; the test then clears the record so the session-end check stays green.
- Mutation check per block: disable the block, see its self-test fail, restore.
- Suite counts are unchanged apart from the deleted test and the new self-tests.
