/**
 * DB dispatcher for Claude tool_use calls.
 *
 * Each tool name maps to a read-only DB query. Safety invariants:
 *   - All queries are scoped to analysisDate (no cross-date access)
 *   - before/to params are clamped to asOf (no future data leakage)
 *   - Every query has a hard LIMIT (200, 50, or 100 rows)
 *   - DB errors return is_error: true — Claude can handle gracefully
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type {
  ToolUseBlock,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import { getFlowData } from './db-flow.js';
import { getSpotExposures, formatSpotExposuresForClaude } from './db-flow.js';
import {
  getStrikeExposures,
  formatStrikeExposuresForClaude,
  getNetGexHeatmap,
  formatNetGexHeatmapForClaude,
} from './db-strike-helpers.js';
import logger from './logger.js';

// Row limits per tool (kept conservative to fit in token budget)
const FLOW_LIMIT = 200;
const SPOT_LIMIT = 50;
const STRIKE_LIMIT = 100;
const CANDLE_LIMIT = 200;

// ── SPX 1-minute candle query (local — no shared module for this yet) ──

export interface SpxCandle1m {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fetch 1-minute SPX candles from the spx_candles_1m table.
 *
 * @param db - Neon query function
 * @param date - Trading date (YYYY-MM-DD)
 * @param from - Optional ISO UTC lower bound
 * @param to - Optional ISO UTC upper bound (already clamped to asOf by caller)
 * @returns Candle rows ordered by timestamp ASC, max CANDLE_LIMIT rows
 */
