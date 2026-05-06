// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _resetEnvCache } from '../_lib/env.js';
import { mockRequest, mockResponse } from './helpers';

// ============================================================
// Module mocks (hoisted above imports of the handler)
// ============================================================

// Capture readFileSync calls at module init so the
// "loads SKILL.md and references at module init" test can verify both
// paths were read. The mock falls through to the real fs (the bundled
// files exist on disk in this repo, and the production function ships
// them via vercel.json includeFiles), but records which paths were read.
// vi.hoisted() makes the array available inside the hoisted vi.mock.
const { readFileSyncCalls } = vi.hoisted(() => ({
  readFileSyncCalls: [] as string[],
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(
      (
        path: Parameters<typeof actual.readFileSync>[0],
        options?: Parameters<typeof actual.readFileSync>[1],
      ) => {
        readFileSyncCalls.push(typeof path === 'string' ? path : String(path));
        return actual.readFileSync(path, options);
      },
    ),
  };
});

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  respondIfInvalid: vi
    .fn()
    .mockImplementation(
      (
        parsed: { success: boolean; error?: { issues: { message: string }[] } },
        res: { status: (n: number) => { json: (o: unknown) => void } },
      ) => {
        if (!parsed.success) {
          const msg =
            parsed.error?.issues[0]?.message ?? 'Invalid request body';
          res.status(400).json({ error: msg });
          return true;
        }
        return false;
      },
    ),
}));

vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(null),
}));

vi.mock('../_lib/periscope-blob.js', () => ({
  uploadPeriscopeImages: vi.fn().mockResolvedValue({}),
}));

vi.mock('../_lib/periscope-db.js', () => ({
  savePeriscopeAnalysis: vi.fn().mockResolvedValue(42),
  fetchPeriscopeAnalysisById: vi.fn().mockResolvedValue(null),
  fetchParentChain: vi.fn().mockResolvedValue([]),
  // Echo the structured input into the summary string so tests can
  // verify which fields propagate (e.g. extracted vs analysis-derived).
  // Format mirrors the real buildPeriscopeSummary output well enough
  // that retrieval-query assertions can grep for `spot=`, `cone=`, etc.
  buildPeriscopeSummary: vi.fn().mockImplementation((args: unknown) => {
    const a = args as {
      mode?: string;
      structured?: {
        spot?: number | null;
        cone_lower?: number | null;
        cone_upper?: number | null;
        regime_tag?: string | null;
      };
      proseText?: string;
    };
    const s = a.structured ?? {};
    const fmt = (n: number | null | undefined) =>
      n == null ? 'null' : String(n);
    return [
      `mode=${a.mode ?? 'pre_trade'}`,
      `spot=${fmt(s.spot)}`,
      `cone=${fmt(s.cone_lower)}-${fmt(s.cone_upper)}`,
      `regime=${s.regime_tag ?? 'null'}`,
      `prose=${(a.proseText ?? '').slice(0, 80)}`,
    ].join(' | ');
  }),
}));

vi.mock('../_lib/periscope-calibration.js', () => ({
  buildCalibrationBlock: vi.fn().mockResolvedValue(null),
}));

vi.mock('../_lib/periscope-retrieval.js', () => ({
  buildRetrievalBlock: vi.fn().mockResolvedValue(null),
}));

vi.mock('../_lib/periscope-extract.js', () => ({
  extractChartStructure: vi.fn().mockResolvedValue(null),
  extractHeatMapStrikes: vi.fn().mockResolvedValue(null),
}));

vi.mock('../_lib/spx-candles.js', async () => {
  const actual = await vi.importActual<typeof import('../_lib/spx-candles.js')>(
    '../_lib/spx-candles.js',
  );
  return {
    ...actual,
    fetchSPXSpotAtTimestamp: vi
      .fn()
      .mockResolvedValue({ price: 7120, source: 'db_exact' }),
  };
});

vi.mock('../_lib/periscope-flow-context.js', () => ({
  buildFlowContextBlock: vi.fn().mockResolvedValue(null),
}));

// Mock the Anthropic SDK — capture both stream + create calls.
//   - handler uses `anthropic.messages.stream(params).finalMessage()`
//     for the main analysis call (Pass 2).
//   - The extraction helper (Pass 1) uses `messages.create()` directly
//     and is module-mocked above, so the create stub here is just a
//     defensive default; tests don't rely on it firing.
const mockFinalMessage = vi.fn();
const mockStream = vi.fn().mockReturnValue({ finalMessage: mockFinalMessage });
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'APIError';
    }
  }
  class AuthenticationError extends APIError {
    constructor(message = 'Auth error') {
      super(401, message);
      this.name = 'AuthenticationError';
    }
  }
  class RateLimitError extends APIError {
    constructor(message = 'Rate limited') {
      super(429, message);
      this.name = 'RateLimitError';
    }
  }
  (globalThis as Record<string, unknown>).__MockErrors = {
    APIError,
    RateLimitError,
    AuthenticationError,
  };

  class MockAnthropic {
    get messages() {
      return { stream: mockStream, create: mockCreate };
    }
    static readonly AuthenticationError = AuthenticationError;
    static readonly RateLimitError = RateLimitError;
    static readonly APIError = APIError;
  }

  return {
    default: MockAnthropic,
    AuthenticationError,
    RateLimitError,
    APIError,
  };
});

