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
    case 'pre_trade': {
      const window = PRE_TRADE_WINDOW;
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
        flavor: 'pre_trade',
      });
    }
    case 'intraday': {
      const window = INTRADAY_WINDOW;
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
        flavor: 'intraday',
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
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

// ── Internals ───────────────────────────────────────────────

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
