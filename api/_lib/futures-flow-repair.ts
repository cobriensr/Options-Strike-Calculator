/**
 * Order-flow repair for `futures_bars` from UW REST prints.
 *
 * uw-stream writes per-minute aggressor flow (`buy_volume`,
 * `sell_volume`, `buy_prints`, `sell_prints`, migration #193) with each
 * bar. Bars it never saw (websocket drops, rows the OHLC repair inserts,
 * rows written before the columns existed) carry NULL flow, meaning
 * unknown. This module refills them from `GET /futures/{contract}/trades`,
 * shared by the nightly pass in `api/cron/backfill-futures-gaps.ts`
 * (Phase 6) and the one-time history backfill
 * `scripts/backfill-futures-flow.ts` (Phase 6b).
 *
 *   - `fetchContractFlow` pages one contract's prints newest-first over a
 *     time range (`skip_blocks=true`, `limit=500`, a +1 µs `older_than`
 *     cursor with `trade_id` dedup at the boundary, probe 0a) under a
 *     shared page budget, drops spread prints, and sums each minute's
 *     volume by UW `side`: the exchange aggressor flag (99.1% tick-test
 *     agreement). `none` or a missing side counts toward volume only, so
 *     buy + sell ≤ volume. Never classify on `nbbo_*`: it is post-trade.
 *   - `matchFlowToBars` keeps a minute only when its REST volume is within
 *     2% of the bar's `volume` and buy + sell fits inside it. Deduped
 *     non-spread print volume matched websocket bars exactly (30 of 30
 *     minutes), so a miss means the wrong contract, a gap in UW's history,
 *     or a bar from another source (Databento-era OHLCV), and the minute
 *     stays NULL.
 *   - `writeFlowMinutes` is one batched `UPDATE … FROM unnest(…)` per 500
 *     minutes, conditional on `buy_volume IS NULL`: idempotent, and it
 *     never overwrites flow the websocket wrote.
 *   - `fetchNullFlowBars` / `groupFlowRanges` find the NULL-flow bars in
 *     Globex-open minutes, in runs of consecutive bars.
 *
 * Which contract a root's bar came from is not stored; callers pick it
 * with `replayFrontMonth` (`api/_lib/futures-contracts.ts`), the same rule
 * the live handler and the OHLC repair use.
 *
 * Spec: docs/superpowers/specs/2026-10-28-uw-futures-orderflow-design.md
 * (Phases 6 and 6b, as amended by probe 0a).
 */

import { z } from 'zod';
import { uwFetch, withRetry } from './api-helpers.js';
import { getDb, withDbRetry } from './db.js';
import { formatMicrosIso, parseUwTimeMicros } from './uw-time.js';
import { isFuturesMarketOpen } from '../../src/utils/timezone.js';

/** UW's maximum `limit` on /futures/{contract}/trades. */
const TRADES_PAGE_LIMIT = 500;

/** Largest relative gap between REST minute volume and the bar's volume. */
export const FLOW_VOLUME_TOLERANCE = 0.02;

const UPDATE_CHUNK = 500;
const MINUTE_MS = 60_000;
const MINUTE_US = 60_000_000n;

// ── Types ───────────────────────────────────────────────────

/** One minute's aggressor flow for one contract. */
export interface FlowMinute {
  /** The minute, `toISOString()` form (UTC). */
  ts: string;
  /** Deduped non-spread print volume, every side. */
  volume: number;
  buyVolume: number;
  sellVolume: number;
  buyPrints: number;
  sellPrints: number;
}

/**
 * Shared, mutable request budget. Every page request takes one from
 * `pagesLeft`; no request starts at or after `deadlineMs`.
 */
export interface PageBudget {
  pagesLeft: number;
  deadlineMs: number;
}

/**
 * Why paging stopped: it reached the range start (`complete`), the
 * budget ran out (`budget`), or UW returned an empty page, which is the
 * edge of its history for the contract (`exhausted`).
 */
export type FlowFetchStop = 'complete' | 'budget' | 'exhausted';

