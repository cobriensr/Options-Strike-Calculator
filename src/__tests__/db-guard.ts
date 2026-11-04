/**
 * The no-database guard for the Vitest suite (owner rule, 2026-11-04; spec
 * docs/superpowers/specs/tests-no-db-2026-11-04.md).
 *
 * No test may connect to or write to a real database. The one place the
 * app builds a Neon client is `neon()` in api/_lib/db.ts, so `setup.ts`
 * mocks `@neondatabase/serverless` for every test file with `neon`, `Pool`
 * and `Client` that call `blockDbAccess`. The block fires when the client is
 * built, before any query. In-process pglite stays allowed, and a test file
 * that mocks the package itself overrides the global mock.
 *
 * `safeDb` and similar best-effort wrappers swallow what their callback
 * throws, so a thrown block alone could still leave a green run. Every
 * attempt is therefore also recorded in `dbAttempts`. The `afterEach` in
 * `setup.ts` fails the test that made one, and its `afterAll` fails the file
 * for one made after the last test (in the file's own `afterAll`, or by work
 * still running then). A file whose tests are all skipped runs no hooks.
 *
 * Twin of the Python guards in ml/conftest.py and scripts/conftest.py.
 */

/** The message every block carries. */
export const BLOCK_MESSAGE = 'tests must not connect to a database';

/**
 * Every name a database client or a writable remote store reads. Tests that
 * need a value set their own fake (vi.stubEnv) after `setup.ts` has run.
 */
export const BLOCKED_ENV_NAMES = [
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_PRISMA_URL',
  'NEON_DATABASE_URL',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'BLOB_READ_WRITE_TOKEN',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT_URL',
  'R2_BUCKET_FULLTAPE',
] as const;

/**
 * Every attempt the mocked client constructors saw, in order. A self-test
 * that provokes one on purpose drops its own entries with `trackDbAttempts`.
 * Test-only module state: it lives for one test file and holds one entry per
 * attempt.
 */
export const dbAttempts: string[] = [];

/**
 * The attempts made since this call, for a self-test that provokes them on
 * purpose. `discard()` drops only those entries. Emptying the whole log would
 * also erase an earlier offender (an attempt a `beforeAll` swallowed), and the
 * check would then pass without naming it.
 */
export function trackDbAttempts(): {
  readonly made: string[];
  discard(): void;
} {
  const start = dbAttempts.length;
  return {
    get made() {
      return dbAttempts.slice(start);
    },
    discard() {
      dbAttempts.splice(start);
    },
  };
}

/** Delete the database and writable-store env names from `process.env`. */
export function scrubDbEnv(): void {
  for (const name of BLOCKED_ENV_NAMES) {
    delete process.env[name];
  }
}

/** Record an attempt and throw. The connection string is never echoed. */
export function blockDbAccess(kind: string): never {
  dbAttempts.push(kind);
  throw new Error(`${kind}: ${BLOCK_MESSAGE}`);
}

/**
 * Fail if any client was built since the last check, even when the caller
 * swallowed the thrown block. Clears the log first so one attempt fails one
 * test, not every later one.
 */
export function assertNoDbAttempts(): void {
  if (dbAttempts.length === 0) return;
  const kinds = dbAttempts.splice(0).join(', ');
  throw new Error(
    `${BLOCK_MESSAGE}; this test tried: ${kinds}. Mock the connection at ` +
      `the module boundary (vi.mock the db module, or use pglite).`,
  );
}
