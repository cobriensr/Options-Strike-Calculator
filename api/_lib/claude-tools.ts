/**
 * Claude tool definitions for read-only DB access during analysis generation.
 *
 * These 5 tools let Claude call named functions against Neon Postgres via
 * Anthropic's tool_use API, pulling live trading data on-demand rather than
 * pre-loading everything in the context.
 *
 * All tools are read-only. The dispatcher (db-claude-tools.ts) enforces
 * date-scoping and row caps on every query.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';

/**
 * Build the full list of Anthropic Tool definitions for the analyze endpoint.
 * Returns all 5 Phase-1 Tier-1 tools.
 */
export function buildClaudeTools(): Tool[] {
  return [
    {
      name: 'get_flow_data',
      description:
        'Fetch options flow trades for the analysis date. Returns premium, strike, side, expiry, size. Use after/before to narrow a time window.',
      input_schema: {
        type: 'object',
        properties: {
          after: {
            type: 'string',
            description:
              'ISO UTC lower bound, e.g. "2026-04-10T14:00:00Z". When provided, only rows with timestamp >= after are returned. If after exceeds the analysis ceiling (asOf), results will be empty.',
          },
          before: {
            type: 'string',
            description:
              'ISO UTC upper bound. Defaults to asOf if set. Clamped to the analysis asOf so Claude cannot query future data.',
          },
          source: {
            type: 'string',
            enum: ['unusual_whales', 'schwab'],
            description: 'Optional source filter.',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_spot_exposures',
      description:
        'Fetch aggregate SPX greek exposures (GEX, DEX, CEX, VEX, net delta) for the analysis date.',
      input_schema: {
        type: 'object',
        properties: {
          asOf: {
            type: 'string',
            description:
              'ISO UTC ceiling timestamp. Defaults to analysis asOf. Clamped to asOf so Claude cannot query future data.',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_strike_exposures',
      description:
        'Fetch per-strike OI, gamma, and delta exposures for SPX for the analysis date.',
      input_schema: {
        type: 'object',
        properties: {
          asOf: {
            type: 'string',
            description: 'ISO UTC ceiling timestamp.',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_net_gex_heatmap',
      description:
        'Fetch the net GEX heatmap for SPX: gamma walls, acceleration zones, gamma flip zone, and per-strike breakdown ±100pts of the flip zone.',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'get_spx_candles',
      description:
        'Fetch 1-minute SPX price candles. Returns open, high, low, close, volume per minute. Max 200 rows.',
      input_schema: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            description: 'ISO UTC start timestamp.',
          },
          to: {
            type: 'string',
            description:
              'ISO UTC end timestamp. Max 200 candles returned. Clamped to asOf so Claude cannot query future data.',
          },
        },
        required: [],
      },
    },
  ];
}
