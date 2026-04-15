/**
 * GET /api/cron/fetch-flow-alerts
 *
 * Fetches UW repeated-hit options flow alerts for 0-1 DTE SPXW contracts.
 * Scheduled every minute during market hours. Upserts into flow_alerts.
 *
 * Strategy:
 *   1. Read MAX(created_at) from flow_alerts to scope the request.
 *   2. Call UW with rule_name=RepeatedHits/Ascending/Descending, min_dte=0,
 *      max_dte=1, ticker_symbol=SPXW, issue_types[]=Index, limit=200.
 *   3. If the DB already has rows, pass `newer_than=<max(created_at)>`.
 *      Otherwise omit — first-run backfill.
 *   4. If the response has exactly 200 rows, paginate using `older_than`
 *      until we see <200 or hit a 1000-row safety cap.
 *   5. Compute 11 denormalized derived fields (CT time math, moneyness,
 *      premium ratios, etc.) and upsert. ON CONFLICT (option_chain,
 *      created_at) DO NOTHING dedupes across overlapping cron windows.
 *
 * Detail-only UW fields (uw_alert_id, rule_id, bid, ask, iv_start, iv_end,
 * start_time, end_time) are left NULL — this cron only hits the list endpoint.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronGuard, uwFetch, withRetry } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// ── Types ────────────────────────────────────────────────────

export interface UwFlowAlert {
  alert_rule: string;
  all_opening_trades: boolean;
  created_at: string;
  expiry: string;
  expiry_count: number;
  has_floor: boolean;
  has_multileg: boolean;
  has_singleleg: boolean;
  has_sweep: boolean;
  issue_type: string;
  open_interest: number;
  option_chain: string;
  price: string;
  strike: string;
  ticker: string;
  total_ask_side_prem: string;
  total_bid_side_prem: string;
  total_premium: string;
  total_size: number;
  trade_count: number;
  type: string;
  underlying_price: string;
  volume: number;
  volume_oi_ratio: string;
}

interface DerivedFields {
  ask_side_ratio: number | null;
  bid_side_ratio: number | null;
  net_premium: number;
  dte_at_alert: number;
  distance_from_spot: number;
  distance_pct: number | null;
  moneyness: number | null;
  is_itm: boolean | null;
  minute_of_day: number;
  session_elapsed_min: number;
  day_of_week: number;
}

// ── Constants ────────────────────────────────────────────────

const PAGE_SIZE = 200;
const SAFETY_CAP = 1000;
const FLOW_ALERTS_PATH = '/option-trades/flow-alerts';
const SESSION_OPEN_MINUTE_CT = 510; // 08:30 CT = 8*60 + 30

// ── Derived-field computation ────────────────────────────────

/**
 * Extract hour/minute/day-of-week/date in America/Chicago TZ using
 * Intl.DateTimeFormat. Avoids DST bugs that plague manual offset math.
 */
function getCtParts(isoUtc: string): {
  hour: number;
  minute: number;
  dayOfWeek: number;
  dateStr: string;
} {
  const d = new Date(isoUtc);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number.parseInt(get('hour'), 10) % 24; // 24 → 0 guard
  const minute = Number.parseInt(get('minute'), 10);
  const weekdayMap: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  const dayOfWeek = weekdayMap[get('weekday')] ?? -1;
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  return { hour, minute, dayOfWeek, dateStr };
}

