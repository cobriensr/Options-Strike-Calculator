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
 * The network block (`net-guard.ts`, 2026-11-13) is the layer under all of
 * them: any connection to a host outside this machine, from any client, is
 * recorded here as `net.connect <host>:<port>` and fails. It also catches what
 * the package mocks cannot: a raw `fetch` to a Blob, Upstash or R2 URL, or an
 * API call no mock covers.
 *
 * Twin of the Python guards in ml/conftest.py and scripts/conftest.py.
 */

/** The message every database block carries. */
export const BLOCK_MESSAGE = 'tests must not connect to a database';

/** The message every store (Redis, Blob, R2) block carries. */
export const STORE_BLOCK_MESSAGE = 'tests must not reach a production store';

/** The message every network block carries (see `net-guard.ts`). */
export const NETWORK_BLOCK_MESSAGE = 'tests must not open a network connection';

/**
 * What a network attempt's kind starts with: `net.connect <host>:<port>`. The
 * hosts are open-ended, so `assertNoDbAttempts` recognizes the kind by this
 * prefix instead of listing each one in `state.storeKinds`.
 */
export const NETWORK_ATTEMPT_PREFIX = 'net.connect ';

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
 * The attempts log and the store kinds, held on `globalThis` so that every
 * instance of this module shares them. The `setup.ts` mock factories import
 * this module, and `vi.resetModules()` makes the next factory run build a new
 * instance; module-level arrays would then split in two, and the `afterEach`
 * check would read one while the block wrote to the other, losing a swallowed
 * attempt. `??=` keeps the first instance's state. Test-only state: it lives
 * for one test file and holds one entry per attempt.
 */
interface GuardState {
  attempts: string[];
  storeKinds: Set<string>;
}

const GUARD_STATE = Symbol.for('strike-calculator.test-db-guard');

const state = ((globalThis as { [GUARD_STATE]?: GuardState })[GUARD_STATE] ??= {
  attempts: [],
  storeKinds: new Set(),
});

/**
 * Every attempt the mocked clients saw, in order. A self-test that provokes
 * one on purpose drops its own entries with `trackDbAttempts`.
 */
export const dbAttempts: string[] = state.attempts;

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

/**
 * Record an attempt without throwing, for a block that fails the call some
 * other way (the network block destroys the socket on the next tick). The
 * `afterEach` check still fails the test, whatever the caller does with the
 * failure. Nothing but the kind is kept.
 */
export function recordBlockedAttempt(kind: string): void {
  dbAttempts.push(kind);
}

/** Record an attempt and throw. The connection string is never echoed. */
export function blockDbAccess(kind: string): never {
  recordBlockedAttempt(kind);
  throw new Error(`${kind}: ${BLOCK_MESSAGE}`);
}

/**
 * Record an attempt on a production store and throw. Nothing is echoed. The
 * kind goes into `state.storeKinds` (a fixed, small set: one name per blocked
 * entry point) so the check below can name the store rule for it.
 */
export function blockStoreAccess(kind: string): never {
  state.storeKinds.add(kind);
  recordBlockedAttempt(kind);
  throw new Error(`${kind}: ${STORE_BLOCK_MESSAGE}`);
}

/** The rule an attempt of this kind broke. */
function ruleFor(kind: string): string {
  if (kind.startsWith(NETWORK_ATTEMPT_PREFIX)) return NETWORK_BLOCK_MESSAGE;
  if (state.storeKinds.has(kind)) return STORE_BLOCK_MESSAGE;
  return BLOCK_MESSAGE;
}

/**
 * The kinds in first-seen order, each once. One that repeated carries its
 * count, so a test that made the same request five times reads as one line.
 */
function summarize(kinds: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, n]) => (n > 1 ? `${kind} (x${n})` : kind))
    .join(', ');
}

/**
 * Fail if any client was built, any store was called or any connection was
 * opened since the last check, even when the caller swallowed the failure.
 * Clears the log first so one attempt fails one test, not every later one.
 */
