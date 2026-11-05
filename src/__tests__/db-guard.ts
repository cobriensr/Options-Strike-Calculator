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
 * The production stores (Upstash Redis, Vercel Blob, Cloudflare R2) follow
 * the same design: `setup.ts` mocks each package with its network-calling
 * entry points replaced by `blockStoreAccess`, which records into the same
 * `dbAttempts` log, so the same checks catch a swallowed attempt. A read
 * reaches production as surely as a write, so reads are blocked too.
 *
 * Twin of the Python guards in ml/conftest.py and scripts/conftest.py.
 */

/** The message every database block carries. */
export const BLOCK_MESSAGE = 'tests must not connect to a database';

/** The message every store (Redis, Blob, R2) block carries. */
export const STORE_BLOCK_MESSAGE = 'tests must not reach a production store';

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
 * The kinds `blockStoreAccess` has recorded, so the check below can name the
 * store rule for them. A fixed, small set: one name per blocked entry point.
 */
const storeKinds = new Set<string>();

/** Record an attempt on a production store and throw. Nothing is echoed. */
export function blockStoreAccess(kind: string): never {
  storeKinds.add(kind);
  dbAttempts.push(kind);
  throw new Error(`${kind}: ${STORE_BLOCK_MESSAGE}`);
}

/**
 * Fail if any client was built or any store was called since the last check,
 * even when the caller swallowed the thrown block. Clears the log first so one
 * attempt fails one test, not every later one.
 */
export function assertNoDbAttempts(): void {
  if (dbAttempts.length === 0) return;
  const kinds = dbAttempts.splice(0);
  const rules = new Set(
    kinds.map((kind) =>
      storeKinds.has(kind) ? STORE_BLOCK_MESSAGE : BLOCK_MESSAGE,
    ),
  );
  throw new Error(
    `${[...rules].join('; ')}; this test tried: ${kinds.join(', ')}. Mock ` +
      `it at the module boundary (vi.mock the db, Redis, Blob or R2 module, ` +
      `or use pglite).`,
  );
}

/**
 * Block every S3 / Cloudflare R2 call at `S3Client.send`, which every command
 * goes through (the aggregated `S3` client extends `S3Client`). Reads and
 * writes alike: `send` is the one place the request leaves the process.
 */
export function blockS3Sends(S3Client: {
  prototype: { send: (...args: never[]) => unknown };
}): void {
  S3Client.prototype.send = async () => blockStoreAccess('s3');
}

/**
 * Every function `@vercel/blob` exports that calls the Blob API: the reads
 * (`get`, `head`, `list`), the writes and the signing calls. They are plain
 * functions with no shared client to patch, so the mocked package replaces
 * each by name. The self-test compares this list and `PURE_BLOB_EXPORTS`
 * against the installed package, so an export added by an upgrade fails it
 * instead of slipping through.
 */
export const BLOCKED_BLOB_EXPORTS = [
  'completeMultipartUpload',
  'copy',
  'createFolder',
  'createMultipartUpload',
  'createMultipartUploader',
  'del',
  'get',
  'head',
  'issueSignedToken',
  'list',
  'presignUrl',
  'put',
  'uploadPart',
] as const;

/** Blob exports that compute locally and never call the API. */
export const PURE_BLOB_EXPORTS = [
  'getDownloadUrl',
  'parseStoreIdFromDelegationToken',
  'parseStoreIdFromPresignedUrl',
] as const;

/**
 * The real `@vercel/blob` module with `BLOCKED_BLOB_EXPORTS` replaced by
 * functions that record and reject. Everything else survives, the error
 * classes included, since production code branches on `instanceof`.
 */
export function blockBlobExports<T extends object>(actual: T): T {
  const blocked = Object.fromEntries(
    BLOCKED_BLOB_EXPORTS.map((name) => [
      name,
      async () => blockStoreAccess(`blob.${name}`),
    ]),
  );
  return { ...actual, ...blocked };
}

/**
 * The fetch this file saw at load, which `setup.ts` imports before any test
 * code runs. A Redis request is let through only when a test has replaced
 * `globalThis.fetch` with its own double.
 */
const realFetch = globalThis.fetch;

interface RedisHttpClient {
  request(req: unknown): Promise<unknown>;
}

/**
 * Block every Upstash Redis command at the HTTP client's `request`, the one
 * method that all commands, pipelines and the auto-pipeline funnel through
 * (it calls the global `fetch`). The class is not exported by the package, so
 * its prototype is reached from a throwaway client, which opens no
 * connection. A test that stubbed `fetch` gets its stub, since that cannot
 * reach the store.
 */
export function blockRedisRequests(
  Redis: new (config: { url: string; token: string }) => unknown,
): void {
  const { client } = new Redis({
    url: 'https://redis.invalid',
    token: 'x',
  }) as {
    client: RedisHttpClient;
  };
  const proto = Object.getPrototypeOf(client) as RedisHttpClient;
  const real = proto.request;
  proto.request = async function (this: RedisHttpClient, req) {
    if (globalThis.fetch === realFetch) blockStoreAccess('redis');
    return real.call(this, req);
  };
}