import handler from '../periscope-chat.js';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  respondIfInvalid,
} from '../_lib/api-helpers.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import {
  fetchParentChain,
  fetchPeriscopeAnalysisById,
  savePeriscopeAnalysis,
} from '../_lib/periscope-db.js';
import {
  extractChartStructure,
  extractHeatMapStrikes,
} from '../_lib/periscope-extract.js';
import { buildRetrievalBlock } from '../_lib/periscope-retrieval.js';
import { fetchSPXSpotAtTimestamp } from '../_lib/spx-candles.js';
import { buildFlowContextBlock } from '../_lib/periscope-flow-context.js';

const mockSavePeriscopeAnalysis = vi.mocked(savePeriscopeAnalysis);
const mockFetchPeriscopeAnalysisById = vi.mocked(fetchPeriscopeAnalysisById);
const mockFetchParentChain = vi.mocked(fetchParentChain);
const mockExtractChartStructure = vi.mocked(extractChartStructure);
const mockExtractHeatMapStrikes = vi.mocked(extractHeatMapStrikes);
const mockBuildRetrievalBlock = vi.mocked(buildRetrievalBlock);
const mockFetchSPXSpotAtTimestamp = vi.mocked(fetchSPXSpotAtTimestamp);
const mockBuildFlowContextBlock = vi.mocked(buildFlowContextBlock);

const MockErrors = (globalThis as Record<string, unknown>).__MockErrors as {
  APIError: new (status: number, message: string) => Error;
  RateLimitError: new (message?: string) => Error;
  AuthenticationError: new (message?: string) => Error;
};

// ============================================================
// Fixtures
// ============================================================

/** A small but valid PNG-shaped base64 string (content doesn't matter — it's mocked). */
const SAMPLE_BASE64 = 'aGVsbG8td29ybGQ='; // "hello-world"

function makeBody(
  overrides: Partial<{
    mode: 'pre_trade' | 'intraday' | 'debrief';
    images: Array<{
      kind: 'chart' | 'gex' | 'charm';
      data: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    }>;
    parentId: number | null;
    tradingDate: string;
    read_date: string;
    read_time: string;
  }> = {},
) {
  return {
    // Default to pre_trade so the parent-required guard for intraday/debrief
    // doesn't trip every test that doesn't explicitly set parentId.
    mode: overrides.mode ?? 'pre_trade',
    images: overrides.images ?? [
      { kind: 'chart', data: SAMPLE_BASE64, mediaType: 'image/png' },
    ],
    read_date: overrides.read_date ?? '2026-05-06',
    read_time: overrides.read_time ?? '08:30',
    ...(overrides.parentId !== undefined && { parentId: overrides.parentId }),
    ...(overrides.tradingDate !== undefined && {
      tradingDate: overrides.tradingDate,
    }),
  };
}

/**
 * Build a mock Anthropic stream.finalMessage() resolution carrying the
 * given prose text. Adds the JSON code block at the end if structured
 * fields are passed.
 */
function makeSDKResponse(args: {
  prose: string;
  structured?: Record<string, unknown> | null;
  stopReason?: string;
}) {
  const { prose, structured, stopReason = 'end_turn' } = args;
  const fullText =
    structured === null
      ? prose // explicit null = caller wants no JSON block at all
      : `${prose}\n\n\`\`\`json\n${JSON.stringify(structured ?? defaultStructured(), null, 2)}\n\`\`\``;
  return {
    content: [{ type: 'text', text: fullText }],
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 0,
    },
    stop_reason: stopReason,
    model: 'claude-opus-4-7',
  };
}

function defaultStructured() {
  return {
    spot: 7120,
    cone_lower: 7095,
    cone_upper: 7150,
    long_trigger: 7125,
    short_trigger: 7115,
    regime_tag: 'pin',
  };
}

/** Parse the final NDJSON line (skips ping heartbeats). */
function parseNdjsonResponse(res: {
  _chunks: string[];
}): Record<string, unknown> {
  const lines = res._chunks
    .join('')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const last = lines.at(-1) ?? '{}';
  return JSON.parse(last);
}

// ============================================================
// Tests
// ============================================================