export interface ContractFlow {
  /**
   * Minutes with at least one counted print, keyed by `FlowMinute.ts`,
   * oldest last. Only minutes in [coveredFromMs, end) are present, and a
   * minute that held a malformed print is withheld.
   */
  minutes: Map<string, FlowMinute>;
  /** Minutes at or after this (ms) and before the range end are complete. */
  coveredFromMs: number;
  stop: FlowFetchStop;
  pages: number;
  /** Prints skipped as malformed (each withholds its minute). */
  malformed: number;
}

/** A bar's identity and volume, as the repair matches it. */
export interface FlowBar {
  ts: string;
  volume: number;
}

export interface NullFlowBar extends FlowBar {
  symbol: string;
  /** The previous bar of this symbol (if any) already had flow. */
  startsRange: boolean;
}

/** Consecutive NULL-flow bars of one symbol, oldest first. */
export interface FlowRange {
  symbol: string;
  bars: FlowBar[];
}

// ── REST paging ─────────────────────────────────────────────

const TradeRow = z.object({
  trade_id: z.number().int().nonnegative(),
  is_spread: z.boolean(),
  is_block: z.boolean().nullish(),
  size: z.number().int().nonnegative().nullish(),
  side: z.enum(['buy', 'sell', 'none']).nullish(),
});

type Print =
  | {
      ok: true;
      id: number;
      us: bigint;
      counted: boolean;
      size: number;
      side: 'buy' | 'sell' | null;
    }
  | { ok: false; us: bigint };

function parsePrint(contract: string, raw: unknown): Print {
  const at = typeof raw === 'object' && raw !== null ? raw : {};
  const us = parseUwTimeMicros((at as { executed_at?: unknown }).executed_at);
  const parsed = TradeRow.safeParse(raw);
  if (us === null) {
    const id = parsed.success ? parsed.data.trade_id : 'unknown';
    throw new Error(
      `UW trades for ${contract}: print ${id} has no usable executed_at`,
    );
  }
  if (!parsed.success) return { ok: false, us };
  const r = parsed.data;
  const block = r.is_block === true;
  // A regular print must carry a size; a block (skip_blocks should drop
  // them) has qty instead and is never counted.
  if (!block && r.size == null) return { ok: false, us };
  return {
    ok: true,
    id: r.trade_id,
    us,
    counted: !block && !r.is_spread,
    size: r.size ?? 0,
    side: r.side === 'buy' || r.side === 'sell' ? r.side : null,
  };
}

function minuteMsOf(us: bigint): number {
  return Number(us / MINUTE_US) * MINUTE_MS;
}

function addPrint(
  minutes: Map<number, FlowMinute>,
  minuteMs: number,
  size: number,
  side: 'buy' | 'sell' | null,
): void {
  let m = minutes.get(minuteMs);
  if (!m) {
    m = {
      ts: new Date(minuteMs).toISOString(),
      volume: 0,
      buyVolume: 0,
      sellVolume: 0,
      buyPrints: 0,
      sellPrints: 0,
    };
    minutes.set(minuteMs, m);
  }
  m.volume += size;
  if (side === 'buy') {
    m.buyVolume += size;
    m.buyPrints += 1;
  } else if (side === 'sell') {
    m.sellVolume += size;
    m.sellPrints += 1;
  }
}

/**
 * One contract's per-minute flow over [startMs, endMs), paged back from
 * `endMs`. Throws on an upstream error (after `withRetry`), a non-array
 * page, a page whose prints are all malformed, or a print whose time
 * can't be read. A malformed print with a readable time is skipped and
 * its minute withheld, so a partial count is never written.
 */
