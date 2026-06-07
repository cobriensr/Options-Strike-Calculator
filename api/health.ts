/**
 * GET /api/health
 *
 * Unified health check endpoint that verifies connectivity to all
 * critical backing services: Postgres (Neon), Redis (Upstash), and
 * Schwab OAuth token validity.
 *
 * Returns 200 with service status or 503 if any service is unhealthy.
 *
 * **Public endpoint** — no auth guard so external monitors / uptime
 * checks can ping it. The response includes only `status` and
 * `latencyMs` per service. Internal error messages (which could leak
 * Schwab token state, Postgres connection strings, etc.) are logged
 * to Sentry but NOT surfaced in the response body. Audit 2026-05-19.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, withDbRetry } from './_lib/db.js';
import { getAccessToken } from './_lib/schwab.js';
import { redis } from './_lib/redis.js';
import { Sentry } from './_lib/sentry.js';

interface ServiceStatus {
  status: 'ok' | 'error';
  latencyMs?: number;
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

async function checkService(
  serviceName: string,
  fn: () => Promise<void>,
  timeoutMs = 5000,
): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await withTimeout(fn(), timeoutMs);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
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
    checkService('redis', async () => {
      await redis.ping();
    }),
    checkService('schwab', async () => {
      const tokenResult = await getAccessToken();
      if ('error' in tokenResult) throw new Error(tokenResult.error.message);
    }),
  ]);

  const results = { postgres, redis: redisStatus, schwab };

  const allHealthy = Object.values(results).every((s) => s.status === 'ok');
  const status = allHealthy ? 200 : 503;

  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({
    status: allHealthy ? 'healthy' : 'degraded',
    services: results,
    timestamp: new Date().toISOString(),
  });
}