export function assertNoDbAttempts(): void {
  if (dbAttempts.length === 0) return;
  const kinds = dbAttempts.splice(0);
  const rules = new Set(kinds.map(ruleFor));
  throw new Error(
    `${[...rules].join('; ')}; this test tried: ${summarize(kinds)}. Mock it ` +
      `at the module boundary (vi.mock the db, Redis, Blob, R2 or API client ` +
      `module, stub fetch for an HTTP call, or use pglite).`,
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
 * each by name. The self-test classifies every export of the installed
 * package as blocked, pure or an error class (the three lists below), so an
 * export added by an upgrade fails it instead of slipping through.
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
 * The error classes `@vercel/blob` exports. Production code branches on
 * `instanceof`, so they stay real.
 */
export const BLOB_ERROR_CLASSES = [
  'BlobAccessError',
  'BlobClientTokenExpiredError',
  'BlobContentTypeNotAllowedError',
  'BlobError',
  'BlobFileTooLargeError',
  'BlobNotFoundError',
  'BlobPathnameMismatchError',
  'BlobPreconditionFailedError',
  'BlobRequestAbortedError',
  'BlobServiceNotAvailable',
  'BlobServiceRateLimited',
  'BlobStoreNotFoundError',
  'BlobStoreSuspendedError',
  'BlobUnknownError',
] as const;

/**
 * The same, for the separate `@vercel/blob/client` entry point (browser
 * uploads). Nothing imports it today. The upload functions call the API with
 * a client token, so they are blocked like the server ones.
 */
export const BLOCKED_BLOB_CLIENT_EXPORTS = [
  'completeMultipartUpload',
  'createFolder',
  'createMultipartUpload',
  'createMultipartUploader',
  'put',
  'upload',
  'uploadPart',
  'uploadPresigned',
] as const;

/**
 * Client-entry exports that only sign or verify locally: the two token
 * helpers, and the two route handlers, which generate a token or verify a
 * callback signature and call the API in neither case.
 */
export const PURE_BLOB_CLIENT_EXPORTS = [
  'generateClientTokenFromReadWriteToken',
  'getPayloadFromClientToken',
  'handleUpload',
  'handleUploadPresigned',
] as const;

/** Replace the named exports of a module with record-and-reject functions. */
function blockNamedExports<T extends object>(
  actual: T,
  names: readonly string[],
  prefix: string,
): T {
  const blocked = Object.fromEntries(
    names.map((name) => [
      name,
      async () => blockStoreAccess(`${prefix}.${name}`),
    ]),
  );
  return { ...actual, ...blocked };
}

/**
 * The real `@vercel/blob` module with `BLOCKED_BLOB_EXPORTS` replaced by
 * functions that record (as `blob.<name>`) and reject. Everything else
 * survives, the error classes included, since production code branches on
 * `instanceof`.
 */
export function blockBlobExports<T extends object>(actual: T): T {
  return blockNamedExports(actual, BLOCKED_BLOB_EXPORTS, 'blob');
}

/** The same for `@vercel/blob/client`; attempts record as `blob.client.<name>`. */
export function blockBlobClientExports<T extends object>(actual: T): T {
  return blockNamedExports(actual, BLOCKED_BLOB_CLIENT_EXPORTS, 'blob.client');
}

interface RedisHttpClient {
  request(req: unknown): Promise<unknown>;
}

/**
 * Block every Upstash Redis command at the HTTP client's `request`, the one
 * method that all commands, pipelines and the auto-pipeline funnel through
 * (it calls the global `fetch`). The class is not exported by the package, so
 * its prototype is reached from a throwaway client, which opens no
 * connection. The block is unconditional: a `fetch` stub, spy or wrapper is
 * not a reliable sign that the request stays in the process (a call-through
 * spy reaches the store). A test that builds a real client against its own
 * `fetch` double opts out per file, with
 * `vi.mock('@upstash/redis', (importOriginal) => importOriginal())`.
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
  proto.request = async () => blockStoreAccess('redis');
}
