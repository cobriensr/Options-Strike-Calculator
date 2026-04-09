/**
 * GET /api/cron/backfill-futures-gaps
 *
 * Daily gap-fill: fetches the last 2 days of OHLCV-1m bars from the
 * Databento historical API and upserts into futures_bars. Patches any
 * gaps caused by sidecar restarts, deploys, or network issues.
 *
 * Uses ON CONFLICT DO NOTHING so duplicate bars are harmless.
 *
 * Schedule: daily at 06:00 UTC (1 AM ET, after CME maintenance window)
 *
 * Environment: CRON_SECRET, DATABENTO_API_KEY
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { checkDataQuality, cronGuard } from '../_lib/api-helpers.js';

// ── Constants ───────────────────────────────────────────────

const DATABENTO_BASE = 'https://hist.databento.com/v0';
const NANODOLLAR = 1_000_000_000;
const MAX_PRICE = 99_999_999; // NUMERIC(12,4) limit

const SYMBOLS: Record<string, { continuous: string; dataset: string }> = {
  ES: { continuous: 'ES.c.0', dataset: 'GLBX.MDP3' },
  NQ: { continuous: 'NQ.c.0', dataset: 'GLBX.MDP3' },
  ZN: { continuous: 'ZN.c.0', dataset: 'GLBX.MDP3' },
  RTY: { continuous: 'RTY.c.0', dataset: 'GLBX.MDP3' },
  CL: { continuous: 'CL.c.0', dataset: 'GLBX.MDP3' },
  GC: { continuous: 'GC.c.0', dataset: 'GLBX.MDP3' },
  DX: { continuous: 'DX.c.0', dataset: 'IFUS.IMPACT' },
};

// Reasonable price bounds to filter spread/combo bars [min, max]
const PRICE_BOUNDS: Record<string, [number, number]> = {
  ES: [1000, 20000],
  NQ: [5000, 50000],
  ZN: [50, 200],
  RTY: [500, 10000],
  CL: [20, 250],
  GC: [500, 10000],
  DX: [70, 150],
};

interface OhlcvRecord {
  hd: { ts_event: string };
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

// ── Databento fetch ─────────────────────────────────────────

interface FetchBarsResult {
  bars: Array<{
    ts: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  rejected: number;
}

async function fetchBars(
  symbol: string,
  cfg: { continuous: string; dataset: string },
  start: string,
  end: string,
  apiKey: string,
): Promise<FetchBarsResult> {
  const formBody = new URLSearchParams({
    dataset: cfg.dataset,
    symbols: cfg.continuous,
    schema: 'ohlcv-1m',
    start: `${start}T00:00:00.000000000Z`,
    end: `${end}T23:59:59.999999999Z`,
    stype_in: 'continuous',
    encoding: 'json',
  });

  const encodedKey = Buffer.from(`${apiKey}:`).toString('base64');

  const res = await fetch(`${DATABENTO_BASE}/timeseries.get_range`, {
    method: 'POST',
    headers: { Authorization: `Basic ${encodedKey}` },
    body: formBody,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn(
      { symbol, status: res.status },
      'Databento API error: %s',
      text.slice(0, 200),
    );
    return { bars: [], rejected: 0 };
  }

  const text = await res.text();
  if (!text.trim()) return { bars: [], rejected: 0 };

  const parsed = text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as OhlcvRecord)
    .map((r) => ({
      ts: new Date(Number(BigInt(r.hd.ts_event) / 1_000_000n)).toISOString(),
      open: Number(r.open) / NANODOLLAR,
      high: Number(r.high) / NANODOLLAR,
      low: Number(r.low) / NANODOLLAR,
      close: Number(r.close) / NANODOLLAR,
      volume: Number(r.volume),
    }));

  const bars: FetchBarsResult['bars'] = [];
  let rejected = 0;

  for (const r of parsed) {
    // Filter overflow (INT64_MAX sentinel) — corrupted tick, not a silent
    // Databento drift. Count it and log so gaps are visible.
    if (
      Math.abs(r.open) > MAX_PRICE ||
      Math.abs(r.high) > MAX_PRICE ||
      Math.abs(r.low) > MAX_PRICE ||
      Math.abs(r.close) > MAX_PRICE
    ) {
      rejected += 1;
      logger.warn(
        { symbol, ts: r.ts, close: r.close, reason: 'overflow' },
        'backfill-futures-gaps: rejected bar (overflow)',
      );
      continue;
    }

    // Filter spread/combo bars using per-symbol price bounds. A silent
    // continue here used to hide Databento tick-scale shifts — log with
    // structured fields so cascading ML-pipeline gaps become visible.
    const bounds = PRICE_BOUNDS[symbol];
    if (bounds) {
      const [lo, hi] = bounds;
      if (r.close < lo || r.close > hi || r.low < lo * 0.5) {
        rejected += 1;
        logger.warn(
          {
            symbol,
            ts: r.ts,
            close: r.close,
            low: r.low,
            bounds: [lo, hi],
          },
          'backfill-futures-gaps: rejected bar (out of bounds)',
        );
        continue;
      }
    }

    bars.push(r);
  }

  return { bars, rejected };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // No market hours check — runs daily regardless of day
  const guard = cronGuard(req, res, {
    requireApiKey: false,
    marketHours: false,
  });
  if (!guard) return;

  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    logger.error('DATABENTO_API_KEY not configured');
    return res.status(500).json({ error: 'Missing DATABENTO_API_KEY' });
  }

  const sql = getDb();
  const startTime = Date.now();

  // Fill last 2 days to cover any gaps from sidecar restarts
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);

  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const results: Array<{ symbol: string; inserted: number }> = [];
  const rejectedBySymbol: Record<string, number> = {};
  const errors: string[] = [];

  for (const [symbol, cfg] of Object.entries(SYMBOLS)) {
    try {
      const { bars, rejected } = await fetchBars(
        symbol,
        cfg,
        startStr,
        endStr,
        apiKey,
      );
      rejectedBySymbol[symbol] = rejected;

      if (bars.length === 0) {
        results.push({ symbol, inserted: 0 });
        // Even when nothing passed the filter, surface the quality signal so
        // a total Databento drift (all bars rejected) alerts via Sentry.
        await checkDataQuality({
          job: 'backfill-futures-gaps',
          table: 'futures_bars',
          date: endStr,
          sourceFilter: `symbol=${symbol}`,
          total: rejected,
          nonzero: 0,
        });
        continue;
      }

      // Batch insert with ON CONFLICT DO NOTHING
      const BATCH_SIZE = 100;
      let inserted = 0;

      for (let i = 0; i < bars.length; i += BATCH_SIZE) {
        const batch = bars.slice(i, i + BATCH_SIZE);
        const values = batch
          .map(
            (bar) =>
              `('${symbol}', '${bar.ts}', ${bar.open}, ${bar.high}, ${bar.low}, ${bar.close}, ${bar.volume})`,
          )
          .join(',\n');

        await sql.query(
          `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
           VALUES ${values}
           ON CONFLICT (symbol, ts) DO NOTHING`,
        );
        inserted += batch.length;
      }

      results.push({ symbol, inserted });

      // NOTE: We do NOT call checkDataQuality here. Reaching this point
      // means bars.length > 0 AND at least one batch landed, so
      // inserted > 0 by construction. checkDataQuality's "all-zero"
      // alert condition (nonzero === 0) can never trigger from this
      // branch. The drift signal we care about — "Databento returned
      // data but every bar was filtered out" — is handled by the
      // bars.length === 0 branch above with (total: rejected, nonzero: 0).
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`${symbol}: ${msg}`);
      rejectedBySymbol[symbol] = rejectedBySymbol[symbol] ?? 0;
      logger.warn({ symbol, err }, 'Gap-fill failed for symbol');
      metrics.increment('backfill_futures_gaps.symbol_error');
      Sentry.captureException(err);
    }
  }

  const totalInserted = results.reduce((sum, r) => sum + r.inserted, 0);
  const totalRejected = Object.values(rejectedBySymbol).reduce(
    (sum, n) => sum + n,
    0,
  );

  logger.info(
    {
      startStr,
      endStr,
      totalInserted,
      totalRejected,
      rejectedBySymbol,
      symbols: results,
      errors: errors.length,
    },
    'backfill-futures-gaps completed',
  );

  return res.status(200).json({
    job: 'backfill-futures-gaps',
    range: `${startStr} to ${endStr}`,
    totalInserted,
    totalRejected,
    rejected: rejectedBySymbol,
    symbols: results,
    errors: errors.length > 0 ? errors : undefined,
    durationMs: Date.now() - startTime,
  });
}
