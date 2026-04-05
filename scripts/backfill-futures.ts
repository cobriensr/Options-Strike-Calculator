#!/usr/bin/env npx tsx

/**
 * One-time historical backfill for futures_bars using Databento HTTP API.
 *
 * Fetches 1-minute OHLCV bars for the configured symbols over the
 * specified lookback window, then bulk-inserts into the futures_bars
 * table with ON CONFLICT DO NOTHING (safe to re-run).
 *
 * Usage:
 *   npx tsx scripts/backfill-futures.ts
 *   npx tsx scripts/backfill-futures.ts --symbols ES,NQ --days 60
 *
 * Env:
 *   DATABENTO_API_KEY  — required
 *   DATABASE_URL       — required (Neon connection string)
 */

import { neon } from '@neondatabase/serverless';

// ── Config ─────────────────────────────────────────────────────

const DEFAULT_SYMBOLS = ['ES', 'NQ', 'VXM', 'ZN', 'RTY', 'CL'];
const DEFAULT_DAYS = 252; // ~1 trading year

interface BackfillConfig {
  symbols: string[];
  days: number;
  apiKey: string;
  databaseUrl: string;
}

// ── Databento symbol mapping ───────────────────────────────────
// Maps our internal symbol names to Databento continuous contract
// root symbols. Actual dataset + stype_in values will need to be
// confirmed against the Databento API docs during implementation.

const DATABENTO_SYMBOL_MAP: Record<string, string> = {
  ES: 'ES.FUT',
  NQ: 'NQ.FUT',
  VXM: 'VXM.FUT', // Micro VIX front month
  ZN: 'ZN.FUT',
  RTY: 'RTY.FUT',
  CL: 'CL.FUT',
};

// ── CLI arg parsing ────────────────────────────────────────────

function parseArgs(): BackfillConfig {
  const args = process.argv.slice(2);
  let symbols = DEFAULT_SYMBOLS;
  let days = DEFAULT_DAYS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--symbols' && args[i + 1]) {
      symbols = args[i + 1].split(',').map((s) => s.trim());
      i++;
    } else if (arg === '--days' && args[i + 1]) {
      days = Number.parseInt(args[i + 1], 10);
      if (Number.isNaN(days) || days < 1) {
        console.error('--days must be a positive integer');
        process.exit(1);
      }
      i++;
    }
  }

  const apiKey = process.env.DATABENTO_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;

  if (!apiKey) {
    console.error('Missing DATABENTO_API_KEY env var');
    process.exit(1);
  }
  if (!databaseUrl) {
    console.error('Missing DATABASE_URL env var');
    process.exit(1);
  }

  return { symbols, days, apiKey, databaseUrl };
}

// ── Date helpers ───────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Generate month-boundary date ranges covering the lookback window.
 * Pulls data in 1-month chunks to stay within API limits.
 */
function getMonthChunks(
  days: number,
): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() - 1); // yesterday (most recent complete day)

  const earliest = new Date(now);
  earliest.setDate(earliest.getDate() - days);

  let chunkEnd = new Date(end);
  while (chunkEnd > earliest) {
    const chunkStart = new Date(chunkEnd);
    chunkStart.setMonth(chunkStart.getMonth() - 1);
    chunkStart.setDate(chunkStart.getDate() + 1);

    const effectiveStart =
      chunkStart < earliest ? earliest : chunkStart;

    chunks.push({
      start: formatDate(effectiveStart),
      end: formatDate(chunkEnd),
    });

    chunkEnd = new Date(effectiveStart);
    chunkEnd.setDate(chunkEnd.getDate() - 1);
  }

  return chunks.reverse(); // chronological order
}

// ── Databento API types ────────────────────────────────────────

// [Databento] Confirm exact response shape from the HTTP API.
// The timeseries.get_range endpoint returns records in the
// requested schema format. For OHLCV-1m, each record has:
interface DatabentoBarsResponse {
  records?: DabentoOhlcvRecord[];
}

