/**
 * Pure formatters for analyze-context.
 *
 * Everything in this file takes DB rows or domain objects and produces
 * a Claude-readable string block. No DB access, no network — the
 * fetchers in analyze-context-fetchers.ts call these after loading
 * the raw data.
 *
 * These functions are exported so analyze.ts unit tests can exercise
 * them directly without mocking the whole context builder.
 */

import {
  getEarlyCloseHourET,
  isHalfDay,
  priorTradingDay,
} from '../../src/data/marketHours.js';
import type { InternalBar } from '../../src/types/market-internals.js';
import { classifyRegime } from '../../src/utils/market-regime.js';
import { detectExtremes } from '../../src/utils/extreme-detector.js';
import type { getDb } from './db.js';

// ── Shared types ──────────────────────────────────────────────────────

type Sql = ReturnType<typeof getDb>;

export interface EconomicEventRow {
  event_name: string;
  event_time: string | Date;
  event_type: string;
  forecast: string | null;
  previous: string | null;
  reported_period: string | null;
}

type NumericColumn = string | number | null;
export interface VolRealizedRow {
  iv_30d: NumericColumn;
  rv_30d: NumericColumn;
  iv_rv_spread: NumericColumn;
  iv_overpricing_pct: NumericColumn;
  iv_rank: NumericColumn;
}

// FED (speeches, testimony, minutes, Beige Book) stays [HIGH]: analyze Rule 12
// hard-exits on Fed speeches after 1 PM ET (owner decision 2026-11-06).
const HIGH_SEVERITY_TYPES = new Set([
  'FOMC',
  'FED',
  'CPI',
  'PCE',
  'JOBS',
  'GDP',
]);

const FLOW_SOURCE_LABELS: Record<string, string> = {
  market_tide: 'Market Tide',
  spx_flow: 'SPX Flow',
  spy_flow: 'SPY Flow',
  qqq_flow: 'QQQ Flow',
  spy_etf_tide: 'SPY ETF Tide',
  qqq_etf_tide: 'QQQ ETF Tide',
};

const SECONDARY_FLOW_SOURCES = [
  'spx_flow',
  'spy_flow',
  'qqq_flow',
  'spy_etf_tide',
  'qqq_etf_tide',
] as const;

type SecondaryFlowSource = (typeof SECONDARY_FLOW_SOURCES)[number];

// 17:00 UTC = 12:00 PM ET (noon) for mid-session checkpoint
const MIDDAY_UTC_HOUR = 17;

interface FlowRow {
  ncp: number;
  npp: number;
  source: string;
  date: string;
  created_at: string | Date;
}

interface TideArc {
  open: FlowRow;
  midday: FlowRow;
  close: FlowRow;
}

interface DayFlowData {
  date: string;
  tideArc: TideArc | null;
  secondarySources: Partial<Record<SecondaryFlowSource, FlowRow>>;
}

// ── Economic calendar ─────────────────────────────────────────────────

export function formatEconomicCalendarForClaude(
  rows: EconomicEventRow[],
): string {
  if (rows.length === 0) return 'No scheduled economic events today.';

  const lines = rows.map((row) => {
    const severity = HIGH_SEVERITY_TYPES.has(row.event_type) ? '🔴' : '🟡';
    const level = HIGH_SEVERITY_TYPES.has(row.event_type) ? 'HIGH' : 'MEDIUM';

    const dt =
      row.event_time instanceof Date
        ? row.event_time
        : new Date(row.event_time);
    const timeEt = dt.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    let line = `${severity} ${row.event_name} at ${timeEt} ET [${level}]`;

    const forecastTrimmed = row.forecast != null ? row.forecast.trim() : '';
    const previousTrimmed = row.previous != null ? row.previous.trim() : '';

    if (forecastTrimmed) line += ` | Forecast: ${forecastTrimmed}`;
    if (previousTrimmed) {
      const period =
        row.reported_period != null && row.reported_period.trim()
          ? ` (${row.reported_period.trim()})`
          : '';
      line += ` | Previous: ${previousTrimmed}${period}`;
    }

    return line;
  });

  return lines.join('\n');
}

// ── Market internals ──────────────────────────────────────────────────

