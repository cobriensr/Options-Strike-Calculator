/**
 * GET /api/periscope-playbook
 *
 * Returns the latest auto-generated Periscope playbook for a trading
 * date — the row produced by `api/periscope-auto-playbook` (Phase 2b)
 * after each scraper tick. The frontend `PeriscopePanel` consumes this
 * directly and renders the structured `panel_payload` JSON.
 *
 * Phase 2c of docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md.
 *
 * Query params:
 *   ?date=YYYY-MM-DD   CT trading date. Defaults to today's CT date.
 *   ?slot=<ISO>        Optional slot_captured_at to pin the lookup to a
 *                      specific tick. When set, the handler returns the
 *                      auto-generated `complete` row whose
 *                      slot_captured_at matches the ISO exactly; when
 *                      absent, returns the latest complete row for the
 *                      date (legacy behavior). The panel passes this
 *                      whenever the user time-travels to a past slot
 *                      so the playbook lane stays in sync with the
 *                      exposure view.
 *   ?nocache=<rand>    Optional cache-bust hint for manual rerun flows.
 *                      The query string is not parsed; presence merely
 *                      forces the edge to revalidate via Cache-Control:
 *                      no-store. Used by the panel's "re-run now" button.
 *
 * Response shape:
 * {
 *   marketOpen: boolean,
 *   asOf: string (ISO),
 *   data: {
 *     id: number,
 *     mode: 'pre_trade' | 'intraday' | 'debrief',
 *     status: 'complete' | 'failed' | 'truncated',
 *     slotCapturedAt: string (ISO),
 *     readTime: string (ISO),
 *     spot: number,
 *     panelPayload: object | null,
 *     parentId: number | null,
 *     model: string | null,
 *     failureReason: string | null,
 *     durationMs: number | null,
 *     createdAt: string (ISO),
 *   } | null,
 *   latestInProgress: boolean,    // true when a newer slot is mid-flight
 *   reason?: 'no_playbook',       // present when data === null
 * }
 *
 * Cache:
 *   Live (no date param):    60s edge + 60s SWR during RTH, 600s + 60s after hours.
 *   Picked historical date:  600s + 60s — immutable past day.
 *   ?nocache=<...>:          no-store (manual rerun forces fresh read).
 *
 * Auth: owner OR guest (matches the actual posture of /api/periscope-exposure).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { Sentry } from './_lib/sentry.js';
import {
  setCacheHeaders,
  isMarketOpen,
  guardOwnerOrGuestEndpoint,
} from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import { withDbReader } from './_lib/request-scope.js';
import { getETDateStr } from '../src/utils/timezone.js';
import logger from './_lib/logger.js';
import type {
  PeriscopeMode,
  PeriscopeAnalysisStatus,
} from './_lib/periscope-db.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Loose ISO-8601 with date+time+TZ marker. Tight enough to reject
// obvious junk before it hits the DB; the Neon driver coerces the
// trailing precision so we don't enforce milliseconds.
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

interface PlaybookRow {
  id: string | number;
  mode: PeriscopeMode;
  status: PeriscopeAnalysisStatus;
  slot_captured_at: string | Date;
  read_time: string | Date;
  spot_at_read_time: string | number;
  panel_payload: Record<string, unknown> | string | null;
  parent_id: string | number | null;
  model: string | null;
  failure_reason: string | null;
  duration_ms: number | null;
  created_at: string | Date;
}

interface PlaybookResponseRow {
  id: number;
  mode: PeriscopeMode;
  status: PeriscopeAnalysisStatus;
  slotCapturedAt: string;
  readTime: string;
  spot: number;
  panelPayload: Record<string, unknown> | null;
  parentId: number | null;
  model: string | null;
  failureReason: string | null;
  durationMs: number | null;
  createdAt: string;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function parseJsonbField(
  raw: Record<string, unknown> | string | null,
): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Fetch the completed auto-generated playbook for the date.
 *
 * When `slotCapturedAt` is null: returns the latest complete row (legacy
 * behavior, used by Live mode). Uses the partial index
 * `idx_periscope_analyses_latest` (migration #142) keyed on
 * (trading_date DESC, slot_captured_at DESC) WHERE status = 'complete'.
 *
 * When `slotCapturedAt` is an ISO timestamp: pins the lookup to that
 * exact tick. The panel passes this when the user time-travels so the
 * playbook lane updates to match the rendered exposure slot rather
 * than getting stuck on the most recent debrief row.
 */
