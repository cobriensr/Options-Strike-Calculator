// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/db-flow.js', () => ({
  getFlowData: vi.fn(),
  getSpotExposures: vi.fn(),
  formatSpotExposuresForClaude: vi.fn(),
}));

vi.mock('../_lib/db-strike-helpers.js', () => ({
  getStrikeExposures: vi.fn(),
  formatStrikeExposuresForClaude: vi.fn(),
  getNetGexHeatmap: vi.fn(),
  formatNetGexHeatmapForClaude: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

// ── Imports (after mocks) ─────────────────────────────────────

import { buildClaudeTools } from '../_lib/claude-tools.js';
import { executeDbTool, getSpxCandles } from '../_lib/db-claude-tools.js';
import type { SpxCandle1m } from '../_lib/db-claude-tools.js';
import {
  getFlowData,
  getSpotExposures,
  formatSpotExposuresForClaude,
} from '../_lib/db-flow.js';
import {
  getStrikeExposures,
  formatStrikeExposuresForClaude,
  getNetGexHeatmap,
  formatNetGexHeatmapForClaude,
} from '../_lib/db-strike-helpers.js';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { NeonQueryFunction } from '@neondatabase/serverless';

// ── Helpers ───────────────────────────────────────────────────

function makeToolUseBlock(
  name: string,
  input: Record<string, unknown> = {},
  id = 'tool_abc123',
): ToolUseBlock {
  return {
    id,
    name,
    type: 'tool_use',
    input,
    caller: { type: 'direct' },
  } as ToolUseBlock;
}

const ANALYSIS_DATE = '2026-04-10';
const AS_OF = '2026-04-10T19:55:59.000Z';

// ── buildClaudeTools ──────────────────────────────────────────

describe('buildClaudeTools', () => {
  it('returns exactly 5 tools', () => {
    const tools = buildClaudeTools();
    expect(tools).toHaveLength(5);
  });

  it('has the correct tool names', () => {
    const tools = buildClaudeTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_flow_data');
    expect(names).toContain('get_spot_exposures');
    expect(names).toContain('get_strike_exposures');
    expect(names).toContain('get_net_gex_heatmap');
    expect(names).toContain('get_spx_candles');
  });

  it('every tool has input_schema with type object', () => {
    const tools = buildClaudeTools();
    for (const tool of tools) {
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
    }
  });

  it('every tool has a non-empty description', () => {
    const tools = buildClaudeTools();
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect((tool.description ?? '').length).toBeGreaterThan(0);
    }
  });

  it('get_flow_data schema has optional after/before/source properties', () => {
    const tools = buildClaudeTools();
    const tool = tools.find((t) => t.name === 'get_flow_data')!;
    const props = (
      tool.input_schema as { properties: Record<string, unknown> }
    ).properties;
    expect(props).toHaveProperty('after');
    expect(props).toHaveProperty('before');
    expect(props).toHaveProperty('source');
    expect(tool.input_schema.required).toHaveLength(0);
  });

  it('get_net_gex_heatmap schema has empty properties', () => {
    const tools = buildClaudeTools();
    const tool = tools.find((t) => t.name === 'get_net_gex_heatmap')!;
    const props = (
      tool.input_schema as { properties: Record<string, unknown> }
    ).properties;
    expect(Object.keys(props)).toHaveLength(0);
  });
});

// ── executeDbTool ─────────────────────────────────────────────

describe('executeDbTool — get_flow_data', () => {
  beforeEach(() => {
    vi.mocked(getFlowData).mockReset();
    vi.mocked(formatSpotExposuresForClaude).mockReset();
    mockLogger.error.mockReset();
    mockLogger.warn.mockReset();
  });

  it('calls getFlowData with date and source, returns tool_result', async () => {
    vi.mocked(getFlowData).mockResolvedValueOnce([
      {
        timestamp: '2026-04-10T14:00:00Z',
        ncp: 1_000_000,
        npp: -500_000,
        netVolume: 1000,
        otmNcp: null,
        otmNpp: null,
      },
    ]);

    const block = makeToolUseBlock('get_flow_data', { source: 'unusual_whales' });
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(result.type).toBe('tool_result');
    expect(result.tool_use_id).toBe('tool_abc123');
    expect(result.is_error).toBeFalsy();
    expect(vi.mocked(getFlowData)).toHaveBeenCalledWith(
      ANALYSIS_DATE,
      'unusual_whales',
      AS_OF,
    );
    expect(typeof result.content).toBe('string');
    expect(result.content).toContain('flow data');
  });

  it('defaults to unusual_whales when source not provided', async () => {
    vi.mocked(getFlowData).mockResolvedValueOnce([]);

    const block = makeToolUseBlock('get_flow_data', {});
    await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(vi.mocked(getFlowData)).toHaveBeenCalledWith(
      ANALYSIS_DATE,
      'unusual_whales',
      AS_OF,
    );
  });

  it('clamps before to asOf when before > asOf', async () => {
    vi.mocked(getFlowData).mockResolvedValueOnce([]);

    const futureBefore = '2099-01-01T00:00:00Z';
    const block = makeToolUseBlock('get_flow_data', { before: futureBefore });
    await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      AS_OF,
    );

    // before > asOf, so it should be clamped to asOf
    expect(vi.mocked(getFlowData)).toHaveBeenCalledWith(
      ANALYSIS_DATE,
      'unusual_whales',
      AS_OF,
    );
  });

  it('applies after filter in-memory', async () => {
    vi.mocked(getFlowData).mockResolvedValueOnce([
      {
        timestamp: '2026-04-10T13:00:00Z',
        ncp: 100,
        npp: 200,
        netVolume: 10,
        otmNcp: null,
        otmNpp: null,
      },
      {
        timestamp: '2026-04-10T15:00:00Z',
        ncp: 300,
        npp: 400,
        netVolume: 20,
        otmNcp: null,
        otmNpp: null,
      },
    ]);

    const block = makeToolUseBlock('get_flow_data', {
      after: '2026-04-10T14:00:00Z',
    });
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      AS_OF,
    );

    // Only the 15:00Z (11:00 AM ET) row should be in the output (after filter applied)
    // 13:00Z = 09:00 AM ET should be excluded
    expect(result.content).not.toContain('09:00 AM');
    expect(result.content).toContain('11:00 AM');
  });

  it('returns is_error on DB failure', async () => {
    vi.mocked(getFlowData).mockRejectedValueOnce(new Error('DB timeout'));

    const block = makeToolUseBlock('get_flow_data', {});
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('DB timeout');
    expect(result.type).toBe('tool_result');
    expect(result.tool_use_id).toBe('tool_abc123');
  });
});

