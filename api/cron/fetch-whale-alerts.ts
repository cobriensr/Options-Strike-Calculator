/**
 * GET /api/cron/fetch-whale-alerts
 *
 * Fetches UW whale-sized options flow alerts (≥ $500K premium) for 0-7 DTE
 * SPXW contracts across ALL rule types. Scheduled every 5 minutes during
 * market hours. Upserts into whale_alerts.
 *
 * Strategy:
 *   1. Read MAX(created_at) from whale_alerts to scope the request.
 *   2. Call UW with ticker_symbol=SPXW, issue_types[]=Index, min_dte=0,
 *      max_dte=7, min_premium=500000, limit=200 (NO rule_name filter —
 *      whale flow spans multiple rule types).
 *   3. If the DB already has rows, pass `newer_than=<max(created_at)>`.
 *      Otherwise omit — first-run backfill.
 *   4. If the response has exactly 200 rows, paginate using `older_than`
 *      until we see <200 or hit a 1000-row safety cap.
 *   5. Compute 11 denormalized derived fields via `computeDerived` plus the
 *      `age_minutes_at_ingest` delta, then upsert. ON CONFLICT
 *      (option_chain, created_at) DO NOTHING dedupes across overlapping
 *      cron windows and against the companion /api/options-flow/whale-positioning
 *      live-query endpoint.
 *
 * The live-query endpoint stays the source of truth for the UI; this cron
 * runs alongside purely for DB persistence / future ML training.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronGuard, uwFetch, withRetry } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import { computeDerived, type UwFlowAlert } from '../_lib/flow-alert-derive.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// Re-export so tests can import the shared type from this module.
export { computeDerived, type UwFlowAlert };

// ── Constants ────────────────────────────────────────────────

const PAGE_SIZE = 200;
const SAFETY_CAP = 1000;
const MIN_PREMIUM = 500_000;
const MAX_DTE = 7;
const WHALE_ALERTS_PATH = '/option-trades/flow-alerts';

// ── UW fetch + pagination ────────────────────────────────────

function buildWhaleAlertsPath(
  params: Record<string, string | undefined>,
): string {
  const qs = new URLSearchParams();
  qs.append('ticker_symbol', 'SPXW');
  qs.append('issue_types[]', 'Index');
  // Intentionally NO rule_name[] filter — whale flow spans all rule types.
  qs.append('min_dte', '0');
  qs.append('max_dte', String(MAX_DTE));
  qs.append('min_premium', String(MIN_PREMIUM));
  qs.append('limit', String(PAGE_SIZE));
  if (params.newer_than) qs.append('newer_than', params.newer_than);
  if (params.older_than) qs.append('older_than', params.older_than);
  return `${WHALE_ALERTS_PATH}?${qs.toString()}`;
}

async function fetchAllNewAlerts(
  apiKey: string,
  newerThan: string | null,
): Promise<UwFlowAlert[]> {
  const collected: UwFlowAlert[] = [];
  let olderThan: string | undefined;

  while (collected.length < SAFETY_CAP) {
    const path = buildWhaleAlertsPath({
      newer_than: newerThan ?? undefined,
      older_than: olderThan,
    });
    const batch = await withRetry(() => uwFetch<UwFlowAlert>(apiKey, path));
    collected.push(...batch);

    if (batch.length < PAGE_SIZE) break;

    // Paginate backwards from the oldest row in this batch. Subtract 1ms so
    // a full batch sharing an identical `created_at` can't infinite-loop on
    // an inclusive `older_than`.
    const oldest = batch.reduce(
      (acc, row) => (row.created_at < acc ? row.created_at : acc),
      batch[0]!.created_at,
    );
    const oldestTs = new Date(oldest);
    oldestTs.setMilliseconds(oldestTs.getMilliseconds() - 1);
    olderThan = oldestTs.toISOString();
  }

  return collected.slice(0, SAFETY_CAP);
}

// ── Handler ──────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey } = guard;
  const startedAt = Date.now();

  try {
    const db = getDb();

    // 1. Scope to records newer than our last-seen timestamp.
    const rows = await db`
      SELECT MAX(created_at) AS max_created_at FROM whale_alerts
    `;
    const maxCreatedAt =
      (rows[0]?.max_created_at as string | Date | null | undefined) ?? null;
    const newerThan =
      maxCreatedAt instanceof Date
        ? maxCreatedAt.toISOString()
        : (maxCreatedAt ?? null);

    // 2. Fetch (with pagination + safety cap).
    const alerts = await fetchAllNewAlerts(apiKey, newerThan);

    if (alerts.length === 0) {
      return res.status(200).json({
        job: 'fetch-whale-alerts',
        fetched: 0,
        inserted: 0,
        durationMs: Date.now() - startedAt,
      });
    }

    // 3. Upsert each row.
    let inserted = 0;
    for (const a of alerts) {
      const d = computeDerived(a);
      const ageMinutesAtIngest = Math.floor(
        (Date.now() - new Date(a.created_at).getTime()) / 60_000,
      );
      const result = await db`
        INSERT INTO whale_alerts (
          alert_rule, ticker, issue_type, option_chain, strike, expiry, type,
          created_at, age_minutes_at_ingest, price, underlying_price,
          total_premium, total_ask_side_prem, total_bid_side_prem,
          total_size, trade_count, expiry_count, volume, open_interest, volume_oi_ratio,
          has_sweep, has_floor, has_multileg, has_singleleg, all_opening_trades,
          ask_side_ratio, bid_side_ratio, net_premium,
          dte_at_alert, distance_from_spot, distance_pct, moneyness, is_itm,
          minute_of_day, session_elapsed_min, day_of_week,
          raw_response
        ) VALUES (
          ${a.alert_rule}, ${a.ticker}, ${a.issue_type}, ${a.option_chain}, ${a.strike}, ${a.expiry}, ${a.type},
          ${a.created_at}, ${ageMinutesAtIngest}, ${a.price}, ${a.underlying_price},
          ${a.total_premium}, ${a.total_ask_side_prem}, ${a.total_bid_side_prem},
          ${a.total_size}, ${a.trade_count}, ${a.expiry_count}, ${a.volume}, ${a.open_interest}, ${a.volume_oi_ratio},
          ${a.has_sweep}, ${a.has_floor}, ${a.has_multileg}, ${a.has_singleleg}, ${a.all_opening_trades},
          ${d.ask_side_ratio}, ${d.bid_side_ratio}, ${d.net_premium},
          ${d.dte_at_alert}, ${d.distance_from_spot}, ${d.distance_pct}, ${d.moneyness}, ${d.is_itm},
          ${d.minute_of_day}, ${d.session_elapsed_min}, ${d.day_of_week},
          ${JSON.stringify(a)}::jsonb
        )
        ON CONFLICT (option_chain, created_at) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) inserted++;
    }

    logger.info(
      { fetched: alerts.length, inserted },
      'fetch-whale-alerts completed',
    );

    return res.status(200).json({
      job: 'fetch-whale-alerts',
      fetched: alerts.length,
      inserted,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-whale-alerts');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-whale-alerts error');
    return res.status(500).json({
      job: 'fetch-whale-alerts',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
