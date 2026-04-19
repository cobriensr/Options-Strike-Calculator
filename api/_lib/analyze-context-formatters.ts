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

const HIGH_SEVERITY_TYPES = new Set(['FOMC', 'CPI', 'PCE', 'JOBS', 'GDP']);

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
  ticker: string;
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

// ── ML findings ───────────────────────────────────────────────────────

export function formatMlFindingsForClaude(
  findings: Record<string, unknown>,
  updatedAt: Date,
): string {
  if (!findings?.dataset) {
    return `Latest ML pipeline run: ${updatedAt.toISOString().slice(0, 10)} (data unavailable)`;
  }
  const d = findings.dataset as {
    total_days: number;
    labeled_days: number;
    date_range: string[];
    overall_accuracy: number;
  };
  const conf = findings.confidence_calibration as Record<
    string,
    { correct: number; total: number; rate: number }
  >;
  const flow = findings.flow_reliability as Record<
    string,
    { correct: number; total: number; rate: number }
  >;
  const structAcc = findings.structure_accuracy as Record<
    string,
    { correct: number; total: number; rate: number }
  >;
  const majority = findings.majority_baseline as {
    structure: string;
    rate: number;
  };
  const topPredictors = (
    findings.top_correctness_predictors as Array<{
      feature: string;
      r: number;
      p: number;
    }>
  )?.slice(0, 5);

  const lines: string[] = [
    `Latest ML pipeline run: ${updatedAt.toISOString().slice(0, 10)} (${d.total_days} days, ${d.labeled_days} labeled, ${d.date_range[0]} to ${d.date_range[1]})`,
    `Overall accuracy: ${(d.overall_accuracy * 100).toFixed(1)}%`,
    '',
    'Structure accuracy:',
  ];

  for (const [struct, acc] of Object.entries(structAcc)) {
    lines.push(
      `  ${struct}: ${acc.correct}/${acc.total} (${(acc.rate * 100).toFixed(0)}%)`,
    );
  }

  lines.push('', 'Confidence calibration:');
  for (const [level, cal] of Object.entries(conf)) {
    lines.push(
      `  ${level}: ${cal.correct}/${cal.total} (${(cal.rate * 100).toFixed(0)}%)`,
    );
  }

  lines.push('', 'Flow source accuracy (settlement direction):');
  for (const [source, rel] of Object.entries(flow)) {
    lines.push(
      `  ${source}: ${rel.correct}/${rel.total} (${(rel.rate * 100).toFixed(0)}%)`,
    );
  }

  lines.push(
    '',
    `Previous-day baseline: always repeat yesterday = ${(majority.rate * 100).toFixed(0)}% (structure: ${majority.structure})`,
  );

  if (topPredictors?.length) {
    lines.push('', 'Top correctness predictors:');
    for (const pred of topPredictors) {
      const dir =
        pred.r > 0 ? 'higher = MORE correct' : 'higher = LESS correct';
      lines.push(`  ${pred.feature}: r=${pred.r.toFixed(3)} (${dir})`);
    }
  }

  return lines.join('\n');
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
    WHERE ticker = 'market_tide'
      AND date < ${currentDate}
    ORDER BY date DESC
    LIMIT 2
  `;

  if (dateRows.length === 0) return null;

  const priorDates = (dateRows as Array<{ date: string }>).map((r) => r.date);

  const dayData: DayFlowData[] = await Promise.all(
    priorDates.map(async (date) => {
      const tideRows = (await sql`
        SELECT ncp, npp, ticker, date, created_at
        FROM flow_data
        WHERE date = ${date}
          AND ticker = 'market_tide'
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
        SELECT DISTINCT ON (ticker) ticker, ncp, npp, date, created_at
        FROM flow_data
        WHERE date = ${date}
          AND ticker = ANY(${SECONDARY_FLOW_SOURCES as unknown as string[]})
        ORDER BY ticker, created_at DESC
      `) as FlowRow[];

      const secondarySources: Partial<Record<SecondaryFlowSource, FlowRow>> =
        {};
      for (const row of secRows) {
        if (
          SECONDARY_FLOW_SOURCES.includes(row.ticker as SecondaryFlowSource)
        ) {
          secondarySources[row.ticker as SecondaryFlowSource] = row;
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
  lines.push(`Top ${analogs.length} historical analog days (by embedding cosine similarity):`);
  for (const [i, a] of analogs.entries()) {
    lines.push(`  ${(i + 1).toString().padStart(2, ' ')}. ${a.summary}`);
  }
  lines.push('');
  lines.push(
    'These are structurally similar setups; their eventual day closes (the last field of each row) are your historical priors for what often follows a setup like today\'s. Use them to pressure-test your base-rate expectations — a cohort that mostly closed green argues against a bearish call, and vice versa. Do not treat as deterministic.',
  );
  return lines.join('\n');
}
