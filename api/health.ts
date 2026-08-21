/**
 * GET /api/health
 *
 * Unified health check endpoint that verifies connectivity to all
 * critical backing services: Postgres (Neon), Redis (Upstash), and
 * Schwab OAuth token validity.
 *
 * Per-service status is `ok`, `degraded`, or `error`:
 *   - `error`    — the service is unreachable / misconfigured / failing.
 *   - `degraded` — reachable but impaired in a way the app tolerates. Today
 *                  that is exactly one case: Upstash rejecting commands with
 *                  its over-quota error (`reason: 'quota_exceeded'`). Every
 *                  Redis path in the app fails open or degrades to a cache
 *                  miss under quota, so the app is still serving — but the
 *                  operator needs to see it distinctly from "Redis is down".
 *
 * Overall rule:
 *   - all `ok`                         → 200 `healthy`
 *   - some `degraded`, nothing `error` → 200 `degraded` (app is up; the body
 *                                        carries the detail — a 503 here
 *                                        would page "down" for a billing
 *                                        condition)
 *   - any `error`                      → 503 `degraded` (unchanged contract
 *                                        for the daily cron + uptime probes)
 *
 * **Public endpoint** — no auth guard so external monitors / uptime
 * checks can ping it. The response includes only `status`, `latencyMs`
 * and (for degraded) a fixed `reason` code per service. Internal error
 * messages (which could leak Schwab token state, Postgres connection
 * strings, etc.) are logged to Sentry but NOT surfaced in the response
 * body. Audit 2026-05-19.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, withDbRetry } from './_lib/db.js';
import { getAccessToken } from './_lib/schwab.js';
import { redis, isQuotaError, recordRedisError } from './_lib/redis.js';
import { Sentry } from './_lib/sentry.js';

interface ServiceStatus {
  status: 'ok' | 'degraded' | 'error';
  latencyMs?: number;
  /** Fixed machine-readable code, only present when `status === 'degraded'`. */
  reason?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Health check timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

interface CheckOptions {
  timeoutMs?: number;
  /**
   * Classify a failure as merely degraded: return a short reason code to
   * report `status: 'degraded'` (no Sentry capture — the condition is
   * expected to be already counted/warned by the subsystem), or `null` to
   * treat it as a genuine error.
   */
  degradedReason?: (err: unknown) => string | null;
}

async function checkService(
  serviceName: string,
  fn: () => Promise<void>,
  opts: CheckOptions = {},
): Promise<ServiceStatus> {
  const { timeoutMs = 5000, degradedReason } = opts;
  const start = Date.now();
  try {
    await withTimeout(fn(), timeoutMs);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    const reason = degradedReason?.(err) ?? null;
    if (reason !== null) {
      return { status: 'degraded', reason, latencyMs: Date.now() - start };
    }
    // Capture the actual error to Sentry for internal triage. The
    // response intentionally omits the message — exposing it to
    // unauthenticated callers could leak Schwab token state, DB
    // connection details, etc.
    Sentry.captureException(err, {
      level: 'warning',
      tags: { route: '/api/health', service: serviceName },
    });
    return { status: 'error', latencyMs: Date.now() - start };
  }
}

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
) {
  const [postgres, redisStatus, schwab] = await Promise.all([
    checkService('postgres', async () => {
      const sql = getDb();
      await withDbRetry(() => sql`SELECT 1`, 2, 10_000);
    }),
    checkService(
      'redis',
      async () => {
        try {
          await redis.ping();
        } catch (err) {
          // Route through the shared classifier so the probe lands in the
          // same `redis.error` / `redis.quota_exceeded` counters (and the
          // once-per-process quota warn) as every other Redis call.
          recordRedisError(err);
          throw err;
        }
      },
      {
        degradedReason: (err) => (isQuotaError(err) ? 'quota_exceeded' : null),
      },
    ),
    checkService('schwab', async () => {
      const tokenResult = await getAccessToken();
      if ('error' in tokenResult) throw new Error(tokenResult.error.message);
    }),
  ]);

  const results = { postgres, redis: redisStatus, schwab };
  const statuses = Object.values(results).map((s) => s.status);

  const anyError = statuses.includes('error');
  const allHealthy = statuses.every((s) => s === 'ok');
  const httpStatus = anyError ? 503 : 200;

  res.setHeader('Cache-Control', 'no-store');
  return res.status(httpStatus).json({
    status: allHealthy ? 'healthy' : 'degraded',
    services: results,
    timestamp: new Date().toISOString(),
  });
}
