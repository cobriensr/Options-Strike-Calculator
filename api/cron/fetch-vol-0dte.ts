/**
 * GET /api/cron/fetch-vol-0dte
 *
 * Fetches raw per-strike call and put volume for SPX 0DTE from the Unusual
 * Whales `/stock/SPX/option-contracts` endpoint and stores it in
 * `volume_per_strike_0dte` at the snapshot timestamp.
 *
 * This powers the "TOP VOLUME MAGNETS" panel, which surfaces the single
 * highest-put-volume strike and highest-call-volume strike — the two
 * intraday "magnets" that 0DTE price action gravitates toward.
 *
 * Runs every minute during market hours (13-21 UTC, Mon-Fri) to give the
 * frontend per-minute snapshots for 5-min Δ and 20-min trend sparklines.
 * ON CONFLICT DO NOTHING protects against duplicate writes on retries.
 *
 * Unlike /spot-exposures/expiry-strike (which only returns Greek×volume
 * products), /option-contracts returns each contract's raw `volume` and
 * `open_interest` counts. We parse the OCC `option_symbol` to extract
 * strike and type, then aggregate per strike.
 *
 * Total API calls per invocation: 1 (strict 0DTE via expiry param)
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
  cronJitter,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';

// ── Types ───────────────────────────────────────────────────

interface OptionContractRow {
  option_symbol: string;
  volume: number | string;
  open_interest: number | string;
}

interface AggregatedStrike {
  strike: number;
  call_volume: number;
  put_volume: number;
  call_oi: number;
  put_oi: number;
}

// ── Fetch helper ────────────────────────────────────────────

/**
 * Fetches all 0DTE option contracts for SPX with non-zero volume.
 *
 * UW returns contracts sorted by volume descending, so limit=500 is a
 * generous ceiling — typical SPX 0DTE sessions have 200-400 contracts with
 * volume > 0, all of which fit in a single page.
 */
async function fetchOptionContracts0dte(
  apiKey: string,
  expiry: string,
): Promise<OptionContractRow[]> {
  const params = new URLSearchParams({
    expiry,
    exclude_zero_vol_chains: 'true',
    limit: '500',
  });

  return uwFetch<OptionContractRow>(
    apiKey,
    `/stock/SPX/option-contracts?${params}`,
  );
}

// ── Parsing ─────────────────────────────────────────────────

/**
 * Parses an OCC option symbol into its structural parts.
 *
 * OCC format: `{UNDERLYING}{YYMMDD}{C|P}{STRIKE×1000 as 8-digit int}`
 * Example: `SPXW260408C06800000` → strike 6800, type 'C', expiry 260408.
 *
 * Fixed-width fields are extracted via `slice` rather than regex — faster
 * and more robust. Returns null if the symbol is malformed.
 */
export function parseOptionSymbol(
  symbol: string,
): { strike: number; type: 'C' | 'P' } | null {
  if (!symbol || symbol.length < 15) return null;
  const typeChar = symbol.slice(-9, -8);
  if (typeChar !== 'C' && typeChar !== 'P') return null;
  const strikeRaw = Number.parseInt(symbol.slice(-8), 10);
  if (!Number.isFinite(strikeRaw) || strikeRaw <= 0) return null;
  return { strike: strikeRaw / 1000, type: typeChar };
}

/**
 * Aggregates per-contract rows into per-strike rows, summing call and put
 * volume and open interest separately.
 *
 * Unparseable symbols are silently skipped — a malformed row should not
 * prevent the rest of the snapshot from being stored.
 */
