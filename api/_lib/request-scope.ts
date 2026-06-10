/**
 * withRequestScope — endpoint preamble HOF.
 *
 * Wraps the Sentry isolation scope + transaction-name + metrics.request
 * + 405 method-check pattern that 7+ data endpoints in this repo
 * (`gex-target-history.ts`, `whale-positioning.ts`, `top-strikes.ts`,
 * etc.) repeat at the top of every default handler.
 *
 * Adoption is staged — see Phase 5l in
 * docs/superpowers/specs/api-refactor-2026-05-02.md. This module is
 * greenfield; no consumer migrates here.
 *
 * Phase 1f of the refactor.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerEndpoint } from './auth-helpers.js';
import { guardOwnerOrGuestEndpoint } from './guest-auth.js';
import { metrics, Sentry } from './sentry.js';
import { sendDbErrorResponse } from './transient-db-response.js';

/**
 * Auth mode for a `withDbReader` endpoint. Required (3rd positional) so a
 * route's auth posture is impossible to forget:
 *   - `'owner'`         → `guardOwnerEndpoint` (owner cookie + bot check).
 *   - `'owner-or-guest'`→ `guardOwnerOrGuestEndpoint` (owner OR guest key).
 *   - `'public'`        → no guard (e.g. plot listings with no private data).
 */
export type DbReaderAuth = 'owner' | 'owner-or-guest' | 'public';

/**
 * Tracking handle returned by `metrics.request` for status/duration
 * recording. The wrapper hands this to the caller so the inner handler
 * can call `done({ status, error })` mid-flight (e.g. for 401/403/422
 * rejections from validation), and the wrapper also calls it on the
 * synthetic 405 path.
 */
export type RequestDone = (opts?: { status?: number; error?: string }) => void;

/**
 * Inner handler signature. Receives the standard req/res plus a `done`
 * callback for status reporting. Returning a truthy value signals "I
 * already responded" — the wrapper will not call `done()` again.
 *
 * Most callers will end with `res.status(...).json(...); done({ status })`
 * — same shape they use today.
 */
export type ScopedHandler = (
  req: VercelRequest,
  res: VercelResponse,
  done: RequestDone,
) => Promise<unknown>;

/**
 * Wrap an endpoint handler with the standard preamble.
 *
 *   1. `Sentry.withIsolationScope` — every request gets its own scope
 *      so tags / extra data don't leak across concurrent invocations.
 *   2. `scope.setTransactionName('<METHOD> <path>')` + `scope.setTag(
 *      'endpoint', path)` — readable transaction grouping plus a per-route
 *      tag for filtering in Sentry's performance dashboard.
 *   3. `metrics.request(path)` — counter + duration distribution, exposed
 *      to the inner handler as `done` for granular status tagging.
 *   4. 405 method check — short-circuits non-matching method with a
 *      JSON body and the appropriate `done({ status: 405 })` call.
 *
 * The HOF intentionally does NOT layer on auth, rate limiting, or
 * validation — those concerns are too endpoint-specific. Callers chain
 * `guardOwnerOrGuestEndpoint` / `rejectIfRateLimited` / Zod parsing
 * inside the inner handler exactly as today.
 */
export function withRequestScope(
  method: 'GET' | 'POST',
  path: string,
  handler: ScopedHandler,
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return async function scopedHandler(
    req: VercelRequest,
    res: VercelResponse,
  ): Promise<void> {
    return Sentry.withIsolationScope(async (scope) => {
      scope.setTransactionName(`${method} ${path}`);
      scope.setTag('endpoint', path);
      const done = metrics.request(path);

      if (req.method !== method) {
        done({ status: 405 });
        res.status(405).json({ error: `${method} only` });
        return;
      }

      await handler(req, res, done);
    });
  };
}