export function formatMarketInternalsForClaude(
  bars: InternalBar[],
): string | null {
  if (bars.length === 0) return null;

  const regime = classifyRegime(bars);
  const extremes = detectExtremes(bars, regime.regime);

  const regimeLabel =
    regime.regime === 'range'
      ? 'RANGE DAY'
      : regime.regime === 'trend'
        ? 'TREND DAY'
        : 'NEUTRAL';
  const confidencePct = Math.round(regime.confidence * 100);

  const lines: string[] = [
    `Regime: ${regimeLabel} (confidence: ${confidencePct}%)`,
    'Evidence:',
  ];
  for (const ev of regime.evidence) {
    lines.push(`- ${ev}`);
  }

  const bySymbol = new Map<string, InternalBar>();
  for (const bar of bars) {
    bySymbol.set(bar.symbol, bar);
  }

  const latestLines: string[] = [];
  const tick = bySymbol.get('$TICK');
  if (tick)
    latestLines.push(
      `$TICK: ${tick.close > 0 ? '+' : ''}${Math.round(tick.close)}`,
    );
  const add = bySymbol.get('$ADD');
  if (add)
    latestLines.push(
      `$ADD: ${add.close > 0 ? '+' : ''}${Math.round(add.close).toLocaleString()}`,
    );
  const vold = bySymbol.get('$VOLD');
  if (vold)
    latestLines.push(
      `$VOLD: ${vold.close > 0 ? '+' : ''}${Math.round(vold.close).toLocaleString()}`,
    );
  const trin = bySymbol.get('$TRIN');
  if (trin) latestLines.push(`$TRIN: ${trin.close.toFixed(2)}`);

  if (latestLines.length > 0) {
    lines.push('', 'Current readings (latest bar):');
    for (const l of latestLines) {
      lines.push(`- ${l}`);
    }
  }

  if (extremes.length > 0) {
    lines.push('', `Today's extreme events (${extremes.length} total):`);
    for (const evt of extremes) {
      const time = new Date(evt.ts).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      const pinnedTag = evt.pinned ? ', pinned 5m' : '';
      lines.push(
        `- ${time} ET: ${evt.symbol} ${evt.value > 0 ? '+' : ''}${Math.round(evt.value)} (${evt.band}${pinnedTag}) — ${evt.label}`,
      );
    }
  }

  return lines.join('\n');
}

// ── Prior-day flow ────────────────────────────────────────────────────

function formatNetFlow(ncp: number, npp: number): string {
  const net = ncp - npp;
  const dir = net < 0 ? 'bull' : 'bear';
  const absNet = Math.abs(net);
  const label =
    absNet >= 1e9
      ? `${(absNet / 1e9).toFixed(1)}B`
      : `${Math.round(absNet / 1e6)}M`;
  return `${net < 0 ? '-' : '+'}${label} ${dir}`;
}

function findMiddayRow(rows: FlowRow[]): FlowRow {
  let best = rows[0]!;
  let bestDiff = Infinity;
  for (const row of rows) {
    const dt =
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at);
    const diffHours = Math.abs(dt.getUTCHours() - MIDDAY_UTC_HOUR);
    if (diffHours < bestDiff) {
      bestDiff = diffHours;
      best = row;
    }
  }
  return best;
}

/**
 * Classify a single day's Market Tide intraday arc into a session type.
 *
 * - REVERSAL   — open and close in opposite directions
 * - FADE       — same direction open/close but midday peak ≥ 2× close magnitude
 * - TREND DAY  — same direction, midday peak ≥ 1.5× close magnitude (strong, held)
 * - SUSTAINED  — same direction, relatively flat arc (< 1.5× peak/close ratio)
 */
function classifySessionType(arc: TideArc): string {
  const openBull = arc.open.ncp < arc.open.npp;
  const closeBull = arc.close.ncp < arc.close.npp;

  if (openBull !== closeBull) return 'REVERSAL';

  const closeMag = Math.abs(arc.close.ncp - arc.close.npp);
  const middayMag = Math.abs(arc.midday.ncp - arc.midday.npp);

  if (closeMag === 0) return 'SUSTAINED';

  const ratio = middayMag / closeMag;
  if (ratio >= 2) return 'FADE';
  if (ratio >= 1.5) return 'TREND DAY';
  return 'SUSTAINED';
}

