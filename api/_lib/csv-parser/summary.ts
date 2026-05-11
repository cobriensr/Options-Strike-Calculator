/**
 * Holistic paperMoney CSV Parser — summary / Claude-context layer.
 *
 * Consumes a `ParsedCSV` (produced by `./parse.ts`) and emits:
 *
 *   - `buildFullSummary` — the human-readable, Claude-bound positions
 *     summary used by the `/api/positions` endpoint and the analyze
 *     prompt context.
 *   - `pairShortsWithLongs` — a small reusable greedy matcher exported
 *     for the positions-spreads consumer that needs the same pairing
 *     semantics outside the summary path.
 */

import type { PositionLeg } from '../db.js';
import { MAX_RECOGNIZED_SPREAD_WIDTH } from './internals.js';
import type { ParsedCSV, ParsedTrade } from './parse.js';

// ── Summary builder ─────────────────────────────────────────

/**
 * Build a human-readable summary including open positions,
 * closed trades, and account context.
 */
export function buildFullSummary(parsed: ParsedCSV, spxPrice?: number): string {
  const lines: string[] = [];

  // ── Open positions (using trade-history pairs, not flat legs) ──
  // Build open spread pairs from VERTICAL TO OPEN trades that haven't
  // been closed. This avoids the flat Options section's aggregated
  // quantities which can't distinguish shared long strikes.
  const openSpreads = buildOpenSpreadsFromTrades(parsed.allTrades, spxPrice);

  if (openSpreads.length > 0) {
    lines.push(
      `=== OPEN SPX 0DTE Positions (${openSpreads.length} defined-risk spread${openSpreads.length !== 1 ? 's' : ''}, NO naked legs) ===`,
    );
    if (spxPrice) lines.push(`SPX at fetch time: ${spxPrice}`);
    lines.push('');
    for (const s of openSpreads) {
      lines.push(s);
    }
    lines.push('');
  } else if (parsed.openLegs.length > 0) {
    // Fallback to flat legs if trade history is empty
    const calls = parsed.openLegs.filter((l) => l.putCall === 'CALL');
    const puts = parsed.openLegs.filter((l) => l.putCall === 'PUT');
    const spreadLines = pairForDisplay(calls, puts, spxPrice);
    const spreadCount = spreadLines.filter((l) =>
      l.startsWith('  Short'),
    ).length;
    lines.push(
      `=== OPEN SPX 0DTE Positions (${spreadCount} spread${spreadCount !== 1 ? 's' : ''}) ===`,
    );
    if (spxPrice) lines.push(`SPX at fetch time: ${spxPrice}`);
    lines.push('');
    for (const s of spreadLines) {
      lines.push(s);
    }
    lines.push('');
  } else {
    lines.push('=== NO OPEN SPX 0DTE POSITIONS ===', '');
  }

  // ── Closed trades today ─────────────────────────────────
  if (parsed.closedSpreads.length > 0) {
    const totalRealized = parsed.closedSpreads.reduce(
      (sum, s) => sum + s.realizedPnl,
      0,
    );
    lines.push(
      `=== Closed Today: ${parsed.closedSpreads.length} spread${parsed.closedSpreads.length !== 1 ? 's' : ''} | Realized P&L: $${totalRealized.toLocaleString()} ===`,
    );

    const closedCCS = parsed.closedSpreads.filter(
      (s) => s.type === 'CALL CREDIT SPREAD',
    );
    const closedPCS = parsed.closedSpreads.filter(
      (s) => s.type === 'PUT CREDIT SPREAD',
    );

    if (closedCCS.length > 0) {
      lines.push(`  CCS closed (${closedCCS.length}):`);
      for (const s of closedCCS) {
        lines.push(
          `    ${s.shortStrike}/${s.longStrike}C | ${s.contracts} contracts | Credit: $${s.openCredit.toFixed(2)} → Closed: $${s.closeDebit.toFixed(2)} | P&L: $${s.realizedPnl.toLocaleString()}`,
        );
      }
    }
    if (closedPCS.length > 0) {
      lines.push(`  PCS closed (${closedPCS.length}):`);
      for (const s of closedPCS) {
        lines.push(
          `    ${s.shortStrike}/${s.longStrike}P | ${s.contracts} contracts | Credit: $${s.openCredit.toFixed(2)} → Closed: $${s.closeDebit.toFixed(2)} | P&L: $${s.realizedPnl.toLocaleString()}`,
        );
      }
    }
    lines.push('');
  }

  // ── Max risk calculation (correct for IC) ────────────────
  if (parsed.openLegs.length > 0) {
    const calls = parsed.openLegs.filter((l) => l.putCall === 'CALL');
    const puts = parsed.openLegs.filter((l) => l.putCall === 'PUT');
    const callRisk = computeSideMaxRisk(calls);
    const putRisk = computeSideMaxRisk(puts);

    if (callRisk > 0 || putRisk > 0) {
      lines.push('=== Max Risk ===');
      if (callRisk > 0 && putRisk > 0) {
        // Iron condor: only ONE side can be max loss at a time
        lines.push(
          `  Call side max risk: $${callRisk.toLocaleString()} | Put side max risk: $${putRisk.toLocaleString()}`,
          `  Worst-case max risk: $${Math.max(callRisk, putRisk).toLocaleString()} (only one side of an IC can be max loss — calls and puts cannot both be ITM simultaneously)`,
        );
      } else {
        const totalRisk = callRisk + putRisk;
        const side = callRisk > 0 ? 'Call' : 'Put';
        lines.push(`  ${side} side max risk: $${totalRisk.toLocaleString()}`);
      }
      lines.push('');
    }
  }

  // ── Day P&L context (no account balances) ───────────────
  if (parsed.dayPnl != null) {
    lines.push(
      `=== Today's P&L ===`,
      `  Day P&L (SPX): $${parsed.dayPnl.toLocaleString()}`,
    );
  }

  return lines.join('\n');
}

