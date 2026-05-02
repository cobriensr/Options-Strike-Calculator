/**
 * withRequestScope — endpoint preamble HOF.
 *
 * Wraps the Sentry isolation scope + transaction-name + metrics.request
 * + 405 method-check pattern that 7+ data endpoints in this repo
 * (`gex-target-history.ts`, `gamma-squeezes.ts`, `whale-positioning.ts`,
 * `top-strikes.ts`, etc.) repeat at the top of every default handler.
 *
 * Adoption is staged — see Phase 5l in
 * docs/superpowers/specs/api-refactor-2026-05-02.md. This module is
 * greenfield; no consumer migrates here.
 *
 * Phase 1f of the refactor.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { metrics, Sentry } from './sentry.js';

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
