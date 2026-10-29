/**
 * Anchor print + spread legs for a Lottery Finder fire or Silent Boom alert,
 * read from the exchange's own multi-leg flag instead of the retired Railway
 * classifier.
 *
 *   1. Anchor: the highest `price × size` print on the alert's own option
 *      chain inside its window, `canceled = false`, `price > 0`; ties go to
 *      the earliest print.
 *   2. Leg kind: from the anchor's OPRA trade code alone
 *      (`raw_payload->>'trade_code'`, see `multileg-codes.ts`).
 *   3. Legs (multi-leg anchors only): every multi-leg-coded print on the same
 *      ticker in the anchor's exact millisecond, the anchor included, grouped
 *      by option chain. One chain = one leg (summed size, VWAP price), since
 *      big spread orders fill against several counterparties.
 *
 * Spec: docs/superpowers/specs/2026-10-28-classifier-replacement-design.md
 * ("Decisions already made": anchor print, sibling legs, shape names).
 */

import type {
  AnchorLegKind,
  SpreadLeg,
  SpreadShape,
} from '../../src/types/spread-legs.js';
import { getDb } from './db.js';
import {
  legKindForTradeCode,
  MULTI_LEG_TRADE_CODES,
} from './multileg-codes.js';
import { toIsoDate } from './periscope-db.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** One ws_option_trades print, normalised from the driver's raw types. */
export interface TapePrint {
  wsTradeId: string;
  optionChain: string;
  optionType: 'C' | 'P';
  strike: number;
  /** YYYY-MM-DD. */
  expiry: string;
  /** ISO 8601, millisecond precision (the precision uw-stream stores). */
  executedAt: string;
  price: number;
  size: number;
  tradeCode: string | null;
}

/** What the anchor print says about its order. */
export interface AnchorLegs {
  anchorWsTradeId: string;
  anchorTradeCode: string | null;
  /** null: the print carries no trade code (not the same as `single`). */
  legKind: AnchorLegKind | null;
  /** Non-null only when `legKind === 'multi_leg'`. */
  spreadShape: SpreadShape | null;
  /** Non-null only when `legKind === 'multi_leg'`; anchor leg first. */
  spreadLegs: SpreadLeg[] | null;
}

/** One alert to find an anchor for. */
export interface AnchorRequest {
  /** Caller's identity for the alert; the result map is keyed by it. */
  key: string;
  ticker: string;
  optionChain: string;
  /** Inclusive. */
  windowStart: Date;
  /** Exclusive: the window is [windowStart, windowEnd). */
  windowEnd: Date;
}

// ── Pure: grouping and shape ───────────────────────────────────────────────

/** Most common non-null code; on a tie, the first one seen. */
function mostCommonCode(prints: readonly TapePrint[]): string | null {
  const counts = new Map<string, number>();
  let best: string | null = null;
  let bestCount = 0;
  for (const p of prints) {
    if (p.tradeCode == null) continue;
    const n = (counts.get(p.tradeCode) ?? 0) + 1;
    counts.set(p.tradeCode, n);
    if (n > bestCount) {
      best = p.tradeCode;
      bestCount = n;
    }
  }
  return best;
}

/** Fold one chain's prints into a leg: summed size, VWAP price. */
function toLeg(prints: readonly [TapePrint, ...TapePrint[]]): SpreadLeg {
  const [first] = prints;
  let size = 0;
  let notional = 0;
  for (const p of prints) {
    size += p.size;
    notional += p.price * p.size;
  }
  // Round the VWAP to 4 dp: legs print in cents (sub-penny at most), so
  // this only strips float noise like 0.5260000000000001.
  const price =
    size > 0 ? Math.round((notional / size) * 1e4) / 1e4 : first.price;
  return {
    optionType: first.optionType,
    strike: first.strike,
    expiry: first.expiry,
    size,
    price,
    tradeCode: mostCommonCode(prints),
  };
}

function compareLegs(a: SpreadLeg, b: SpreadLeg): number {
  if (a.expiry !== b.expiry) return a.expiry < b.expiry ? -1 : 1;
  if (a.optionType !== b.optionType)
    return a.optionType < b.optionType ? -1 : 1;
  return a.strike - b.strike;
}

/**
 * Group same-millisecond prints into legs, one per option chain. The
 * anchor's chain comes first, the rest by expiry, type, then strike
 * ascending. Capped at 8 legs (spec: `spread_legs` holds at most 8).
 */
export function groupLegs(
  prints: TapePrint[],
  anchorChain: string,
): SpreadLeg[] {
  const byChain = new Map<string, [TapePrint, ...TapePrint[]]>();
  for (const p of prints) {
    const group = byChain.get(p.optionChain);
    if (group) group.push(p);
    else byChain.set(p.optionChain, [p]);
  }
  const anchorGroup = byChain.get(anchorChain);
  byChain.delete(anchorChain);
  const others = [...byChain.values()].map(toLeg).sort(compareLegs);
  const legs = anchorGroup ? [toLeg(anchorGroup), ...others] : others;
  return legs.slice(0, 8);
}