describe('POST /api/periscope-chat', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetEnvCache();
    mockStream.mockReset().mockReturnValue({ finalMessage: mockFinalMessage });
    mockFinalMessage.mockReset();
    mockCreate.mockReset();
    mockSavePeriscopeAnalysis.mockReset().mockResolvedValue(42);
    mockFetchPeriscopeAnalysisById.mockReset().mockResolvedValue(null);
    mockFetchParentChain.mockReset().mockResolvedValue([]);
    mockExtractChartStructure.mockReset().mockResolvedValue(null);
    mockExtractHeatMapStrikes.mockReset().mockResolvedValue(null);
    mockBuildRetrievalBlock.mockReset().mockResolvedValue(null);
    mockFetchSPXSpotAtTimestamp
      .mockReset()
      .mockResolvedValue({ price: 7120, source: 'db_exact' });
    mockBuildFlowContextBlock.mockReset().mockResolvedValue(null);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // Restore mock defaults that restoreAllMocks may strip
    vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
    vi.mocked(respondIfInvalid).mockImplementation((parsed, res) => {
      if (!parsed.success) {
        const msg = parsed.error?.issues[0]?.message ?? 'Invalid request body';
        res.status(400).json({ error: msg });
        return true;
      }
      return false;
    });
    vi.mocked(generateEmbedding).mockResolvedValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('returns 405 for non-POST requests', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'Too many requests' });
      return true;
    });
    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(429);
  });

  it('returns 500 when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Server configuration error' });
  });

  it('returns 400 when no images provided', async () => {
    const req = mockRequest({
      method: 'POST',
      body: makeBody({ images: [] }),
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'At least one image is required' });
  });

  it('returns 400 when more than 3 images', async () => {
    const images = [
      { kind: 'chart', data: SAMPLE_BASE64, mediaType: 'image/png' },
      { kind: 'gex', data: SAMPLE_BASE64, mediaType: 'image/png' },
      { kind: 'charm', data: SAMPLE_BASE64, mediaType: 'image/png' },
      { kind: 'chart', data: SAMPLE_BASE64, mediaType: 'image/png' },
    ] as const;
    const req = mockRequest({
      method: 'POST',
      body: makeBody({ images: [...images] }),
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: expect.stringContaining('3') });
  });

  it('happy path: returns parsed structured fields on success (pre_trade mode)', async () => {
    mockFinalMessage.mockResolvedValue(
      makeSDKResponse({
        prose: 'The chart shows a clean pin-day setup at 7120.',
      }),
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      ok: boolean;
      id: number;
      mode: string;
      prose: string;
      structured: Record<string, unknown>;
    };
    expect(json.ok).toBe(true);
    expect(json.id).toBe(42);
    expect(json.mode).toBe('pre_trade');
    expect(json.prose).toContain('pin-day setup at 7120');
    // The JSON block must NOT appear in the prose
    expect(json.prose).not.toContain('```json');
    expect(json.structured).toMatchObject({
      spot: 7120,
      cone_lower: 7095,
      cone_upper: 7150,
      long_trigger: 7125,
      short_trigger: 7115,
      regime_tag: 'pin',
    });
    expect(mockSavePeriscopeAnalysis).toHaveBeenCalledOnce();
  });

  it('debrief mode persists parent_id and inlines the parent prose into the user message', async () => {
    mockFetchPeriscopeAnalysisById.mockResolvedValueOnce({
      id: 17,
      mode: 'pre_trade',
      tradingDate: '2026-05-06',
      proseText:
        'Open read at 8:30 CT: spot 7140, +γ ceiling at 7150, lower cone 7092. Long trigger 7150, short trigger 7115.',
      structured: {
        spot: 7140,
        cone_lower: 7092,
        cone_upper: 7163,
        long_trigger: 7150,
        short_trigger: 7115,
        regime_tag: 'trap',
        bias: null,
        trade_types_recommended: [],
        trade_types_avoided: [],
        key_levels: null,
        expected_dealer_behavior: null,
        confidence: null,
        confidence_basis: null,
      },
    });
    // Extraction returns the same trading_date so the debrief proceeds
    // past the date-mismatch guard.
    mockExtractChartStructure.mockResolvedValueOnce({
      structured: {
        spot: 7136,
        cone_lower: null,
        cone_upper: null,
        long_trigger: null,
        short_trigger: null,
        regime_tag: null,
        bias: null,
        trade_types_recommended: [],
        trade_types_avoided: [],
        key_levels: null,
        expected_dealer_behavior: null,
        confidence: null,
        confidence_basis: null,
      },
      chartDate: '2026-05-06',
    });
    mockFinalMessage.mockResolvedValue(
      makeSDKResponse({ prose: 'Debrief: long trigger fired at 11:15 AM.' }),
    );

    const req = mockRequest({
      method: 'POST',
      body: makeBody({
        mode: 'debrief',
        parentId: 17,
        read_date: '2026-05-06',
        read_time: '15:00',
      }),
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockFetchPeriscopeAnalysisById).toHaveBeenCalledWith(17);
    const saveArgs = mockSavePeriscopeAnalysis.mock.calls[0]![0] as {
      mode: string;
      parentId: number | null;
    };
    expect(saveArgs.mode).toBe('debrief');
    expect(saveArgs.parentId).toBe(17);

    // Critical: the parent's prose + structured fields must reach Claude.
    const params = mockStream.mock.calls[0]![0];
    const preamble = (
      params.messages[0].content as Array<{ type: string; text?: string }>
    )[0]!.text!;
    expect(preamble).toContain('Open read to score');
    expect(preamble).toContain('long trigger: 7150');
    expect(preamble).toContain('regime: trap');
    expect(preamble).toContain('+γ ceiling at 7150');
  });

  it('returns 400 when debrief mode is submitted without a parentId', async () => {
    const req = mockRequest({
      method: 'POST',
      body: makeBody({ mode: 'debrief' }), // no parentId
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({
      error: expect.stringContaining('Debrief mode requires a parent read id'),
    });
    expect(mockFetchPeriscopeAnalysisById).not.toHaveBeenCalled();
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('returns 404 NDJSON envelope when the parent read does not exist', async () => {
    mockFetchPeriscopeAnalysisById.mockResolvedValueOnce(null);
    const req = mockRequest({
      method: 'POST',
      body: makeBody({ mode: 'debrief', parentId: 999 }),
    });
    const res = mockResponse();
    await handler(req, res);

    const json = parseNdjsonResponse(res) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Parent read #999 not found');
    expect(mockStream).not.toHaveBeenCalled();
    expect(mockSavePeriscopeAnalysis).not.toHaveBeenCalled();
  });

  it('returns 422 NDJSON envelope when the chart date does not match the parent read date', async () => {
    mockFetchPeriscopeAnalysisById.mockResolvedValueOnce({
      id: 17,
      mode: 'pre_trade',
      tradingDate: '2026-04-30', // parent is yesterday's read
      proseText: 'Yesterday morning read.',
      structured: {
        spot: 7140,
        cone_lower: 7092,
        cone_upper: 7163,
        long_trigger: 7150,
        short_trigger: 7115,
        regime_tag: 'trap',
        bias: null,
        trade_types_recommended: [],
        trade_types_avoided: [],
        key_levels: null,
        expected_dealer_behavior: null,
        confidence: null,
        confidence_basis: null,
      },
    });
    mockExtractChartStructure.mockResolvedValueOnce({
      structured: {
        spot: 7200,
        cone_lower: null,
        cone_upper: null,
        long_trigger: null,
        short_trigger: null,
        regime_tag: null,
        bias: null,
        trade_types_recommended: [],
        trade_types_avoided: [],
        key_levels: null,
        expected_dealer_behavior: null,
        confidence: null,
        confidence_basis: null,
      },
      chartDate: '2026-05-06',
    });

    const req = mockRequest({
      method: 'POST',
      body: makeBody({
        mode: 'debrief',
        parentId: 17,
        read_date: '2026-05-06',
        read_time: '15:00',
      }),
    });
    const res = mockResponse();
    await handler(req, res);

    const json = parseNdjsonResponse(res) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('2026-05-06');
    expect(json.error).toContain('2026-04-30');
    expect(mockStream).not.toHaveBeenCalled();
    expect(mockSavePeriscopeAnalysis).not.toHaveBeenCalled();
  });

  it('returns 422 NDJSON envelope when the debrief parent is itself a debrief', async () => {
    mockFetchPeriscopeAnalysisById.mockResolvedValueOnce({
      id: 17,
      mode: 'debrief',
      tradingDate: '2026-05-06',
      proseText: 'A previous debrief.',
      structured: {
        spot: 7140,
        cone_lower: null,
        cone_upper: null,
        long_trigger: null,
        short_trigger: null,
        regime_tag: null,
        bias: null,
        trade_types_recommended: [],
        trade_types_avoided: [],
        key_levels: null,
        expected_dealer_behavior: null,
        confidence: null,
        confidence_basis: null,
      },
    });

    const req = mockRequest({
      method: 'POST',
      body: makeBody({ mode: 'debrief', parentId: 17 }),
    });
    const res = mockResponse();
    await handler(req, res);

    const json = parseNdjsonResponse(res) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('debrief');
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('does not fetch a parent in pre_trade mode (parentId is ignored if sent)', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));
    const req = mockRequest({
      method: 'POST',
      body: makeBody({ mode: 'pre_trade' }),
    });
    const res = mockResponse();
    await handler(req, res);
    expect(mockFetchPeriscopeAnalysisById).not.toHaveBeenCalled();
  });

  // ============================================================
  // SPX spot lookup hard-fail path
  // ============================================================

  it('returns 422 when fetchSPXSpotAtTimestamp returns null (no candle)', async () => {
    mockFetchSPXSpotAtTimestamp.mockResolvedValueOnce(null);
    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);
    const json = parseNdjsonResponse(res) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('No SPX');
    expect(mockStream).not.toHaveBeenCalled();
    expect(mockSavePeriscopeAnalysis).not.toHaveBeenCalled();
  });

  it('persists spot_at_read_time + spot_source from the lookup result', async () => {
    mockFetchSPXSpotAtTimestamp.mockResolvedValueOnce({
      price: 7180.5,
      source: 'db_snapped',
    });
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));
    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const saveArgs = mockSavePeriscopeAnalysis.mock.calls[0]![0] as {
      spotAtReadTime: number;
      spotSource: string;
    };
    expect(saveArgs.spotAtReadTime).toBe(7180.5);
    expect(saveArgs.spotSource).toBe('db_snapped');
  });

  it('JSON block parse failure: structured fields are all null but row still saves', async () => {
    mockFinalMessage.mockResolvedValue(
      makeSDKResponse({
        prose: 'Just prose, no structured block.',
        structured: null,
      }),
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      ok: boolean;
      structured: Record<string, unknown>;
      parseOk: boolean;
    };
    expect(json.ok).toBe(true);
    expect(json.parseOk).toBe(false);
    expect(json.structured).toMatchObject({
      spot: null,
      cone_lower: null,
      cone_upper: null,
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
      bias: null,
      trade_types_recommended: [],
      trade_types_avoided: [],
      key_levels: null,
    });
    expect(mockSavePeriscopeAnalysis).toHaveBeenCalledOnce();
  });

  it('omits the calibration block from system prompt when none exist', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));
    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    // Baseline is skill + references (Phase 5) — no calibration / retrieval.
    expect(params.system).toHaveLength(2);
    expect(params.system[1].text).toContain('VolSignals MM heuristics');
  });

  it('injects the calibration block as a third cached system block when present', async () => {
    const { buildCalibrationBlock } =
      await import('../_lib/periscope-calibration.js');
    vi.mocked(buildCalibrationBlock).mockResolvedValueOnce(
      '## Calibration examples\nGold-rated read prose here.',
    );
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));
    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    // skill + references + calibration
    expect(params.system).toHaveLength(3);
    expect(params.system[2].text).toContain('Calibration examples');
    expect(params.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('injects the retrieval block as a third cached system block when present', async () => {
    const { buildRetrievalBlock } =
      await import('../_lib/periscope-retrieval.js');
    vi.mocked(buildRetrievalBlock).mockResolvedValueOnce(
      '## Analogous past reads\nSimilar prior pin day.',
    );
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));
    const req = mockRequest({
      method: 'POST',
      body: makeBody(),
    });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    // skill + references + retrieval (no calibration)
    expect(params.system).toHaveLength(3);
    expect(params.system[2].text).toContain('Analogous past reads');
    expect(params.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('injects all four blocks (skill + references + calibration + retrieval) when both helpers return content', async () => {
    const { buildCalibrationBlock } =
      await import('../_lib/periscope-calibration.js');
    const { buildRetrievalBlock } =
      await import('../_lib/periscope-retrieval.js');
    vi.mocked(buildCalibrationBlock).mockResolvedValueOnce(
      '## Calibration examples\n...',
    );
    vi.mocked(buildRetrievalBlock).mockResolvedValueOnce(
      '## Analogous past reads\n...',
    );
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));
    const req = mockRequest({
      method: 'POST',
      body: makeBody(),
    });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    expect(params.system).toHaveLength(4);
    // Order: skill, references, calibration, retrieval
    expect(params.system[1].text).toContain('VolSignals MM heuristics');
    expect(params.system[2].text).toContain('Calibration examples');
    expect(params.system[3].text).toContain('Analogous past reads');
  });

  it('uses Opus 4.7 with adaptive thinking + high effort + cached system prompt', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(mockStream).toHaveBeenCalledOnce();
    const params = mockStream.mock.calls[0]![0];
    expect(params.model).toBe('claude-opus-4-7');
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.output_config).toEqual({ effort: 'high' });
    // Baseline is skill + references (Phase 5).
    expect(params.system).toHaveLength(2);
    expect(params.system[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(params.system[1].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('returns NDJSON error envelope on Anthropic 429', async () => {
    const err = new MockErrors.RateLimitError('Rate limited');
    mockFinalMessage.mockRejectedValue(err);

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    const json = parseNdjsonResponse(res) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Anthropic rate limit exceeded');
  });

  it('attaches all 3 image blocks with kind labels when sent together', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));

    const images = [
      { kind: 'chart', data: SAMPLE_BASE64, mediaType: 'image/png' },
      { kind: 'gex', data: SAMPLE_BASE64, mediaType: 'image/png' },
      { kind: 'charm', data: SAMPLE_BASE64, mediaType: 'image/png' },
    ] as const;
    const req = mockRequest({
      method: 'POST',
      body: makeBody({ images: [...images] }),
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    // preamble + spotDirective + 3 × (label + image) = 8
    expect(params.messages[0].content).toHaveLength(8);
    const blocks = params.messages[0].content as Array<{
      type: string;
      text?: string;
    }>;
    expect(blocks[0]!.type).toBe('text'); // preamble
    expect(blocks[1]!.type).toBe('text'); // spot directive
    expect(blocks[1]!.text).toContain('Authoritative SPX spot');
    expect(blocks[2]!.text).toContain('[chart screenshot]');
    expect(blocks[3]!.type).toBe('image');
    expect(blocks[4]!.text).toContain('[gex screenshot]');
    expect(blocks[5]!.type).toBe('image');
    expect(blocks[6]!.text).toContain('[charm screenshot]');
    expect(blocks[7]!.type).toBe('image');
  });

  // ============================================================
  // Phase 9 — two-Opus-call flow
  // ============================================================

  it('runs extraction once per submission (Pass 1 before main analysis)', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));
    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(mockExtractChartStructure).toHaveBeenCalledOnce();
    // Now takes (input, anthropic) — caller owns client lifecycle.
    expect(mockExtractChartStructure).toHaveBeenCalledWith(
      expect.objectContaining({ images: expect.any(Array) }),
      expect.anything(),
    );
    // Main call ran exactly once after extraction.
    expect(mockStream).toHaveBeenCalledOnce();
  });

  it('passes extracted structural summary as the retrieval query when extraction succeeds', async () => {
    mockExtractChartStructure.mockResolvedValueOnce({
      structured: {
        spot: 7120,
        cone_lower: 7095,
        cone_upper: 7150,
        long_trigger: null,
        short_trigger: null,
        regime_tag: null,
        bias: null,
        trade_types_recommended: [],
        trade_types_avoided: [],
        key_levels: null,
        expected_dealer_behavior: null,
        confidence: null,
        confidence_basis: null,
      },
      chartDate: '2026-04-30',
    });
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(mockBuildRetrievalBlock).toHaveBeenCalledOnce();
    const args = mockBuildRetrievalBlock.mock.calls[0]![0];
    expect(args.mode).toBe('pre_trade');
    // The retrieval query is the extracted structural summary —
    // the chart fingerprint, not free-form text.
    expect(args.queryText).toContain('spot=7120');
    expect(args.queryText).toContain('cone=7095-7150');
  });

  it('passes null retrieval query when extraction returns null (retrieval skipped)', async () => {
    mockExtractChartStructure.mockResolvedValueOnce(null);
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    const args = mockBuildRetrievalBlock.mock.calls[0]![0];
    expect(args.queryText).toBeNull();
  });

  it('still completes the main analysis when extraction returns null (best-effort)', async () => {
    mockExtractChartStructure.mockResolvedValueOnce(null);
    mockFinalMessage.mockResolvedValue(
      makeSDKResponse({ prose: 'Read despite extraction failure.' }),
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as { ok: boolean; prose: string };
    expect(json.ok).toBe(true);
    expect(json.prose).toContain('Read despite extraction failure.');
    // Main analysis ran even though extraction yielded nothing useful.
    expect(mockStream).toHaveBeenCalledOnce();
  });

  // ============================================================
  // Phase 1B — heat-map OCR injection
  // ============================================================

  it('injects the heat-map OCR block before the image blocks when extraction succeeds', async () => {
    mockExtractHeatMapStrikes.mockResolvedValueOnce({
      gex: [
        { strike: 7275, value: 1450000, color: 'green' },
        { strike: 7295, value: -1370000, color: 'red' },
      ],
      charm: [{ strike: 7240, value: 72521, color: 'green' }],
    });
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));

    const images = [
      { kind: 'chart', data: SAMPLE_BASE64, mediaType: 'image/png' },
      { kind: 'gex', data: SAMPLE_BASE64, mediaType: 'image/png' },
      { kind: 'charm', data: SAMPLE_BASE64, mediaType: 'image/png' },
    ] as const;
    const req = mockRequest({
      method: 'POST',
      body: makeBody({ images: [...images] }),
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const blocks = params.messages[0].content as Array<{
      type: string;
      text?: string;
    }>;
    // Find the heat-map block. Must come BEFORE the first image block.
    const firstImageIdx = blocks.findIndex((b) => b.type === 'image');
    const heatMapIdx = blocks.findIndex(
      (b) =>
        b.type === 'text' &&
        typeof b.text === 'string' &&
        b.text.includes('Heat-map extracted strikes'),
    );
    expect(heatMapIdx).toBeGreaterThanOrEqual(0);
    expect(heatMapIdx).toBeLessThan(firstImageIdx);
    const heatBlock = blocks[heatMapIdx]!.text!;
    expect(heatBlock).toContain('MM-attributed Net GEX / Net Charm from UW');
    expect(heatBlock).toContain('Net GEX');
    expect(heatBlock).toContain('Net Charm');
    expect(heatBlock).toContain('7275');
    expect(heatBlock).toContain('+1,450,000');
    expect(heatBlock).toContain('-1,370,000');
  });

  it('omits the heat-map block when no heat maps are uploaded', async () => {
    // chart only — no gex/charm. Heat-map fetch must be skipped entirely.
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));
    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(mockExtractHeatMapStrikes).not.toHaveBeenCalled();
    const params = mockStream.mock.calls[0]![0];
    const blocks = params.messages[0].content as Array<{
      type: string;
      text?: string;
    }>;
    const heatBlock = blocks.find(
      (b) =>
        b.type === 'text' &&
        typeof b.text === 'string' &&
        b.text.includes('Heat-map extracted strikes'),
    );
    expect(heatBlock).toBeUndefined();
  });

  it('omits the heat-map block when the OCR call fails (best-effort)', async () => {
    mockExtractHeatMapStrikes.mockResolvedValueOnce(null);
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));

    const images = [
      { kind: 'chart', data: SAMPLE_BASE64, mediaType: 'image/png' },
      { kind: 'gex', data: SAMPLE_BASE64, mediaType: 'image/png' },
    ] as const;
    const req = mockRequest({
      method: 'POST',
      body: makeBody({ images: [...images] }),
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockExtractHeatMapStrikes).toHaveBeenCalledOnce();
    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const blocks = params.messages[0].content as Array<{
      type: string;
      text?: string;
    }>;
    const heatBlock = blocks.find(
      (b) =>
        b.type === 'text' &&
        typeof b.text === 'string' &&
        b.text.includes('Heat-map extracted strikes'),
    );
    expect(heatBlock).toBeUndefined();
  });

  // ============================================================
  // Cache stability — system prefix must remain identical across calls
  // so Anthropic returns cache_read_input_tokens > 0 on call 2.
  // ============================================================

  it('reports cacheRead > 0 on a repeated call (mocked SDK simulates cache hit)', async () => {
    // First call — synthetic "cache write" usage shape (cacheRead 0, cacheWrite > 0).
    mockFinalMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'First read.' }],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 9000,
      },
      stop_reason: 'end_turn',
      model: 'claude-opus-4-7',
    });
    // Second call — synthetic "cache hit" shape (cacheRead > 0).
    mockFinalMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Second read.' }],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 0,
      },
      stop_reason: 'end_turn',
      model: 'claude-opus-4-7',
    });

    const req1 = mockRequest({ method: 'POST', body: makeBody() });
    const res1 = mockResponse();
    await handler(req1, res1);
    const json1 = parseNdjsonResponse(res1) as {
      ok: boolean;
      usage: { cacheRead: number; cacheWrite: number };
    };
    expect(json1.ok).toBe(true);
    expect(json1.usage.cacheRead).toBe(0);
    expect(json1.usage.cacheWrite).toBeGreaterThan(0);

    const req2 = mockRequest({ method: 'POST', body: makeBody() });
    const res2 = mockResponse();
    await handler(req2, res2);
    const json2 = parseNdjsonResponse(res2) as {
      ok: boolean;
      usage: { cacheRead: number; cacheWrite: number };
    };
    expect(json2.ok).toBe(true);
    expect(json2.usage.cacheRead).toBeGreaterThan(0);

    // Both calls used the same system prefix shape (skill + references —
    // no calibration / retrieval) so the cache key is stable across all
    // 4 supported block positions. Phase 5 adds the references block as
    // index [1]; verify both blocks are byte-identical across calls.
    const params1 = mockStream.mock.calls[0]![0];
    const params2 = mockStream.mock.calls[1]![0];
    expect(params1.system).toHaveLength(2);
    expect(params2.system).toHaveLength(2);
    expect(params1.system[0].text).toBe(params2.system[0].text);
    expect(params1.system[0].cache_control).toEqual(
      params2.system[0].cache_control,
    );
    expect(params1.system[1].text).toBe(params2.system[1].text);
    expect(params1.system[1].cache_control).toEqual(
      params2.system[1].cache_control,
    );
  });

  // ============================================================
  // Phase 5 — VolSignals references file as cached system block
  // ============================================================

  it('reads SKILL.md and the references file at module init', () => {
    // The handler is imported above (top of file) which triggers the
    // module-init readFileSync calls. We just check the recorded paths.
    const skillCall = readFileSyncCalls.find((p) => p.endsWith('SKILL.md'));
    const refsCall = readFileSyncCalls.find((p) =>
      p.endsWith('vol-signals-mm-heuristics.md'),
    );
    expect(skillCall).toBeDefined();
    expect(refsCall).toBeDefined();
    // Both must live under .claude/skills/periscope/.
    expect(skillCall).toContain('/.claude/skills/periscope/');
    expect(refsCall).toContain('/.claude/skills/periscope/references/');
  });

  it('places the references block immediately after the skill (between skill and calibration)', async () => {
    const { buildCalibrationBlock } =
      await import('../_lib/periscope-calibration.js');
    vi.mocked(buildCalibrationBlock).mockResolvedValueOnce(
      '## Calibration examples\n...',
    );
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));
    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    // Sequence: [0] skill, [1] references, [2] calibration. Verify the
    // references block sits between skill and calibration with the
    // expected header and tag glossary.
    expect(params.system).toHaveLength(3);
    const refText = params.system[1].text as string;
    expect(refText).toContain(
      '# Companion reference — VolSignals MM heuristics',
    );
    expect(refText).toContain('[verified]');
    expect(refText).toContain('[plausible]');
    expect(refText).toContain('[era-specific]');
    expect(refText).toContain('[contested]');
    // Cache control matches the rest — ephemeral 1h.
    expect(params.system[1].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    // Calibration is at [2], not [1].
    expect(params.system[2].text).toContain('Calibration examples');
  });
});