// ── Helper: build open spreads from trade history ────────────
// Uses explicit VERTICAL trade pairs instead of flat leg matching,
// so shared long strikes (e.g., 6525P +40 from two spreads) are
// correctly attributed to their respective spread pairs.

function buildOpenSpreadsFromTrades(
  allTrades: ParsedTrade[],
  spxPrice?: number,
): string[] {
  // Track net opens: each VERTICAL TO OPEN adds a pair,
  // each VERTICAL TO CLOSE removes one.
  interface SpreadPair {
    shortStrike: number;
    longStrike: number;
    type: 'PUT' | 'CALL';
    qty: number;
    credit: number;
    width: number;
    openTime: string;
    closed: boolean;
  }

  const pairs: SpreadPair[] = [];
  const bflyLines: string[] = [];

  // Group trades into buckets where each bucket holds the legs of one
  // logical fill. CSV-001 hardening: the original implementation bucketed
  // by exact `execTime` string equality, which breaks when TOS logs two
  // legs of the same vertical at sub-second offsets (e.g. 09:31:42.110 vs
  // 09:31:42.140 — happens on split-venue fills). Those legs would land in
  // separate singleton buckets, get skipped by the `legs.length < 2` guard,
  // and silently drop the spread from the output — causing
  // `buildFullSummary` to fall through to the flat-legs fallback path
  // which can't distinguish shared long strikes and ends up confusing
  // Claude into thinking there are naked legs.
  //
  // Fix: sort trades by parsed timestamp and sweep them into buckets
  // where each bucket contains all trades within
  // TRADE_BUCKET_WINDOW_MS of the bucket's first trade, AND with
  // matching `spreadType` (so two unrelated orders of different types
  // — e.g. a VERTICAL and a BUTTERFLY — never merge even if they land
  // within the same second).
  const buckets = bucketTradesByTimeWindow(allTrades);

  for (const legs of buckets) {
    if (legs.length < 2) continue;

    const openLegs = legs.filter((l) => l.posEffect === 'TO OPEN');
    const closeLegs = legs.filter((l) => l.posEffect === 'TO CLOSE');

    // 3-leg BUTTERFLY / BWB trades
    if (openLegs.length === 3) {
      const buys = openLegs.filter((l) => l.quantity > 0);
      const sells = openLegs.filter((l) => l.quantity < 0);
      if (
        buys.length === 2 &&
        sells.length === 1 &&
        buys[0]!.putCall === buys[1]!.putCall &&
        buys[0]!.putCall === sells[0]!.putCall
      ) {
        const sell = sells[0]!;
        const middleStrike = sell.strike;
        const wingStrikes = buys.map((b) => b.strike).sort((a, b) => a - b);
        const lowerStrike = wingStrikes[0]!;
        const upperStrike = wingStrikes[1]!;
        const contracts = Math.abs(buys[0]!.quantity);
        const lowerWidth = middleStrike - lowerStrike;
        const upperWidth = upperStrike - middleStrike;
        const isBrokenWing = lowerWidth !== upperWidth;
        const label = isBrokenWing ? 'BWB' : 'BFLY';
        const typeChar = sell.putCall === 'CALL' ? 'CALL' : 'PUT';
        const debit = Math.abs(sell.netPrice) * 100 * contracts;
        const narrowerWidth = Math.min(lowerWidth, upperWidth);
        const maxProfit = narrowerWidth * 100 * contracts - debit;

        bflyLines.push(
          `  ${label} ${lowerStrike}/${middleStrike}/${upperStrike} ${typeChar} x${contracts} — ` +
            `debit $${debit.toLocaleString('en-US', { maximumFractionDigits: 0 })}, ` +
            `max profit at ${middleStrike}, ` +
            `wings ${lowerWidth}/${upperWidth}` +
            (maxProfit > 0
              ? `, max profit $${maxProfit.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
              : ''),
        );
      }
    }

    if (openLegs.length === 2) {
      const sell = openLegs.find((l) => l.quantity < 0);
      const buy = openLegs.find((l) => l.quantity > 0);
      if (sell && buy && sell.putCall === buy.putCall) {
        pairs.push({
          shortStrike: sell.strike,
          longStrike: buy.strike,
          type: sell.putCall,
          qty: Math.abs(sell.quantity),
          credit: sell.netPrice,
          width: Math.abs(sell.strike - buy.strike),
          // Use the bucket's earliest leg time as the canonical open time.
          // For same-millisecond buckets this matches the legacy behavior.
          // For sub-second-offset buckets this picks the first leg, which
          // is close enough — the two legs are within 1 second of each
          // other by construction.
          openTime: legs[0]!.execTime,
          closed: false,
        });
      }
    }

    if (closeLegs.length === 2) {
      const btc = closeLegs.find((l) => l.quantity > 0);
      if (btc) {
        // Mark matching open spread as closed
        for (const p of pairs) {
          if (
            !p.closed &&
            p.shortStrike === btc.strike &&
            p.type === btc.putCall
          ) {
            p.closed = true;
            break;
          }
        }
      }
    }
  }

  const openPairs = pairs.filter((p) => !p.closed);
  if (openPairs.length === 0 && bflyLines.length === 0) return [];

  const sorted = openPairs.sort((a, b) => a.shortStrike - b.shortStrike);

  const spreadLines = sorted.map((p) => {
    const typeLabel = p.type === 'PUT' ? 'PCS' : 'CCS';
    const maxLoss = p.width * 100 * p.qty - p.credit * 100 * p.qty;
    const cushion =
      spxPrice != null
        ? p.type === 'PUT'
          ? spxPrice - p.shortStrike
          : p.shortStrike - spxPrice
        : null;
    const cushionStr =
      cushion != null ? `, ${cushion.toFixed(0)} pts cushion` : '';
    return (
      `  ${typeLabel} ${p.shortStrike}/${p.longStrike} x${p.qty} — ` +
      `credit $${(p.credit * 100 * p.qty).toFixed(0)}, ` +
      `max loss $${maxLoss.toFixed(0)}, ` +
      `${p.width} wide${cushionStr}`
    );
  });

  return [...spreadLines, ...bflyLines];
}

// ── Helper: CSV-001 trade bucketing ──────────────────────────

// Bucket size window. 1 second is generous enough to catch any
// split-venue or sub-second dispatch offset TOS has been observed
// to emit, but narrow enough that two genuinely distinct orders
// placed by a human are almost never within it.
const TRADE_BUCKET_WINDOW_MS = 1000;

/**
 * Group trades into buckets where each bucket holds the legs of one
 * logical fill. See the comment block at the call site in
 * `buildOpenSpreadsFromTrades` for the CSV-001 rationale.
 *
 * Bucket boundaries:
 * - Start a new bucket when the current trade's timestamp is more
 *   than `TRADE_BUCKET_WINDOW_MS` past the first trade of the
 *   previous bucket (so each bucket spans at most 1 second total,
 *   no transitive chaining).
 * - Start a new bucket when the current trade's `spreadType` differs
 *   from the first trade of the previous bucket — TOS tags each
 *   logical order with a structure label (VERTICAL, BUTTERFLY,
 *   IRON CONDOR, etc.) and two adjacent orders of different types
 *   must never merge.
 */
function bucketTradesByTimeWindow(
  allTrades: readonly ParsedTrade[],
): ParsedTrade[][] {
  const sorted = [...allTrades].sort(
    (a, b) => tradeTimeToMs(a.execTime) - tradeTimeToMs(b.execTime),
  );
  const buckets: ParsedTrade[][] = [];
  for (const trade of sorted) {
    const t = tradeTimeToMs(trade.execTime);
    const lastBucket = buckets.at(-1);
    if (lastBucket != null) {
      const firstInBucket = lastBucket[0]!;
      const bucketStart = tradeTimeToMs(firstInBucket.execTime);
      const withinWindow = t - bucketStart <= TRADE_BUCKET_WINDOW_MS;
      // Case-normalize spreadType for the discriminator so hypothetical
      // casing drift in a future TOS export format (e.g. "Vertical"
      // vs "VERTICAL") does not split a single fill into two buckets.
      const sameSpreadType =
        firstInBucket.spreadType.toUpperCase() ===
        trade.spreadType.toUpperCase();
      if (withinWindow && sameSpreadType) {
        lastBucket.push(trade);
        continue;
      }
    }
    buckets.push([trade]);
  }
  return buckets;
}

// Parse a TOS trade-exec-time string into milliseconds-since-midnight.
// TOS emits these observed shapes:
//   - "HH:MM:SS"                  (e.g., "09:31:42")
//   - "HH:MM:SS.fff"              (e.g., "09:31:42.140" — sub-second variant)
//   - "HH:MM:SS AM/PM"            (rare 12-hour export format)
//   - "M/D/YY HH:MM:SS[.fff]"     (the common format in real TOS exports —
//                                  includes a date prefix before the time)
//   - "M/D/YY HH:MM:SS AM/PM"     (combined date + 12-hour format)
// The regex anchors only at the end of the string (no `^` start anchor)
// so any optional date prefix before the time is ignored.
// Returns 0 on unparseable input so callers can gracefully treat
// unparseable rows as belonging to the earliest bucket (which is
// strictly safer than dropping them).
function tradeTimeToMs(tradeTime: string): number {
  const match = tradeTime
    .trim()
    .match(/(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s*(AM|PM)?$/i);
  if (!match) return 0;
  let hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  const seconds = Number.parseInt(match[3]!, 10);
  // Pad/truncate the fractional-second portion to exactly 3 digits so
  // ".05" becomes 50ms (not 5ms) and ".1234" becomes 123ms. The padEnd
  // guarantees the string is always at least 3 chars long (e.g. '' → '000').
  const msStr = (match[4] ?? '').padEnd(3, '0').slice(0, 3);
  const ms = Number.parseInt(msStr, 10);
  const ampm = match[5]?.toUpperCase();
  if (ampm === 'PM' && hours < 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

// ── Helper: pair legs into spread display lines ─────────────

function pairForDisplay(
  calls: PositionLeg[],
  puts: PositionLeg[],
  spxPrice?: number,
): string[] {
  const lines: string[] = [];

  function formatGroup(group: PositionLeg[], label: string): void {
    const { results, hasShorts } = pairShortsWithLongs(group);

    if (!hasShorts) return;

    lines.push(`${label}:`);

    for (const r of results) {
      if (r.long) {
        const { short, long, width } = r;
        const credit =
          Math.abs(short.averagePrice) - Math.abs(long.averagePrice);
        const cushion =
          spxPrice != null
            ? short.putCall === 'CALL'
              ? Math.round(short.strike - spxPrice)
              : Math.round(spxPrice - short.strike)
            : null;
        const cushionLabel =
          short.putCall === 'CALL' ? 'above SPX' : 'below SPX';

        lines.push(
          `  Short ${short.strike}${short.putCall[0]} / Long ${long.strike}${long.putCall[0]} | ${Math.abs(short.quantity)} contracts | Credit: $${credit.toFixed(2)} | Width: ${width} pts` +
            (cushion != null
              ? ` | Cushion: ${cushion} pts ${cushionLabel}`
              : ''),
        );
      } else {
        lines.push(
          `  Short ${r.short.strike}${r.short.putCall[0]} (unpaired) | ${Math.abs(r.short.quantity)} contracts`,
        );
      }
    }
  }

  formatGroup(calls, 'CALL CREDIT SPREADS');
  formatGroup(puts, 'PUT CREDIT SPREADS');

  return lines;
}

// ── Helper: pair shorts with their nearest unused long ───────
//
// Both `pairForDisplay` and `computeSideMaxRisk` previously inlined the
// same matching loop verbatim: filter to shorts/longs (qty < 0 vs > 0),
// sort by strike, then for each short walk the long array picking the
// closest unused strike within MAX_RECOGNIZED_SPREAD_WIDTH. The shape
// is small but identical, and any future change to the pairing rule
// (FIFO instead of nearest, multi-strike legging out, etc.) needs to
// land in both call sites or the two consumers diverge silently.
//
// Greedy pairing — same shape as the previous inline loops, just
// extracted. Results come back in short-strike-ascending order so
// `pairForDisplay` can interleave paired vs unpaired output the way
// the original loop did. `computeSideMaxRisk` filters to entries with
// a `long` (open-ended naked-short risk doesn't roll into a defined
// max-loss number).

/**
 * One short, optionally with the long it was paired against. `long`
 * is `null` only for shorts the matcher couldn't find an in-window
 * partner for; in that case `width` is also `null`.
 */
export type ShortPairResult =
  | { short: PositionLeg; long: PositionLeg; width: number }
  | { short: PositionLeg; long: null; width: null };

/**
 * Greedy short-to-long pairing for a single side (calls OR puts) of a
 * defined-risk vertical spread book. Sorts both queues by strike, then
 * for each short picks the closest unused long whose distance is within
 * `maxWidth` (default `MAX_RECOGNIZED_SPREAD_WIDTH`).
 *
 * Returns `results` in short-strike-ascending order — one entry per
 * short, paired or not — plus a `hasShorts` boolean so callers can
 * skip the section header when there's nothing to render.
 *
 * Behaviour:
 *   - Empty `legs`            → `{ results: [], hasShorts: false }`.
 *   - Only shorts, no longs   → every entry has `long: null`.
 *   - Only longs, no shorts   → no entries; longs are silently dropped
 *                               (callers don't track unpaired longs).
 *   - Width cap exceeded      → the short stays unmatched, longs remain
 *                               available for closer-strike shorts.
 *   - Multiple shorts, one
 *     long within range       → first short by strike-asc wins; later
 *                               shorts get `long: null` if no other
 *                               in-window long remains.
 */
export function pairShortsWithLongs(
  legs: PositionLeg[],
  options: { maxWidth?: number } = {},
): { results: ShortPairResult[]; hasShorts: boolean } {
  const maxWidth = options.maxWidth ?? MAX_RECOGNIZED_SPREAD_WIDTH;

  const shorts = legs
    .filter((l) => l.quantity < 0)
    .sort((a, b) => a.strike - b.strike);
  const longs = legs
    .filter((l) => l.quantity > 0)
    .sort((a, b) => a.strike - b.strike);

  const results: ShortPairResult[] = [];
  const usedLongs = new Set<number>();

  for (const short of shorts) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < longs.length; i++) {
      if (usedLongs.has(i)) continue;
      const dist = Math.abs(longs[i]!.strike - short.strike);
      if (dist < bestDist && dist <= maxWidth) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      usedLongs.add(bestIdx);
      const long = longs[bestIdx]!;
      results.push({
        short,
        long,
        width: Math.abs(long.strike - short.strike),
      });
    } else {
      results.push({ short, long: null, width: null });
    }
  }

  return { results, hasShorts: shorts.length > 0 };
}

// ── Helper: compute max risk for one side of positions ───────

function computeSideMaxRisk(legs: PositionLeg[]): number {
  const { results } = pairShortsWithLongs(legs);

  let totalRisk = 0;
  for (const r of results) {
    if (r.long == null) continue;
    const { short, long, width } = r;
    const credit = Math.abs(short.averagePrice) - Math.abs(long.averagePrice);
    const maxLoss = (width - credit) * 100 * Math.abs(short.quantity);
    totalRisk += Math.max(0, maxLoss);
  }

  return Math.round(totalRisk);
}
