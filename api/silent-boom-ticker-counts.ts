/**
 * GET /api/silent-boom-ticker-counts
 *
 * Backs the ticker-rollup chip strip above SilentBoomSection. Returns
 * one row per underlying symbol with the alert count, best realized
 * peak%, and latest bucket time for the day — across the whole feed
 * regardless of pagination. The chip strip is the ticker selector, so
 * `ticker` is intentionally NOT in the filter surface; every other
 * filter mirrors /api/silent-boom-feed so the strip and the list stay
 * coherent. See docs/superpowers/specs/ticker-rollup-2026-05-14.md.
 *
 * Owner-or-guest. Filters validated by
 * `silentBoomTickerCountsQuerySchema` in api/_lib/validation.ts.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { silentBoomTickerCountsQuerySchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';

type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;

interface CountRow {
  ticker: string;
  count: number;
  peak_best_pct: DbNullableNumeric;
  latest_bucket_ct: DbTimestamp;
}

interface SilentBoomTickerCountsResponse {
  date: string;
  filters: {
    optionType: 'C' | 'P' | null;
    minVolOi: number;
    minSpikeRatio: number;
    minScore: number | null;
    tod: 'AM_open' | 'MID' | 'LUNCH' | 'PM' | 'LATE' | null;
    dte: '0' | '1-3' | '4+' | null;
    burst: 'red' | 'yellow' | 'grey' | null;
    askPctBand: '70-80' | '80-90' | '90-95' | '95-99' | '100' | null;
  };
  tickers: {
    ticker: string;
    count: number;
    peakBestPct: number | null;
    latestBucketCt: string;
  }[];
}

function toIso(v: DbTimestamp): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(v).toISOString();
}

function toNumOrNull(v: DbNullableNumeric): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : Number.parseFloat(v);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  const parsed = silentBoomTickerCountsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid query',
      details: parsed.error.issues,
    });
    return;
  }
  const q = parsed.data;
  const date = q.date ?? getETDateStr(new Date());

  // Filter encoding mirrors /api/silent-boom-feed (see comments there
  // for the bucket semantics).
  const todRange = (() => {
    if (q.tod === 'AM_open') return { lo: 0, hi: 10 * 60 };
    if (q.tod === 'MID') return { lo: 10 * 60, hi: 12 * 60 };
    if (q.tod === 'LUNCH') return { lo: 12 * 60, hi: 13 * 60 };
    if (q.tod === 'PM') return { lo: 13 * 60, hi: 15 * 60 };
    if (q.tod === 'LATE') return { lo: 15 * 60, hi: 24 * 60 };
    return null;
  })();
  const todLo = todRange?.lo ?? null;
  const todHi = todRange?.hi ?? null;

  const dteRange = (() => {
    if (q.dte === '0') return { lo: 0, hi: 0 };
    if (q.dte === '1-3') return { lo: 1, hi: 3 };
    if (q.dte === '4+') return { lo: 4, hi: 100_000 };
    return null;
  })();
  const dteLo = dteRange?.lo ?? null;
  const dteHiBound = dteRange?.hi ?? 100_000;

  const burstRange = (() => {
    if (q.burst === 'red') return { lo: 50, hi: 1_000_000 };
    if (q.burst === 'yellow') return { lo: 20, hi: 50 };
    if (q.burst === 'grey') return { lo: 0, hi: 20 };
    return null;
  })();
  const burstLo = burstRange?.lo ?? null;
  const burstHiBound = burstRange?.hi ?? 1_000_000;

  const askPctRange = (() => {
    if (q.askPctBand === '70-80') return { lo: 0.7, hi: 0.8 };
    if (q.askPctBand === '80-90') return { lo: 0.8, hi: 0.9 };
    if (q.askPctBand === '90-95') return { lo: 0.9, hi: 0.95 };
    if (q.askPctBand === '95-99') return { lo: 0.95, hi: 1.0 };
    if (q.askPctBand === '100') return { lo: 1.0, hi: 1.001 };
    return null;
  })();
  const askPctLo = askPctRange?.lo ?? null;
  const askPctHiBound = askPctRange?.hi ?? 1.001;

  try {
    const db = getDb();

    const rows = (await db`
      SELECT
        underlying_symbol AS ticker,
        COUNT(*)::int AS count,
        MAX(peak_ceiling_pct) AS peak_best_pct,
        MAX(bucket_ct) AS latest_bucket_ct
      FROM silent_boom_alerts
      WHERE date = ${date}::date
        AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? null}::text)
        AND vol_oi >= ${q.minVolOi}::numeric
        AND spike_ratio >= ${q.minSpikeRatio}::numeric
        AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? null}::int)
        AND (${todLo}::int IS NULL OR (
          EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
          EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
        ) >= ${todLo}::int)
        AND (${todHi}::int IS NULL OR (
          EXTRACT(HOUR FROM bucket_ct AT TIME ZONE 'America/Chicago')::int * 60 +
          EXTRACT(MINUTE FROM bucket_ct AT TIME ZONE 'America/Chicago')::int
        ) < ${todHi}::int)
        AND (${dteLo}::int IS NULL OR dte BETWEEN ${dteLo}::int AND ${dteHiBound}::int)
        AND (${burstLo}::numeric IS NULL OR (spike_ratio >= ${burstLo}::numeric AND spike_ratio < ${burstHiBound}::numeric))
        AND (${askPctLo}::numeric IS NULL OR (ask_pct >= ${askPctLo}::numeric AND ask_pct < ${askPctHiBound}::numeric))
      GROUP BY underlying_symbol
      ORDER BY count DESC, latest_bucket_ct DESC, underlying_symbol ASC
    `) as CountRow[];

    const response: SilentBoomTickerCountsResponse = {
      date,
      filters: {
        optionType: q.optionType ?? null,
        minVolOi: q.minVolOi,
        minSpikeRatio: q.minSpikeRatio,
        minScore: q.minScore ?? null,
        tod: q.tod ?? null,
        dte: q.dte ?? null,
        burst: q.burst ?? null,
        askPctBand: q.askPctBand ?? null,
      },
      tickers: rows.map((r) => ({
        ticker: r.ticker,
        count: r.count,
        peakBestPct: toNumOrNull(r.peak_best_pct),
        latestBucketCt: toIso(r.latest_bucket_ct),
      })),
    };

    setCacheHeaders(res, 30, 60);
    res.status(200).json(response);
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'silent-boom-ticker-counts: unexpected error');
    res.status(500).json({ error: 'Internal error' });
  }
}
