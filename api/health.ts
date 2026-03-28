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

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
) {
  const results: Record<string, ServiceStatus> = {};

  // Check Postgres
  const dbStart = Date.now();
  try {
    const sql = getDb();
    await sql`SELECT 1`;
    results.postgres = { status: 'ok', latencyMs: Date.now() - dbStart };
  } catch (err) {
    results.postgres = {
      status: 'error',
      latencyMs: Date.now() - dbStart,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Check Redis
  const redisStart = Date.now();
  try {
    await redis.ping();
    results.redis = { status: 'ok', latencyMs: Date.now() - redisStart };
  } catch (err) {
    results.redis = {
      status: 'error',
      latencyMs: Date.now() - redisStart,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Check Schwab token validity (non-blocking — just reports status)
  const schwabStart = Date.now();
  try {
    const tokenResult = await getAccessToken();
    if ('error' in tokenResult) {
      results.schwab = {
        status: 'error',
        latencyMs: Date.now() - schwabStart,
        error: tokenResult.error.message,
      };
    } else {
      results.schwab = { status: 'ok', latencyMs: Date.now() - schwabStart };
    }
  } catch (err) {
    results.schwab = {
      status: 'error',
      latencyMs: Date.now() - schwabStart,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  const allHealthy = Object.values(results).every((s) => s.status === 'ok');
  const status = allHealthy ? 200 : 503;

  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({
    status: allHealthy ? 'healthy' : 'degraded',
    services: results,
    timestamp: new Date().toISOString(),
  });
}