export async function fetchContractFlow(
  apiKey: string,
  contract: string,
  startMs: number,
  endMs: number,
  budget: PageBudget,
): Promise<ContractFlow> {
  const startUs = BigInt(startMs) * 1000n;
  const endUs = BigInt(endMs) * 1000n;
  const byMinute = new Map<number, FlowMinute>();
  const withheld = new Set<number>();
  let cursorUs = endUs;
  // Trade ids already counted at the current cursor's boundary time: the
  // +1 µs cursor re-returns exactly those rows, and only those can repeat.
  let boundaryUs: bigint | null = null;
  let boundaryIds = new Set<number>();
  let oldestUs: bigint | null = null;
  let pages = 0;
  let malformed = 0;
  let stop: FlowFetchStop;

  for (;;) {
    if (budget.pagesLeft <= 0 || Date.now() >= budget.deadlineMs) {
      stop = 'budget';
      break;
    }
    budget.pagesLeft -= 1;
    pages += 1;
    const query = new URLSearchParams({
      limit: String(TRADES_PAGE_LIMIT),
      skip_blocks: 'true',
      older_than: formatMicrosIso(cursorUs),
    });
    const path = `/futures/${encodeURIComponent(contract)}/trades?${query}`;
    const page: unknown = await withRetry(() => uwFetch<unknown>(apiKey, path));
    if (!Array.isArray(page)) {
      throw new Error(`UW trades for ${contract}: non-array trades page`);
    }
    if (page.length === 0) {
      stop = 'exhausted';
      break;
    }

    const prints = page.map((raw) => parsePrint(contract, raw));
    const bad = prints.filter((p) => !p.ok).length;
    if (bad === prints.length) {
      throw new Error(
        `UW trades for ${contract}: all ${bad} prints on a trades page are malformed`,
      );
    }
    malformed += bad;

    let pageOldest = prints[0]!.us;
    for (const p of prints) if (p.us < pageOldest) pageOldest = p.us;

    const pageIds = new Set<number>();
    let added = 0;
    for (const p of prints) {
      if (!p.ok) {
        withheld.add(minuteMsOf(p.us));
        continue;
      }
      if (pageIds.has(p.id)) continue;
      pageIds.add(p.id);
      if (p.us === boundaryUs && boundaryIds.has(p.id)) continue;
      added += 1;
      if (!p.counted || p.us < startUs || p.us >= endUs) continue;
      addPrint(byMinute, minuteMsOf(p.us), p.size, p.side);
    }

    const atOldest = new Set(
      prints.flatMap((p) => (p.ok && p.us === pageOldest ? [p.id] : [])),
    );
    boundaryIds =
      pageOldest === boundaryUs
        ? new Set([...boundaryIds, ...atOldest])
        : atOldest;
    boundaryUs = pageOldest;
    if (oldestUs === null || pageOldest < oldestUs) oldestUs = pageOldest;

    if (pageOldest < startUs) {
      stop = 'complete';
      break;
    }
    if (added > 0) {
      cursorUs = pageOldest + 1n;
    } else {
      // A full page of one microsecond's prints, all seen: step strictly
      // past it. Any prints left at that instant are lost, so its minute
      // is withheld rather than written short.
      withheld.add(minuteMsOf(pageOldest));
      cursorUs = pageOldest;
    }
  }

  // Paging back stopped mid-range: the oldest print's minute may hold
  // older prints never fetched, so coverage starts at the next minute.
  const coveredFromMs =
    stop === 'complete'
      ? startMs
      : oldestUs === null
        ? endMs
        : Math.max(startMs, minuteMsOf(oldestUs) + MINUTE_MS);

  const minutes = new Map<string, FlowMinute>();
  for (const [minuteMs, m] of byMinute) {
    if (minuteMs < coveredFromMs || withheld.has(minuteMs)) continue;
    minutes.set(m.ts, m);
  }
  return { minutes, coveredFromMs, stop, pages, malformed };
}

// ── Matching ────────────────────────────────────────────────

/**
 * The minutes safe to write onto these bars: REST volume within
 * FLOW_VOLUME_TOLERANCE of the bar's volume, and buy + sell ≤ the bar's
 * volume. A minute with no REST prints counts as zero volume, so a
 * zero-volume bar is written as a known zero and any other bar is
 * skipped. Each skipped bar is counted.
 */