export async function getSpxCandles(
  db: NeonQueryFunction<false, false>,
  date: string,
  from?: string,
  to?: string,
): Promise<SpxCandle1m[]> {
  let rows: Record<string, unknown>[];

  if (from && to) {
    rows = await db`
      SELECT timestamp, open, high, low, close, volume
      FROM spx_candles_1m
      WHERE date = ${date} AND timestamp >= ${from} AND timestamp <= ${to}
      ORDER BY timestamp ASC
      LIMIT ${CANDLE_LIMIT}
    `;
  } else if (from) {
    rows = await db`
      SELECT timestamp, open, high, low, close, volume
      FROM spx_candles_1m
      WHERE date = ${date} AND timestamp >= ${from}
      ORDER BY timestamp ASC
      LIMIT ${CANDLE_LIMIT}
    `;
  } else if (to) {
    rows = await db`
      SELECT timestamp, open, high, low, close, volume
      FROM spx_candles_1m
      WHERE date = ${date} AND timestamp <= ${to}
      ORDER BY timestamp ASC
      LIMIT ${CANDLE_LIMIT}
    `;
  } else {
    rows = await db`
      SELECT timestamp, open, high, low, close, volume
      FROM spx_candles_1m
      WHERE date = ${date}
      ORDER BY timestamp ASC
      LIMIT ${CANDLE_LIMIT}
    `;
  }

  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

// ── Tool input shapes (narrowed from unknown) ─────────────────

interface GetFlowDataInput {
  after?: string;
  before?: string;
  source?: string;
}

interface GetSpotExposuresInput {
  asOf?: string;
}

interface GetStrikeExposuresInput {
  asOf?: string;
}

interface GetSpxCandlesInput {
  from?: string;
  to?: string;
}

// ── Clamp helper ──────────────────────────────────────────────

/**
 * Clamp a caller-supplied timestamp to the analysis asOf ceiling.
 * Returns asOf when the supplied value is absent or exceeds asOf.
 */
function clampToAsOf(
  supplied: string | undefined,
  asOf: string | undefined,
): string | undefined {
  if (!supplied) return asOf;
  if (!asOf) return supplied;
  return supplied > asOf ? asOf : supplied;
}

// ── Flow data formatter ───────────────────────────────────────

interface FlowRow {
  timestamp: string;
  ncp: number;
  npp: number;
  netVolume: number;
  otmNcp: number | null;
  otmNpp: number | null;
}

function formatFlowForClaude(rows: FlowRow[]): string {
  if (rows.length === 0) return 'No flow data found for the requested window.';

  const limited = rows.slice(0, FLOW_LIMIT);
  const lines: string[] = [
    `Options flow data (${limited.length} rows, ordered by timestamp ASC):`,
  ];

  for (const r of limited) {
    const time = new Date(r.timestamp).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    const ncpFmt = fmtPremium(r.ncp);
    const nppFmt = fmtPremium(r.npp);
    const vol =
      r.netVolume != null
        ? `${r.netVolume >= 0 ? '+' : ''}${r.netVolume.toLocaleString()}`
        : 'N/A';
    lines.push(
      `  ${time} ET — NCP: ${ncpFmt}, NPP: ${nppFmt}, Vol: ${vol}`,
    );
  }

  return lines.join('\n');
}

function fmtPremium(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1_000_000_000)
    return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ── Main dispatcher ────────────────────────────────────────────

/**
 * Dispatch a Claude tool_use block to the appropriate DB function.
 *
 * @param block - The ToolUseBlock from Anthropic's response
 * @param db - Neon query function (from getDb())
 * @param analysisDate - Trading date in YYYY-MM-DD format (date-scopes all queries)
 * @param asOf - ISO UTC ceiling from the analysis context (clamps time-bounded queries)
 * @returns ToolResultBlockParam ready to be appended to the messages array
 */
export async function executeDbTool(
  block: ToolUseBlock,
  db: NeonQueryFunction<false, false>,
  analysisDate: string,
  asOf?: string,
): Promise<ToolResultBlockParam> {
  const { id: tool_use_id, name, input } = block;

  try {
    switch (name) {
      case 'get_flow_data': {
        const inp = (input ?? {}) as GetFlowDataInput;
        const source = inp.source ?? 'unusual_whales';
        const effectiveBefore = clampToAsOf(inp.before, asOf);

        // getFlowData accepts (date, source, asOf?) — asOf acts as upper bound
        // We use effectiveBefore for the upper bound and filter after in-memory
        const rows = await getFlowData(
          analysisDate,
          source,
          effectiveBefore,
        );

        // Apply after filter in-memory (getFlowData does not have an after param)
        const filtered = inp.after
          ? rows.filter((r) => r.timestamp >= inp.after!)
          : rows;

        const limited = filtered.slice(0, FLOW_LIMIT);

        return {
          type: 'tool_result',
          tool_use_id,
          content: formatFlowForClaude(limited),
        };
      }

      case 'get_spot_exposures': {
        const inp = (input ?? {}) as GetSpotExposuresInput;
        const effectiveAsOf = clampToAsOf(inp.asOf, asOf);

        const rows = await getSpotExposures(
          analysisDate,
          'SPX',
          effectiveAsOf,
        );

        const limited = rows.slice(-SPOT_LIMIT);
        const formatted = formatSpotExposuresForClaude(limited);

        return {
          type: 'tool_result',
          tool_use_id,
          content: formatted ?? 'No spot exposure data found.',
        };
      }

      case 'get_strike_exposures': {
        const inp = (input ?? {}) as GetStrikeExposuresInput;
        const effectiveAsOf = clampToAsOf(inp.asOf, asOf);

        const rows = await getStrikeExposures(
          analysisDate,
          'SPX',
          effectiveAsOf,
        );

        const limited = rows.slice(0, STRIKE_LIMIT);
        const formatted = formatStrikeExposuresForClaude(limited);

        return {
          type: 'tool_result',
          tool_use_id,
          content: formatted ?? 'No strike exposure data found.',
        };
      }

      case 'get_net_gex_heatmap': {
        const rows = await getNetGexHeatmap(analysisDate);
        const formatted = formatNetGexHeatmapForClaude(rows);

        return {
          type: 'tool_result',
          tool_use_id,
          content: formatted ?? 'No GEX heatmap data found.',
        };
      }

      case 'get_spx_candles': {
        const inp = (input ?? {}) as GetSpxCandlesInput;
        const effectiveTo = clampToAsOf(inp.to, asOf);

        const rows = await getSpxCandles(
          db,
          analysisDate,
          inp.from,
          effectiveTo,
        );

        if (rows.length === 0) {
          return {
            type: 'tool_result',
            tool_use_id,
            content: 'No SPX candle data found for the requested window.',
          };
        }

        const lines: string[] = [
          `SPX 1-minute candles (${rows.length} rows, ordered by timestamp ASC):`,
          '  timestamp (ET) | open | high | low | close | volume',
        ];

        for (const c of rows) {
          const time = new Date(c.timestamp).toLocaleTimeString('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          });
          lines.push(
            `  ${time} | ${c.open.toFixed(2)} | ${c.high.toFixed(2)} | ${c.low.toFixed(2)} | ${c.close.toFixed(2)} | ${c.volume}`,
          );
        }

        return {
          type: 'tool_result',
          tool_use_id,
          content: lines.join('\n'),
        };
      }

      default: {
        logger.warn({ toolName: name }, 'Unknown Claude tool name');
        return {
          type: 'tool_result',
          tool_use_id,
          content: `Unknown tool: ${name}`,
          is_error: true,
        };
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'DB query failed';
    logger.error({ err, toolName: name }, 'Claude tool DB query failed');
    return {
      type: 'tool_result',
      tool_use_id,
      content: `Tool ${name} failed: ${errMsg}`,
      is_error: true,
    };
  }
}
