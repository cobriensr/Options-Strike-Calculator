/**
 * The typed marker for a retry-exhausted transient Neon error.
 *
 * `withDbRetry` (db.ts) is the only thrower: it wraps the last retryable
 * error once its retries ran out. Endpoints (`sendDbErrorResponse`) and the
 * cron wrapper (`withCronInstrumentation`) both classify with
 * `err instanceof TransientDbError`: a warning plus a counter, no Sentry
 * exception. db.ts re-exports it, so `import { TransientDbError } from
 * './db.js'` keeps working.
 *
 * It lives in its own module because the cron wrapper, which every cron
 * imports, needs only this class, not the Neon driver and the migration
 * list that db.ts loads. It also keeps the class check working when a test
 * replaces db.js wholesale with a `vi.mock` factory that exports `getDb`
 * and friends but not the class.
 */
export class TransientDbError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TransientDbError';
    this.cause = cause;
  }
}
