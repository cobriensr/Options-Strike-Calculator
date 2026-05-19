/**
 * GET /api/periscope-chat-list
 *
 * Paginated index for the Periscope Chat history viewer. Returns a
 * compact summary of past reads + debriefs ordered by `created_at DESC`,
 * suitable for the dashboard's history panel. Image bytes and the full
 * prose response live behind /api/periscope-chat-detail?id=N.
 *
 * Query params:
 *   ?dates=true     — return distinct trading_dates with per-mode counts.
 *                     Mirrors /api/analyses?dates=true; used by the
 *                     history picker's date dropdown.
 *   ?limit=N        — max rows returned (1-100, default 20). Ignored
 *                     when `dates=true`.
 *   ?before=N       — return rows with id < this BIGSERIAL value
 *                     (cursor-style pagination from the most recent).
 *
 * Authorization: owner OR guest (`guardOwnerOrGuestEndpoint`). The
 * chat data is Anthropic-API-backed but the user has chosen to share
 * read-only access with guest-key holders. Only `/api/periscope-chat`
 * (the POST that calls Claude and incurs API cost) stays owner-only.
 *
 * Rate limit: 60/min — ample for browsing the history list and
 * occasional refreshes.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guardOwnerOrGuestEndpoint,
  rejectIfRateLimited,
  respondIfInvalid,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { getDb, withDbRetry } from './_lib/db.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { periscopeChatListQuerySchema } from './_lib/validation.js';

/**
 * Strip markdown syntax from prose for the list excerpt. The full
 * markdown is preserved in `prose_text` for the detail-view renderer;
 * the list shows a flat one-line preview, so headings, bold/italic,
 * bullets, links, and inline code markers collapse to plain text.
 *
 * Not a full CommonMark parser — just enough cleanup so the excerpt
 * doesn't leak `# ** -` glyphs as visible characters. Each rule is
 * scoped tightly to avoid catastrophic backtracking.
 */
