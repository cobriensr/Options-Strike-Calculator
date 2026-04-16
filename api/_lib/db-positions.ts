/**
 * Position-related database operations.
 *
 * Handles saving and querying live Schwab 0DTE SPX positions.
 */

import { getDb } from './db.js';

// ============================================================
// TYPES
// ============================================================

export interface PositionLeg {
  putCall: 'PUT' | 'CALL';
  symbol: string;
  strike: number;
  expiration: string;
  quantity: number;
  averagePrice: number;
  marketValue: number;
  delta?: number | undefined;
  theta?: number | undefined;
  gamma?: number | undefined;
}

export interface PositionInput {
  date: string;
  fetchTime: string;
  accountHash: string;
  spxPrice?: number;
  summary: string;
  legs: PositionLeg[];
  totalSpreads?: number;
  callSpreads?: number;
  putSpreads?: number;
  netDelta?: number;
  netTheta?: number;
  netGamma?: number;
  totalCredit?: number;
  currentValue?: number;
  unrealizedPnl?: number;
  snapshotId?: number | null;
}

// ============================================================
// POSITIONS (live Schwab 0DTE SPX)
// ============================================================

/**
 * Save current positions. Uses ON CONFLICT DO UPDATE so re-fetching
 * the same date+time replaces the previous snapshot.
 */
export async function savePositions(
  input: PositionInput,
): Promise<number | null> {
  const sql = getDb();

  const result = await sql`
    INSERT INTO positions (
      snapshot_id, date, fetch_time, account_hash, spx_price,
      summary, legs,
      total_spreads, call_spreads, put_spreads,
      net_delta, net_theta, net_gamma,
      total_credit, current_value, unrealized_pnl
    ) VALUES (
      ${input.snapshotId ?? null},
      ${input.date}, ${input.fetchTime}, ${input.accountHash},
      ${input.spxPrice ?? null},
      ${input.summary}, ${JSON.stringify(input.legs)},
      ${input.totalSpreads ?? 0}, ${input.callSpreads ?? 0}, ${input.putSpreads ?? 0},
      ${input.netDelta ?? null}, ${input.netTheta ?? null}, ${input.netGamma ?? null},
      ${input.totalCredit ?? null}, ${input.currentValue ?? null}, ${input.unrealizedPnl ?? null}
    )
    ON CONFLICT (date, fetch_time) DO UPDATE SET
      snapshot_id = EXCLUDED.snapshot_id,
      account_hash = EXCLUDED.account_hash,
      spx_price = EXCLUDED.spx_price,
      summary = EXCLUDED.summary,
      legs = EXCLUDED.legs,
      total_spreads = EXCLUDED.total_spreads,
      call_spreads = EXCLUDED.call_spreads,
      put_spreads = EXCLUDED.put_spreads,
      net_delta = EXCLUDED.net_delta,
      net_theta = EXCLUDED.net_theta,
      net_gamma = EXCLUDED.net_gamma,
      total_credit = EXCLUDED.total_credit,
      current_value = EXCLUDED.current_value,
      unrealized_pnl = EXCLUDED.unrealized_pnl
    RETURNING id
  `;

  return result.length > 0 ? ((result[0]?.id as number) ?? null) : null;
}

/**
 * Get the most recent positions for a given date.
 * Returns the summary string for Claude prompt context and the full legs for display.
 */
export async function getLatestPositions(date: string): Promise<{
  summary: string;
  legs: PositionLeg[];
  fetchTime: string;
  stats: {
    totalSpreads: number;
    callSpreads: number;
    putSpreads: number;
    netDelta: number | null;
    netTheta: number | null;
    unrealizedPnl: number | null;
  };
} | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT summary, legs, fetch_time,
           total_spreads, call_spreads, put_spreads,
           net_delta, net_theta, unrealized_pnl
    FROM positions
    WHERE date = ${date}
    ORDER BY
      CASE WHEN total_spreads > 0 THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    summary: row.summary as string,
    legs: (typeof row.legs === 'string'
      ? JSON.parse(row.legs)
      : row.legs) as PositionLeg[],
    fetchTime: row.fetch_time as string,
    stats: {
      totalSpreads: row.total_spreads as number,
      callSpreads: row.call_spreads as number,
      putSpreads: row.put_spreads as number,
      netDelta: row.net_delta as number | null,
      netTheta: row.net_theta as number | null,
      unrealizedPnl: row.unrealized_pnl as number | null,
    },
  };
}
