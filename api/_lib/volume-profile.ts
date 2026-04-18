/**
 * Prior-day volume profile for a futures symbol.
 *
 * Computes POC (Point of Control), VAH (Value Area High), and VAL
 * (Value Area Low) from the previous trading day's `futures_bars`
 * minute bars. Price is bucketed into 1-point wide cells, each bar's
 * volume is assigned to the bucket containing its midpoint, and:
 *
 *   - POC = bucket with maximum volume
 *   - VAH/VAL = the smallest band around POC that contains at least
 *     70% of total day volume
 *
 * Half-day / holiday sessions are filtered out by requiring at least
 * 50 bars of data for the day. Below that threshold the profile is
 * not statistically meaningful and the helper returns null so the
 * caller drops the section.
 *
 * Note: this reads futures bars only — it does NOT attempt to convert
 * futures levels to SPX. Claude interprets ES POC/VAH/VAL directly as
 * futures reference levels.
 */

import { getDb } from './db.js';

// ── Configuration ─────────────────────────────────────────────

/** Minimum bars on the prior day for the profile to be trustworthy. */
const MIN_BAR_COUNT = 50;

/** Price bucket width in points. ES trades in 0.25 ticks; 1-point buckets
 * smooth noise while preserving the structural shape. */
const BUCKET_WIDTH = 1;

/** Value-area target fraction of total volume (70% is the standard). */
const VALUE_AREA_FRACTION = 0.7;

// ── Types ─────────────────────────────────────────────────────

export interface VolumeProfile {
  symbol: string;
  /** YYYY-MM-DD ET calendar date of the profile. */
  tradeDate: string;
  poc: number;
  vah: number;
  val: number;
  totalVolume: number;
  barCount: number;
}

// ── Internal helpers ──────────────────────────────────────────

interface BarRow {
  high: number;
  low: number;
  volume: number;
}

/**
 * Convert a price to its integer bucket. Midpoints are rounded to
 * the nearest integer, so bucket K contains prices in (K - 0.5, K + 0.5].
 */
function priceToBucket(price: number): number {
  return Math.round(price / BUCKET_WIDTH) * BUCKET_WIDTH;
}

/**
 * Given a volume-per-bucket map and total volume, expand the value
 * area outward from POC until it covers `VALUE_AREA_FRACTION` of the
 * total. Returns { vah, val }.
 *
 * Expansion rule at each step: add the adjacent bucket (one above or
 * one below the current band) with the larger volume. Ties go up.
 * This is the standard Market Profile algorithm.
 */
function expandValueArea(
  buckets: Map<number, number>,
  poc: number,
  totalVolume: number,
): { vah: number; val: number } {
  // Sorted list of bucket prices for bounds checks.
  const sorted = [...buckets.keys()].sort((a, b) => a - b);
  const minBucket = sorted[0]!;
  const maxBucket = sorted.at(-1)!;

  let vah = poc;
  let val = poc;
  let covered = buckets.get(poc) ?? 0;
  const target = totalVolume * VALUE_AREA_FRACTION;

  while (covered < target && (val > minBucket || vah < maxBucket)) {
    const nextUp = vah + BUCKET_WIDTH;
    const nextDown = val - BUCKET_WIDTH;
    const upVol = vah < maxBucket ? (buckets.get(nextUp) ?? 0) : -1;
    const downVol = val > minBucket ? (buckets.get(nextDown) ?? 0) : -1;

    if (upVol < 0 && downVol < 0) break; // nowhere left to expand

    if (upVol >= downVol) {
      vah = nextUp;
      covered += Math.max(0, upVol);
    } else {
      val = nextDown;
      covered += Math.max(0, downVol);
    }
  }

  return { vah, val };
}

// ── Public API ────────────────────────────────────────────────

/**
 * Compute the volume profile for `symbol` on `priorTradeDate`.
 * Returns null when fewer than MIN_BAR_COUNT bars exist (holiday or
 * half-day).
 *
 * @param symbol          Futures symbol stored in futures_bars.
 * @param priorTradeDate  YYYY-MM-DD ET calendar date (caller picks).
 */
export async function computeVolumeProfile(
  symbol: string,
  priorTradeDate: string,
): Promise<VolumeProfile | null> {
  const sql = getDb();
  // Select bars whose ts falls on priorTradeDate in UTC. Futures bars
  // span a 23-hour session but for volume-profile purposes the ET
  // calendar boundary is close enough — we only need to filter out
  // the wrong session, not get pit-perfect timing.
  const rows = (await sql`
    SELECT high, low, volume
    FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts >= ${`${priorTradeDate}T00:00:00Z`}
      AND ts < ${`${priorTradeDate}T24:00:00Z`}
  `) as Array<{
    high: string | number;
    low: string | number;
    volume: string | number;
  }>;

  const bars: BarRow[] = rows
    .map((r) => ({
      high: Number.parseFloat(String(r.high)),
      low: Number.parseFloat(String(r.low)),
      volume: Number.parseInt(String(r.volume), 10),
    }))
    .filter(
      (b) =>
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.volume) &&
        b.volume > 0,
    );

  if (bars.length < MIN_BAR_COUNT) return null;

  // Aggregate volume into per-bucket map keyed by midpoint.
  const buckets = new Map<number, number>();
  let totalVolume = 0;
  for (const b of bars) {
    const mid = (b.high + b.low) / 2;
    const bucket = priceToBucket(mid);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + b.volume);
    totalVolume += b.volume;
  }

  if (totalVolume === 0 || buckets.size === 0) return null;

  // POC = bucket with maximum volume (break ties by lower price for
  // determinism; the order in which bars arrive is not guaranteed).
  let poc = Number.NaN;
  let pocVol = -1;
  for (const [bucket, vol] of buckets) {
    if (vol > pocVol || (vol === pocVol && bucket < poc)) {
      poc = bucket;
      pocVol = vol;
    }
  }

  const { vah, val } = expandValueArea(buckets, poc, totalVolume);

  return {
    symbol,
    tradeDate: priorTradeDate,
    poc,
    vah,
    val,
    totalVolume,
    barCount: bars.length,
  };
}

// ── Formatter ─────────────────────────────────────────────────

/**
 * Format the volume profile for injection into the analyze prompt.
 * Returns null when the profile is null.
 */
export function formatVolumeProfileForClaude(
  p: VolumeProfile | null,
): string | null {
  if (!p) return null;
  return [
    `Prior-day volume profile (${p.symbol}, ${p.tradeDate})`,
    `  POC: ${p.poc.toFixed(2)}`,
    `  VAH: ${p.vah.toFixed(2)}  (value area high)`,
    `  VAL: ${p.val.toFixed(2)}  (value area low)`,
    `  Bars: ${p.barCount}  Total volume: ${p.totalVolume.toLocaleString('en-US')}`,
  ].join('\n');
}

// ── Prior-trade-date helper ───────────────────────────────────

/**
 * Given an ET calendar date (YYYY-MM-DD), return the prior trading
 * date skipping weekends. Holidays are not tracked — on a holiday the
 * profile will naturally return null via the MIN_BAR_COUNT gate.
 */
export function priorTradeDate(tradeDate: string): string {
  // Parse as UTC to avoid local-timezone drift.
  const d = new Date(`${tradeDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return tradeDate;

  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