export function matchFlowToBars(
  bars: readonly FlowBar[],
  flow: ReadonlyMap<string, FlowMinute>,
): { updates: FlowMinute[]; skippedTolerance: number } {
  const updates: FlowMinute[] = [];
  let skippedTolerance = 0;
  for (const bar of bars) {
    const m = flow.get(bar.ts) ?? {
      ts: bar.ts,
      volume: 0,
      buyVolume: 0,
      sellVolume: 0,
      buyPrints: 0,
      sellPrints: 0,
    };
    const withinTolerance =
      Math.abs(m.volume - bar.volume) <= FLOW_VOLUME_TOLERANCE * bar.volume;
    if (withinTolerance && m.buyVolume + m.sellVolume <= bar.volume) {
      updates.push(m);
    } else {
      skippedTolerance += 1;
    }
  }
  return { updates, skippedTolerance };
}

// ── DB ──────────────────────────────────────────────────────

/**
 * Writes flow onto `symbol`'s bars whose `buy_volume` is still NULL.
 * Returns the rows actually updated. Throws on a rejected UPDATE.
 */
export async function writeFlowMinutes(
  symbol: string,
  updates: readonly FlowMinute[],
): Promise<number> {
  if (updates.length === 0) return 0;
  const sql = getDb();
  let written = 0;
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
    const chunk = updates.slice(i, i + UPDATE_CHUNK);
    const rows = (await withDbRetry(
      () => sql`
        UPDATE futures_bars AS b
        SET buy_volume = t.buy_volume,
            sell_volume = t.sell_volume,
            buy_prints = t.buy_prints,
            sell_prints = t.sell_prints
        FROM unnest(
          ${chunk.map((m) => m.ts)}::timestamptz[],
          ${chunk.map((m) => m.buyVolume)}::bigint[],
          ${chunk.map((m) => m.sellVolume)}::bigint[],
          ${chunk.map((m) => m.buyPrints)}::int[],
          ${chunk.map((m) => m.sellPrints)}::int[]
        ) AS t(ts, buy_volume, sell_volume, buy_prints, sell_prints)
        WHERE b.symbol = ${symbol}
          AND b.ts = t.ts
          AND b.buy_volume IS NULL
        RETURNING b.ts
      `,
      2,
      10_000,
    )) as unknown[];
    written += rows.length;
  }
  return written;
}

interface NullFlowRow {
  symbol: string;
  ts: Date | string;
  volume: number | string;
  starts_range: boolean;
}

/**
 * NULL-flow bars of `symbols` in [startIso, endIso), Globex-open minutes
 * only, ordered by symbol then time. `startsRange` is true when the
 * symbol's previous bar in the window had flow, or there is none.
 */
export async function fetchNullFlowBars(
  symbols: readonly string[],
  startIso: string,
  endIso: string,
): Promise<NullFlowBar[]> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT symbol, ts, volume::float8 AS volume, starts_range
      FROM (
        SELECT symbol, ts, volume, buy_volume,
               (LAG(buy_volume IS NULL) OVER (PARTITION BY symbol ORDER BY ts))
                 IS NOT TRUE AS starts_range
        FROM futures_bars
        WHERE symbol = ANY(${symbols}::text[])
          AND ts >= ${startIso}::timestamptz
          AND ts < ${endIso}::timestamptz
      ) b
      WHERE buy_volume IS NULL
      ORDER BY symbol, ts
    `,
    2,
    10_000,
  )) as NullFlowRow[];

  const out: NullFlowBar[] = [];
  for (const r of rows) {
    const ts = new Date(r.ts);
    if (!isFuturesMarketOpen(ts)) continue;
    out.push({
      symbol: r.symbol,
      ts: ts.toISOString(),
      volume: Number(r.volume),
      startsRange: r.starts_range,
    });
  }
  return out;
}

/** Splits ordered NULL-flow bars into runs per symbol. */
export function groupFlowRanges(rows: readonly NullFlowBar[]): FlowRange[] {
  const ranges: FlowRange[] = [];
  let current: FlowRange | null = null;
  for (const r of rows) {
    if (current === null || r.startsRange || r.symbol !== current.symbol) {
      current = { symbol: r.symbol, bars: [] };
      ranges.push(current);
    }
    current.bars.push({ ts: r.ts, volume: r.volume });
  }
  return ranges;
}