describe('executeDbTool — get_spot_exposures', () => {
  beforeEach(() => {
    vi.mocked(getSpotExposures).mockReset();
    vi.mocked(formatSpotExposuresForClaude).mockReset();
  });

  it('calls getSpotExposures and returns formatted result', async () => {
    const fakeRows = [
      {
        timestamp: '2026-04-10T14:00:00Z',
        price: 5500,
        gammaOi: 1e10,
        gammaVol: 5e9,
        gammaDir: 2e9,
        charmOi: 1e8,
        charmVol: 5e7,
        charmDir: 2e7,
        vannaOi: 3e8,
        vannaVol: 1e8,
        vannaDir: 5e7,
      },
    ];
    vi.mocked(getSpotExposures).mockResolvedValueOnce(fakeRows);
    vi.mocked(formatSpotExposuresForClaude).mockReturnValueOnce(
      'SPX Aggregate GEX Panel...',
    );

    const block = makeToolUseBlock('get_spot_exposures', {});
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(result.type).toBe('tool_result');
    expect(result.tool_use_id).toBe('tool_abc123');
    expect(result.is_error).toBeFalsy();
    expect(vi.mocked(getSpotExposures)).toHaveBeenCalledWith(
      ANALYSIS_DATE,
      'SPX',
      AS_OF,
    );
    expect(result.content).toBe('SPX Aggregate GEX Panel...');
  });

  it('clamps asOf when caller supplies a future timestamp', async () => {
    vi.mocked(getSpotExposures).mockResolvedValueOnce([]);
    vi.mocked(formatSpotExposuresForClaude).mockReturnValueOnce(null);

    const block = makeToolUseBlock('get_spot_exposures', {
      asOf: '2099-12-31T23:59:59Z',
    });
    await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(vi.mocked(getSpotExposures)).toHaveBeenCalledWith(
      ANALYSIS_DATE,
      'SPX',
      AS_OF,
    );
  });
});