function classifyPair(a: SpreadLeg, b: SpreadLeg): SpreadShape {
  const sameExpiry = a.expiry === b.expiry;
  const sameStrike = a.strike === b.strike;
  if (a.optionType === b.optionType) {
    if (sameExpiry) return sameStrike ? 'other' : 'vertical';
    return sameStrike ? 'calendar' : 'diagonal';
  }
  if (!sameExpiry) return 'other';
  return sameStrike ? 'straddle' : 'combo';
}

/**
 * OCC strikes are whole thousandths of a dollar, so compare spacing in
 * integer thousandths (10.2 - 10.1 !== 10.3 - 10.2 in float).
 */
const strikeMilli = (leg: SpreadLeg): number => Math.round(leg.strike * 1000);

/** Same type and expiry, equally spaced strikes, sizes 1:2:1. */
function isButterfly(legs: readonly SpreadLeg[]): boolean {
  const [low, body, high] = [...legs].sort(
    (x, y) => strikeMilli(x) - strikeMilli(y),
  );
  if (low == null || body == null || high == null) return false;
  const uniform = legs.every(
    (l) => l.optionType === low.optionType && l.expiry === low.expiry,
  );
  const lowerWing = strikeMilli(body) - strikeMilli(low);
  const upperWing = strikeMilli(high) - strikeMilli(body);
  return (
    uniform &&
    lowerWing > 0 &&
    lowerWing === upperWing &&
    low.size === high.size &&
    body.size === 2 * low.size
  );
}

/** The spec's shape table, applied to grouped legs (one leg per chain). */
export function classifySpreadShape(legs: SpreadLeg[]): SpreadShape {
  const [a, b] = legs;
  switch (legs.length) {
    case 1:
      return 'unpaired';
    case 2:
      return a != null && b != null ? classifyPair(a, b) : 'other';
    case 3:
      return isButterfly(legs) ? 'butterfly' : 'three_leg';
    case 4:
      return new Set(legs.map((l) => l.expiry)).size === 1
        ? 'four_leg'
        : 'four_leg_multi_expiry';
    default:
      // 0 legs can't come from describeAnchor (the anchor is always a leg).
      return legs.length >= 5 ? 'complex' : 'other';
  }
}

/**
 * Leg kind, shape and legs for one anchor. `sameMsMultiLeg` is every
 * multi-leg-coded print on the anchor's ticker in its millisecond; it may
 * include the anchor itself (deduped by trade id). Shape and legs are set
 * only for a multi-leg anchor; a multi-leg anchor with no other chain in
 * its millisecond is `unpaired` (e.g. the other leg was stock or futures).
 */
export function describeAnchor(
  anchor: TapePrint,
  sameMsMultiLeg: TapePrint[],
): AnchorLegs {
  const legKind = legKindForTradeCode(anchor.tradeCode);
  const base = {
    anchorWsTradeId: anchor.wsTradeId,
    anchorTradeCode: anchor.tradeCode,
    legKind,
  };
  if (legKind !== 'multi_leg') {
    return { ...base, spreadShape: null, spreadLegs: null };
  }
  const prints = [
    anchor,
    ...sameMsMultiLeg.filter((p) => p.wsTradeId !== anchor.wsTradeId),
  ];
  const spreadLegs = groupLegs(prints, anchor.optionChain);
  return { ...base, spreadShape: classifySpreadShape(spreadLegs), spreadLegs };
}

// ── DB: two batched queries per call ───────────────────────────────────────

/** A print row as the Neon driver returns it (NUMERIC/BIGINT as strings). */
interface TapeRow {
  /** 1-based position in the unnest()ed input (WITH ORDINALITY, bigint). */
  idx: string | number;
  ws_trade_id: string;
  option_chain: string;
  option_type: 'C' | 'P';
  strike: string | number;
  expiry: Date | string;
  executed_ms: string | number;
  price: string | number;
  size: string | number;
  trade_code: string | null;
}

function toTapePrint(row: TapeRow): TapePrint {
  return {
    wsTradeId: row.ws_trade_id,
    optionChain: row.option_chain,
    optionType: row.option_type,
    strike: Number(row.strike),
    expiry: toIsoDate(row.expiry),
    executedAt: new Date(Number(row.executed_ms)).toISOString(),
    price: Number(row.price),
    size: Number(row.size),
    // UW sends a literal '' on some prints: that's "no code", not a code.
    tradeCode: row.trade_code === '' ? null : row.trade_code,
  };
}

