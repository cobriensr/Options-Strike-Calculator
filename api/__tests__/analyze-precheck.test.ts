// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/db-claude-tools.js', () => ({
  executeDbTool: vi.fn(),
}));

vi.mock('../_lib/claude-tools.js', () => ({
  buildClaudeTools: vi.fn(() => []),
}));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

// ── Imports (after mocks) ─────────────────────────────────────

import { runAnalysisPreCheck } from '../_lib/analyze-precheck.js';
import { executeDbTool } from '../_lib/db-claude-tools.js';
import { buildClaudeTools } from '../_lib/claude-tools.js';
import { getDb } from '../_lib/db.js';
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

/** Build a minimal mock Anthropic SDK instance */
function makeMockAnthropic(createResponses: unknown[]) {
  const createFn = vi.fn();
  for (const resp of createResponses) {
    createFn.mockResolvedValueOnce(resp);
  }
  return {
    messages: { create: createFn },
    _createFn: createFn,
  } as unknown as import('@anthropic-ai/sdk').default & {
    _createFn: ReturnType<typeof vi.fn>;
  };
}

const ANALYSIS_DATE = '2026-04-10';
const AS_OF = '2026-04-10T19:55:59.000Z';

const CONTEXT: Record<string, unknown> = {
  mode: 'entry',
  entryTime: '2:55 PM CT',
  vix: 18,
  vix1d: 15,
  spx: 5700,
  regimeZone: 'GREEN',
};

// ── Group 1: Basic behavior ────────────────────────────────────

describe('runAnalysisPreCheck — basic behavior', () => {
  beforeEach(() => {
    vi.mocked(executeDbTool).mockReset();
    vi.mocked(buildClaudeTools).mockReturnValue([]);
    mockLogger.warn.mockReset();
  });

  it('returns null when Claude responds without tool_use (end_turn)', async () => {
    const anthropic = makeMockAnthropic([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'none' }] },
    ]);

    const result = await runAnalysisPreCheck(
      anthropic,
      CONTEXT,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(result).toBeNull();
  });

  it('returns null when stop_reason is max_tokens with no tool_use blocks', async () => {
    const anthropic = makeMockAnthropic([
      {
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'partial response' }],
      },
    ]);

    const result = await runAnalysisPreCheck(
      anthropic,
      CONTEXT,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(result).toBeNull();
  });

  it('returns null when Anthropic throws any error', async () => {
    const anthropic = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('Network timeout')),
      },
    } as unknown as import('@anthropic-ai/sdk').default;

    const result = await runAnalysisPreCheck(
      anthropic,
      CONTEXT,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

// ── Group 2: Tool execution ────────────────────────────────────

describe('runAnalysisPreCheck — tool execution', () => {
  beforeEach(() => {
    vi.mocked(executeDbTool).mockReset();
    vi.mocked(buildClaudeTools).mockReturnValue([]);
    mockLogger.warn.mockReset();
  });

  it('calls executeDbTool for each tool_use block and returns formatted string', async () => {
    const toolBlock = makeToolUseBlock('get_spot_exposures', {});
    const anthropic = makeMockAnthropic([
      {
        stop_reason: 'tool_use',
        content: [toolBlock],
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
      },
    ]);

    vi.mocked(executeDbTool).mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tool_abc123',
      content: 'SPX spot exposure data here',
    });

    const result = await runAnalysisPreCheck(
      anthropic,
      CONTEXT,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(vi.mocked(executeDbTool)).toHaveBeenCalledOnce();
    expect(result).not.toBeNull();
    expect(result).toContain('SPX spot exposure data here');
  });

  it('calls tools in parallel — all tool results appear in output', async () => {
    const block1 = makeToolUseBlock('get_spot_exposures', {}, 'tool_1');
    const block2 = makeToolUseBlock('get_flow_data', {}, 'tool_2');
    const anthropic = makeMockAnthropic([
      {
        stop_reason: 'tool_use',
        content: [block1, block2],
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
      },
    ]);

    vi.mocked(executeDbTool)
      .mockResolvedValueOnce({
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: 'spot exposure result',
      })
      .mockResolvedValueOnce({
        type: 'tool_result',
        tool_use_id: 'tool_2',
        content: 'flow data result',
      });

    const result = await runAnalysisPreCheck(
      anthropic,
      CONTEXT,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(vi.mocked(executeDbTool)).toHaveBeenCalledTimes(2);
    expect(result).toContain('spot exposure result');
    expect(result).toContain('flow data result');
  });

  it('result string starts with === Additional Market Data header', async () => {
    const toolBlock = makeToolUseBlock('get_spot_exposures', {});
    const anthropic = makeMockAnthropic([
      { stop_reason: 'tool_use', content: [toolBlock] },
      { stop_reason: 'end_turn', content: [] },
    ]);

    vi.mocked(executeDbTool).mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tool_abc123',
      content: 'some data',
    });

    const result = await runAnalysisPreCheck(
      anthropic,
      CONTEXT,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(result).toMatch(
      /^=== Additional Market Data \(fetched on request\)/,
    );
  });

  it('returns null when all tool results are is_error true', async () => {
    const toolBlock = makeToolUseBlock('get_spot_exposures', {});
    const anthropic = makeMockAnthropic([
      { stop_reason: 'tool_use', content: [toolBlock] },
      { stop_reason: 'end_turn', content: [] },
    ]);

    vi.mocked(executeDbTool).mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tool_abc123',
      content: 'DB query failed',
      is_error: true,
    });

    const result = await runAnalysisPreCheck(
      anthropic,
      CONTEXT,
      ANALYSIS_DATE,
      AS_OF,
    );

    // Error results are excluded from output — no non-error text → null
    expect(result).toBeNull();
  });
});