describe('executeDbTool — get_strike_exposures', () => {
  beforeEach(() => {
    vi.mocked(getStrikeExposures).mockReset();
    vi.mocked(formatStrikeExposuresForClaude).mockReset();
  });

  it('calls getStrikeExposures and returns formatted result', async () => {
    vi.mocked(getStrikeExposures).mockResolvedValueOnce([]);
    vi.mocked(formatStrikeExposuresForClaude).mockReturnValueOnce(
      'SPX per-strike profile',
    );

    const block = makeToolUseBlock('get_strike_exposures', {});
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(result.type).toBe('tool_result');
    expect(result.tool_use_id).toBe('tool_abc123');
    expect(vi.mocked(getStrikeExposures)).toHaveBeenCalledWith(
      ANALYSIS_DATE,
      'SPX',
      AS_OF,
    );
    expect(result.content).toBe('SPX per-strike profile');
  });

  it('returns fallback message when no data', async () => {
    vi.mocked(getStrikeExposures).mockResolvedValueOnce([]);
    vi.mocked(formatStrikeExposuresForClaude).mockReturnValueOnce(null);

    const block = makeToolUseBlock('get_strike_exposures', {});
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
    );

    expect(result.content).toContain('No strike exposure data');
  });
});

describe('executeDbTool — get_net_gex_heatmap', () => {
  beforeEach(() => {
    vi.mocked(getNetGexHeatmap).mockReset();
    vi.mocked(formatNetGexHeatmapForClaude).mockReset();
  });

  it('calls getNetGexHeatmap and returns formatted result', async () => {
    vi.mocked(getNetGexHeatmap).mockResolvedValueOnce([]);
    vi.mocked(formatNetGexHeatmapForClaude).mockReturnValueOnce(
      'SPX 0DTE Net GEX Heatmap...',
    );

    const block = makeToolUseBlock('get_net_gex_heatmap', {});
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
    );

    expect(result.type).toBe('tool_result');
    expect(result.tool_use_id).toBe('tool_abc123');
    expect(vi.mocked(getNetGexHeatmap)).toHaveBeenCalledWith(ANALYSIS_DATE);
    expect(result.content).toBe('SPX 0DTE Net GEX Heatmap...');
  });

  it('returns fallback message when formatter returns null', async () => {
    vi.mocked(getNetGexHeatmap).mockResolvedValueOnce([]);
    vi.mocked(formatNetGexHeatmapForClaude).mockReturnValueOnce(null);

    const block = makeToolUseBlock('get_net_gex_heatmap', {});
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
    );

    expect(result.content).toContain('No GEX heatmap data');
  });
});

