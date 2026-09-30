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
 *   - A bar only stands in for the price at a moment T if it printed
 *     within MAX_BAR_AGE_MS of T (see below). A symbol whose latest bar
 *     is older than that has no snapshot at all.
 *   - Percentages are clamped to ±999 as a defensive guard against
 *     NUMERIC(8,4) overflow.
 */
import { getDb } from './db.js';
import logger from './logger.js';
import { getETMarketOpenUtcIso } from '../../src/utils/timezone.js';

// ── Constants ───────────────────────────────────────────────

// DX (ICE) is not carried by the UW futures feed and had no bars after
// 2026-03-05, so it is not snapshotted.
export const FUTURES_SYMBOLS = [
  'ES',
  'NQ',
  'VX1',
  'VX2',
  'ZN',
  'RTY',
  'CL',
  'GC',
] as const;

/**
 * Oldest a 1-minute bar may be and still count as the price at a moment.
 *
 * Without this bound, "latest bar at or before `at`" happily returned
 * the 2026-09-03 ES close for four weeks after the feed stopped, and the
 * cron wrote it into every futures_snapshots row.
 *
 * Why 15 minutes:
 *   - The snapshot cron runs every 5 min; 15 min = three missed cron
 *     slots, so an outage stops producing rows within 15 minutes.
 *   - Healthy bars land within ~1-2 min (1m bars, written once the
 *     next minute starts printing).
 *   - Measured on futures_bars 2026-08-03..2026-09-03: outside the
 *     daily break, weekends and feed outages, ES/NQ/RTY never went more
 *     than 10 min between bars. CL/ZN are thinner (CL 16, ZN 31 gaps of
 *     15-55 min that month, ~80% overnight); those slots are dropped
 *     rather than showing a price nobody has traded at for 15+ minutes.
 *
 * Those gap counts are from the Databento era. uw-stream writes a
 * symbol's minute bar only once a print lands in a later minute, so a
 * thin symbol's newest bar lags by its next quiet stretch and the
 * UW-era drop rate for CL/ZN will be somewhat higher — re-measure after
 * the UW soak.
 *
 * Live runs that get no row for a symbol, besides real outages:
 *   - The first slot after each 17:00 CT reopen (Sunday and weekdays):
 *     the newest bar is the pre-break close (>= 60 min old). Rows resume
 *     at the next slot once post-reopen bars land. The 1H change is also
 *     null from ~17:15 to 18:00 CT, while its reference moment falls
 *     inside the break.
 *   - CME holiday halts and early closes. isFuturesMarketOpen knows only
 *     the weekly schedule, so the cron still runs then and now writes
 *     nothing instead of the pre-halt price.
 *   - Thin-symbol quiet stretches (CL/ZN above).
 * A historical pick (/api/futures/snapshot?at=) inside a closure returns
 * no snapshot for that symbol — the pre-close price is not the price
 * "at" a moment when nothing trades.
 */
const MAX_BAR_AGE_MS = 15 * 60 * 1000;

export type FuturesSymbol = (typeof FUTURES_SYMBOLS)[number];

export interface SnapshotRow {
  symbol: FuturesSymbol;
  price: number;
  change1hPct: number | null;
  changeDayPct: number | null;
  volumeRatio: number | null;
  /** Timestamp of the latest bar actually used for `price`. */
  latestTs: string;
}

/**
 * Outcome of computeSnapshot for one symbol.
 *   - `fresh`: a snapshot from a bar within MAX_BAR_AGE_MS of `at`.
 *   - `stale`: bars exist but the newest is too old — a stopped feed.
 *     Both fields are null when the bar's ts is unparseable.
 *   - `missing`: no bar at or before `at` at all (e.g. VX1/VX2, never
 *     ingested).
 */
export type SnapshotResult =
  | { kind: 'fresh'; snapshot: SnapshotRow }
  | { kind: 'stale'; latestTs: string | null; ageMinutes: number | null }
  | { kind: 'missing' };

/** Defensive clamp against NUMERIC(8,4) overflow in futures_snapshots. */
function clampPct(v: number | null): number | null {
  return v != null ? Math.max(-999, Math.min(999, v)) : null;
}

/**
 * Epoch ms of a bar's `ts`. Neon returns TIMESTAMPTZ as an ISO string
 * or a Date depending on the driver path; null/unparseable → null.
 */
