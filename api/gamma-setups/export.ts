/**
 * GET /api/gamma-setups/export
 *
 * Owner-or-guest CSV (default) / JSON dump of `ws_gamma_setup_fires`
 * over a date range. Lets the user pull live fires + EOD-backfilled
 * outcomes into their own journal / spreadsheet tooling without us
 * reinventing a journal UI inside the app.
 *
 * Query params:
 *   ?from=YYYY-MM-DD   Window start (inclusive). Default = today - 30d.
 *   ?to=YYYY-MM-DD     Window end (inclusive). Default = today.
 *   ?format=csv|json   Default csv.
 *
 * CSV defaults to a `Content-Disposition: attachment` so a browser
 * navigation triggers a download. JSON is for piping into scripts.
 *
 * Spec: docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { getDb, withDbRetry } from '../_lib/db.js';
import { DB_RETRY_ATTEMPTS, DB_RETRY_TIMEOUT_MS } from '../_lib/constants.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { sendDbErrorResponse } from '../_lib/transient-db-response.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { loadFiresForExport } from '../_lib/gamma-stats.js';
import { getETDateStr } from '../../src/utils/timezone.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !ISO_DATE_RE.test(raw)) return fallback;
  return raw;
}

function parseFormat(raw: unknown): 'csv' | 'json' {
  return raw === 'json' ? 'json' : 'csv';
}

function daysAgoEtDateStr(days: number): string {
  const now = new Date();
  const past = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return getETDateStr(past);
}

/** Normalize Neon Date / Timestamp values to ISO strings (YYYY-MM-DD for
 *  DATE columns, full ISO 8601 for TIMESTAMPTZ). Mirrors lottery-export
 *  for consistency across the app's CSV exports. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) {
      out[k] = v.toISOString();
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Escape one CSV field per RFC 4180 (quote when needed, double inner quotes). */
function csvField(val: unknown): string {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/gamma-setups/export');
    const done = metrics.request('/api/gamma-setups/export');

    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        res.status(405).json({ error: 'GET only' });
        return;
      }
      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const today = getETDateStr(new Date());
      const from = parseDate(req.query.from, daysAgoEtDateStr(30));
      const to = parseDate(req.query.to, today);
      const format = parseFormat(req.query.format);

      const sql = getDb();
      const rows = await withDbRetry(
        () => loadFiresForExport(sql, from, to),
        DB_RETRY_ATTEMPTS,
        DB_RETRY_TIMEOUT_MS,
      );
      const normalized = rows.map((r) => normalizeRow(r));

      if (format === 'json') {
        done({ status: 200 });
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({
          from,
          to,
          count: normalized.length,
          rows: normalized,
        });
        return;
      }

      // CSV. Empty-set still gets a (header-less) 200 so the download
      // doesn't surface as a 404 in the browser. Matches lottery-export.
      const filename = `gamma-setups-${from}_to_${to}.csv`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      res.setHeader('Cache-Control', 'no-store');

      if (normalized.length === 0) {
        done({ status: 200 });
        res.status(200).send('');
        return;
      }

      const headers = Object.keys(normalized[0]!);
      const lines = [headers.join(',')];
      for (const row of normalized) {
        lines.push(headers.map((h) => csvField(row[h])).join(','));
      }
      done({ status: 200 });
      res.status(200).send(lines.join('\n'));
    } catch (err) {
      done({ status: 500 });
      sendDbErrorResponse(res, err, {
        label: 'gamma_setups_export',
        serverErrorBody: { error: 'Internal error' },
      });
    }
  });
}
