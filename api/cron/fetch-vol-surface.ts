/**
 * GET /api/cron/fetch-vol-surface
 *
 * Fetches SPX volatility surface data from three Unusual Whales endpoints:
 *   1. /stock/SPX/volatility/term-structure — ATM IV curve by expiry
 *   2. /stock/SPX/volatility/realized — 30D IV vs RV comparison
 *   3. /stock/SPX/iv-rank — IV rank (1-year percentile)
 *
 * Stores in vol_term_structure and vol_realized tables.
 * Runs daily post-close before build-features.
 *
 * Total API calls per invocation: 3
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { uwFetch, cronGuard, withRetry } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';

// ── Types ───────────────────────────────────────────────────

interface TermStructureRow {
  date: string;
  dte: number | string;
  days?: number | string;
  volatility: string;
  implied_move_perc?: string;
  implied_move?: string;
}

interface RealizedVolRow {
  date: string;
  implied_volatility: string;
  realized_volatility: string;
}

interface IvRankRow {
  date: string;
  iv_rank?: string;
  iv_rank_1y?: string;
}

// ── Fetch helpers ───────────────────────────────────────────

async function fetchTermStructure(apiKey: string): Promise<TermStructureRow[]> {
  return uwFetch<TermStructureRow>(
    apiKey,
    '/stock/SPX/volatility/term-structure',
  );
}

async function fetchRealizedVol(apiKey: string): Promise<RealizedVolRow[]> {
  return uwFetch<RealizedVolRow>(apiKey, '/stock/SPX/volatility/realized');
}

async function fetchIvRank(apiKey: string): Promise<IvRankRow[]> {
  return uwFetch<IvRankRow>(apiKey, '/stock/SPX/iv-rank');
}

// ── Store helpers ───────────────────────────────────────────

async function storeTermStructure(
  rows: TermStructureRow[],
  today: string,
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const row of rows) {
    const days = Number.parseInt(String(row.dte ?? row.days), 10);
    if (Number.isNaN(days)) continue;

    const volatility = Number.parseFloat(String(row.volatility)) || 0;
    const impliedMove =
      Number.parseFloat(
        String(row.implied_move_perc ?? row.implied_move ?? ''),
      ) || null;

    const result = await sql`
      INSERT INTO vol_term_structure (date, days, volatility, implied_move)
      VALUES (${today}, ${days}, ${volatility}, ${impliedMove})
      ON CONFLICT (date, days) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) stored++;
    else skipped++;
  }

  return { stored, skipped };
}

async function storeRealizedVol(
  rvRows: RealizedVolRow[],
  ivRankRows: IvRankRow[],
  today: string,
): Promise<boolean> {
  if (rvRows.length === 0) return false;

  const sql = getDb();

  // Take the latest realized vol entry
  const latestRv = rvRows.at(-1)!;
  const iv30d = Number.parseFloat(String(latestRv.implied_volatility)) || null;
  const rv30d = Number.parseFloat(String(latestRv.realized_volatility)) || null;

  // Compute derived metrics
  const ivRvSpread = iv30d !== null && rv30d !== null ? iv30d - rv30d : null;
  const ivOverpricingPct =
    iv30d !== null && rv30d !== null && rv30d !== 0
      ? ((iv30d - rv30d) / rv30d) * 100
      : null;

  // Take the latest IV rank entry
  const latestIvRank = ivRankRows.length > 0 ? ivRankRows.at(-1) : null;
  const ivRank = latestIvRank
    ? Number.parseFloat(
        String(latestIvRank.iv_rank_1y ?? latestIvRank.iv_rank ?? ''),
      ) || null
    : null;

  await sql`
    INSERT INTO vol_realized (
      date, iv_30d, rv_30d, iv_rv_spread,
      iv_overpricing_pct, iv_rank
    )
    VALUES (
      ${today}, ${iv30d}, ${rv30d}, ${ivRvSpread},
      ${ivOverpricingPct}, ${ivRank}
    )
    ON CONFLICT (date) DO UPDATE SET
      iv_30d             = EXCLUDED.iv_30d,
      rv_30d             = EXCLUDED.rv_30d,
      iv_rv_spread       = EXCLUDED.iv_rv_spread,
      iv_overpricing_pct = EXCLUDED.iv_overpricing_pct,
      iv_rank            = EXCLUDED.iv_rank
  `;

  return true;
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, { marketHours: false });
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    // Skip if data already exists for today
    const sql = getDb();
    const existing = await sql`
      SELECT COUNT(*)::int AS cnt
      FROM vol_term_structure
      WHERE date = ${today}
    `;
    const existingCount = (existing[0]?.cnt as number) ?? 0;
    if (existingCount > 0) {
      return res.status(200).json({
        skipped: true,
        reason: `Data already exists for ${today} (${existingCount} rows)`,
      });
    }

    // Fetch all three endpoints in parallel
    const [tsRows, rvRows, ivRankRows] = await Promise.all([
      withRetry(() => fetchTermStructure(apiKey)),
      withRetry(() => fetchRealizedVol(apiKey)),
      withRetry(() => fetchIvRank(apiKey)),
    ]);

    // Store term structure
    const tsResult = await storeTermStructure(tsRows, today);

    // Store realized vol + IV rank
    const rvStored = await storeRealizedVol(rvRows, ivRankRows, today);

    logger.info(
      {
        date: today,
        termStructure: tsResult,
        realizedVol: rvStored,
        rawCounts: {
          tsRows: tsRows.length,
          rvRows: rvRows.length,
          ivRankRows: ivRankRows.length,
        },
      },
      'fetch-vol-surface completed',
    );

    const durationMs = Date.now() - startTime;

    await reportCronRun('fetch-vol-surface', {
      status: 'ok',
      date: today,
      termStructureStored: tsResult.stored,
      termStructureSkipped: tsResult.skipped,
      realizedVol: rvStored,
      rawCounts: {
        tsRows: tsRows.length,
        rvRows: rvRows.length,
        ivRankRows: ivRankRows.length,
      },
      durationMs,
    });

    return res.status(200).json({
      job: 'fetch-vol-surface',
      date: today,
      termStructure: tsResult,
      realizedVol: rvStored,
      rawCounts: {
        tsRows: tsRows.length,
        rvRows: rvRows.length,
        ivRankRows: ivRankRows.length,
      },
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-vol-surface');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-vol-surface error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
