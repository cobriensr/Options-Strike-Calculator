// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _resetEnvCache } from '../_lib/env.js';
import { mockRequest, mockResponse } from './helpers';

// ============================================================
// Module mocks (hoisted above imports of the handler)
// ============================================================

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
  // Echo the structured input into the summary string so tests can
  // verify which fields propagate (e.g. extracted vs analysis-derived).
  // Format mirrors the real buildPeriscopeSummary output well enough
  // that retrieval-query assertions can grep for `spot=`, `cone=`, etc.
  buildPeriscopeSummary: vi.fn().mockImplementation((args: unknown) => {
    const a = args as {
      mode?: string;
      tradingDate?: string;
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
      `mode=${a.mode ?? 'read'}`,
      `date=${a.tradingDate ?? 'null'}`,
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
import { savePeriscopeAnalysis } from '../_lib/periscope-db.js';
import { extractChartStructure } from '../_lib/periscope-extract.js';
import { buildRetrievalBlock } from '../_lib/periscope-retrieval.js';

const mockSavePeriscopeAnalysis = vi.mocked(savePeriscopeAnalysis);
const mockExtractChartStructure = vi.mocked(extractChartStructure);
const mockBuildRetrievalBlock = vi.mocked(buildRetrievalBlock);

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
    mode: 'read' | 'debrief';
    images: Array<{
      kind: 'chart' | 'gex' | 'charm';
      data: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    }>;
    parentId: number | null;
  }> = {},
) {
  return {
    mode: overrides.mode ?? 'read',
    images: overrides.images ?? [
      { kind: 'chart', data: SAMPLE_BASE64, mediaType: 'image/png' },
    ],
    ...(overrides.parentId !== undefined && { parentId: overrides.parentId }),
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
    mockExtractChartStructure.mockReset().mockResolvedValue(null);
    mockBuildRetrievalBlock.mockReset().mockResolvedValue(null);
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

  it('happy path: returns parsed structured fields on success (read mode)', async () => {
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
    expect(json.mode).toBe('read');
    expect(json.prose).toContain('pin-day setup at 7120');
    // The JSON block must NOT appear in the prose
    expect(json.prose).not.toContain('```json');
    expect(json.structured).toEqual({
      spot: 7120,
      cone_lower: 7095,
      cone_upper: 7150,
      long_trigger: 7125,
      short_trigger: 7115,
      regime_tag: 'pin',
    });
    expect(mockSavePeriscopeAnalysis).toHaveBeenCalledOnce();
  });

  it('debrief mode persists parent_id', async () => {
    mockFinalMessage.mockResolvedValue(
      makeSDKResponse({ prose: 'Debrief: long trigger fired at 11:15 AM.' }),
    );

    const req = mockRequest({
      method: 'POST',
      body: makeBody({ mode: 'debrief', parentId: 17 }),
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const saveArgs = mockSavePeriscopeAnalysis.mock.calls[0]![0] as {
      mode: string;
      parentId: number | null;
    };
    expect(saveArgs.mode).toBe('debrief');
    expect(saveArgs.parentId).toBe(17);
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
    };
    expect(json.ok).toBe(true);
    expect(json.structured).toEqual({
      spot: null,
      cone_lower: null,
      cone_upper: null,
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
    });
    expect(mockSavePeriscopeAnalysis).toHaveBeenCalledOnce();
  });

  it('omits the calibration block from system prompt when none exist', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));
    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    expect(params.system).toHaveLength(1);
  });

  it('injects the calibration block as a second cached system block when present', async () => {
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
    expect(params.system).toHaveLength(2);
    expect(params.system[1].text).toContain('Calibration examples');
    expect(params.system[1].cache_control).toEqual({
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
    expect(params.system).toHaveLength(2); // skill + retrieval (no calibration)
    expect(params.system[1].text).toContain('Analogous past reads');
    expect(params.system[1].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('injects all three blocks (skill + calibration + retrieval) when both helpers return content', async () => {
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
    expect(params.system).toHaveLength(3);
    // Order: skill, then calibration, then retrieval
    expect(params.system[1].text).toContain('Calibration examples');
    expect(params.system[2].text).toContain('Analogous past reads');
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
    expect(params.system).toHaveLength(1);
    expect(params.system[0].cache_control).toEqual({
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
    // preamble text + 3 × (label text + image block) = 7
    expect(params.messages[0].content).toHaveLength(7);
    const blocks = params.messages[0].content as Array<{
      type: string;
      text?: string;
    }>;
    expect(blocks[0]!.type).toBe('text'); // preamble
    expect(blocks[1]!.text).toContain('[chart screenshot]');
    expect(blocks[2]!.type).toBe('image');
    expect(blocks[3]!.text).toContain('[gex screenshot]');
    expect(blocks[4]!.type).toBe('image');
    expect(blocks[5]!.text).toContain('[charm screenshot]');
    expect(blocks[6]!.type).toBe('image');
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
    expect(mockExtractChartStructure).toHaveBeenCalledWith(
      expect.objectContaining({ images: expect.any(Array) }),
    );
    // Main call ran exactly once after extraction.
    expect(mockStream).toHaveBeenCalledOnce();
  });

  it('passes extracted structural summary as the retrieval query when extraction succeeds', async () => {
    mockExtractChartStructure.mockResolvedValueOnce({
      spot: 7120,
      cone_lower: 7095,
      cone_upper: 7150,
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
    });
    mockFinalMessage.mockResolvedValue(makeSDKResponse({ prose: 'Read.' }));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(mockBuildRetrievalBlock).toHaveBeenCalledOnce();
    const args = mockBuildRetrievalBlock.mock.calls[0]![0];
    expect(args.mode).toBe('read');
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
});