function barTsMs(ts: unknown): number | null {
  if (ts == null) return null;
  const ms = ts instanceof Date ? ts.getTime() : new Date(String(ts)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Close of a reference bar, or null when the row is missing, its ts is
 * unparseable, or it falls outside [fromMs, toMs]. Keeps a % change from
 * being computed against a bar that doesn't represent the reference
 * moment (e.g. a pre-outage bar standing in for "one hour ago").
 */
function closeWithin(
  row: Record<string, unknown> | undefined,
  fromMs: number,
  toMs: number,
): number | null {
  if (!row) return null;
  const tsMs = barTsMs(row.ts);
  if (tsMs == null || tsMs < fromMs || tsMs > toMs) return null;
  const close = Number.parseFloat(String(row.close));
  return Number.isFinite(close) ? close : null;
}

/** Percent change from `ref` to `price`; null when there's no usable ref. */
function pctChange(price: number, ref: number | null): number | null {
  return ref != null && ref !== 0 ? ((price - ref) / ref) * 100 : null;
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
 * @returns         `fresh` with the snapshot, `stale` when the latest bar
 *                  at or before `at` is more than MAX_BAR_AGE_MS older
 *                  than `at`, or `missing` when there is no such bar.
 *                  DB errors reject.
 */
export async function computeSnapshot(
  symbol: FuturesSymbol,
  tradeDate: string,
  at: Date,
): Promise<SnapshotResult> {
  const sql = getDb();
  const atIso = at.toISOString();
  const atMs = at.getTime();

  // Latest bar at or before `at`
  const latestRows = await sql`
    SELECT close, ts FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts <= ${atIso}
    ORDER BY ts DESC LIMIT 1
  `;
  if (latestRows.length === 0) return { kind: 'missing' };

  // Freshness gate. The age is checked here rather than in SQL so the
  // caller and the log can say how stale the feed is. An unparseable ts
  // can't be shown to be fresh, so it is treated as stale.
  const latestMs = barTsMs(latestRows[0]!.ts);
  if (latestMs == null || atMs - latestMs > MAX_BAR_AGE_MS) {
    const stale = {
      kind: 'stale',
      latestTs: latestMs == null ? null : new Date(latestMs).toISOString(),
      ageMinutes:
        latestMs == null ? null : Math.round((atMs - latestMs) / 60_000),
    } as const;
    logger.info(
      {
        symbol,
        at: atIso,
        latestTs: stale.latestTs,
        ageMinutes: stale.ageMinutes,
      },
      'latest futures bar is stale — skipping snapshot',
    );
    return stale;
  }

  const latestTs = new Date(latestMs).toISOString();
  const price = Number.parseFloat(String(latestRows[0]!.close));

  // 1H change: bar at or before (at - 60m), and no more than
  // MAX_BAR_AGE_MS before it — otherwise, after a feed gap, the
  // "hour-ago" bar would be from before the outage.
  const oneHourAgoMs = atMs - 60 * 60 * 1000;
  const hourAgoRows = await sql`
    SELECT close, ts FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts <= ${new Date(oneHourAgoMs).toISOString()}
    ORDER BY ts DESC LIMIT 1
  `;
  const change1hPct = pctChange(
    price,
    closeWithin(hourAgoRows[0], oneHourAgoMs - MAX_BAR_AGE_MS, oneHourAgoMs),
  );

  // Day change: earliest bar on the picked trade date at or after the
  // ET cash-session open (9:30 AM ET). The UTC offset is DST-aware —
  // 13:30Z during EDT, 14:30Z during EST — so we derive it from the
  // tradeDate itself rather than hardcoding a UTC hour.
  const dayOpenTs = getETMarketOpenUtcIso(tradeDate);
  if (!dayOpenTs) {
    // Malformed tradeDate — skip day-scoped metrics but keep the
    // latest-price + 1H-change computations above.
    return {
      kind: 'fresh',
      snapshot: {
        symbol,
        price,
        change1hPct: clampPct(change1hPct),
        changeDayPct: null,
        volumeRatio: null,
        latestTs,
      },
    };
  }
  const dayOpenRows = await sql`
    SELECT close, ts FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts >= ${dayOpenTs}
    ORDER BY ts ASC LIMIT 1
  `;
  // The open bar must print within MAX_BAR_AGE_MS of 9:30 ET (a later
  // first bar means the feed was down at the open) and not after `at`
  // (before the open, or a historical pick, it would be a future bar).
  // Days with no cash session (Sunday evening) therefore get null.
  const dayOpenMs = new Date(dayOpenTs).getTime();
  const changeDayPct = pctChange(
    price,
    closeWithin(
      dayOpenRows[0],
      dayOpenMs,
      Math.min(atMs, dayOpenMs + MAX_BAR_AGE_MS),
    ),
  );

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

  return {
    kind: 'fresh',
    snapshot: {
      symbol,
      price,
      change1hPct: clampPct(change1hPct),
      changeDayPct: clampPct(changeDayPct),
      volumeRatio,
      latestTs,
    },
  };
}