function buildPriorFlowTrend(dayData: DayFlowData[]): string {
  if (dayData.length === 0) return 'Insufficient data.';

  const assessments = dayData
    .map((day) => {
      if (!day.tideArc) return null;
      const { close } = day.tideArc;
      return {
        bullish: close.ncp < close.npp,
        strength: Math.abs(close.ncp - close.npp),
        sessionType: classifySessionType(day.tideArc),
      };
    })
    .filter(Boolean) as Array<{
    bullish: boolean;
    strength: number;
    sessionType: string;
  }>;

  if (assessments.length === 0)
    return 'No Market Tide data available for prior days.';

  if (assessments.length === 1) {
    const a = assessments[0]!;
    return `Market Tide was ${a.bullish ? 'bullish' : 'bearish'} (${a.sessionType}, single prior day — no trend).`;
  }

  const first = assessments[0]!;
  const last = assessments.at(-1)!;

  const recentDay = dayData.at(-1)!;
  const sourcesAligned = SECONDARY_FLOW_SOURCES.every((src) => {
    const row = recentDay.secondarySources[src];
    if (!row) return true;
    return row.ncp < row.npp === last.bullish;
  });

  let trend: string;
  if (first.bullish === last.bullish) {
    const strengthening = last.strength > first.strength;
    const dir = last.bullish ? 'bullish' : 'bearish';
    const change = strengthening ? 'strengthening' : 'weakening';
    trend = `Market Tide ${change} ${dir} (${last.sessionType} most recent session).`;
  } else {
    const newDir = last.bullish ? 'bullish' : 'bearish';
    trend = `Market Tide reversing to ${newDir} (${last.sessionType} most recent session).`;
  }

  const alignmentNote = sourcesAligned
    ? ' Other sources aligned.'
    : ' Mixed signals across sources.';

  return trend + alignmentNote;
}

/**
 * Format prior 2 trading days' flow readings for Claude, including the full
 * intraday arc (open → midday → close) for Market Tide and terminal values
 * for secondary sources. Returns null when no prior dates have data.
 */
export async function formatPriorDayFlowForClaude(
  sql: Sql,
  currentDate: string,
): Promise<string | null> {
  const dateRows = await sql`
    SELECT DISTINCT date
    FROM flow_data
    WHERE source = 'market_tide'
      AND date < ${currentDate}
    ORDER BY date DESC
    LIMIT 2
  `;

  if (dateRows.length === 0) return null;

  const priorDates = (dateRows as Array<{ date: string }>).map((r) => r.date);

  const dayData: DayFlowData[] = await Promise.all(
    priorDates.map(async (date) => {
      const tideRows = (await sql`
        SELECT ncp, npp, source, date, created_at
        FROM flow_data
        WHERE date = ${date}
          AND source = 'market_tide'
        ORDER BY created_at ASC
      `) as FlowRow[];

      let tideArc: TideArc | null = null;
      if (tideRows.length > 0) {
        const openRow = tideRows[0]!;
        const closeRow = tideRows.at(-1)!;
        const middayRow = findMiddayRow(tideRows);
        tideArc = { open: openRow, midday: middayRow, close: closeRow };
      }

      const secRows = (await sql`
        SELECT DISTINCT ON (source) source, ncp, npp, date, created_at
        FROM flow_data
        WHERE date = ${date}
          AND source = ANY(${SECONDARY_FLOW_SOURCES as unknown as string[]})
        ORDER BY source, created_at DESC
      `) as FlowRow[];

      const secondarySources: Partial<Record<SecondaryFlowSource, FlowRow>> =
        {};
      for (const row of secRows) {
        if (
          SECONDARY_FLOW_SOURCES.includes(row.source as SecondaryFlowSource)
        ) {
          secondarySources[row.source as SecondaryFlowSource] = row;
        }
      }

      return { date, tideArc, secondarySources };
    }),
  );

  dayData.reverse();

  const lines: string[] = ['## Prior-Day Flow Trend'];

  for (const day of dayData) {
    lines.push('');
    lines.push(`### ${day.date}`);

    if (day.tideArc) {
      const { open, midday, close } = day.tideArc;
      const openLabel = formatNetFlow(open.ncp, open.npp);
      const middayLabel = formatNetFlow(midday.ncp, midday.npp);
      const closeLabel = formatNetFlow(close.ncp, close.npp);
      const sessionType = classifySessionType(day.tideArc);
      const closeBull = close.ncp < close.npp;
      const closeDir = closeBull ? 'bullish' : 'bearish';
      lines.push(
        `Market Tide Arc: Open ${openLabel} → Midday ${middayLabel} → Close ${closeLabel}`,
      );
      lines.push(`Session Type: ${sessionType} — ${closeDir} close`);
    } else {
      lines.push('Market Tide: N/A');
    }

    const secParts: string[] = [];
    for (const src of SECONDARY_FLOW_SOURCES) {
      const row = day.secondarySources[src];
      if (row) {
        const label = FLOW_SOURCE_LABELS[src] ?? src;
        secParts.push(`${label}: ${formatNetFlow(row.ncp, row.npp)}`);
      }
    }
    if (secParts.length > 0) {
      lines.push(`Confirmation: ${secParts.join(' | ')}`);
    }
  }

  lines.push('');
  lines.push(`Trend: ${buildPriorFlowTrend(dayData)}`);

  return lines.join('\n');
}