export function stripMarkdownForExcerpt(text: string): string {
  return (
    text
      .replace(/^#{1,6}\s+/gm, '') // ATX headings
      // Marker-only deletes for bold + inline code. Walking with literal
      // patterns (not quantified groups) is ReDoS-immune and still
      // produces a clean excerpt — text between the markers is preserved
      // as-is, only the * / _ / ` syntax glyphs go.
      .replaceAll('**', '')
      .replaceAll('__', '')
      .replaceAll('`', '')
      // Bounded leading whitespace ({0,8}) + bounded digit count keep the
      // list-marker patterns linear under sonar's slow-regex check.
      .replace(/^[ \t]{0,8}[-*+][ \t]+/gm, '') // list bullets
      .replace(/^[ \t]{0,8}\d{1,4}\.[ \t]+/gm, '') // ordered-list markers
      // [text](url) → text. Bounded class + bounded quantifier keep
      // matching linear; sonar accepts this shape.
      .replace(/\[([^\]\n]{1,200})\]\([^)\n]{1,500}\)/g, '$1')
      .replace(/```[a-z]*\n?/gi, '') // code fences
      .replace(/\s+/g, ' ') // collapse all whitespace
      .trim()
  );
}

import type { PeriscopeMode } from './_lib/periscope-db.js';
import { toIsoDate, toIsoTimestamp } from './_lib/periscope-db.js';

interface PeriscopeChatSummary {
  id: number;
  trading_date: string;
  captured_at: string;
  mode: PeriscopeMode;
  parent_id: number | null;
  spot: number | null;
  long_trigger: number | null;
  short_trigger: number | null;
  regime_tag: string | null;
  calibration_quality: number | null;
  prose_excerpt: string;
  duration_ms: number | null;
}

function parseSummaryRow(r: Record<string, unknown>): PeriscopeChatSummary {
  const proseText = typeof r.prose_text === 'string' ? r.prose_text : '';
  return {
    id: Number(r.id),
    trading_date: toIsoDate(r.trading_date),
    captured_at: toIsoTimestamp(r.captured_at),
    mode: r.mode as PeriscopeMode,
    parent_id: r.parent_id == null ? null : Number(r.parent_id),
    spot: r.spot == null ? null : Number(r.spot),
    long_trigger: r.long_trigger == null ? null : Number(r.long_trigger),
    short_trigger: r.short_trigger == null ? null : Number(r.short_trigger),
    regime_tag: (r.regime_tag as string | null) ?? null,
    calibration_quality:
      r.calibration_quality == null ? null : Number(r.calibration_quality),
    // 240 chars of plain-text excerpt — markdown stripped, whitespace
    // collapsed. Full prose lives behind /periscope-chat-detail and is
    // rendered with proper typography there.
    prose_excerpt: stripMarkdownForExcerpt(proseText).slice(0, 240),
    duration_ms: r.duration_ms == null ? null : Number(r.duration_ms),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/periscope-chat-list');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'periscope-chat-list',
    60,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  // ?dates=true short-circuits the cursor query and returns the
  // distinct-date aggregation used by the history picker dropdown.
  // Mirrors /api/analyses?dates=true.
  if (req.query.dates === 'true') {
    try {
      const sql = getDb();
      setCacheHeaders(res, 30, 60);
      const rows = await withDbRetry(
        () => sql`
        SELECT
          TO_CHAR(trading_date, 'YYYY-MM-DD') AS date,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE mode = 'pre_trade') AS pre_trades,
          COUNT(*) FILTER (WHERE mode = 'intraday') AS intradays,
          COUNT(*) FILTER (WHERE mode = 'debrief') AS debriefs
        FROM periscope_analyses
        GROUP BY trading_date
        ORDER BY trading_date DESC
      `,
        2,
        10_000,
      );
      done({ status: 200 });
      return res.status(200).json({
        dates: rows.map((r) => ({
          date: r.date as string,
          total: Number(r.total),
          // `reads` retained as a back-compat aggregate (pre_trade + intraday)
          // for any frontend still expecting the legacy field shape.
          reads: Number(r.pre_trades) + Number(r.intradays),
          pre_trades: Number(r.pre_trades),
          intradays: Number(r.intradays),
          debriefs: Number(r.debriefs),
        })),
      });
    } catch (err) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(err);
      logger.error({ err }, 'periscope-chat-list dates aggregation error');
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  const parsed = periscopeChatListQuerySchema.safeParse(req.query);
  if (respondIfInvalid(parsed, res, done)) return;
  const { limit, before, date } = parsed.data;

  try {
    const sql = getDb();
    setCacheHeaders(res, 30, 60);

    // Three query shapes:
    //   `?date=YYYY-MM-DD` — filter to that trading_date, no cursor
    //   `?before=N`        — cursor pagination
    //   neither            — most recent `limit` rows
    // BIGSERIAL id is the cheapest stable cursor — newer rows always
    // have larger ids regardless of trading_date / captured_at.
    const rows = date
      ? await withDbRetry(
          () => sql`
          SELECT id, trading_date, captured_at, mode, parent_id,
                 spot, long_trigger, short_trigger, regime_tag,
                 calibration_quality, prose_text, duration_ms
          FROM periscope_analyses
          WHERE trading_date = ${date}
          ORDER BY id DESC
          LIMIT ${limit}
        `,
          2,
          10_000,
        )
      : before
        ? await withDbRetry(
            () => sql`
          SELECT id, trading_date, captured_at, mode, parent_id,
                 spot, long_trigger, short_trigger, regime_tag,
                 calibration_quality, prose_text, duration_ms
          FROM periscope_analyses
          WHERE id < ${before}
          ORDER BY id DESC
          LIMIT ${limit}
        `,
            2,
            10_000,
          )
        : await withDbRetry(
            () => sql`
          SELECT id, trading_date, captured_at, mode, parent_id,
                 spot, long_trigger, short_trigger, regime_tag,
                 calibration_quality, prose_text, duration_ms
          FROM periscope_analyses
          ORDER BY id DESC
          LIMIT ${limit}
        `,
            2,
            10_000,
          );

    const items = rows.map(parseSummaryRow);
    const nextBefore =
      items.length === limit ? (items.at(-1)?.id ?? null) : null;

    done({ status: 200 });
    return res.status(200).json({ items, nextBefore });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'periscope-chat-list endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