async function fetchComplete(
  date: string,
  slotCapturedAt: string | null,
): Promise<PlaybookResponseRow | null> {
  const sql = getDb();
  try {
    const rows = (await (slotCapturedAt == null
      ? sql`
          SELECT
            id,
            mode,
            status,
            slot_captured_at,
            read_time,
            spot_at_read_time,
            panel_payload,
            parent_id,
            model,
            failure_reason,
            duration_ms,
            created_at
          FROM periscope_analyses
          WHERE trading_date = ${date}
            AND auto_generated = TRUE
            AND status = 'complete'
          ORDER BY slot_captured_at DESC
          LIMIT 1
        `
      : sql`
          SELECT
            id,
            mode,
            status,
            slot_captured_at,
            read_time,
            spot_at_read_time,
            panel_payload,
            parent_id,
            model,
            failure_reason,
            duration_ms,
            created_at
          FROM periscope_analyses
          WHERE trading_date = ${date}
            AND auto_generated = TRUE
            AND status = 'complete'
            AND slot_captured_at = ${slotCapturedAt}
          LIMIT 1
        `)) as PlaybookRow[];
    const row = rows[0];
    if (row == null) return null;
    const idNum = Number(row.id);
    const parentNum = row.parent_id == null ? null : Number(row.parent_id);
    const spotNum = Number(row.spot_at_read_time);
    return {
      id: Number.isFinite(idNum) ? idNum : -1,
      mode: row.mode,
      status: row.status,
      slotCapturedAt: toIso(row.slot_captured_at),
      readTime: toIso(row.read_time),
      spot: Number.isFinite(spotNum) ? spotNum : 0,
      panelPayload: parseJsonbField(row.panel_payload),
      parentId:
        parentNum != null && Number.isFinite(parentNum) ? parentNum : null,
      model: row.model,
      failureReason: row.failure_reason,
      durationMs: row.duration_ms,
      createdAt: toIso(row.created_at),
    };
  } catch (err) {
    Sentry.captureException(err);
    logger.error(
      { err, date, slotCapturedAt },
      '/api/periscope-playbook: fetchComplete query failed',
    );
    return null;
  }
}

/**
 * Returns true when an `in_progress` auto-generated row exists for the
 * date strictly newer than `afterSlotIso` (or any in_progress row when
 * `afterSlotIso` is null — the no-completed-rows-yet case).
 *
 * The panel uses this to render a "Claude reading slot X..." hint when
 * a newer tick is mid-flight than the one currently displayed.
 */
async function hasLaterInProgress(
  date: string,
  afterSlotIso: string | null,
): Promise<boolean> {
  const sql = getDb();
  try {
    const rows = (await (afterSlotIso == null
      ? sql`
          SELECT 1
          FROM periscope_analyses
          WHERE trading_date = ${date}
            AND auto_generated = TRUE
            AND status = 'in_progress'
          LIMIT 1
        `
      : sql`
          SELECT 1
          FROM periscope_analyses
          WHERE trading_date = ${date}
            AND auto_generated = TRUE
            AND status = 'in_progress'
            AND slot_captured_at > ${afterSlotIso}
          LIMIT 1
        `)) as Array<unknown>;
    return rows.length > 0;
  } catch (err) {
    Sentry.captureException(err);
    logger.warn(
      { err, date, afterSlotIso },
      '/api/periscope-playbook: hasLaterInProgress query failed',
    );
    return false;
  }
}

export default withDbReader(
  '/api/periscope-playbook',
  'periscope_playbook',
  async (req: VercelRequest, res: VercelResponse, done) => {
    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const dateParam = (req.query.date as string | undefined) ?? '';
    const slotParam = (req.query.slot as string | undefined) ?? '';
    const isHistoricalRead = dateParam !== '' || slotParam !== '';
    const noCache = (req.query.nocache as string | undefined) ?? '';

    let date: string;
    if (dateParam === '') {
      date = getETDateStr(new Date());
    } else if (DATE_RE.test(dateParam)) {
      date = dateParam;
    } else {
      done({ status: 400, error: 'bad_date' });
      res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      return;
    }

    if (slotParam !== '' && !ISO_RE.test(slotParam)) {
      done({ status: 400, error: 'bad_slot' });
      res.status(400).json({ error: 'slot must be ISO-8601' });
      return;
    }
    const slotCapturedAt: string | null = slotParam !== '' ? slotParam : null;

    const marketOpen = isMarketOpen();

    // Cache policy:
    //   - Manual rerun (?nocache=...): force no-store so a re-run is
    //     immediately visible to the panel client.
    //   - Historical (date param): immutable past day, cache aggressively.
    //   - Live (no date): short window during RTH, longer after hours.
    if (noCache !== '') {
      res.setHeader('Cache-Control', 'no-store');
    } else if (isHistoricalRead) {
      setCacheHeaders(res, 600, 60);
    } else {
      // 60s SWR in both regimes; only the edge TTL flexes RTH-vs-after-hours.
      setCacheHeaders(res, marketOpen ? 60 : 600, 60);
    }

    const data = await fetchComplete(date, slotCapturedAt);
    const latestInProgress = await hasLaterInProgress(
      date,
      data?.slotCapturedAt ?? null,
    );

    done({ status: 200 });
    const body: {
      marketOpen: boolean;
      asOf: string;
      data: PlaybookResponseRow | null;
      latestInProgress: boolean;
      reason?: string;
    } = {
      marketOpen,
      asOf: new Date().toISOString(),
      data,
      latestInProgress,
    };
    if (data == null) body.reason = 'no_playbook';
    res.status(200).json(body);
  },
);