// ============================================================
// Historical analogs (day embeddings)
// ============================================================

export interface HistoricalAnalog {
  date: string;
  symbol: string;
  summary: string;
  distance: number;
}

/**
 * Format a cohort of historical analog days for the analyze prompt.
 *
 * The summary text per row is the deterministic one-liner produced by
 * the sidecar (`day_summary_text`). We surface distance as an integer
 * "similarity rank" (1 = closest) rather than the raw cosine distance
 * — the rank is what Claude can reason about cleanly, and the raw
 * distance values across the cohort are all in a narrow band that
 * doesn't add signal.
 */
export function formatSimilarDaysForClaude(
  todaySummary: string,
  analogs: HistoricalAnalog[],
): string {
  if (analogs.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('Today:');
  lines.push(`  ${todaySummary}`);
  lines.push('');
  lines.push(
    `Top ${analogs.length} historical analog days (by embedding cosine similarity):`,
  );
  for (const [i, a] of analogs.entries()) {
    lines.push(`  ${(i + 1).toString().padStart(2, ' ')}. ${a.summary}`);
  }
  lines.push('');
  lines.push(
    "These are structurally similar setups; their eventual day closes (the last field of each row) are your historical priors for what often follows a setup like today's. Use them to pressure-test your base-rate expectations — a cohort that mostly closed green argues against a bearish call, and vice versa. Do not treat as deterministic.",
  );
  return lines.join('\n');
}

// ── Vol realized + IV rank ────────────────────────────────────────────

/**
 * Format the vol_realized row into a Claude-readable block. Mirrors the
 * inline prose previously baked into fetchVolRealizedContext (Phase 5g).
 *
 * Returns null when neither the IV/RV pair nor the IV rank yields a
 * usable line — keeps "no data" outcomes identical to the pre-split
 * fetcher (callers compare with === null and drop the section).
 */
export function formatVolRealizedForClaude(rv: VolRealizedRow): string | null {
  const iv30 = rv.iv_30d != null ? (Number(rv.iv_30d) * 100).toFixed(1) : null;
  const rv30 = rv.rv_30d != null ? (Number(rv.rv_30d) * 100).toFixed(1) : null;
  const spread =
    rv.iv_rv_spread != null ? (Number(rv.iv_rv_spread) * 100).toFixed(1) : null;
  const overpricing =
    rv.iv_overpricing_pct != null
      ? Number(rv.iv_overpricing_pct).toFixed(1)
      : null;
  const rank = rv.iv_rank != null ? Number(rv.iv_rank).toFixed(0) : null;

  const lines: string[] = [];
  if (iv30 && rv30) {
    lines.push(`30D Implied Vol: ${iv30}% | 30D Realized Vol: ${rv30}%`);
    if (spread) {
      const label = Number(spread) > 0 ? 'IV OVERPRICING' : 'IV UNDERPRICING';
      lines.push(`IV-RV Spread: ${spread} vol pts (${label})`);
    }
    if (overpricing) {
      lines.push(
        `Overpricing: ${overpricing}% — ${Number(overpricing) > 10 ? 'premium is rich, favorable for selling' : Number(overpricing) < -10 ? 'premium is cheap, caution selling' : 'fairly priced'}`,
      );
    }
  }
  if (rank) {
    lines.push(
      `IV Rank (1-year): ${rank}th percentile — ${Number(rank) > 70 ? 'elevated, rich premium' : Number(rank) < 30 ? 'low, cheap premium' : 'mid-range'}`,
    );
  }
  return lines.length > 0 ? lines.join('\n  ') : null;
}

// ── Previous session + VIX-implied move ───────────────────────────────

/** One `outcomes` row with its numeric columns parsed; a NULL stays null. */
export interface OutcomesDay {
  settlement: number | null;
  day_high: number | null;
  day_low: number | null;
  day_range_pts: number | null;
  vix_close: number | null;
}

export interface PrevSessionInput {
  /** D, the date being analyzed. */
  analysisDate: string;
  /** P1, the trading day before D. */
  p1Date: string;
  /** P2, the trading day before P1. */
  p2Date: string;
  p1: OutcomesDay;
  /** null when `outcomes` has no row for P2. */
  p2: OutcomesDay | null;
  /**
   * Every `outcomes` row the fetcher read (the days before D, newest 30), by
   * 'YYYY-MM-DD' date, for the recent-sessions line. It includes P1 and P2.
   */
  recent: ReadonlyMap<string, OutcomesDay>;
}

/** The annualisation the range study used: 252 trading days a year. */
const SQRT_TRADING_DAYS = Math.sqrt(252);

/** A finite number above zero, else null: a zero or negative close or VIX is unusable. */
function positive(v: number | null): number | null {
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

function finite(v: number | null): number | null {
  return v !== null && Number.isFinite(v) ? v : null;
}

interface ImpliedMove {
  close: number;
  vix: number;
  pts: number;
}

/** close x VIX / 100 / sqrt(252) in index points; null when either input is unusable. */
function impliedMove(day: OutcomesDay | null): ImpliedMove | null {
  const close = positive(day?.settlement ?? null);
  const vix = positive(day?.vix_close ?? null);
  if (close === null || vix === null) return null;
  return { close, vix, pts: (close * vix) / 100 / SQRT_TRADING_DAYS };
}

/** `v` signed to `places` decimals; a value that rounds to zero reads plus zero. */
function signed(v: number, places: number): string {
  const scale = 10 ** places;
  const rounded = Math.round(v * scale) / scale;
  return `${rounded < 0 ? '-' : '+'}${Math.abs(rounded).toFixed(places)}`;
}

/**
 * "12:00 CT" for an early-close day, null for a normal one. The calendar
 * stores the close in ET; ET and CT change clocks together, so CT is one hour
 * earlier all year.
 */
function halfDayCloseCt(date: string): string | null {
  const closeEt = isHalfDay(date) ? getEarlyCloseHourET(date) : undefined;
  return closeEt === undefined ? null : `${closeEt - 1}:00 CT`;
}

/** How many of the most recent full sessions the recent-sessions line counts. */
const RECENT_WINDOW = 20;
/** Fewer usable sessions than this and the line says it is unavailable. */
const RECENT_MIN = 10;

/**
 * How often the most recent full sessions reached 1.0x, 1.25x and 1.5x their own
 * VIX-implied move, so the model can see the current regime beside the prompt's
 * full-sample rates.
 *
 * A session S counts only when S is not a half day, `priorTradingDay(S)` is in
 * `recent` with a usable close and VIX (its implied move is the yardstick), and
 * S has a high above its low. Its multiple is (high - low) / that implied move.
 * A missing or unusable row therefore costs the sessions that need it and no
 * others. The window is the newest 20 such sessions; with fewer than 10 the
 * line says it is unavailable.
 */
function recentSessionsLine(recent: ReadonlyMap<string, OutcomesDay>): string {
  const multiples: { date: string; multiple: number }[] = [];
  const newestFirst = [...recent.entries()].sort(([a], [b]) =>
    a < b ? 1 : -1,
  );
  for (const [date, day] of newestFirst) {
    if (isHalfDay(date)) continue;
    const high = finite(day.day_high);
    const low = finite(day.day_low);
    if (high === null || low === null || high <= low) continue;
    const prior = impliedMove(recent.get(priorTradingDay(date)) ?? null);
    if (prior === null) continue;
    multiples.push({ date, multiple: (high - low) / prior.pts });
    if (multiples.length === RECENT_WINDOW) break;
  }

  const n = multiples.length;
  if (n < RECENT_MIN) {
    return `Recent sessions: unavailable (fewer than ${RECENT_MIN} usable sessions).`;
  }
  const count = (level: number) =>
    multiples.filter((m) => m.multiple >= level).length;
  const pct = (c: number) => Math.round((c / n) * 100);
  const [c10, c125, c15] = [count(1), count(1.25), count(1.5)];
  const lastFive = multiples.slice(0, 5);
  const average =
    lastFive.reduce((sum, m) => sum + m.multiple, 0) / lastFive.length;
  return `Recent sessions (last ${n} full sessions, ${multiples[n - 1]!.date} to ${multiples[0]!.date}): ${c10} reached 1.0× their implied move (${pct(c10)}%), ${c125} reached 1.25× (${pct(c125)}%), ${c15} reached 1.5× (${pct(c15)}%). Average multiple over the last 5: ${average.toFixed(2)}×.`;
}

/**
 * Today's VIX-implied move, the previous session's range as a multiple of its
 * own implied move, the previous session's VIX change, and how often recent
 * sessions reached 1.0x, 1.25x and 1.5x their own implied move, from the
 * `outcomes` rows before D: P1 and P2 (the two trading days before D) for the
 * first three lines, the newest 30 rows for the last.
 *
 * Each line degrades alone: a missing or unusable column makes that line say
 * it is unavailable, and never prints NaN or Infinity. The caller returns
 * nothing at all when P1 has no row. There are no flags and no thresholds
 * here: the base rates live in the cached prompt text, in one place.
 */
export function formatPrevSessionForClaude(input: PrevSessionInput): string {
  const { analysisDate, p1Date, p2Date, p1, p2, recent } = input;
  const lines: string[] = [];

  const today = impliedMove(p1);
  lines.push(
    today === null
      ? `Today's VIX-implied move (prior-close VIX): unavailable (no usable SPX close and VIX close for ${p1Date}).`
      : `Today's VIX-implied move (prior-close VIX): ${today.pts.toFixed(1)} pts (SPX close ${today.close.toFixed(2)} × VIX ${today.vix.toFixed(2)} / 100 / √252, ${p1Date}). Session high-to-low range at 1.0× = ${Math.round(today.pts)}, 1.25× = ${Math.round(today.pts * 1.25)}, 1.5× = ${Math.round(today.pts * 1.5)} pts (whole range, not distance from the open).`,
  );

  const p1CloseCt = halfDayCloseCt(p1Date);
  const rangeLabel =
    p1CloseCt === null
      ? p1Date
      : `${p1Date}, a half day with a ${p1CloseCt} close`;
  const high = finite(p1.day_high);
  const low = finite(p1.day_low);
  const rangePts = finite(p1.day_range_pts);
  // A day's high is above its low, so an inverted or zero pair is bad data and
  // would print a negative or "0.00×" multiple: treat it as unusable.
  if (high === null || low === null || rangePts === null || high <= low) {
    lines.push(
      `Previous day range (${rangeLabel}): unavailable (no usable high, low and range in outcomes).`,
    );
  } else {
    const spread = `${rangePts.toFixed(0)} pts (high ${high.toFixed(2)}, low ${low.toFixed(2)})`;
    const prior = impliedMove(p2);
    lines.push(
      prior === null
        ? `Previous day range (${rangeLabel}): ${spread}; no implied-move multiple, because ${p2Date} has no usable SPX close and VIX close.`
        : `Previous day range (${rangeLabel}): ${spread} = ${((high - low) / prior.pts).toFixed(2)}× that day's implied move (${prior.pts.toFixed(1)} pts).`,
    );
  }

  const vixP1 = positive(p1.vix_close);
  const vixP2 = positive(p2?.vix_close ?? null);
  if (vixP1 === null || vixP2 === null) {
    lines.push(
      `VIX change (${p1Date}, close to close): unavailable (needs a usable VIX close for ${p1Date} and ${p2Date}).`,
    );
  } else {
    const change = vixP1 - vixP2;
    lines.push(
      `VIX change (${p1Date}, close to close): ${signed(change, 2)} (${vixP2.toFixed(2)} → ${vixP1.toFixed(2)}), ${signed((change / vixP2) * 100, 1)}%.`,
    );
  }

  lines.push(recentSessionsLine(recent));

  const todayCloseCt = halfDayCloseCt(analysisDate);
  if (todayCloseCt !== null) {
    lines.push(
      `Today is a half day (close ${todayCloseCt}); the prompt's base rates come from full sessions and overstate today's range.`,
    );
  }

  return lines.join('\n');
}
