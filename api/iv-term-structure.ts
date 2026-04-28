/**
 * GET /api/iv-term-structure
 *
 * Fetches interpolated IV term structure for SPX from Unusual Whales.
 * Returns the full term structure (0DTE through 30DTE) including
 * implied move percentages and 1y percentile rankings.
 *
 * Called on-demand at analysis time — not a cron job.
 * Owner-or-guest (uses Schwab session cookie).
 *
 * Environment: UW_API_KEY
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guardOwnerOrGuestEndpoint,
  rejectIfRateLimited,
} from './_lib/api-helpers.js';
import logger from './_lib/logger.js';
import { getETDateStr } from '../src/utils/timezone.js';

const UW_BASE = 'https://api.unusualwhales.com/api';

export interface IvTermRow {
  date: string;
  days: number;
  implied_move_perc: string;
  percentile: string;
  volatility: string;
}

interface UwIvResponse {
  data: IvTermRow[];
}

async function fetchInterpolatedIv(
  apiKey: string,
  date: string,
): Promise<IvTermRow[]> {
  const res = await fetch(`${UW_BASE}/stock/SPX/interpolated-iv?date=${date}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res
      .text()
      .catch((e) => `[parse error: ${(e as Error).message}]`);
    throw new Error(`UW API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body: UwIvResponse = await res.json();
  return body.data ?? [];
}

/**
 * Format IV term structure for Claude context injection.
 *
 * Outputs a table with DTE, annualized IV, implied move %, and 1y percentile.
 * Highlights the 0DTE row as the direct calibration check against VIX1D-derived σ.
 */
export function formatIvTermStructureForClaude(
  rows: IvTermRow[],
  calculatorSigma?: string | null,
): string | null {
  if (!rows.length) return null;

  const sorted = [...rows].sort((a, b) => a.days - b.days);

  const lines: string[] = [
    '| DTE | Ann. IV | Implied Move | 1y Percentile |',
    '|----:|--------:|-------------:|--------------:|',
  ];

  for (const r of sorted) {
    const move = (Number.parseFloat(r.implied_move_perc) * 100).toFixed(2);
    const vol = (Number.parseFloat(r.volatility) * 100).toFixed(1);
    const pct = Number.parseFloat(r.percentile).toFixed(1);
    lines.push(`| ${r.days} | ${vol}% | ${move}% | ${pct}th |`);
  }

  // σ calibration check: compare 0DTE implied move to calculator σ
  const zeroDte = sorted.find((r) => r.days <= 1);
  if (zeroDte && calculatorSigma) {
    const apiMove = Number.parseFloat(zeroDte.implied_move_perc) * 100;
    const calcSigma = Number.parseFloat(calculatorSigma) * 100;
    if (!Number.isNaN(apiMove) && !Number.isNaN(calcSigma) && apiMove > 0) {
      const diff = ((calcSigma - apiMove) / apiMove) * 100;
      const direction = diff > 0 ? 'wider' : 'narrower';
      lines.push(
        '',
        `σ calibration: API 0DTE implied move = ${apiMove.toFixed(2)}%, calculator σ = ${calcSigma.toFixed(2)}% → cone is ${Math.abs(diff).toFixed(0)}% ${direction} than market pricing.`,
      );
    }
  }

  // Term structure shape
  const shortDte = sorted.find((r) => r.days <= 1);
  const longDte = sorted.find((r) => r.days >= 30);
  if (shortDte && longDte) {
    const shortVol = Number.parseFloat(shortDte.volatility);
    const longVol = Number.parseFloat(longDte.volatility);
    if (!Number.isNaN(shortVol) && !Number.isNaN(longVol) && longVol > 0) {
      const ratio = shortVol / longVol;
      let shape: string;
      if (ratio > 1.5) shape = 'STEEP INVERSION (0DTE IV >> 30D IV)';
      else if (ratio > 1.1) shape = 'INVERTED (0DTE IV > 30D IV)';
      else if (ratio > 0.9) shape = 'FLAT';
      else if (ratio > 0.6)
        shape = 'CONTANGO (0DTE IV < 30D IV — normal structure)';
      else shape = 'STEEP CONTANGO (0DTE IV << 30D IV)';
      lines.push(
        `Term structure shape: ${shape} (0DTE/30D ratio: ${ratio.toFixed(2)})`,
      );
    }
  }

  return lines.join('\n');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/iv-term-structure');
    const done = metrics.request('/api/iv-term-structure');

    try {
      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const rateLimitCheck = await rejectIfRateLimited(
        req,
        res,
        '/api/iv-term-structure',
      );
      if (rateLimitCheck) return;

      const apiKey = process.env.UW_API_KEY;
      if (!apiKey) {
        logger.error('UW_API_KEY not configured');
        done({ status: 500 });
        return res.status(500).json({ error: 'UW_API_KEY not configured' });
      }

      // Always use today's date (ET)
      const today = getETDateStr(new Date());

      const rows = await fetchInterpolatedIv(apiKey, today);

      // Short edge cache — data changes intraday
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

      done({ status: 200 });
      return res.status(200).json({
        data: rows,
        date: today,
        asOf: new Date().toISOString(),
      });
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      logger.error({ err: error }, 'IV term structure fetch failed');
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