/** ISO date (YYYY-MM-DD) → epoch day number, for day-diff math. */
function isoDateToEpochDays(iso: string): number {
  const [y, m, d] = iso.split('-').map((p) => Number.parseInt(p, 10));
  // Date.UTC returns ms since epoch for that midnight UTC.
  return Math.floor(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

export function computeDerived(a: UwFlowAlert): DerivedFields {
  const totalPrem = Number.parseFloat(a.total_premium);
  const askPrem = Number.parseFloat(a.total_ask_side_prem);
  const bidPrem = Number.parseFloat(a.total_bid_side_prem);
  const strike = Number.parseFloat(a.strike);
  const spot = Number.parseFloat(a.underlying_price);

  const ask_side_ratio =
    Number.isFinite(totalPrem) && totalPrem > 0 ? askPrem / totalPrem : null;
  const bid_side_ratio =
    Number.isFinite(totalPrem) && totalPrem > 0 ? bidPrem / totalPrem : null;
  const net_premium = askPrem - bidPrem;

  const { hour, minute, dayOfWeek, dateStr } = getCtParts(a.created_at);
  const alertEpoch = isoDateToEpochDays(dateStr);
  const expiryEpoch = isoDateToEpochDays(a.expiry);
  const dte_at_alert = Math.max(0, expiryEpoch - alertEpoch);

  const distance_from_spot = strike - spot;
  const distance_pct =
    Number.isFinite(spot) && spot > 0 ? (strike - spot) / spot : null;
  const moneyness =
    Number.isFinite(strike) && strike > 0 ? spot / strike : null;

  let is_itm: boolean | null = null;
  if (
    Number.isFinite(strike) &&
    strike > 0 &&
    Number.isFinite(spot) &&
    spot > 0
  ) {
    if (a.type === 'call') is_itm = strike < spot;
    else if (a.type === 'put') is_itm = strike > spot;
  }

  const minute_of_day = hour * 60 + minute;
  const session_elapsed_min = minute_of_day - SESSION_OPEN_MINUTE_CT;

  return {
    ask_side_ratio,
    bid_side_ratio,
    net_premium,
    dte_at_alert,
    distance_from_spot,
    distance_pct,
    moneyness,
    is_itm,
    minute_of_day,
    session_elapsed_min,
    day_of_week: dayOfWeek,
  };
}

// ── UW fetch + pagination ────────────────────────────────────

function buildAlertsPath(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  qs.append('ticker_symbol', 'SPXW');
  qs.append('issue_types[]', 'Index');
  qs.append('rule_name[]', 'RepeatedHits');
  qs.append('rule_name[]', 'RepeatedHitsAscendingFill');
  qs.append('rule_name[]', 'RepeatedHitsDescendingFill');
  qs.append('min_dte', '0');
  qs.append('max_dte', '1');
  qs.append('limit', String(PAGE_SIZE));
  if (params.newer_than) qs.append('newer_than', params.newer_than);
  if (params.older_than) qs.append('older_than', params.older_than);
  return `${FLOW_ALERTS_PATH}?${qs.toString()}`;
}

async function fetchAllNewAlerts(
  apiKey: string,
  newerThan: string | null,
): Promise<UwFlowAlert[]> {
  const collected: UwFlowAlert[] = [];
  let olderThan: string | undefined;

  while (collected.length < SAFETY_CAP) {
    const path = buildAlertsPath({
      newer_than: newerThan ?? undefined,
      older_than: olderThan,
    });
    const batch = await withRetry(() => uwFetch<UwFlowAlert>(apiKey, path));
    collected.push(...batch);

    if (batch.length < PAGE_SIZE) break;

    // Paginate backwards from the oldest row in this batch.
    const oldest = batch.reduce(
      (acc, row) => (row.created_at < acc ? row.created_at : acc),
      batch[0]!.created_at,
    );
    olderThan = oldest;
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
      SELECT MAX(created_at) AS max_created_at FROM flow_alerts
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
        job: 'fetch-flow-alerts',
        fetched: 0,
        inserted: 0,
        durationMs: Date.now() - startedAt,
      });
    }

    // 3. Upsert each row.
    let inserted = 0;
    for (const a of alerts) {
      const d = computeDerived(a);
      const result = await db`
        INSERT INTO flow_alerts (
          alert_rule, ticker, issue_type, option_chain, strike, expiry, type,
          created_at, price, underlying_price,
          total_premium, total_ask_side_prem, total_bid_side_prem,
          total_size, trade_count, expiry_count, volume, open_interest, volume_oi_ratio,
          has_sweep, has_floor, has_multileg, has_singleleg, all_opening_trades,
          ask_side_ratio, bid_side_ratio, net_premium,
          dte_at_alert, distance_from_spot, distance_pct, moneyness, is_itm,
          minute_of_day, session_elapsed_min, day_of_week,
          raw_response
        ) VALUES (
          ${a.alert_rule}, ${a.ticker}, ${a.issue_type}, ${a.option_chain}, ${a.strike}, ${a.expiry}, ${a.type},
          ${a.created_at}, ${a.price}, ${a.underlying_price},
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
      'fetch-flow-alerts completed',
    );

    return res.status(200).json({
      job: 'fetch-flow-alerts',
      fetched: alerts.length,
      inserted,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-flow-alerts');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-flow-alerts error');
    return res.status(500).json({
      job: 'fetch-flow-alerts',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
