/**
 * GET /api/lottery-export
 *
 * Owner-only EOD dump of `lottery_finder_fires` joined with
 * `lottery_ticker_stats` for one trading day. Returns every matching
 * fire (no chain-day dedup, no pagination) so the spreadsheet has the
 * full firehose for analysis — exit-policy %s, peak %, score, macro
 * snapshot, ticker stats, all in one row.
 *
 * Query params: ?date= ?ticker= ?reload= ?cheapCallPm= ?mode=
 *               ?optionType= ?tod= ?minScore= ?format=csv|json
 * Validated by `lotteryExportQuerySchema`.
 *
 * Defaults to CSV with `Content-Disposition: attachment` so a browser
 * navigation triggers a download. JSON is for ad-hoc piping.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, withDbRetry } from './_lib/db.js';
import { DB_RETRY_ATTEMPTS, DB_RETRY_TIMEOUT_MS } from './_lib/constants.js';
import { guardOwnerEndpoint } from './_lib/api-helpers.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import { lotteryExportQuerySchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';

/** Normalize Neon Date / Timestamp values to ISO strings (or YYYY-MM-DD for DATE). */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) {
      // DATE columns come back as midnight-UTC Date objects; render as
      // YYYY-MM-DD. TIMESTAMPTZ columns get the full ISO string. We
      // discriminate on column-name suffix because the JS Date type
      // doesn't carry "this was a DATE not a TIMESTAMP" provenance.
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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerEndpoint(req, res, () => undefined)) return;

  try {
    const parsed = lotteryExportQuerySchema.safeParse(req.query);
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
      reload,
      cheapCallPm,
      mode,
      optionType,
      tod,
      minScore,
      format,
    } = parsed.data;

    const targetDate = date ?? getETDateStr(new Date());
    const db = getDb();

    // No chain-day dedup, no LIMIT — export the full firehose. Order
    // chronologically forward so the spreadsheet reads top-to-bottom
    // by trigger time. The (date, trigger_time_ct, id) shape lets the
    // existing index handle this without a sort.
    const rows = (await withDbRetry(
      () => db`
      SELECT
        f.*,
        s.n_fires AS ticker_n_fires,
        s.high_peak_rate AS ticker_high_peak_rate,
        s.ci_lower AS ticker_ci_lower,
        s.ci_upper AS ticker_ci_upper,
        s.ci_width AS ticker_ci_width,
        s.tier AS ticker_tier
      FROM lottery_finder_fires f
      LEFT JOIN lottery_ticker_stats s ON s.ticker = f.underlying_symbol
      WHERE f.date = ${targetDate}::date
        AND (${ticker ?? null}::text IS NULL OR f.underlying_symbol = ${ticker ?? ''})
        AND (${reload ?? null}::boolean IS NULL OR f.reload_tagged = ${reload ?? false})
        AND (${cheapCallPm ?? null}::boolean IS NULL OR f.cheap_call_pm_tagged = ${cheapCallPm ?? false})
        AND (${mode ?? null}::text IS NULL OR f.mode = ${mode ?? ''})
        AND (${optionType ?? null}::text IS NULL OR f.option_type = ${optionType ?? ''})
        AND (${tod ?? null}::text IS NULL OR f.tod = ${tod ?? ''})
        AND (${minScore ?? null}::int IS NULL OR f.score >= ${minScore ?? 0})
      ORDER BY f.trigger_time_ct ASC, f.id ASC
    `,
      DB_RETRY_ATTEMPTS,
      DB_RETRY_TIMEOUT_MS,
    )) as Record<string, unknown>[];

    const normalized = rows.map(normalizeRow);

    if (format === 'json') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        date: targetDate,
        count: normalized.length,
        filters: {
          ticker,
          reload,
          cheapCallPm,
          mode,
          optionType,
          tod,
          minScore,
        },
        rows: normalized,
      });
    }

    // CSV. Empty-set still gets a (header-less) 200 so the download
    // doesn't surface as a 404 in the browser.
    const tickerSuffix = ticker ? `-${ticker}` : '';
    const filename = `lottery-fires-${targetDate}${tickerSuffix}.csv`;
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
    sendDbErrorResponse(res, err, {
      label: 'lottery_export',
      serverErrorBody: { error: 'Internal error' },
    });
    return;
  }
}
