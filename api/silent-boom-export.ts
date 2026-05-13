/**
 * GET /api/silent-boom-export
 *
 * Owner-only EOD dump of `silent_boom_alerts` for one trading day.
 * Returns every matching row (no pagination, no chain dedup) so the
 * spreadsheet has the full firehose for analysis — score, tier,
 * spike ratio, vol/OI, ask%, peak, realized horizons, all in one row.
 *
 * Query params: ?date= ?ticker= ?optionType= ?minVolOi= ?minSpikeRatio=
 *               ?minScore= ?tod= ?format=csv|json
 * Validated by `silentBoomExportQuerySchema`.
 *
 * Defaults to CSV with `Content-Disposition: attachment` so a browser
 * navigation triggers a download. Mirrors api/lottery-export.ts.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import { guardOwnerEndpoint } from './_lib/auth-helpers.js';
import { silentBoomExportQuerySchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';

/** Normalize Neon Date / Timestamp values to ISO strings (or
 *  YYYY-MM-DD for DATE columns). Same logic as lottery-export. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) {
      out[k] =
        k === 'date' || k === 'expiry'
          ? v.toISOString().slice(0, 10)
          : v.toISOString();
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Escape one CSV field per RFC 4180. */
function csvField(val: unknown): string {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerEndpoint(req, res, () => undefined)) return;

  try {
    const parsed = silentBoomExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid query',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const {
      date,
      ticker,
      optionType,
      minVolOi,
      minSpikeRatio,
      minScore,
      tod,
      dte,
      burst,
      askPctBand,
      format,
    } = parsed.data;

    const targetDate = date ?? getETDateStr(new Date());
    const tickerUpper = ticker?.toUpperCase();

    // TOD bucket → CT minute-of-day half-open range. Mirrors the
    // mapping in api/silent-boom-feed.ts so the export and feed agree
    // on every alert's bucket.
    const todRange = (() => {
      if (tod === 'AM_open') return { lo: 0, hi: 10 * 60 };
      if (tod === 'MID') return { lo: 10 * 60, hi: 12 * 60 };
      if (tod === 'LUNCH') return { lo: 12 * 60, hi: 13 * 60 };
      if (tod === 'PM') return { lo: 13 * 60, hi: 15 * 60 };
      if (tod === 'LATE') return { lo: 15 * 60, hi: 24 * 60 };
      return null;
    })();
    const todLo = todRange?.lo ?? null;
    const todHi = todRange?.hi ?? null;

    // DTE bucket → numeric range. Mirrors api/silent-boom-feed.ts.
    const dteRange = (() => {
      if (dte === '0') return { lo: 0, hi: 0 };
      if (dte === '1-3') return { lo: 1, hi: 3 };
      if (dte === '4+') return { lo: 4, hi: 100_000 };
      return null;
    })();
    const dteLo = dteRange?.lo ?? null;
    const dteHiBound = dteRange?.hi ?? 100_000;

    // Burst color → spike_ratio range. Visual-intensity buckets.
    const burstRange = (() => {
      if (burst === 'red') return { lo: 50, hi: 1_000_000 };
      if (burst === 'yellow') return { lo: 20, hi: 50 };
      if (burst === 'grey') return { lo: 0, hi: 20 };
      return null;
    })();
    const burstLo = burstRange?.lo ?? null;
    const burstHiBound = burstRange?.hi ?? 1_000_000;

    // Ask% band → half-open [lo, hi). '100' is exact equality
    // (ask_pct = 1.0) — the cliff bucket from the saturation audit.
    // Mirrors api/silent-boom-feed.ts.
    const askPctRange = (() => {
      if (askPctBand === '70-80') return { lo: 0.7, hi: 0.8 };
      if (askPctBand === '80-90') return { lo: 0.8, hi: 0.9 };
      if (askPctBand === '90-95') return { lo: 0.9, hi: 0.95 };
      if (askPctBand === '95-99') return { lo: 0.95, hi: 1.0 };
      if (askPctBand === '100') return { lo: 1.0, hi: 1.001 };
      return null;
    })();
    const askPctLo = askPctRange?.lo ?? null;
    const askPctHiBound = askPctRange?.hi ?? 1.001;

    const db = getDb();

    // No LIMIT — export the full firehose. Order chronologically
    // forward so the spreadsheet reads top-to-bottom by bucket time.
    const rows = (await db`
      SELECT *
      FROM silent_boom_alerts
      WHERE date = ${targetDate}::date
        AND (${tickerUpper ?? null}::text IS NULL OR underlying_symbol = ${tickerUpper ?? null}::text)
        AND (${optionType ?? null}::text IS NULL OR option_type = ${optionType ?? null}::text)
        AND vol_oi >= ${minVolOi}::numeric
        AND spike_ratio >= ${minSpikeRatio}::numeric
        AND (${minScore ?? null}::int IS NULL OR score >= ${minScore ?? null}::int)
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
      ORDER BY bucket_ct ASC, id ASC
    `) as Record<string, unknown>[];

    const normalized = rows.map(normalizeRow);

    if (format === 'json') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        date: targetDate,
        count: normalized.length,
        filters: {
          ticker: tickerUpper ?? null,
          optionType: optionType ?? null,
          minVolOi,
          minSpikeRatio,
          minScore: minScore ?? null,
          tod: tod ?? null,
          dte: dte ?? null,
          burst: burst ?? null,
          askPctBand: askPctBand ?? null,
        },
        rows: normalized,
      });
    }

    // CSV. Empty-set still gets a 200 so the download doesn't surface
    // as a 404 in the browser.
    const tickerSuffix = tickerUpper ? `-${tickerUpper}` : '';
    const filename = `silent-boom-${targetDate}${tickerSuffix}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    if (normalized.length === 0) {
      return res.status(200).send('');
    }

    const headers = Object.keys(normalized[0]!);
    const lines = [headers.join(',')];
    for (const row of normalized) {
      lines.push(headers.map((h) => csvField(row[h])).join(','));
    }
    return res.status(200).send(lines.join('\n'));
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'silent-boom-export error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