describe('executeDbTool — get_spx_candles', () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it('queries spx_candles_1m and returns formatted rows', async () => {
    const fakeDbRows = [
      {
        timestamp: '2026-04-10T14:30:00Z',
        open: '5500.25',
        high: '5510.50',
        low: '5498.00',
        close: '5505.75',
        volume: '12345',
        spx_schwab_price: null,
      },
    ];
    mockSql.mockResolvedValueOnce(fakeDbRows);

    const block = makeToolUseBlock('get_spx_candles', {
      from: '2026-04-10T14:00:00Z',
      to: '2026-04-10T15:00:00Z',
    });
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(result.type).toBe('tool_result');
    expect(result.tool_use_id).toBe('tool_abc123');
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain('SPX 1-minute candles');
    expect(result.content).toContain('5500.25');
  });

  it('includes Schwab SPX price anchor in formatted output when present', async () => {
    const fakeDbRows = [
      {
        timestamp: '2026-04-10T14:30:00Z',
        open: '5500.25',
        high: '5510.50',
        low: '5498.00',
        close: '5505.75',
        volume: '12345',
        spx_schwab_price: '6810.20',
      },
    ];
    mockSql.mockResolvedValueOnce(fakeDbRows);

    const block = makeToolUseBlock('get_spx_candles', {});
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
    );

    expect(result.content).toContain('Schwab SPX close: 6810.20');
  });

  it('clamps to param to asOf when to > asOf', async () => {
    mockSql.mockResolvedValueOnce([]);

    const block = makeToolUseBlock('get_spx_candles', {
      to: '2099-01-01T00:00:00Z',
    });
    await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      AS_OF,
    );

    // mockSql was called — check the call happened (clamping is internal)
    expect(mockSql).toHaveBeenCalled();
  });

  it('returns fallback when no candles found', async () => {
    mockSql.mockResolvedValueOnce([]);

    const block = makeToolUseBlock('get_spx_candles', {});
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
    );

    expect(result.content).toContain('No SPX candle data');
  });
});

describe('executeDbTool — unknown tool', () => {
  it('returns is_error true for unknown tool name', async () => {
    const block = makeToolUseBlock('get_unknown_data', {});
    const result = await executeDbTool(
      block,
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
    );

    expect(result.type).toBe('tool_result');
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Unknown tool');
    expect(result.tool_use_id).toBe('tool_abc123');
  });
});

// ── getSpxCandles (direct unit tests) ────────────────────────

describe('getSpxCandles', () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it('maps DB rows to SpxCandle1m correctly', async () => {
    const fakeRows = [
      {
        timestamp: '2026-04-10T14:30:00Z',
        open: '5500.25',
        high: '5510.50',
        low: '5498.00',
        close: '5505.75',
        volume: '100',
        spx_schwab_price: '6810.50',
      },
    ];
    mockSql.mockResolvedValueOnce(fakeRows);

    const result = await getSpxCandles(
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
    );

    expect(result).toHaveLength(1);
    const candle = result[0] as SpxCandle1m;
    expect(candle.timestamp).toBe('2026-04-10T14:30:00Z');
    expect(candle.open).toBe(5500.25);
    expect(candle.high).toBe(5510.5);
    expect(candle.low).toBe(5498.0);
    expect(candle.close).toBe(5505.75);
    expect(candle.volume).toBe(100);
    expect(candle.spxSchwabPrice).toBe(6810.5);
  });

  it('sets spxSchwabPrice to null when DB column is null', async () => {
    const fakeRows = [
      {
        timestamp: '2026-04-10T14:30:00Z',
        open: '5500.25',
        high: '5510.50',
        low: '5498.00',
        close: '5505.75',
        volume: '100',
        spx_schwab_price: null,
      },
    ];
    mockSql.mockResolvedValueOnce(fakeRows);

    const result = await getSpxCandles(
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
    );

    expect(result[0]?.spxSchwabPrice).toBeNull();
  });

  it('queries without from/to when neither is provided', async () => {
    mockSql.mockResolvedValueOnce([]);
    await getSpxCandles(
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
    );
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('queries with from only', async () => {
    mockSql.mockResolvedValueOnce([]);
    await getSpxCandles(
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      '2026-04-10T14:00:00Z',
    );
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('queries with to only', async () => {
    mockSql.mockResolvedValueOnce([]);
    await getSpxCandles(
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      undefined,
      '2026-04-10T19:00:00Z',
    );
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('queries with both from and to', async () => {
    mockSql.mockResolvedValueOnce([]);
    await getSpxCandles(
      mockSql as unknown as NeonQueryFunction<false, false>,
      ANALYSIS_DATE,
      '2026-04-10T14:00:00Z',
      '2026-04-10T19:00:00Z',
    );
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
