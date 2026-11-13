/**
 * The typed marker for a retry-exhausted transient Neon error.
 *
 * It lives in its own module so the cron wrapper (`withCronInstrumentation`,
 * which every cron imports) can classify an error with `instanceof` without
 * importing db.ts, which carries the Neon driver and the whole migration
 * list. db.ts re-exports it, so `import { TransientDbError } from
 * './db.js'` keeps working.
 *
 * `withDbRetry` (db.ts) is the only thrower: it wraps the last retryable
 * error once its retries ran out. Endpoints (`sendDbErrorResponse`) and the
 * cron wrapper both classify with `err instanceof TransientDbError`: a
 * warning plus a counter, no Sentry exception.
 *
 * Side effect of the split: a `vi.mock` factory for db.js that does not
 * export this class no longer breaks the wrapper's catch path.
 */
export class TransientDbError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TransientDbError';
    this.cause = cause;
  }
}
