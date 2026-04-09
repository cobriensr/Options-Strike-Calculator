/**
 * GET /api/cron/fetch-gex-0dte
 *
 * Fetches per-strike Greek exposure for SPX 0DTE from Unusual Whales API
 * and stores it in the gex_strike_0dte table at the original timestamp
 * (no rounding — preserves minute precision from UW API).
 *
 * This powers the "0DTE GEX Per Strike" dashboard widget, storing:
 *   - OI-based gamma, charm, delta, vanna per strike
 *   - Volume-based gamma, charm, vanna (for vol vs OI reinforcement)
 *   - Directionalized gamma (bid/ask breakdown)
 *
 * Runs every minute during market hours (13-21 UTC, Mon-Fri) to power
 * the GEX migration component (5-min Δ and 20-min trend per strike).
 * ON CONFLICT DO NOTHING protects against duplicate writes if UW returns
 * the same snapshot timestamp on consecutive fetches.
 * Total API calls per invocation: 1 (0DTE only)
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  uwFetch,
  cronGuard,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';
import {
  loadSnapshotHistory,
  writeFeatureRows,
  type WriteFeatureRowsResult,
} from '../_lib/gex-target-features.js';

// Snapshot window required for multi-horizon feature extraction: the
// 60-minute horizon needs 60 prior snapshots plus the current one.
const FEATURE_HISTORY_SIZE = 61;

const ATM_RANGE = 200; // ±200 pts from ATM

// ── Types ───────────────────────────────────────────────────

interface StrikeRow {
  strike: string;
  price: string;
  time: string;
  call_gamma_oi: string;
  put_gamma_oi: string;
  call_gamma_vol: string;
  put_gamma_vol: string;
  call_gamma_ask: string;
  call_gamma_bid: string;
  put_gamma_ask: string;
  put_gamma_bid: string;
  call_charm_oi: string;
  put_charm_oi: string;
  call_charm_vol: string;
  put_charm_vol: string;
  call_delta_oi: string;
  put_delta_oi: string;
  call_vanna_oi: string;
  put_vanna_oi: string;
  call_vanna_vol: string;
  put_vanna_vol: string;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchStrike0dte(
  apiKey: string,
  expiry: string,
): Promise<StrikeRow[]> {
  const params = new URLSearchParams({
    'expirations[]': expiry,
    limit: '500',
  });

  return uwFetch<StrikeRow>(
    apiKey,
    `/stock/SPX/spot-exposures/expiry-strike?${params}`,
  );
}

// ── Store helper ────────────────────────────────────────────

async function storeStrikes(
  rows: StrikeRow[],
  today: string,
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const price = Number.parseFloat(rows[0]!.price);
  const minStrike = price - ATM_RANGE;
  const maxStrike = price + ATM_RANGE;

  const filtered = rows.filter((r) => {
    const s = Number.parseFloat(r.strike);
    return s >= minStrike && s <= maxStrike;
  });

  if (filtered.length === 0) return { stored: 0, skipped: 0 };

  // Use original timestamp (no rounding — minute precision)
  const timestamp = new Date(rows[0]!.time).toISOString();

  const sql = getDb();

  // Single multi-row INSERT: one HTTP round-trip instead of one-per-row.
  // Builds a parameterized statement of the form:
  //   INSERT INTO ... VALUES ($1,$2,...,$22),($23,$24,...,$44),...
  // with a flat params array aligned to COLUMNS_PER_ROW.
  const COLUMNS_PER_ROW = 22;
  const params: unknown[] = [];
  const valuesClauses: string[] = [];

  for (const row of filtered) {
    const base = params.length;
    const placeholders: string[] = [];
    for (let i = 1; i <= COLUMNS_PER_ROW; i++) {
      placeholders.push(`$${base + i}`);
    }
    valuesClauses.push(`(${placeholders.join(',')})`);
    params.push(
      today,
      timestamp,
      row.strike,
      row.price,
      row.call_gamma_oi,
      row.put_gamma_oi,
      row.call_gamma_vol,
      row.put_gamma_vol,
      row.call_gamma_ask,
      row.call_gamma_bid,
      row.put_gamma_ask,
      row.put_gamma_bid,
      row.call_charm_oi,
      row.put_charm_oi,
      row.call_charm_vol,
      row.put_charm_vol,
      row.call_delta_oi,
      row.put_delta_oi,
      row.call_vanna_oi,
      row.put_vanna_oi,
      row.call_vanna_vol,
      row.put_vanna_vol,
    );
  }

  const insertSql = `
    INSERT INTO gex_strike_0dte (
      date, timestamp, strike, price,
      call_gamma_oi, put_gamma_oi,
      call_gamma_vol, put_gamma_vol,
      call_gamma_ask, call_gamma_bid,
      put_gamma_ask, put_gamma_bid,
      call_charm_oi, put_charm_oi,
      call_charm_vol, put_charm_vol,
      call_delta_oi, put_delta_oi,
      call_vanna_oi, put_vanna_oi,
      call_vanna_vol, put_vanna_vol
    )
    VALUES ${valuesClauses.join(',')}
    ON CONFLICT (date, timestamp, strike) DO NOTHING
    RETURNING id
  `;

  try {
    const result = (await sql.query(insertSql, params)) as Array<{
      id: number;
    }>;
    const stored = result.length;
    return { stored, skipped: filtered.length - stored };
  } catch (err) {
    logger.warn({ err }, 'Batch gex_strike_0dte insert failed');
    metrics.increment('fetch_gex_0dte.batch_insert_error');
    Sentry.captureException(err);
    return { stored: 0, skipped: filtered.length };
  }
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    const rows = await withRetry(() => fetchStrike0dte(apiKey, today));

    if (rows.length === 0) {
      return res
        .status(200)
        .json({ stored: false, reason: 'No 0DTE strike data' });
    }

    const price = Number.parseFloat(rows[0]!.price);
    const result = await withRetry(() => storeStrikes(rows, today));

    logger.info(
      {
        total: rows.length,
        stored: result.stored,
        skipped: result.skipped,
        price,
        date: today,
      },
      'fetch-gex-0dte completed',
    );

    // Data quality check
    if (result.stored > 10) {
      const qcRows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (
                 WHERE call_gamma_oi::numeric != 0
                    OR put_gamma_oi::numeric != 0
               ) AS nonzero
        FROM gex_strike_0dte
        WHERE date = ${today}
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-gex-0dte',
        table: 'gex_strike_0dte',
        date: today,
        sourceFilter: '0DTE only',
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    // ── GexTarget features (Phase 4A) ────────────────────────
    //
    // Feature writes are non-blocking: any failure here is logged to
    // Sentry and the cron still returns 200 with the raw snapshot
    // counts populated. We deliberately do NOT short-circuit on feature
    // errors — the raw data pipeline must remain resilient to scoring
    // bugs.
    let featureStatus: WriteFeatureRowsResult | { error: true } | null = null;
    if (result.stored > 0) {
      const timestamp = new Date(rows[0]!.time).toISOString();
      try {
        const snapshots = await loadSnapshotHistory(
          today,
          timestamp,
          FEATURE_HISTORY_SIZE,
        );
        if (snapshots.length < 2) {
          logger.info(
            { snapshots: snapshots.length, date: today, timestamp },
            'fetch-gex-0dte: skipping feature writes (history < 2 snapshots)',
          );
        } else {
          const featureResult = await writeFeatureRows(
            snapshots,
            today,
            timestamp,
          );
          featureStatus = featureResult;
          logger.info(
            {
              date: today,
              timestamp,
              historyCount: snapshots.length,
              featuresWritten: featureResult.written,
              featuresSkipped: featureResult.skipped,
              modes: featureResult.modes,
            },
            'fetch-gex-0dte: gex_target_features written',
          );
        }
      } catch (featureErr) {
        featureStatus = { error: true };
        Sentry.setTag('cron.job', 'fetch-gex-0dte');
        Sentry.setTag('feature.phase', 'write');
        Sentry.captureException(featureErr);
        logger.error(
          { err: featureErr, date: today, timestamp },
          'fetch-gex-0dte: feature write threw unexpectedly',
        );
      }
    }

    const featureJson =
      featureStatus === null
        ? null
        : 'error' in featureStatus
          ? { error: true }
          : {
              written: featureStatus.written,
              skipped: featureStatus.skipped,
              modes: featureStatus.modes,
            };

    return res.status(200).json({
      job: 'fetch-gex-0dte',
      success: true,
      price,
      stored: result.stored,
      skipped: result.skipped,
      features: featureJson,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-gex-0dte');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-gex-0dte error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
