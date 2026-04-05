/**
 * GET /api/system-status
 *
 * Unified system status: service health + data freshness + ML pipeline.
 * Extends /api/health with data-layer observability.
 *
 * Returns 200 if all services reachable, 503 if any service is down.
 * Data freshness is informational (stale data doesn't cause 503).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { redis, getAccessToken } from './_lib/schwab.js';

interface ServiceCheck {
  status: 'ok' | 'error';
  latencyMs: number;
  error?: string;
}

interface FreshnessCheck {
  table: string;
  latestRecord: string | null;
  ageMinutes: number | null;
  stale: boolean;
}

async function checkService(
  fn: () => Promise<void>,
  timeoutMs = 5000,
): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'error',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

function computeFreshness(
  table: string,
  latest: string | null,
  staleAfterMinutes: number,
): FreshnessCheck {
  if (!latest) {
    return { table, latestRecord: null, ageMinutes: null, stale: true };
  }
  const ageMs = Date.now() - new Date(latest).getTime();
  const ageMinutes = Math.round(ageMs / 60_000);
  return {
    table,
    latestRecord: latest,
    ageMinutes,
    stale: ageMinutes > staleAfterMinutes,
  };
}

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
) {
  const sql = getDb();

  // Service connectivity (parallel)
  const [postgres, redisStatus, schwab] = await Promise.all([
    checkService(async () => {
      await sql`SELECT 1`;
    }),
    checkService(async () => {
      await redis.ping();
    }),
    checkService(async () => {
      const result = await getAccessToken();
      if ('error' in result) throw new Error(result.error.message);
    }),
  ]);

  // Data freshness — one query per table using hardcoded SQL
  // Stale thresholds: intraday tables ~15 min, daily tables ~30 hours
  let freshness: FreshnessCheck[] = [];
  try {
    const [flow, spot, strike, darkpool, features, outcomes, findings] =
      await Promise.all([
        sql`SELECT MAX(timestamp) AS ts FROM flow_data`,
        sql`SELECT MAX(timestamp) AS ts FROM spot_exposures`,
        sql`SELECT MAX(timestamp) AS ts FROM strike_exposures`,
        sql`SELECT MAX(updated_at) AS ts FROM dark_pool_levels`,
        sql`SELECT MAX(created_at) AS ts FROM training_features`,
        sql`SELECT MAX(created_at) AS ts FROM outcomes`,
        sql`SELECT updated_at AS ts FROM ml_findings WHERE id = 1 LIMIT 1`,
      ]);

    freshness = [
      computeFreshness('flow_data', flow[0]?.ts as string, 15),
      computeFreshness('spot_exposures', spot[0]?.ts as string, 15),
      computeFreshness('strike_exposures', strike[0]?.ts as string, 15),
      computeFreshness('dark_pool_levels', darkpool[0]?.ts as string, 10),
      computeFreshness('training_features', features[0]?.ts as string, 1800),
      computeFreshness('outcomes', outcomes[0]?.ts as string, 1800),
      computeFreshness('ml_findings', findings[0]?.ts as string, 2880),
    ];
  } catch {
    // Tables may not exist yet — freshness section will be empty
  }

  // ML pipeline last run (from ml_findings singleton)
  let mlPipeline: { lastRun: string | null; ageHours: number | null } = {
    lastRun: null,
    ageHours: null,
  };
  const findingsEntry = freshness.find((f) => f.table === 'ml_findings');
  if (findingsEntry?.latestRecord) {
    const ts = new Date(findingsEntry.latestRecord);
    mlPipeline = {
      lastRun: ts.toISOString(),
      ageHours: Math.round((Date.now() - ts.getTime()) / 3_600_000),
    };
  }

  const services = { postgres, redis: redisStatus, schwab };
  const allServicesHealthy = Object.values(services).every(
    (s) => s.status === 'ok',
  );
  const staleCount = freshness.filter((f) => f.stale).length;

  res.setHeader('Cache-Control', 'no-store');
  return res.status(allServicesHealthy ? 200 : 503).json({
    status: allServicesHealthy ? 'healthy' : 'degraded',
    services,
    dataFreshness: {
      checks: freshness,
      staleCount,
      allFresh: staleCount === 0,
    },
    mlPipeline,
    timestamp: new Date().toISOString(),
  });
}
