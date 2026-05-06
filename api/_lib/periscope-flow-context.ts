/**
 * Per-mode flow-alert context block for /api/periscope-chat.
 *
 * Builds a labelled text block summarising recent (or full-day) SPXW
 * informed-flow alerts — anchored to the read's spot + asOf — that
 * the periscope-chat handler appends to the Pass 2 user content
 * BETWEEN the heat-map block and the image blocks.
 *
 * Per spec `docs/superpowers/specs/periscope-chat-overhaul-2026-05-05.md`
 * Phase 1.5 the windowing varies by mode:
 *
 *   pre_trade : last 30 min, ±20 pts of spot, top 8
 *   intraday  : last 15 min, ±10 pts of spot, top 8
 *   debrief   : full session, hourly CT buckets
 *
 * The mode column today only carries `read | debrief`. The 3-mode
 * widening lands in Phase 6. For now `read` is treated as the
 * intraday case for the recent-window query — see {@link
 * resolveReadFlavor}. The `switch (mode)` includes an exhaustive
 * `never` check so adding a third branch in Phase 6 is a single-line
 * change, not a hunt-and-update.
 *
 * Failure mode: every code path returns `null` rather than throwing,
 * so the periscope read does not fail because a context query lost a
 * race with the websocket daemon. Caller wraps the call in a
 * best-effort try/catch as a second line of defence.
 */

import {
  fetchRecentFlowAlerts,
  aggregateFlowAlertsForDay,
  type FlowAlertRow,
  type DayBucket,
} from './db-flow-alerts.js';
import type { PeriscopeMode } from './periscope-db.js';

// ── Window constants ────────────────────────────────────────

// NOTE (Phase 6 follow-up): the mode column widens to
// 'pre_trade' | 'intraday' | 'debrief'. When that lands, drop the
// resolveReadFlavor() shim and switch directly on the new union; the
// three constant blocks below already match the spec's pre/intra/debrief
// windows, so the only change is the dispatch.

const PRE_TRADE_WINDOW = {
  windowMinutes: 30,
  spotProximityPts: 20,
  topN: 8,
} as const;

const INTRADAY_WINDOW = {
  windowMinutes: 15,
  spotProximityPts: 10,
  topN: 8,
} as const;

const TICKER = 'SPXW' as const;

// ── Public API ──────────────────────────────────────────────

interface BuildFlowContextArgs {
  mode: PeriscopeMode;
  spot: number;
  asOf: Date;
}

/**
 * Build a labelled flow-alert text block for injection into Pass 2
 * user content. Returns `null` when no alerts are available (caller
 * should skip appending in that case).
 */
export async function buildFlowContextBlock(
  args: BuildFlowContextArgs,
): Promise<string | null> {
  const { mode, spot, asOf } = args;

  switch (mode) {
    case 'read': {
      // TEMPORARY MAPPING (Phase 1.5):
      //   Today's mode column only has `read | debrief`. The 3-mode
      //   migration in Phase 6 will widen `read` into `pre_trade` +
      //   `intraday`. Until then, every `read` is dispatched through
      //   resolveReadFlavor() which infers pre-open vs intraday from
      //   the asOf timestamp. The Phase-6 migration will replace this
      //   block with two separate cases that pick the constants
      //   directly off the mode value.
      const flavor = resolveReadFlavor(asOf);
      const window =
        flavor === 'pre_trade' ? PRE_TRADE_WINDOW : INTRADAY_WINDOW;
      const rows = await fetchRecentFlowAlerts({
        ticker: TICKER,
        windowMinutes: window.windowMinutes,
        spotProximityPts: window.spotProximityPts,
        spot,
        asOf,
        topN: window.topN,
      });
      if (rows.length === 0) return null;
      return formatRecentBlock({
        rows,
        windowMinutes: window.windowMinutes,
        spotProximityPts: window.spotProximityPts,
        flavor,
      });
    }
    case 'debrief': {
      const date = isoDateInCt(asOf);
      const buckets = await aggregateFlowAlertsForDay({
        ticker: TICKER,
        date,
      });
      if (buckets.length === 0) return null;
      return formatDebriefBlock(buckets, date);
    }
    default: {
      // Exhaustiveness check — adding a new PeriscopeMode value (Phase 6)
      // will produce a compile error here until the new branch is added.
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

// ── Internals ───────────────────────────────────────────────

/**
 * Pre-Phase-6 heuristic: does `asOf` fall before the regular cash
 * session open (09:30 ET)? If so, treat the `read` as a pre-trade
 * read and use the wider 30-min / ±20pt window. Otherwise treat as
 * intraday with the tighter 15-min / ±10pt window.
 *
 * 09:30 ET = 14:30 UTC during EDT (DST), 14:30 UTC during EST (no DST
 * change for the equity open boundary itself but UTC offset shifts).
 * To keep this simple and tz-aware without pulling a heavy date lib,
 * we use Intl.DateTimeFormat with `America/New_York` to read the wall
 * clock at the source.
 */
function resolveReadFlavor(asOf: Date): 'pre_trade' | 'intraday' {
  const hourEt = etHour(asOf);
  const minuteEt = etMinute(asOf);
  // Pre-09:30 ET → pre_trade. The window is permissive on the lower
  // bound (we don't try to require 06:30+ ET); a query with no rows
  // returns null and the caller skips the block.
  if (hourEt < 9) return 'pre_trade';
  if (hourEt === 9 && minuteEt < 30) return 'pre_trade';
  return 'intraday';
}

function etHour(d: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
  });
  // en-US in 24h returns "00".."23" (sometimes "24" for midnight on
  // some runtimes — coerce to mod 24 for safety).
  return Number(fmt.format(d)) % 24;
}

function etMinute(d: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    minute: '2-digit',
  });
  return Number(fmt.format(d));
}

