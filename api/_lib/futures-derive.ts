/**
 * Shared helpers for derived 1-minute futures snapshots.
 *
 * Both the fetch-futures-snapshot cron and the /api/futures/snapshot
 * endpoint compute the same derived metrics (latest price, 1H change,
 * day change, 20-day volume ratio) from the `futures_bars` table. The
 * cron passes `new Date()`; the endpoint passes a user-supplied
 * historical timestamp. Behavior is otherwise identical.
 *
 * Key invariants:
 *   - "Latest bar" is the most recent bar with `ts <= at`, NOT the
 *     absolute latest bar for the symbol. This is what makes the
 *     historical picker correct — walking back in time must not leak
 *     future information.
 *   - Percentages are clamped to ±999 to avoid NUMERIC(8,4) overflow
 *     on stale comparisons.
 */
import { getDb } from './db.js';

// ── Constants ───────────────────────────────────────────────

export const FUTURES_SYMBOLS = [
  'ES',
  'NQ',
  'VX1',
  'VX2',
  'ZN',
  'RTY',
  'CL',
  'GC',
  'DX',
] as const;

export type FuturesSymbol = (typeof FUTURES_SYMBOLS)[number];

export interface SnapshotRow {
  symbol: FuturesSymbol;
  price: number;
  change1hPct: number | null;
  changeDayPct: number | null;
  volumeRatio: number | null;
  /** Timestamp of the latest bar actually used for `price`. */
  latestTs: string | null;
}

// ── computeSnapshot ─────────────────────────────────────────

/**
 * Compute a single symbol's snapshot as of `at`.
 *
 * @param symbol    Futures symbol (ES, NQ, VX1, etc.)
 * @param tradeDate ET calendar date used for "day change" and today's
 *                  volume (typically `getETDateStr(at)`).
 * @param at        The "now" moment from the caller's perspective. The
 *                  latest bar is the most recent bar with `ts <= at`.
 *                  20-day avg volume window ends at `at`.
 */
export async function computeSnapshot(
  symbol: FuturesSymbol,
  tradeDate: string,
  at: Date,
): Promise<SnapshotRow | null> {
  const sql = getDb();
  const atIso = at.toISOString();

  // Latest bar at or before `at`
  const latestRows = await sql`
    SELECT close, ts FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts <= ${atIso}
    ORDER BY ts DESC LIMIT 1
  `;
  if (latestRows.length === 0) return null;

  const price = Number.parseFloat(String(latestRows[0]!.close));
  const latestTs = latestRows[0]!.ts
    ? new Date(String(latestRows[0]!.ts)).toISOString()
    : null;

  // 1H change: bar at or before (at - 60m)
  const oneHourAgo = new Date(at.getTime() - 60 * 60 * 1000);
  const hourAgoRows = await sql`
    SELECT close FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts <= ${oneHourAgo.toISOString()}
    ORDER BY ts DESC LIMIT 1
  `;
  let change1hPct: number | null = null;
  if (hourAgoRows.length > 0) {
    const hourAgoClose = Number.parseFloat(String(hourAgoRows[0]!.close));
    if (hourAgoClose !== 0) {
      change1hPct = ((price - hourAgoClose) / hourAgoClose) * 100;
    }
  }

  // Day change: earliest bar on the picked trade date at or after
  // today's market open (approximation: 13:30 UTC).
  const dayOpenTs = `${tradeDate}T13:30:00Z`;
  const dayOpenRows = await sql`
    SELECT close FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts >= ${dayOpenTs}
    ORDER BY ts ASC LIMIT 1
  `;
  let changeDayPct: number | null = null;
  if (dayOpenRows.length > 0) {
    const dayOpenClose = Number.parseFloat(String(dayOpenRows[0]!.close));
    if (dayOpenClose !== 0) {
      changeDayPct = ((price - dayOpenClose) / dayOpenClose) * 100;
    }
  }

  // 20-day average daily volume, ending at `at`.
  const twentyDaysAgo = new Date(at.getTime() - 20 * 24 * 60 * 60 * 1000);
  const avgVolRows = await sql`
    SELECT
      AVG(daily_vol) AS avg_vol
    FROM (
      SELECT
        SUM(volume) AS daily_vol
      FROM futures_bars
      WHERE symbol = ${symbol}
        AND ts >= ${twentyDaysAgo.toISOString()}
        AND ts <= ${atIso}
      GROUP BY DATE(ts)
    ) sub
  `;

  // Today's volume, up to `at`.
  const todayVolRows = await sql`
    SELECT SUM(volume) AS today_vol
    FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts >= ${dayOpenTs}
      AND ts <= ${atIso}
  `;

  let volumeRatio: number | null = null;
  if (avgVolRows[0]?.avg_vol && todayVolRows[0]?.today_vol) {
    const avgVol = Number.parseFloat(String(avgVolRows[0].avg_vol));
    const todayVol = Number.parseFloat(String(todayVolRows[0].today_vol));
    if (avgVol > 0) {
      volumeRatio = todayVol / avgVol;
    }
  }

  // Clamp percentages to avoid NUMERIC(8,4) overflow on stale comparisons
  const clamp = (v: number | null) =>
    v != null ? Math.max(-999, Math.min(999, v)) : null;

  return {
    symbol,
    price,
    change1hPct: clamp(change1hPct),
    changeDayPct: clamp(changeDayPct),
    volumeRatio,
    latestTs,
  };
}
