/**
 * GET /api/cron/fetch-whale-alerts
 *
 * Fetches UW whale-sized options flow alerts (≥ $500K premium) for 0-14 DTE
 * across all 7 whale tickers — SPX, SPXW, NDX, NDXP (Index) and QQQ, SPY,
 * IWM (ETF). Scheduled every 5 minutes during market hours. Upserts into
 * whale_alerts. The downstream `detect-whales` cron then classifies these
 * rows against the whale-detection checklist.
 *
 * Strategy:
 *   1. Read MAX(created_at) per ticker from whale_alerts to scope each
 *      request independently (a ticker with sparse activity should not be
 *      held back by a more active one's last-seen cursor).
 *   2. For each ticker, call UW with min_premium=500000, min_dte=0,
 *      max_dte=14, limit=200, plus a per-ticker `newer_than` if known.
 *   3. Paginate per-ticker via `older_than` until <200 rows or the
 *      per-ticker safety cap.
 *   4. Combine results, compute derived fields, upsert into whale_alerts
 *      with ON CONFLICT (option_chain, created_at) DO NOTHING.
 *
 * Rate budget: 7 tickers × ~1 page typical = ~7 calls per cron run, well
 * under UW limits. Spike days may double this if any ticker fully fills.
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
const SAFETY_CAP_PER_TICKER = 1000;
const MIN_PREMIUM = 500_000;
const MAX_DTE = 14; // Whale checklist DTE cap.
const WHALE_ALERTS_PATH = '/option-trades/flow-alerts';

/**
 * Ticker → UW issue_type mapping for the 7 whale-checklist tickers.
 * Index tickers are SPX/SPXW/NDX/NDXP; ETFs are QQQ/SPY/IWM.
 * Order chosen so the heaviest tickers (SPXW, SPY, QQQ) fetch first —
 * if we ever bump into the safety cap mid-run, the most-trafficked names
 * still get refreshed.
 */
export const WHALE_TICKERS = [
  { ticker: 'SPXW', issueType: 'Index' },
  { ticker: 'SPY', issueType: 'ETF' },
  { ticker: 'QQQ', issueType: 'ETF' },
  { ticker: 'NDXP', issueType: 'Index' },
  { ticker: 'IWM', issueType: 'ETF' },
  { ticker: 'SPX', issueType: 'Index' },
  { ticker: 'NDX', issueType: 'Index' },
] as const;

// ── UW fetch + pagination ────────────────────────────────────

function buildWhaleAlertsPath(
  ticker: string,
  issueType: string,
  params: Record<string, string | undefined>,
): string {
  const qs = new URLSearchParams();
  qs.append('ticker_symbol', ticker);
  qs.append('issue_types[]', issueType);
  // Intentionally NO rule_name[] filter — whale flow spans all rule types.
  qs.append('min_dte', '0');
  qs.append('max_dte', String(MAX_DTE));
  qs.append('min_premium', String(MIN_PREMIUM));
  qs.append('limit', String(PAGE_SIZE));
  if (params.newer_than) qs.append('newer_than', params.newer_than);
  if (params.older_than) qs.append('older_than', params.older_than);
  return `${WHALE_ALERTS_PATH}?${qs.toString()}`;
}

async function fetchAllNewAlertsForTicker(
  apiKey: string,
  ticker: string,
  issueType: string,
  newerThan: string | null,
): Promise<UwFlowAlert[]> {
  const collected: UwFlowAlert[] = [];
  let olderThan: string | undefined;

  while (collected.length < SAFETY_CAP_PER_TICKER) {
    const path = buildWhaleAlertsPath(ticker, issueType, {
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

  return collected.slice(0, SAFETY_CAP_PER_TICKER);
}

// ── Handler ──────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey } = guard;
  const startedAt = Date.now();

  try {
    const db = getDb();

    // 1. Per-ticker MAX(created_at) so each ticker's cursor is independent.
    const cursorRows = (await db`
      SELECT ticker, MAX(created_at) AS max_created_at
      FROM whale_alerts
      WHERE ticker = ANY(${WHALE_TICKERS.map((t) => t.ticker)})
      GROUP BY ticker
    `) as { ticker: string; max_created_at: string | Date | null }[];

    const cursorByTicker = new Map<string, string | null>();
    for (const row of cursorRows) {
      const ts =
        row.max_created_at instanceof Date
          ? row.max_created_at.toISOString()
          : (row.max_created_at ?? null);
      cursorByTicker.set(row.ticker, ts);
    }

    // 2. Fetch each ticker independently.
    const allAlerts: UwFlowAlert[] = [];
    const fetchedByTicker: Record<string, number> = {};
    for (const { ticker, issueType } of WHALE_TICKERS) {
      const newerThan = cursorByTicker.get(ticker) ?? null;
      const alerts = await fetchAllNewAlertsForTicker(
        apiKey,
        ticker,
        issueType,
        newerThan,
      );
      allAlerts.push(...alerts);
      fetchedByTicker[ticker] = alerts.length;
    }

    if (allAlerts.length === 0) {
      return res.status(200).json({
        job: 'fetch-whale-alerts',
        fetched: 0,
        inserted: 0,
        fetchedByTicker,
        durationMs: Date.now() - startedAt,
      });
    }

    // 3. Upsert each row.
    let inserted = 0;
    for (const a of allAlerts) {
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
      { fetched: allAlerts.length, inserted, fetchedByTicker },
      'fetch-whale-alerts completed',
    );

    return res.status(200).json({
      job: 'fetch-whale-alerts',
      fetched: allAlerts.length,
      inserted,
      fetchedByTicker,
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
