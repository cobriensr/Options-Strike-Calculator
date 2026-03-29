/**
 * GET /api/health
 *
 * Unified health check endpoint that verifies connectivity to all
 * critical backing services: Postgres (Neon), Redis (Upstash), and
 * Schwab OAuth token validity.
 *
 * Returns 200 with service status or 503 if any service is unhealthy.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { redis, getAccessToken } from './_lib/schwab.js';

interface ServiceStatus {
  status: 'ok' | 'error';
  latencyMs?: number;
  error?: string;
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
  fn: () => Promise<void>,
  timeoutMs = 5000,
): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await withTimeout(fn(), timeoutMs);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'error',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
) {
  const [postgres, redisStatus, schwab] = await Promise.all([
    checkService(async () => {
      const sql = getDb();
      await sql`SELECT 1`;
    }),
    checkService(async () => {
      await redis.ping();
    }),
    checkService(async () => {
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