// ============================================================
// Phase 5 — references-load failure path (isolated module reload)
// ============================================================
//
// The references file path is read once at module init. To exercise the
// failure path we reset modules, re-mock node:fs to throw on the
// references path (but pass through for SKILL.md), and re-import the
// handler so it goes through module init again with the failing fs mock.
// All other module mocks must be re-declared inside the isolate so the
// fresh handler import sees them.
describe('POST /api/periscope-chat — references file load failure', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('omits the references block from system prompt when the file fails to load', async () => {
    // Re-mock node:fs to throw on the references path. SKILL.md still
    // loads (handler must remain functional with skill alone).
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        readFileSync: vi.fn(
          (
            path: Parameters<typeof actual.readFileSync>[0],
            options?: Parameters<typeof actual.readFileSync>[1],
          ) => {
            const p = typeof path === 'string' ? path : String(path);
            if (p.endsWith('vol-signals-mm-heuristics.md')) {
              throw new Error('ENOENT (simulated): references file missing');
            }
            return actual.readFileSync(path, options);
          },
        ),
      };
    });

    // Re-declare every other mock the handler depends on; vi.resetModules
    // wipes the module registry so the previous vi.mock calls at the top
    // of this file no longer apply to the fresh handler import.
    vi.doMock('../_lib/api-helpers.js', () => ({
      guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
      rejectIfRateLimited: vi.fn().mockResolvedValue(false),
      respondIfInvalid: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('../_lib/embeddings.js', () => ({
      generateEmbedding: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../_lib/periscope-blob.js', () => ({
      uploadPeriscopeImages: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock('../_lib/periscope-db.js', () => ({
      savePeriscopeAnalysis: vi.fn().mockResolvedValue(42),
      fetchPeriscopeAnalysisById: vi.fn().mockResolvedValue(null),
      fetchParentChain: vi.fn().mockResolvedValue([]),
      buildPeriscopeSummary: vi.fn().mockReturnValue('summary'),
    }));
    vi.doMock('../_lib/periscope-calibration.js', () => ({
      buildCalibrationBlock: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../_lib/periscope-retrieval.js', () => ({
      buildRetrievalBlock: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../_lib/periscope-extract.js', () => ({
      extractChartStructure: vi.fn().mockResolvedValue(null),
      extractHeatMapStrikes: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../_lib/spx-candles.js', async () => {
      const actual = await vi.importActual<
        typeof import('../_lib/spx-candles.js')
      >('../_lib/spx-candles.js');
      return {
        ...actual,
        fetchSPXSpotAtTimestamp: vi
          .fn()
          .mockResolvedValue({ price: 7120, source: 'db_exact' }),
      };
    });
    vi.doMock('../_lib/periscope-flow-context.js', () => ({
      buildFlowContextBlock: vi.fn().mockResolvedValue(null),
    }));

    // Anthropic SDK mock — capture stream params so we can inspect
    // system[].length after the handler runs.
    const localFinalMessage = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Read.' }],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      stop_reason: 'end_turn',
      model: 'claude-opus-4-7',
    });
    const localStream = vi
      .fn()
      .mockReturnValue({ finalMessage: localFinalMessage });
    vi.doMock('@anthropic-ai/sdk', () => {
      class APIError extends Error {
        status: number;
        constructor(status: number, message: string) {
          super(message);
          this.status = status;
        }
      }
      class MockAnthropic {
        get messages() {
          return { stream: localStream, create: vi.fn() };
        }
        static readonly APIError = APIError;
        static readonly RateLimitError = class extends APIError {
          constructor(message = 'Rate limited') {
            super(429, message);
          }
        };
        static readonly AuthenticationError = class extends APIError {
          constructor(message = 'Auth error') {
            super(401, message);
          }
        };
      }
      return { default: MockAnthropic, APIError };
    });

    process.env.ANTHROPIC_API_KEY = 'test-key';

    // Re-import the handler — module init runs against the failing fs
    // mock and Sentry.captureException catches the references throw.
    const { default: failHandler } = await import('../periscope-chat.js');

    const req = mockRequest({
      method: 'POST',
      body: {
        mode: 'pre_trade',
        images: [
          { kind: 'chart', data: 'aGVsbG8td29ybGQ=', mediaType: 'image/png' },
        ],
        read_date: '2026-05-06',
        read_time: '08:30',
      },
    });
    const res = mockResponse();
    await failHandler(req, res);

    // System prefix is skill-only (no references block, no calibration,
    // no retrieval). Confirms the load-failure fallback path.
    expect(localStream).toHaveBeenCalledOnce();
    const params = localStream.mock.calls[0]![0];
    expect(params.system).toHaveLength(1);
    const skillText = params.system[0].text as string;
    expect(skillText).not.toContain('VolSignals MM heuristics');
  });
});