export function aggregateByStrike(
  rows: OptionContractRow[],
): AggregatedStrike[] {
  const byStrike = new Map<number, AggregatedStrike>();

  for (const row of rows) {
    const parsed = parseOptionSymbol(row.option_symbol);
    if (!parsed) {
      metrics.increment('fetch_vol_0dte.symbol_parse_error');
      continue;
    }

    const volume = Number(row.volume) || 0;
    const oi = Number(row.open_interest) || 0;

    const existing = byStrike.get(parsed.strike);
    if (existing) {
      if (parsed.type === 'C') {
        existing.call_volume += volume;
        existing.call_oi += oi;
      } else {
        existing.put_volume += volume;
        existing.put_oi += oi;
      }
    } else {
      byStrike.set(parsed.strike, {
        strike: parsed.strike,
        call_volume: parsed.type === 'C' ? volume : 0,
        put_volume: parsed.type === 'P' ? volume : 0,
        call_oi: parsed.type === 'C' ? oi : 0,
        put_oi: parsed.type === 'P' ? oi : 0,
      });
    }
  }

  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

// ── Store helper ────────────────────────────────────────────

async function storeStrikes(
  aggregated: AggregatedStrike[],
  today: string,
  timestamp: string,
): Promise<{ stored: number; skipped: number }> {
  if (aggregated.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();

  try {
    const results = await sql.transaction((txn) =>
      aggregated.map(
        (row) => txn`
          INSERT INTO volume_per_strike_0dte (
            date, timestamp, strike,
            call_volume, put_volume,
            call_oi, put_oi
          )
          VALUES (
            ${today}, ${timestamp}, ${row.strike},
            ${row.call_volume}, ${row.put_volume},
            ${row.call_oi}, ${row.put_oi}
          )
          ON CONFLICT (date, timestamp, strike) DO NOTHING
          RETURNING id
        `,
      ),
    );

    let stored = 0;
    for (const result of results) {
      if (result.length > 0) stored++;
    }
    return { stored, skipped: aggregated.length - stored };
  } catch (err) {
    logger.warn({ err }, 'Batch volume_per_strike_0dte insert failed');
    return { stored: 0, skipped: aggregated.length };
  }
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  await cronJitter();

  const startTime = Date.now();

  try {
    const rows = await withRetry(() => fetchOptionContracts0dte(apiKey, today));

    if (rows.length === 0) {
      await reportCronRun('fetch-vol-0dte', {
        status: 'skipped',
        reason: 'No 0DTE contracts with volume',
        durationMs: Date.now() - startTime,
      });
      return res
        .status(200)
        .json({ stored: false, reason: 'No 0DTE contracts with volume' });
    }

    const aggregated = aggregateByStrike(rows);

    // Snapshot at the minute boundary — UW returns cumulative day-total
    // volume per contract, so each row we store is "today's total as of T".
    // The frontend computes deltas by diffing adjacent minute rows.
    const timestamp = new Date().toISOString();

    const result = await withRetry(() =>
      storeStrikes(aggregated, today, timestamp),
    );

    logger.info(
      {
        contracts: rows.length,
        strikes: aggregated.length,
        stored: result.stored,
        skipped: result.skipped,
        date: today,
      },
      'fetch-vol-0dte completed',
    );

    // Data quality check — alert if we stored many rows but all volume is
    // zero, which would indicate a UW upstream issue or parse regression.
    if (result.stored > 10) {
      const qcRows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (
                 WHERE call_volume != 0 OR put_volume != 0
               ) AS nonzero
        FROM volume_per_strike_0dte
        WHERE date = ${today}
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-vol-0dte',
        table: 'volume_per_strike_0dte',
        date: today,
        sourceFilter: '0DTE only',
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    await reportCronRun('fetch-vol-0dte', {
      status: 'ok',
      contracts: rows.length,
      strikes: aggregated.length,
      stored: result.stored,
      skipped: result.skipped,
      durationMs: Date.now() - startTime,
    });
    return res.status(200).json({
      job: 'fetch-vol-0dte',
      success: true,
      contracts: rows.length,
      strikes: aggregated.length,
      stored: result.stored,
      skipped: result.skipped,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-vol-0dte');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-vol-0dte error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