// ── Group 3: Multi-turn ───────────────────────────────────────

describe('runAnalysisPreCheck — multi-turn', () => {
  beforeEach(() => {
    vi.mocked(executeDbTool).mockReset();
    vi.mocked(buildClaudeTools).mockReturnValue([]);
  });

  it('handles two tool turns then end_turn — collects results from both turns', async () => {
    const block1 = makeToolUseBlock('get_spot_exposures', {}, 'tool_1');
    const block2 = makeToolUseBlock('get_flow_data', {}, 'tool_2');
    const anthropic = makeMockAnthropic([
      // Turn 1: tool_use
      { stop_reason: 'tool_use', content: [block1] },
      // Turn 2: another tool_use
      { stop_reason: 'tool_use', content: [block2] },
      // Turn 3: end_turn
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    ]);

    vi.mocked(executeDbTool)
      .mockResolvedValueOnce({
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: 'first turn data',
      })
      .mockResolvedValueOnce({
        type: 'tool_result',
        tool_use_id: 'tool_2',
        content: 'second turn data',
      });

    const result = await runAnalysisPreCheck(
      anthropic,
      CONTEXT,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(vi.mocked(executeDbTool)).toHaveBeenCalledTimes(2);
    expect(result).toContain('first turn data');
    expect(result).toContain('second turn data');
  });

  it('stops after MAX_PRECHECK_TURNS=3 even if stop_reason is still tool_use', async () => {
    const block = makeToolUseBlock('get_spot_exposures', {});

    // Provide 4 tool_use responses — the 4th should never be reached
    const anthropic = makeMockAnthropic([
      { stop_reason: 'tool_use', content: [block] },
      { stop_reason: 'tool_use', content: [block] },
      { stop_reason: 'tool_use', content: [block] },
      // This 4th response should never be called
      { stop_reason: 'tool_use', content: [block] },
    ]);

    vi.mocked(executeDbTool).mockResolvedValue({
      type: 'tool_result',
      tool_use_id: 'tool_abc123',
      content: 'some data',
    });

    await runAnalysisPreCheck(anthropic, CONTEXT, ANALYSIS_DATE, AS_OF);

    // Only 3 turns max → only 3 create calls
    expect(anthropic.messages.create).toHaveBeenCalledTimes(3);
    // executeDbTool called once per turn (3 times max)
    expect(vi.mocked(executeDbTool)).toHaveBeenCalledTimes(3);
  });
});

// ── Group 4: Safety / correctness ────────────────────────────

describe('runAnalysisPreCheck — safety and correctness', () => {
  beforeEach(() => {
    vi.mocked(executeDbTool).mockReset();
    vi.mocked(buildClaudeTools).mockReturnValue([]);
  });

  it('passes asOf to executeDbTool', async () => {
    const toolBlock = makeToolUseBlock('get_spot_exposures', {});
    const anthropic = makeMockAnthropic([
      { stop_reason: 'tool_use', content: [toolBlock] },
      { stop_reason: 'end_turn', content: [] },
    ]);

    vi.mocked(executeDbTool).mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tool_abc123',
      content: 'data',
    });

    await runAnalysisPreCheck(anthropic, CONTEXT, ANALYSIS_DATE, AS_OF);

    expect(vi.mocked(executeDbTool)).toHaveBeenCalledWith(
      toolBlock,
      mockSql,
      ANALYSIS_DATE,
      AS_OF,
    );
  });

  it('uses claude-sonnet-4-6, not claude-opus-4-7', async () => {
    const anthropic = makeMockAnthropic([
      { stop_reason: 'end_turn', content: [] },
    ]);

    await runAnalysisPreCheck(anthropic, CONTEXT, ANALYSIS_DATE, AS_OF);

    const firstCall = (anthropic.messages.create as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    const callArgs = firstCall[0] as { model: string };
    expect(callArgs.model).toBe('claude-sonnet-4-6');
    expect(callArgs.model).not.toContain('opus');
  });

  it('context fields missing from context object do not crash', async () => {
    const anthropic = makeMockAnthropic([
      { stop_reason: 'end_turn', content: [] },
    ]);

    // Empty context — all fields will be N/A or default
    const result = await runAnalysisPreCheck(anthropic, {}, ANALYSIS_DATE);

    // Should not throw, should return null (no tools called)
    expect(result).toBeNull();
  });

  it('passes getDb() result as the db argument to executeDbTool', async () => {
    const toolBlock = makeToolUseBlock('get_spot_exposures', {});
    const anthropic = makeMockAnthropic([
      { stop_reason: 'tool_use', content: [toolBlock] },
      { stop_reason: 'end_turn', content: [] },
    ]);

    vi.mocked(executeDbTool).mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tool_abc123',
      content: 'data',
    });

    await runAnalysisPreCheck(anthropic, CONTEXT, ANALYSIS_DATE, AS_OF);

    // The db passed to executeDbTool should be the result of getDb()
    expect(vi.mocked(getDb)).toHaveBeenCalled();
    const dbArg = (vi.mocked(executeDbTool).mock.calls[0] as unknown[])[1];
    expect(dbArg).toBe(mockSql);
  });

  it('uses tool_choice auto so Claude can skip tools', async () => {
    const anthropic = makeMockAnthropic([
      { stop_reason: 'end_turn', content: [] },
    ]);

    await runAnalysisPreCheck(anthropic, CONTEXT, ANALYSIS_DATE, AS_OF);

    const firstCall = (anthropic.messages.create as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    const callArgs = firstCall[0] as { tool_choice: { type: string } };
    expect(callArgs.tool_choice).toEqual({ type: 'auto' });
  });

  it('sets max_tokens to 2048', async () => {
    const anthropic = makeMockAnthropic([
      { stop_reason: 'end_turn', content: [] },
    ]);

    await runAnalysisPreCheck(anthropic, CONTEXT, ANALYSIS_DATE, AS_OF);

    const firstCall = (anthropic.messages.create as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    const callArgs = firstCall[0] as { max_tokens: number };
    expect(callArgs.max_tokens).toBe(2048);
  });

  it('omits error tool results from the output string', async () => {
    const block1 = makeToolUseBlock('get_spot_exposures', {}, 'tool_1');
    const block2 = makeToolUseBlock('get_flow_data', {}, 'tool_2');
    const anthropic = makeMockAnthropic([
      { stop_reason: 'tool_use', content: [block1, block2] },
      { stop_reason: 'end_turn', content: [] },
    ]);

    vi.mocked(executeDbTool)
      .mockResolvedValueOnce({
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: 'good data',
      })
      .mockResolvedValueOnce({
        type: 'tool_result',
        tool_use_id: 'tool_2',
        content: 'DB error message',
        is_error: true,
      });

    const result = await runAnalysisPreCheck(
      anthropic,
      CONTEXT,
      ANALYSIS_DATE,
      AS_OF,
    );

    expect(result).toContain('good data');
    expect(result).not.toContain('DB error message');
  });
});

// ── Group 5: analyze.ts integration ──────────────────────────
// These tests live in analyze.test.ts (via vi.mock of analyze-precheck.js).
// The integration tests below verify the precheck module in isolation
// as a callable unit with controlled inputs.

describe('runAnalysisPreCheck — NeonQueryFunction type compat', () => {
  it('executeDbTool receives a NeonQueryFunction, not a plain function', async () => {
    const toolBlock = makeToolUseBlock('get_spx_candles', {});
    const anthropic = makeMockAnthropic([
      { stop_reason: 'tool_use', content: [toolBlock] },
      { stop_reason: 'end_turn', content: [] },
    ]);

    vi.mocked(executeDbTool).mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tool_abc123',
      content: 'candle data',
    });

    await runAnalysisPreCheck(anthropic, CONTEXT, ANALYSIS_DATE, AS_OF);

    // Verify the third argument is the db returned by getDb()
    const dbArg = (
      vi.mocked(executeDbTool).mock.calls[0] as [
        unknown,
        NeonQueryFunction<false, false>,
        string,
        string,
      ]
    )[1];
    expect(dbArg).toBe(mockSql);
  });
});