/**
 * Anchor + legs for every request, in at most two queries whatever the
 * batch size (rule R5: no per-alert round trips):
 *
 *   1. Anchors: one LATERAL top-1 per request on
 *      ws_option_trades_chain_executed_idx (option_chain, executed_at).
 *   2. Siblings: one LATERAL scan per distinct (ticker, millisecond) of a
 *      multi-leg anchor on ws_option_trades_ticker_executed_idx. Skipped
 *      when no anchor is multi-leg. `OFFSET 0` keeps it a per-pair index
 *      scan: as a plain join the planner can't size the 1 ms range from a
 *      joined column and, at ~150 pairs, chose a parallel seq scan of the
 *      whole table (31 GB, EXPLAIN 2026-10-29).
 *
 * Returns `null` for a request with no qualifying print in its window. A
 * DB error propagates, so a missing anchor (null) and a failed lookup
 * (throw) stay distinguishable. No retry or timeout here: the caller owns
 * the deadline, e.g. `withDbRetry(() => lookupAnchorLegs(reqs), …)`.
 */
export async function lookupAnchorLegs(
  requests: AnchorRequest[],
): Promise<Map<string, AnchorLegs | null>> {
  const result = new Map<string, AnchorLegs | null>();
  if (requests.length === 0) return result;
  const sql = getDb();

  const anchorRows = (await sql`
    SELECT r.idx, a.ws_trade_id, a.option_chain, a.option_type, a.strike,
           a.expiry, a.executed_ms, a.price, a.size, a.trade_code
      FROM unnest(
             ${requests.map((r) => r.optionChain)}::text[],
             ${requests.map((r) => r.windowStart.toISOString())}::timestamptz[],
             ${requests.map((r) => r.windowEnd.toISOString())}::timestamptz[]
           ) WITH ORDINALITY AS r(chain, window_start, window_end, idx)
      CROSS JOIN LATERAL (
             SELECT t.ws_trade_id, t.option_chain, t.option_type, t.strike,
                    t.expiry,
                    floor(extract(epoch FROM t.executed_at) * 1000)::bigint
                      AS executed_ms,
                    t.price, t.size, t.raw_payload->>'trade_code' AS trade_code
               FROM ws_option_trades t
              WHERE t.option_chain = r.chain
                AND t.executed_at >= r.window_start
                AND t.executed_at < r.window_end
                AND t.canceled = FALSE
                AND t.price > 0
              ORDER BY t.price * t.size DESC, t.executed_at ASC, t.id ASC
              LIMIT 1
           ) a
  `) as TapeRow[];

  const anchors = new Map<number, TapePrint>();
  for (const row of anchorRows) {
    anchors.set(Number(row.idx) - 1, toTapePrint(row));
  }

  // Distinct (ticker, ms) pairs of multi-leg anchors, in first-seen order.
  const pairKey = (ticker: string, executedAt: string) =>
    `${ticker}|${executedAt}`;
  const pairIndex = new Map<string, number>();
  const pairTickers: string[] = [];
  const pairStarts: string[] = [];
  requests.forEach((req, i) => {
    const anchor = anchors.get(i);
    if (anchor == null) return;
    if (legKindForTradeCode(anchor.tradeCode) !== 'multi_leg') return;
    const key = pairKey(req.ticker, anchor.executedAt);
    if (pairIndex.has(key)) return;
    pairIndex.set(key, pairTickers.length);
    pairTickers.push(req.ticker);
    pairStarts.push(anchor.executedAt);
  });

  const siblingsByPair: TapePrint[][] = pairTickers.map(() => []);
  if (pairTickers.length > 0) {
    const siblingRows = (await sql`
      SELECT p.idx, s.ws_trade_id, s.option_chain, s.option_type, s.strike,
             s.expiry, s.executed_ms, s.price, s.size, s.trade_code
        FROM unnest(${pairTickers}::text[], ${pairStarts}::timestamptz[])
               WITH ORDINALITY AS p(ticker, start_at, idx)
        CROSS JOIN LATERAL (
               SELECT t.id, t.ws_trade_id, t.option_chain, t.option_type,
                      t.strike, t.expiry,
                      floor(extract(epoch FROM t.executed_at) * 1000)::bigint
                        AS executed_ms,
                      t.price, t.size, t.raw_payload->>'trade_code' AS trade_code
                 FROM ws_option_trades t
                WHERE t.ticker = p.ticker
                  AND t.executed_at >= p.start_at
                  AND t.executed_at < p.start_at + interval '1 millisecond'
                  AND t.canceled = FALSE
                  AND t.price > 0
                  AND lower(t.raw_payload->>'trade_code')
                        = ANY(${[...MULTI_LEG_TRADE_CODES]}::text[])
               OFFSET 0
             ) s
       ORDER BY p.idx, s.id
    `) as TapeRow[];
    for (const row of siblingRows) {
      siblingsByPair[Number(row.idx) - 1]?.push(toTapePrint(row));
    }
  }

  requests.forEach((req, i) => {
    const anchor = anchors.get(i);
    if (anchor == null) {
      result.set(req.key, null);
      return;
    }
    const pair = pairIndex.get(pairKey(req.ticker, anchor.executedAt));
    const siblings = pair == null ? [] : (siblingsByPair[pair] ?? []);
    result.set(req.key, describeAnchor(anchor, siblings));
  });
  return result;
}
