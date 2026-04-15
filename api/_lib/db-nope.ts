/**
 * NOPE (Net Options Pricing Effect) database operations.
 *
 * Reads nope_ticks for Claude's analyze context and the ML pipeline.
 * Writes happen only via the fetch-nope cron.
 */

import { getDb } from './db.js';

export interface NopeRow {
  ticker: string;
  timestamp: string;
  nope: number;
  nope_fill: number;
  call_delta: number;
  put_delta: number;
  call_fill_delta: number;
  put_fill_delta: number;
  call_vol: number;
  put_vol: number;
  stock_vol: number;
}

/**
 * Get the most recent N minutes of NOPE data for a ticker.
 *
 * @param ticker   e.g. 'SPY'
 * @param minutes  lookback window
 * @param asOf     optional upper bound (ISO timestamp). When provided, the
 *                 window is [asOf - minutes, asOf] instead of [now - minutes, now].
 *                 Required for backtest mode so queries are deterministic.
 */
export async function getRecentNope(
  ticker: string,
  minutes: number,
  asOf?: string,
): Promise<NopeRow[]> {
  const sql = getDb();
  const interval = `${minutes} minutes`;
  const rows = asOf
    ? await sql`
        SELECT ticker, timestamp,
               call_vol, put_vol, stock_vol,
               call_delta, put_delta, call_fill_delta, put_fill_delta,
               nope, nope_fill
        FROM nope_ticks
        WHERE ticker = ${ticker}
          AND timestamp >= ${asOf}::timestamptz - ${interval}::interval
          AND timestamp <= ${asOf}::timestamptz
        ORDER BY timestamp ASC
      `
    : await sql`
        SELECT ticker, timestamp,
               call_vol, put_vol, stock_vol,
               call_delta, put_delta, call_fill_delta, put_fill_delta,
               nope, nope_fill
        FROM nope_ticks
        WHERE ticker = ${ticker}
          AND timestamp >= NOW() - ${interval}::interval
        ORDER BY timestamp ASC
      `;
  return rows.map(mapRow);
}

/** Get the full session of NOPE data for a ticker (America/Chicago date). */
export async function getSessionNope(
  ticker: string,
  date: string,
): Promise<NopeRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT ticker, timestamp,
           call_vol, put_vol, stock_vol,
           call_delta, put_delta, call_fill_delta, put_fill_delta,
           nope, nope_fill
    FROM nope_ticks
    WHERE ticker = ${ticker}
      AND (timestamp AT TIME ZONE 'America/Chicago')::date = ${date}
    ORDER BY timestamp ASC
  `;
  return rows.map(mapRow);
}

function mapRow(r: Record<string, unknown>): NopeRow {
  const ts = r.timestamp;
  return {
    ticker: r.ticker as string,
    timestamp: ts instanceof Date ? ts.toISOString() : (ts as string),
    call_vol: Number(r.call_vol),
    put_vol: Number(r.put_vol),
    stock_vol: Number(r.stock_vol),
    call_delta: Number(r.call_delta),
    put_delta: Number(r.put_delta),
    call_fill_delta: Number(r.call_fill_delta),
    put_fill_delta: Number(r.put_fill_delta),
    nope: Number(r.nope),
    nope_fill: Number(r.nope_fill),
  };
}

/**
 * Format NOPE rows as a Claude-readable context block.
 *
 * NOPE interpretation (for prompt reference):
 *   - Positive NOPE → dealers hedge by buying stock (bullish tape pressure)
 *   - Negative NOPE → dealers hedge by selling stock (bearish tape pressure)
 *   - Sign flips mark regime shifts in intraday hedging demand
 *
 * @param rows - NOPE rows ordered by timestamp ascending
 * @returns Formatted text block, or null if empty
 */
export function formatNopeForClaude(rows: NopeRow[]): string | null {
  if (rows.length === 0) return null;
  const ticker = rows[0]!.ticker;

  const lines: string[] = [
    `${ticker} NOPE trajectory (1-min resolution, ${rows.length} samples):`,
  ];

  for (const row of rows) {
    const time = new Date(row.timestamp).toLocaleTimeString('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    lines.push(
      `  ${time} CT — NOPE: ${formatNope(row.nope)} (fill: ${formatNope(row.nope_fill)})`,
    );
  }

  if (rows.length >= 2) {
    const first = rows[0]!;
    const last = rows.at(-1)!;
    const delta = last.nope - first.nope;
    const dir = delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat';
    const minutes = Math.round(
      (new Date(last.timestamp).getTime() -
        new Date(first.timestamp).getTime()) /
        60_000,
    );

    let flips = 0;
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!.nope;
      const curr = rows[i]!.nope;
      if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) flips++;
    }

    const regimeLabel =
      last.nope > 0
        ? 'POSITIVE — dealers hedge by buying stock (bullish tape pressure)'
        : last.nope < 0
          ? 'NEGATIVE — dealers hedge by selling stock (bearish tape pressure)'
          : 'NEUTRAL';

    lines.push(
      `  Direction (${minutes} min): NOPE ${dir} (Δ ${formatNope(delta)})`,
      `  Sign flips: ${flips}`,
      `  Current regime: ${regimeLabel}`,
    );
  }

  return lines.join('\n');
}

function formatNope(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(6)}`;
}