/**
 * Wrap a GET reader endpoint with the full standard envelope: the
 * `withRequestScope` preamble (Sentry isolation scope + transaction name +
 * `endpoint` tag + `metrics.request`→`done` + 405 method check), the
 * declared auth guard, AND the soft-degrade catch that every Neon-reading
 * endpoint would otherwise hand-roll.
 *
 * **Use this for any new GET reader endpoint** (single-JSON, 405-gated)
 * instead of hand-rolling the scope/metrics/405/auth/try-catch preamble.
 *
 * Auth is a REQUIRED parameter (`auth`, 3rd positional). The wrapper runs
 * the matching guard BEFORE the handler, so a route's auth posture cannot
 * be forgotten — there is no path where the handler runs without the
 * declared guard having passed first (no accidental public data exposure):
 *
 *   - `'owner'`          → `guardOwnerEndpoint`.
 *   - `'owner-or-guest'` → `guardOwnerOrGuestEndpoint`.
 *   - `'public'`         → no guard.
 *
 * If the guard rejects (401/403), it has already written the response and
 * recorded `done`, so the wrapper returns without running the handler.
 *
 * The guard runs INSIDE the wrapper's `try`. This is intentional: a guard
 * or rate-limit failure (e.g. an Upstash Redis blip or a `checkBot`
 * network error throwing) now soft-degrades through `sendDbErrorResponse`
 * (Sentry-captured, with the endpoint's `serverErrorBody`) rather than
 * escaping as a bare uncaught `500`. The DB-flavored body on a non-DB
 * guard failure is an accepted trade for uniform capture.
 *
 * `done` is wrapped in a once-latch (`finalized`). `done` is NOT
 * idempotent — each call emits a fresh metric — so a handler that calls
 * `done({ status: 200 })` and then throws would otherwise double-record
 * (200 then 500). The latch makes the FIRST call win: the catch's
 * `sendDbErrorResponse` still sends its 500 response but its `done` is a
 * no-op, leaving a single recorded status.
 *
 * The transient-vs-genuine error policy (the one place it lives):
 *   - A transient Neon blip (`TransientDbError` — `db attempt timeout`,
 *     `fetch failed`, `recovery_mode`, …) degrades to a soft `503` with a
 *     `Retry-After: 5` header and body `{ error: 'temporarily
 *     unavailable', transient: true }`. It is logged at `warn`, increments
 *     `<label>.db_timeout`, and is NOT sent to Sentry (infra noise).
 *   - Any genuine error degrades to `500` with `opts.serverErrorBody`
 *     (default `{ error: 'Internal error' }`), logged at `error` and
 *     captured in Sentry.
 *   - Both paths record the real status through `done` so the request
 *     metric matches the response (`503` / `500`, never a guessed status).
 *
 * The inner handler keeps ownership of the rest of its concerns — rate
 * limiting, Zod 400s, 404 early returns — and is responsible for calling
 * `done({ status: 200 })` on the success path before writing its JSON.
 *
 * Usage:
 * ```ts
 * export default withDbReader('/api/zero-gamma', 'zero_gamma', 'owner-or-guest',
 *   async (req, res, done) => {
 *     // guard already ran in the wrapper — no auth line here
 *     // ...zod 400s, 404s, query...
 *     done({ status: 200 });
 *     res.status(200).json(payload);
 *   },
 * );
 * ```
 *
 * @param path  Route path, e.g. `/api/zero-gamma` — used for the Sentry
 *   transaction name and the `metrics.request` key.
 * @param label Telemetry label, e.g. `zero_gamma` — used in the log
 *   message and the `<label>.db_timeout` counter on a transient blip.
 * @param auth  REQUIRED auth mode — the wrapper runs the matching guard
 *   before the handler. `'owner'` | `'owner-or-guest'` | `'public'`.
 * @param handler The inner endpoint logic. Receives `(req, res, done)`.
 * @param opts.serverErrorBody Body returned on a genuine 500. Defaults to
 *   `{ error: 'Internal error' }`.
 */
export function withDbReader(
  path: string,
  label: string,
  auth: DbReaderAuth,
  handler: ScopedHandler,
  opts: { serverErrorBody?: Record<string, unknown> } = {},
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return withRequestScope('GET', path, async (req, res, done) => {
    // Latch: done() is not idempotent (each call emits a fresh metric). A
    // throw after a handler's done({status:200}) would otherwise
    // double-record. First call wins.
    let finalized = false;
    const onceDone: RequestDone = (o) => {
      if (finalized) return;
      finalized = true;
      done(o);
    };
    try {
      if (auth !== 'public') {
        const guard =
          auth === 'owner' ? guardOwnerEndpoint : guardOwnerOrGuestEndpoint;
        if (await guard(req, res, onceDone)) return; // guard sent 401/403
      }
      await handler(req, res, onceDone);
    } catch (err) {
      sendDbErrorResponse(res, err, {
        label,
        serverErrorBody: opts.serverErrorBody,
        done: onceDone,
      });
    }
  });
}