/** ISO YYYY-MM-DD for the date `d` lands on in America/Chicago. */
function isoDateInCt(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA returns YYYY-MM-DD natively.
  return fmt.format(d);
}

/** HH:MM CT formatted timestamp for prose framing. */
function ctClock(iso: string): string {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(d);
}

/**
 * Format the recent-alerts block for read mode (currently pre_trade
 * or intraday, post-Phase-6 will be the two flavors directly).
 */
function formatRecentBlock(args: {
  rows: FlowAlertRow[];
  windowMinutes: number;
  spotProximityPts: number;
  flavor: 'pre_trade' | 'intraday';
}): string {
  const { rows, windowMinutes, spotProximityPts, flavor } = args;
  const header =
    flavor === 'pre_trade'
      ? `Pre-open SPXW flow alerts placed in the last ${windowMinutes} min within ±${spotProximityPts} pts of spot:`
      : `Fresh SPXW flow alerts placed in the last ${windowMinutes} min within ±${spotProximityPts} pts of spot:`;

  const bullets = rows.map((r) => {
    const time = ctClock(r.created_at);
    const type = r.option_type === 'C' ? 'CALL' : 'PUT';
    const strike = formatStrike(r.strike);
    const rule = r.rule_name ?? 'unknown';
    const askSide = formatAskSide(r.ask_side_ratio);
    const prem = formatPremium(r.total_premium);
    const tail = [askSide, prem].filter((s) => s !== '').join(', ');
    const tailSegment = tail.length > 0 ? `  (${tail})` : '';
    return `  - ${time} CT  ${type} ${strike}  rule="${rule}"${tailSegment}`;
  });

  return [header, ...bullets].join('\n');
}

function formatStrike(strike: number): string {
  // Strikes are integers in practice; show one decimal only when needed.
  return Number.isInteger(strike) ? String(strike) : strike.toFixed(2);
}

function formatAskSide(ratio: number | null): string {
  if (ratio == null) return '';
  const pct = Math.round(ratio * 100);
  return `ask ${pct}%`;
}

function formatPremium(premium: number | null): string {
  if (premium == null || premium <= 0) return '';
  if (premium >= 1_000_000) {
    return `prem $${(premium / 1_000_000).toFixed(2)}M`;
  }
  if (premium >= 1_000) {
    return `prem $${(premium / 1_000).toFixed(1)}K`;
  }
  return `prem $${premium.toFixed(0)}`;
}

/**
 * Format the day-aggregation block for debrief mode as a small
 * monospace-aligned table (markdown-ish).
 */
function formatDebriefBlock(buckets: DayBucket[], date: string): string {
  const header = `SPXW flow distribution across ${date} (hourly CT buckets):`;
  const colHeader = '  hour  total  bullish  bearish  neutral  premium';
  const rows = buckets.map((b) => {
    const hour = padLeft(`${String(b.hourCt).padStart(2, '0')}:00`, 6);
    const total = padLeft(String(b.total), 5);
    const bull = padLeft(String(b.bullish), 7);
    const bear = padLeft(String(b.bearish), 7);
    const neut = padLeft(String(b.neutral), 7);
    const prem = padLeft(formatPremium(b.totalPremium) || '$0', 9);
    return `  ${hour}  ${total}  ${bull}  ${bear}  ${neut}  ${prem}`;
  });
  return [header, colHeader, ...rows].join('\n');
}

function padLeft(s: string, width: number): string {
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}