// [Databento] Confirm field names from Databento docs.
// Prices are int64 in 1e-9 units (nanodollars).
interface DabentoOhlcvRecord {
  ts_event: string; // ISO timestamp or nanosecond epoch
  open: number; // nanodollar price
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Databento HTTP API calls ───────────────────────────────────

const DATABENTO_BASE = 'https://hist.databento.com/v0';
const NANODOLLAR = 1_000_000_000;

/**
 * Fetch OHLCV-1m bars for a single symbol over a date range.
 *
 * [Databento] The exact endpoint path, query parameters, and auth
 * mechanism need to be confirmed against the Databento HTTP API
 * documentation. The structure below is a best-effort placeholder
 * based on the known API patterns.
 *
 * Databento HTTP Historical API uses:
 *   POST /v0/timeseries.get_range
 *   Auth: Basic auth with API key as password
 *   Body: JSON with dataset, symbols, schema, start, end, stype_in
 */
async function fetchBars(
  symbol: string,
  start: string,
  end: string,
  apiKey: string,
): Promise<
  Array<{
    ts: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>
> {
  const databentoSymbol = DATABENTO_SYMBOL_MAP[symbol] ?? symbol;

  // [Databento] Confirm dataset name — CME futures use 'GLBX.MDP3'
  // VXM may use 'XCFE.TC' (CFE exchange)
  const dataset =
    symbol === 'VXM' ? 'XCFE.TC' : 'GLBX.MDP3';

  const body = {
    dataset,
    symbols: databentoSymbol,
    schema: 'ohlcv-1m',
    start: `${start}T00:00:00.000000000Z`,
    end: `${end}T23:59:59.999999999Z`,
    stype_in: 'continuous',
    encoding: 'json',
  };

  // [Databento] Confirm auth mechanism — Databento uses API key as
  // Basic auth password with empty username
  const encodedKey = Buffer.from(`:${apiKey}`).toString('base64');
  const authHeader = `Basic ${encodedKey}`;

  const res = await fetch(
    `${DATABENTO_BASE}/timeseries.get_range`,
    {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  Databento API ${res.status} for ${symbol} ` +
        `${start}\u2013${end}: ${text.slice(0, 200)}`,
    );
    return [];
  }

  const data = (await res.json()) as DatabentoBarsResponse;
  const records = data.records ?? [];

  // [Databento] Confirm price format — Databento uses 1e-9
  // (nanodollar) prices as int64. The JSON encoding may return
  // these as numbers or strings. Verify and adjust accordingly.
  return records.map((r) => ({
    ts: r.ts_event,
    open: r.open / NANODOLLAR,
    high: r.high / NANODOLLAR,
    low: r.low / NANODOLLAR,
    close: r.close / NANODOLLAR,
    volume: r.volume,
  }));
}

// ── Database insertion ─────────────────────────────────────────

/**
 * Bulk-insert bars into futures_bars.
 *
 * Neon's serverless driver supports tagged template queries but
 * not multi-row VALUES in a single template literal. We insert in
 * batches of 500 rows using individual INSERT ... ON CONFLICT
 * statements to keep memory usage reasonable.
 */
async function insertBars(
  sql: ReturnType<typeof neon>,
  symbol: string,
  bars: Array<{
    ts: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>,
): Promise<number> {
  let inserted = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < bars.length; i += BATCH_SIZE) {
    const batch = bars.slice(i, i + BATCH_SIZE);
    const promises = batch.map((bar) =>
      sql`
        INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
        VALUES (
          ${symbol},
          ${bar.ts},
          ${bar.open},
          ${bar.high},
          ${bar.low},
          ${bar.close},
          ${bar.volume}
        )
        ON CONFLICT (symbol, ts) DO NOTHING
      `,
    );

    await Promise.all(promises);
    inserted += batch.length;
  }

  return inserted;
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();
  const sql = neon(config.databaseUrl);
  const chunks = getMonthChunks(config.days);

  console.log(
    `Backfilling ${config.symbols.join(', ')} ` +
      `over ${config.days} days (${chunks.length} month chunks)`,
  );
  console.log();

  let grandTotal = 0;

  for (const symbol of config.symbols) {
    console.log(`── ${symbol} ──`);
    let symbolTotal = 0;

    for (const chunk of chunks) {
      const bars = await fetchBars(
        symbol,
        chunk.start,
        chunk.end,
        config.apiKey,
      );

      if (bars.length === 0) {
        console.log(`  ${chunk.start} → ${chunk.end}: 0 bars`);
        continue;
      }

      const count = await insertBars(sql, symbol, bars);
      symbolTotal += count;
      console.log(
        `  ${chunk.start} → ${chunk.end}: ` +
          `${count} bars inserted`,
      );

      // Small delay between chunks to be respectful of rate limits
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
    }

    console.log(`  Total: ${symbolTotal} bars`);
    console.log();
    grandTotal += symbolTotal;
  }

  console.log(`Done. ${grandTotal} total bars inserted.`);
}

main().catch((err: unknown) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
