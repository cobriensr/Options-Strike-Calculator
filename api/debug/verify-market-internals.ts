/**
 * TEMPORARY verification endpoint.
 *
 * Verifies that Schwab pricehistory supports $TICK, $ADD, $VOLD as
 * symbols before we invest in building the full market-internals
 * cron + table + hook + component stack.
 *
 * Plan: docs/superpowers/specs/market-internals-2026-04-15.md
 *
 * Usage:
 *   npm run dev:full
 *   curl http://localhost:3000/api/debug/verify-market-internals
 *
 * DELETE this file once verified.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { schwabFetch } from '../_lib/api-helpers.js';

interface SchwabCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number;
}

interface SchwabPriceHistory {
  symbol: string;
  empty: boolean;
  candles: SchwabCandle[];
}

interface SymbolResult {
  symbol: string;
  ok: boolean;
  status?: number;
  empty?: boolean;
  candleCount?: number;
  firstCandle?: SchwabCandle;
  lastCandle?: SchwabCandle;
  error?: string;
}

const SYMBOLS = ['$TICK', '$ADD', '$VOLD', '$TICKQ', '$TRIN'];

async function verifySymbol(symbol: string): Promise<SymbolResult> {
  const endMs = Date.now();
  const startMs = endMs - 24 * 60 * 60 * 1000; // last 24h

  const params = new URLSearchParams({
    symbol,
    periodType: 'day',
    frequencyType: 'minute',
    frequency: '1',
    startDate: String(startMs),
    endDate: String(endMs),
    needExtendedHoursData: 'false',
    needPreviousClose: 'false',
  });

  try {
    const result = await schwabFetch<SchwabPriceHistory>(
      `/pricehistory?${params.toString()}`,
    );

    if (!result.ok) {
      return { symbol, ok: false, status: result.status, error: result.error };
    }

    return {
      symbol,
      ok: true,
      empty: result.data.empty,
      candleCount: result.data.candles.length,
      firstCandle: result.data.candles[0],
      lastCandle: result.data.candles.at(-1),
    };
  } catch (err) {
    return {
      symbol,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
) {
  const results = await Promise.all(SYMBOLS.map(verifySymbol));

  res.status(200).json({
    verifiedAt: new Date().toISOString(),
    results,
    summary: {
      supported: results.filter((r) => r.ok && !r.empty).map((r) => r.symbol),
      empty: results.filter((r) => r.ok && r.empty).map((r) => r.symbol),
      failed: results
        .filter((r) => !r.ok)
        .map((r) => ({
          symbol: r.symbol,
          status: r.status,
          error: r.error,
        })),
    },
  });
}
