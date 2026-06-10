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
import { metrics, Sentry } from './sentry.js';
import { sendDbErrorResponse } from './transient-db-response.js';

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
 *   2. `scope.setTransactionName('<METHOD> <path>')` — readable transaction
 *      grouping in Sentry's performance dashboard.
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
 * `withRequestScope` preamble (Sentry isolation scope + transaction name
 * + `metrics.request`→`done` + 405 method check) PLUS the soft-degrade
 * catch that every Neon-reading endpoint would otherwise hand-roll.
 *
 * This is the one place the transient-vs-genuine error policy lives, so
 * reader endpoints stop copy-pasting `try/catch → sendDbErrorResponse`:
 *
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
 * The wrapper owns ONLY the method gate, instrumentation, and the
 * error-to-response mapping. The inner handler keeps full ownership of
 * its own concerns — auth guard (`guardOwnerOrGuestEndpoint` /
 * `guardOwnerEndpoint`), rate limiting, Zod 400s, 404 early returns — and
 * is responsible for calling `done({ status: 200 })` on the success path
 * before writing its JSON. The wrapper never touches auth or validation.
 *
 * Usage:
 * ```ts
 * export default withDbReader('/api/zero-gamma', 'zero_gamma',
 *   async (req, res, done) => {
 *     const guard = await guardOwnerOrGuestEndpoint(req, res, done);
 *     if (guard) return;          // handler owns its own early returns
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
 * @param handler The inner endpoint logic. Receives `(req, res, done)`.
 * @param opts.serverErrorBody Body returned on a genuine 500. Defaults to
 *   `{ error: 'Internal error' }`.
 */
export function withDbReader(
  path: string,
  label: string,
  handler: ScopedHandler,
  opts: { serverErrorBody?: Record<string, unknown> } = {},
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return withRequestScope('GET', path, async (req, res, done) => {
    try {
      await handler(req, res, done);
    } catch (err) {
      sendDbErrorResponse(res, err, {
        label,
        serverErrorBody: opts.serverErrorBody,
        done,
      });
    }
  });
}
