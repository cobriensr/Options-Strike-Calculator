// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _resetEnvCache } from '../_lib/env.js';
import { mockRequest, mockResponse } from './helpers';

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

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => async () => []),
  saveAnalysis: vi.fn().mockResolvedValue(undefined),
  saveSnapshot: vi.fn().mockResolvedValue(null),
  getLatestPositions: vi.fn().mockResolvedValue(null),
  getPreviousRecommendation: vi.fn().mockResolvedValue(null),
  getFlowData: vi.fn().mockResolvedValue([]),
  formatFlowDataForClaude: vi.fn().mockReturnValue(null),
  getGreekExposure: vi.fn().mockResolvedValue([]),
  formatGreekExposureForClaude: vi.fn().mockReturnValue(null),
  getSpotExposures: vi.fn().mockResolvedValue([]),
  formatSpotExposuresForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/db-strike-helpers.js', () => ({
  getStrikeExposures: vi.fn().mockResolvedValue([]),
  formatStrikeExposuresForClaude: vi.fn().mockReturnValue(null),
  getAllExpiryStrikeExposures: vi.fn().mockResolvedValue([]),
  formatAllExpiryStrikesForClaude: vi.fn().mockReturnValue(null),
  formatGreekFlowForClaude: vi.fn().mockReturnValue(null),
  formatZeroGammaForClaude: vi.fn().mockReturnValue(null),
  getNetGexHeatmap: vi.fn().mockResolvedValue([]),
  formatNetGexHeatmapForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/db-nope.js', () => ({
  getRecentNope: vi.fn().mockResolvedValue([]),
  formatNopeForClaude: vi.fn().mockReturnValue(null),
}));

vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(null),
  findSimilarAnalyses: vi.fn().mockResolvedValue([]),
  saveAnalysisEmbedding: vi.fn().mockResolvedValue(undefined),
  buildAnalysisSummary: vi.fn().mockReturnValue(''),
}));

vi.mock('../_lib/lessons.js', () => ({
  getActiveLessons: vi.fn().mockResolvedValue([]),
  formatLessonsBlock: vi.fn().mockReturnValue(''),
  getHistoricalWinRate: vi.fn().mockResolvedValue(null),
  formatWinRateForClaude: vi.fn().mockReturnValue(''),
}));

// Mock the pre-check module — prevents real Anthropic calls in analyze tests.
// Default: returns null (no-op path, existing content unchanged).
vi.mock('../_lib/analyze-precheck.js', () => ({
  runAnalysisPreCheck: vi.fn().mockResolvedValue(null),
}));

// Mock the Anthropic SDK — capture the stream call
// The handler uses `anthropic.messages.stream(params).finalMessage()`
const mockFinalMessage = vi.fn();
const mockStream = vi.fn().mockReturnValue({ finalMessage: mockFinalMessage });

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'APIError';
    }
  }
  class BadRequestError extends APIError {
    constructor(message = 'Bad request') {
      super(400, message);
      this.name = 'BadRequestError';
    }
  }
  class AuthenticationError extends APIError {
    constructor(message = 'Auth error') {
      super(401, message);
      this.name = 'AuthenticationError';
    }
  }
  class PermissionDeniedError extends APIError {
    constructor(message = 'Forbidden') {
      super(403, message);
      this.name = 'PermissionDeniedError';
    }
  }
  class RateLimitError extends APIError {
    constructor(message = 'Rate limited') {
      super(429, message);
      this.name = 'RateLimitError';
    }
  }

  // Expose to tests via globalThis — vi.mock is hoisted above all declarations,
  // so we cannot use module-scope variables. globalThis is always available.
  (globalThis as Record<string, unknown>).__MockErrors = {
    APIError,
    RateLimitError,
    AuthenticationError,
  };

  // mockCreate returns end_turn so the tool-use pre-flight loop exits immediately
  const mockCreate = vi.fn().mockResolvedValue({
    stop_reason: 'end_turn',
    content: [],
  });
  (globalThis as Record<string, unknown>).__mockCreate = mockCreate;

  class MockAnthropic {
    get messages() {
      return { stream: mockStream, create: mockCreate };
    }
    static readonly BadRequestError = BadRequestError;
    static readonly AuthenticationError = AuthenticationError;
    static readonly PermissionDeniedError = PermissionDeniedError;
    static readonly RateLimitError = RateLimitError;
    static readonly APIError = APIError;
  }

  return {
    default: MockAnthropic,
    BadRequestError,
    AuthenticationError,
    PermissionDeniedError,
    RateLimitError,
    APIError,
  };
});

import handler from '../analyze.js';

const MockErrors = (globalThis as Record<string, unknown>).__MockErrors as {
  APIError: new (status: number, message: string) => Error;
  RateLimitError: new (message?: string) => Error;
  AuthenticationError: new (message?: string) => Error;
};
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  respondIfInvalid,
} from '../_lib/api-helpers.js';
import {
  getActiveLessons,
  formatLessonsBlock,
  getHistoricalWinRate,
  formatWinRateForClaude,
} from '../_lib/lessons.js';
import {
  getFlowData,
  formatFlowDataForClaude,
  getLatestPositions,
  getPreviousRecommendation,
  formatGreekExposureForClaude,
  formatSpotExposuresForClaude,
  getDb,
} from '../_lib/db.js';
import {
  formatStrikeExposuresForClaude,
  formatAllExpiryStrikesForClaude,
  formatGreekFlowForClaude,
} from '../_lib/db-strike-helpers.js';
import { formatNopeForClaude } from '../_lib/db-nope.js';

/** Parse the final NDJSON line from the response chunks (skips keepalive pings). */
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

/** Minimal valid request body */
function makeBody(
  overrides: Partial<{
    images: Array<{ data: string; mediaType: string }>;
    context: Record<string, unknown>;
  }> = {},
) {
  return {
    images: overrides.images ?? [
      { data: 'base64data', mediaType: 'image/png' },
    ],
    context: overrides.context ?? {
      spx: 5700,
      spy: 550,
      vix: 18,
      vix1d: 15,
      vix9d: 17,
      vvix: 90,
      sigma: 0.15,
      T: 0.03,
      hoursRemaining: 7,
      deltaCeiling: 8,
      putSpreadCeiling: 10,
      callSpreadCeiling: 10,
      regimeZone: 'GREEN',
      clusterMult: 1.0,
      dowLabel: 'Friday',
      openingRangeSignal: 'neutral',
      vixTermSignal: 'contango',
      rvIvRatio: 0.85,
      overnightGap: 0.1,
    },
  };
}

const SAMPLE_ANALYSIS = {
  structure: 'IRON CONDOR',
  confidence: 'HIGH',
  suggestedDelta: 8,
  reasoning: 'NCP and NPP are parallel, indicating a ranging day.',
  observations: ['NCP at +50M', 'NPP at -40M', 'Lines trending parallel'],
  risks: ['VIX elevated above 20'],
  periscopeNotes: null,
  structureRationale: 'NCP ≈ NPP suggests balanced flow.',
};

/** Build a mock Anthropic SDK success response */
function makeSDKResponse(analysis: Record<string, unknown>) {
  return {
    content: [{ type: 'text', text: JSON.stringify(analysis) }],
    usage: { input_tokens: 100, output_tokens: 200 },
    stop_reason: 'end_turn',
  };
}

describe('POST /api/analyze', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetEnvCache();
    mockStream.mockReset().mockReturnValue({ finalMessage: mockFinalMessage });
    mockFinalMessage.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // Restore module mock defaults that restoreAllMocks may strip
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
    vi.mocked(getHistoricalWinRate).mockResolvedValue(null);
    vi.mocked(formatWinRateForClaude).mockReturnValue('');
    // Silence expected console.error/log from error-path tests
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
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
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
    const req = mockRequest({ method: 'POST', body: makeBody({ images: [] }) });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'At least one image is required' });
  });

  it('returns 400 when more than 2 images', async () => {
    const images = Array.from({ length: 3 }, () => ({
      data: 'base64',
      mediaType: 'image/png',
    }));
    const req = mockRequest({ method: 'POST', body: makeBody({ images }) });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Maximum 2 images allowed' });
  });

  it('returns parsed analysis on success', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      analysis: typeof SAMPLE_ANALYSIS;
      raw: string;
    };
    expect(json.analysis.structure).toBe('IRON CONDOR');
    expect(json.analysis.confidence).toBe('HIGH');
    expect(json.analysis.suggestedDelta).toBe(8);
    expect(json.analysis.observations).toHaveLength(3);
    expect(json.raw).toBeDefined();
  });

  it('sends correct model and params to Anthropic SDK', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody();
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(mockStream).toHaveBeenCalledOnce();
    const params = mockStream.mock.calls[0]![0];
    expect(params.model).toBe('claude-opus-4-7');
    expect(params.max_tokens).toBe(128000);
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.messages).toHaveLength(1);
    // Should have 1 text label + 1 image block + 1 context text block
    expect(params.messages[0].content).toHaveLength(3);
    expect(params.messages[0].content[0].type).toBe('text');
    expect(params.messages[0].content[1].type).toBe('image');
    expect(params.messages[0].content[2].type).toBe('text');
  });

  it('handles multiple images', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const images = [
      { data: 'img1', mediaType: 'image/png' },
      { data: 'img2', mediaType: 'image/jpeg' },
    ];
    const req = mockRequest({ method: 'POST', body: makeBody({ images }) });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    // 2 × (text label + image block) + 1 context text block = 5
    expect(params.messages[0].content).toHaveLength(5);
  });

  it('returns error in NDJSON when Anthropic API returns 429', async () => {
    // Must throw on both Opus and Sonnet attempts to reach the outer catch
    const err = new MockErrors.RateLimitError('Rate limited');
    mockFinalMessage.mockRejectedValue(err);

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    const json = parseNdjsonResponse(res) as { error: string };
    expect(json.error).toContain('Anthropic rate limit exceeded');
  });

  it('returns stream corruption error when Claude response is not valid JSON', async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: 'Not valid JSON response' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    // Handler returns 200 (streaming default) with error payload
    // since the stream corruption guard doesn't call res.status()
    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as { error: string };
    expect(json.error).toContain('corrupted in transit');
  });

  it('parses structured output JSON directly', async () => {
    // Structured outputs return clean JSON (no markdown fences)
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(SAMPLE_ANALYSIS) }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      analysis: typeof SAMPLE_ANALYSIS;
    };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('returns 500 when SDK throws a network error', async () => {
    mockStream.mockImplementation(() => {
      throw new Error('Network failure');
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(parseNdjsonResponse(res)).toEqual({ error: 'Network failure' });
  });

  it('returns generic message for non-Error throws', async () => {
    mockStream.mockImplementation(() => {
      throw 'something weird'; // NOSONAR: intentionally testing non-Error throw handling
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(parseNdjsonResponse(res)).toEqual({ error: 'Analysis failed' });
  });

  it('includes midday mode text in context', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: {
        ...makeBody().context,
        mode: 'midday',
        currentPosition: 'Short 10Δ IC at 5650/5750',
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('MID-DAY RE-ANALYSIS');
    expect(contextBlock).toContain('Short 10Δ IC at 5650/5750');
  });

  it('includes review mode text and previous recommendation in context', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: {
        ...makeBody().context,
        mode: 'review',
        previousRecommendation: 'Iron condor at 8Δ',
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('END-OF-DAY REVIEW');
    expect(contextBlock).toContain('Iron condor at 8Δ');
  });

  it('filters out thinking blocks from response', async () => {
    mockFinalMessage.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: 'internal reasoning...' },
        { type: 'text', text: JSON.stringify(SAMPLE_ANALYSIS) },
      ],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      analysis: typeof SAMPLE_ANALYSIS;
    };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('uses image labels when provided', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const images = [
      { data: 'img1', mediaType: 'image/png', label: 'Market Tide (SPX)' },
      { data: 'img2', mediaType: 'image/jpeg' },
    ];
    const req = mockRequest({ method: 'POST', body: makeBody({ images }) });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    const content = params.messages[0].content;
    expect(content[0].text).toContain('Market Tide (SPX)');
    expect(content[2].text).toContain('Unlabeled');
  });

  it('populates all context fields in the request', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const ctx = {
      mode: 'entry',
      selectedDate: '2025-03-14',
      entryTime: '8:45 AM CT',
      spx: 5700,
      spy: 550,
      vix: 18,
      vix1d: 15,
      vix9d: 17,
      vvix: 90,
      sigma: 0.15,
      T: 0.03,
      hoursRemaining: 7,
      deltaCeiling: 8,
      putSpreadCeiling: 10,
      callSpreadCeiling: 10,
      regimeZone: 'GREEN',
      clusterMult: 1.0,
      dowLabel: 'Friday',
      openingRangeSignal: 'neutral',
      vixTermSignal: 'contango',
      rvIvRatio: 0.85,
      overnightGap: 0.1,
    };
    const req = mockRequest({
      method: 'POST',
      body: makeBody({ context: ctx }),
    });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('PRE-TRADE ENTRY');
    expect(contextBlock).toContain('2025-03-14');
    expect(contextBlock).toContain('8:45 AM CT');
    expect(contextBlock).toContain('5700');
    expect(contextBlock).toContain('GREEN');
    expect(contextBlock).toContain('contango');
  });

  it('returns 400 when an image exceeds 5MB', async () => {
    const oversized = 'x'.repeat(5 * 1024 * 1024 + 1);
    const images = [{ data: oversized, mediaType: 'image/png' }];
    const req = mockRequest({ method: 'POST', body: makeBody({ images }) });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({
      error: 'Image too large. Maximum 5MB per image.',
    });
  });

  it('returns correct client message for Anthropic 401', async () => {
    // AuthenticationError is non-retryable — re-thrown immediately from Opus, no Sonnet fallback
    mockFinalMessage.mockRejectedValue(
      new MockErrors.AuthenticationError('Invalid API key'),
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    const json = parseNdjsonResponse(res) as { error: string };
    expect(json.error).toContain('Anthropic API authentication error');
    expect(json.error).not.toContain('Invalid API key');
  });

  it('returns correct client message for Anthropic 500', async () => {
    // APIError 500 triggers Sonnet fallback — must fail on both to reach outer catch
    const err = new MockErrors.APIError(500, 'Internal server error');
    mockFinalMessage.mockRejectedValue(err);

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    const json = parseNdjsonResponse(res) as { error: string };
    expect(json.error).toContain('Analysis service error (500)');
    expect(json.error).not.toContain('Internal server error');
  });

  it('still returns analysis when DB save fails', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    // Make DB throw
    const { saveAnalysis } = await import('../_lib/db.js');
    vi.mocked(saveAnalysis).mockRejectedValueOnce(new Error('DB down'));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    // Response should still succeed
    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      analysis: typeof SAMPLE_ANALYSIS;
    };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('retries DB save and succeeds on second attempt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const { saveAnalysis } = await import('../_lib/db.js');
    const mockedSave = vi.mocked(saveAnalysis);
    mockedSave.mockClear();
    mockedSave
      .mockRejectedValueOnce(new Error('DB transient'))
      .mockResolvedValueOnce(undefined);

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockedSave).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('exhausts all DB save retries and still returns analysis', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const { saveAnalysis } = await import('../_lib/db.js');
    const mockedSave = vi.mocked(saveAnalysis);
    mockedSave.mockClear();
    mockedSave
      .mockRejectedValueOnce(new Error('DB fail 1'))
      .mockRejectedValueOnce(new Error('DB fail 2'))
      .mockRejectedValueOnce(new Error('DB fail 3'));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockedSave).toHaveBeenCalledTimes(3);
    const json = parseNdjsonResponse(res) as {
      analysis: typeof SAMPLE_ANALYSIS;
    };
    expect(json.analysis.structure).toBe('IRON CONDOR');
    vi.useRealTimers();
  });

  it('falls back to Sonnet when Opus fails with server error', async () => {
    // SDK retries are internal (maxRetries: 3). When mockFinalMessage rejects,
    // it means Opus is exhausted — code falls back to Sonnet immediately.
    // Must be an APIError (not BadRequest/Auth/Permission) to trigger fallback.
    const serverErr = new MockErrors.APIError(500, 'Internal server error');
    mockFinalMessage
      .mockRejectedValueOnce(serverErr)
      .mockResolvedValueOnce(makeSDKResponse(SAMPLE_ANALYSIS));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockStream).toHaveBeenCalledTimes(2);
    // First call is Opus, second is Sonnet fallback
    expect(mockStream.mock.calls[0]![0].model).toBe('claude-opus-4-7');
    expect(mockStream.mock.calls[1]![0].model).toBe('claude-sonnet-4-6');
    const json = parseNdjsonResponse(res) as { model: string };
    expect(json.model).toBe('claude-sonnet-4-6');
  });

  it('returns 500 when both Opus and Sonnet fail', async () => {
    const serverErr = new MockErrors.APIError(529, 'overloaded');
    mockFinalMessage
      .mockRejectedValueOnce(serverErr)
      .mockRejectedValueOnce(serverErr);

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(mockStream.mock.calls[0]![0].model).toBe('claude-opus-4-7');
    expect(mockStream.mock.calls[1]![0].model).toBe('claude-sonnet-4-6');
    const json = parseNdjsonResponse(res) as { error: string };
    expect(json.error).toContain('Analysis service error (529)');
  });

  it('handles response with only thinking blocks (no text)', async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'thinking', thinking: 'internal only...' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as { analysis: null; raw: string };
    expect(json.analysis).toBeNull();
    expect(json.raw).toBe('');
  });

  it('injects lessons_learned block as separate system block', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const fakeLessons = [
      {
        id: 1,
        text: 'VIX above 25 means widen wings',
        sourceDate: '2025-03-10',
        marketConditions: { vix: 28, structure: 'IRON CONDOR' },
        tags: ['vix', 'wings'],
        category: 'risk',
      },
    ];
    vi.mocked(getActiveLessons).mockResolvedValueOnce(fakeLessons);
    vi.mocked(formatLessonsBlock).mockReturnValueOnce(
      '<lessons_learned>\n[1] (2025-03-10 | IRON CONDOR | VIX:28)\nVIX above 25 means widen wings\nTags: vix, wings\n</lessons_learned>',
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    // Lessons are in a separate system block (uncached) after the stable block (cached)
    expect(params.system).toHaveLength(2);
    expect(params.system[0].text).toContain('</structure_selection_rules>');
    expect(params.system[0].text).toContain('<data_handling>');
    expect(params.system[0].cache_control).toBeDefined();
    expect(params.system[1].text).toContain('<lessons_learned>');
    expect(params.system[1].text).toContain('VIX above 25 means widen wings');
    expect(params.system[1].cache_control).toBeUndefined();
  });

  it('omits lessons block when no lessons exist', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    vi.mocked(getActiveLessons).mockResolvedValueOnce([]);
    vi.mocked(formatLessonsBlock).mockReturnValueOnce('');

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    // Only one system block (the cached stable prompt) when no lessons
    expect(params.system).toHaveLength(1);
    expect(params.system[0].text).toContain('</structure_selection_rules>');
    expect(params.system[0].text).toContain('<data_handling>');
  });

  it('continues analysis when flow data fetch throws', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    // Make one of the flow data functions throw
    vi.mocked(getFlowData).mockRejectedValueOnce(
      new Error('DB connection lost'),
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    // Analysis should still succeed despite flow data failure
    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      analysis: typeof SAMPLE_ANALYSIS;
    };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('continues analysis when lessons fetch throws', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    vi.mocked(getActiveLessons).mockRejectedValueOnce(
      new Error('Lessons DB error'),
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      analysis: typeof SAMPLE_ANALYSIS;
    };
    expect(json.analysis.structure).toBe('IRON CONDOR');
    // System prompt should NOT contain lessons block
    const params = mockStream.mock.calls[0]![0];
    const systemText = params.system[0].text;
    expect(systemText).not.toContain('<lessons_learned>');
  });

  // ── Bot check ─────────────────────────────────────────────

  it('returns 403 when bot check detects a bot', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(403).json({ error: 'Access denied' });
      return true;
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  // ── Rate limiting ─────────────────────────────────────────

  it('returns early when rate limited', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'Rate limited' });
      return true;
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(429);
  });

  // ── Position and previous rec auto-fetch ──────────────────

  it('includes DB positions in context when available', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    vi.mocked(getLatestPositions).mockResolvedValueOnce({
      summary: 'Short 8Δ IC at 5650/5750, qty 2',
      legs: [],
      fetchTime: '2025-03-14T14:00:00Z',
      stats: {
        totalSpreads: 2,
        callSpreads: 1,
        putSpreads: 1,
        netDelta: null,
        netTheta: null,
        unrealizedPnl: null,
      },
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('Short 8Δ IC at 5650/5750');
    expect(contextBlock).toContain('Current Open Positions');
  });

  it('renders affirmative FLAT block when positions summary is "No open"', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    vi.mocked(getLatestPositions).mockResolvedValueOnce({
      summary: 'No open SPX 0DTE positions.',
      legs: [],
      fetchTime: '2025-03-14T14:00:00Z',
      stats: {
        totalSpreads: 0,
        callSpreads: 0,
        putSpreads: 0,
        netDelta: null,
        netTheta: null,
        unrealizedPnl: null,
      },
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    // The "No open" summary is null-equivalent for positionContext, so the
    // affirmative FLAT block should render (not the live-Schwab block).
    expect(contextBlock).toContain('## Current Open Positions');
    expect(contextBlock).toContain('NONE.');
    expect(contextBlock).toContain('Treat the account as FLAT');
    expect(contextBlock).not.toContain(
      'Current Open Positions (live from Schwab)',
    );
  });

  it('continues when position fetch throws', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    vi.mocked(getLatestPositions).mockRejectedValueOnce(
      new Error('Position fetch error'),
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
  });

  it('auto-fetches previous recommendation in midday mode', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    vi.mocked(getPreviousRecommendation).mockResolvedValueOnce(
      'Earlier analysis recommended PUT CREDIT SPREAD at 8Δ',
    );

    const body = makeBody({
      context: { ...makeBody().context, mode: 'midday' },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('Previous Recommendation');
    expect(contextBlock).toContain('PUT CREDIT SPREAD at 8Δ');
  });

  it('continues when previous recommendation fetch throws', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    vi.mocked(getPreviousRecommendation).mockRejectedValueOnce(
      new Error('DB timeout'),
    );

    const body = makeBody({
      context: { ...makeBody().context, mode: 'review' },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
  });

  // ── Flow/context data interpolation ───────────────────────

  it('includes all flow data contexts when formatters return strings', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    // Make all format functions return non-null strings
    vi.mocked(formatFlowDataForClaude)
      .mockReturnValueOnce('MT_DATA') // market_tide
      .mockReturnValueOnce('MT_OTM_DATA') // market_tide_otm
      .mockReturnValueOnce('SPX_DATA') // spx_flow
      .mockReturnValueOnce('SPY_DATA') // spy_flow
      .mockReturnValueOnce('QQQ_DATA') // qqq_flow
      .mockReturnValueOnce('SPY_ETF_DATA') // spy_etf_tide
      .mockReturnValueOnce('QQQ_ETF_DATA') // qqq_etf_tide
      .mockReturnValueOnce('ZERO_DTE_DATA'); // zero_dte_index
    vi.mocked(formatGreekExposureForClaude).mockReturnValueOnce(
      'GREEK_EXP_DATA',
    );
    vi.mocked(formatGreekFlowForClaude).mockReturnValueOnce('GREEK_FLOW_DATA');
    vi.mocked(formatSpotExposuresForClaude).mockReturnValueOnce(
      'SPOT_GEX_DATA',
    );
    vi.mocked(formatStrikeExposuresForClaude).mockReturnValueOnce(
      'STRIKE_DATA',
    );
    vi.mocked(formatAllExpiryStrikesForClaude).mockReturnValueOnce(
      'ALL_EXP_DATA',
    );
    vi.mocked(formatNopeForClaude).mockReturnValueOnce('NOPE_DATA');

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('MT_DATA');
    expect(contextBlock).toContain('MT_OTM_DATA');
    expect(contextBlock).toContain('SPX_DATA');
    expect(contextBlock).toContain('SPY_DATA');
    expect(contextBlock).toContain('QQQ_DATA');
    expect(contextBlock).toContain('SPY_ETF_DATA');
    expect(contextBlock).toContain('QQQ_ETF_DATA');
    expect(contextBlock).toContain('ZERO_DTE_DATA');
    expect(contextBlock).toContain('GREEK_EXP_DATA');
    expect(contextBlock).toContain('GREEK_FLOW_DATA');
    expect(contextBlock).toContain('SPOT_GEX_DATA');
    expect(contextBlock).toContain('STRIKE_DATA');
    expect(contextBlock).toContain('ALL_EXP_DATA');
    expect(contextBlock).toContain('NOPE_DATA');
    expect(contextBlock).toContain('Market Tide Data');
    expect(contextBlock).toContain('SPX Net Flow Data');
    expect(contextBlock).toContain('Per-Strike Greek Profile');
    expect(contextBlock).toContain('All-Expiry Per-Strike Profile');
    expect(contextBlock).toContain('SPY NOPE');
  });

  // ── Events, backtest, dataNote context fields ─────────────

  it('formats scheduled events in context', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: {
        ...makeBody().context,
        events: [
          { event: 'CPI Release', time: '8:30 AM', severity: 'HIGH' },
          { event: 'Fed Speaker', time: '2:00 PM', severity: 'MEDIUM' },
        ],
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('CPI Release at 8:30 AM [HIGH]');
    expect(contextBlock).toContain('Fed Speaker at 2:00 PM [MEDIUM]');
  });

  it('includes backtest mode indicator in context', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));
    vi.mocked(getLatestPositions).mockClear();

    const body = makeBody({
      context: {
        ...makeBody().context,
        isBacktest: true,
        selectedDate: '2025-03-10',
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('YES — using historical data');
    // isBacktest skips position fetch
    expect(getLatestPositions).not.toHaveBeenCalled();
  });

  it('includes data note warning in context', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: {
        ...makeBody().context,
        dataNote: 'VIX data delayed by 15 minutes',
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('DATA NOTES');
    expect(contextBlock).toContain('VIX data delayed by 15 minutes');
  });

  // ── Truncated JSON returns null (structured outputs prevent this in practice) ──

  it('returns stream corruption error for truncated JSON', async () => {
    // Truncated JSON — structured outputs prevents this, but if max_tokens
    // is hit the response may be incomplete
    const truncated = '{"structure":"IRON CONDOR","confidence":"HIGH"';
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: truncated }],
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: 'max_tokens',
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    // Stream corruption guard fires — text present but unparseable
    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as { error: string };
    expect(json.error).toContain('corrupted in transit');
  });

  // ── Snapshot ID lookup ────────────────────────────────────

  it('passes snapshot ID to saveAnalysis when snapshot exists', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    // Mock getDb to return a function that returns rows with a snapshot ID
    const mockDbFn = vi.fn().mockResolvedValue([{ id: 42 }]);
    vi.mocked(getDb).mockReturnValue(
      mockDbFn as unknown as ReturnType<typeof getDb>,
    );

    const { saveAnalysis } = await import('../_lib/db.js');
    const mockedSave = vi.mocked(saveAnalysis);
    mockedSave.mockClear();
    mockedSave.mockResolvedValueOnce(undefined);

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // saveAnalysis should have been called with snapshotId = 42
    expect(mockedSave).toHaveBeenCalled();
    const saveArgs = mockedSave.mock.calls[0]!;
    expect(saveArgs[2]).toBe(42); // snapshotId parameter
  });

  // ── Opus stream throws (not finalMessage) ────────────────

  it('falls back to Sonnet when Opus stream() itself throws 529', async () => {
    // First stream() call throws (overloaded), second returns normally
    const overloaded = new MockErrors.APIError(529, 'overloaded');
    mockStream
      .mockImplementationOnce(() => {
        throw overloaded;
      })
      .mockReturnValueOnce({
        finalMessage: vi
          .fn()
          .mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS)),
      });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(mockStream.mock.calls[1]![0].model).toBe('claude-sonnet-4-6');
  });

  // ── Review mode skips position fetch ──────────────────────

  it('does not fetch positions in review mode', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));
    vi.mocked(getLatestPositions).mockClear();

    const body = makeBody({
      context: { ...makeBody().context, mode: 'review' },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(getLatestPositions).not.toHaveBeenCalled();
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).not.toContain('Current Open Positions');
  });

  // ── Opening range context fields ──────────────────────────

  it('includes opening range available YES when true', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: { ...makeBody().context, openingRangeAvailable: true },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('YES (30-min data complete)');
  });

  it('includes opening range available NO when false', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: { ...makeBody().context, openingRangeAvailable: false },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('NO (entry before 10:00 AM ET');
  });

  // ── Model refusal handling ──────────────────────────────

  it('returns 422 when Claude refuses the request', async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: 'I cannot assist with that.' }],
      usage: { input_tokens: 100, output_tokens: 10 },
      stop_reason: 'refusal',
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(422);
    expect(res._json).toEqual({
      error: 'Analysis request was refused by the model.',
    });
  });

  // ── Markdown code fence stripping ──────────────────────

  it('strips markdown code fences from Claude response', async () => {
    const fenced = '```json\n' + JSON.stringify(SAMPLE_ANALYSIS) + '\n```';
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: fenced }],
      usage: { input_tokens: 100, output_tokens: 200 },
      stop_reason: 'end_turn',
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      analysis: typeof SAMPLE_ANALYSIS;
    };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('strips code fences without language tag', async () => {
    const fenced = '```\n' + JSON.stringify(SAMPLE_ANALYSIS) + '\n```';
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: fenced }],
      usage: { input_tokens: 100, output_tokens: 200 },
      stop_reason: 'end_turn',
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      analysis: typeof SAMPLE_ANALYSIS;
    };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  // ── OI Concentration formatting ────────────────────────────

  it('includes OI concentration section when topOIStrikes provided', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: {
        ...makeBody().context,
        topOIStrikes: [
          {
            strike: 5700,
            putOI: 12000,
            callOI: 8000,
            totalOI: 20000,
            distFromSpot: 0,
            distPct: '0.0',
            side: 'both',
          },
          {
            strike: 5650,
            putOI: 15000,
            callOI: 2000,
            totalOI: 17000,
            distFromSpot: -50,
            distPct: '-0.9',
            side: 'put',
          },
        ],
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('OI Concentration');
    expect(contextBlock).toContain('Pin Risk');
    expect(contextBlock).toContain('5700');
    expect(contextBlock).toContain('20.0K');
    expect(contextBlock).toContain('12.0K');
    expect(contextBlock).toContain('+0 pts');
    expect(contextBlock).toContain('5650');
    expect(contextBlock).toContain('-50 pts');
    expect(contextBlock).toContain('put');
  });

  it('omits OI concentration when topOIStrikes is empty', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: {
        ...makeBody().context,
        topOIStrikes: [],
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).not.toContain('OI Concentration');
  });

  it('formats OI under 1000 without K suffix', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: {
        ...makeBody().context,
        topOIStrikes: [
          {
            strike: 5700,
            putOI: 500,
            callOI: 300,
            totalOI: 800,
            distFromSpot: 0,
            distPct: '0.0',
            side: 'both',
          },
        ],
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('Total: 800');
    expect(contextBlock).toContain('Put: 500');
    expect(contextBlock).toContain('Call: 300');
  });

  // ── IV Skew Metrics formatting ─────────────────────────────

  it('includes IV skew section with STEEP signal', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: {
        ...makeBody().context,
        skewMetrics: {
          put25dIV: 28.5,
          call25dIV: 18.2,
          atmIV: 20.0,
          putSkew25d: 8.5,
          callSkew25d: 1.8,
          skewRatio: 2.5,
        },
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('IV Skew Metrics');
    expect(contextBlock).toContain('ATM IV: 20.0%');
    expect(contextBlock).toContain('28.5%');
    expect(contextBlock).toContain('STEEP');
    expect(contextBlock).toContain('Strong put-over-call risk premium');
  });

  it('includes IV skew section with NORMAL signal', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: {
        ...makeBody().context,
        skewMetrics: {
          put25dIV: 24.0,
          call25dIV: 20.0,
          atmIV: 20.0,
          putSkew25d: 5.0,
          callSkew25d: 2.0,
          skewRatio: 1.5,
        },
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('NORMAL');
    expect(contextBlock).toContain('Normal asymmetry');
  });

  it('includes IV skew section with FLAT signal and symmetric ratio', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody({
      context: {
        ...makeBody().context,
        skewMetrics: {
          put25dIV: 22.0,
          call25dIV: 20.5,
          atmIV: 20.0,
          putSkew25d: 2.0,
          callSkew25d: 1.5,
          skewRatio: 1.0,
        },
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain('FLAT');
    expect(contextBlock).toContain('Unusually symmetric');
    expect(contextBlock).toContain('Supports IRON CONDOR');
  });

  it('omits IV skew section when skewMetrics not provided', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).not.toContain('IV Skew Metrics');
  });

  // ── Historical win rate context injection ──────────────────

  it('includes win rate context when getHistoricalWinRate returns data', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    vi.mocked(getHistoricalWinRate).mockResolvedValueOnce({
      total: 12,
      wins: 9,
      winRate: 75,
      avgVix: 19.2,
      structures: ['IRON CONDOR'],
    });
    vi.mocked(formatWinRateForClaude).mockReturnValueOnce(
      'Historical Base Rate (VIX 13-23, GEX: GREEN, Friday):\n' +
        '  Matching sessions: 12\n' +
        '  Win rate: 75% (9/12)\n' +
        '  Avg VIX: 19.2\n' +
        '  Signal: Supports upgrading confidence by one level.',
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).toContain(
      'Historical Base Rate (from lessons database)',
    );
    expect(contextBlock).toContain('Win rate: 75%');
    expect(contextBlock).toContain('Supports upgrading confidence');
  });

  it('omits win rate context when getHistoricalWinRate returns null', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));
    vi.mocked(getHistoricalWinRate).mockResolvedValueOnce(null);

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).not.toContain('Historical Base Rate');
  });

  it('continues analysis when getHistoricalWinRate throws', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));
    vi.mocked(getHistoricalWinRate).mockRejectedValueOnce(
      new Error('DB error fetching win rate'),
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const contextBlock = params.messages[0].content.at(-1).text;
    expect(contextBlock).not.toContain('Historical Base Rate');
  });

  it('passes correct conditions to getHistoricalWinRate', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));
    vi.mocked(getHistoricalWinRate).mockResolvedValueOnce(null);

    const body = makeBody({
      context: {
        ...makeBody().context,
        vix: 22,
        regimeZone: 'RED',
        dowLabel: 'Wednesday',
      },
    });
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(getHistoricalWinRate).toHaveBeenCalledWith({
      vix: 22,
      gexRegime: 'RED',
      dayOfWeek: 'Wednesday',
    });
  });
});

// ── Pre-check integration tests ────────────────────────────────

describe('POST /api/analyze — pre-check integration', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetEnvCache();
    mockStream.mockReset().mockReturnValue({ finalMessage: mockFinalMessage });
    mockFinalMessage.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
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
    vi.mocked(getHistoricalWinRate).mockResolvedValue(null);
    vi.mocked(formatWinRateForClaude).mockReturnValue('');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Reset the pre-check mock to default null for each test
    const { runAnalysisPreCheck } = await import('../_lib/analyze-precheck.js');
    vi.mocked(runAnalysisPreCheck).mockResolvedValue(null);
  });

  it('when pre-check returns null, toolMessages content equals original content', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const { runAnalysisPreCheck } = await import('../_lib/analyze-precheck.js');
    vi.mocked(runAnalysisPreCheck).mockResolvedValue(null);

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    // Standard body = 1 text label + 1 image + 1 context block = 3 items
    expect(params.messages[0].content).toHaveLength(3);
    // The last block should be the context text (no pre-check injection)
    const lastBlock = params.messages[0].content.at(-1);
    expect(lastBlock.type).toBe('text');
    expect(lastBlock.text).not.toContain('Additional Market Data');
  });

  it('when pre-check returns a string, it is appended as a text block to toolMessages', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const preCheckText =
      '=== Additional Market Data (fetched on request) ===\nSPX spot exposure data here';
    const { runAnalysisPreCheck } = await import('../_lib/analyze-precheck.js');
    vi.mocked(runAnalysisPreCheck).mockResolvedValue(preCheckText);

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    // Standard body (3 blocks) + 1 pre-check text block = 4 items
    expect(params.messages[0].content).toHaveLength(4);
    // The injected pre-check block should be last
    const lastBlock = params.messages[0].content.at(-1);
    expect(lastBlock.type).toBe('text');
    expect(lastBlock.text).toContain('Additional Market Data');
    expect(lastBlock.text).toContain('SPX spot exposure data here');
  });

  it('analysis still succeeds when pre-check returns null (no-op path)', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const { runAnalysisPreCheck } = await import('../_lib/analyze-precheck.js');
    vi.mocked(runAnalysisPreCheck).mockResolvedValue(null);

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      analysis: typeof SAMPLE_ANALYSIS;
    };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('analysis still succeeds when pre-check returns extra context', async () => {
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const { runAnalysisPreCheck } = await import('../_lib/analyze-precheck.js');
    vi.mocked(runAnalysisPreCheck).mockResolvedValue(
      '=== Additional Market Data (fetched on request) ===\nsome data',
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = parseNdjsonResponse(res) as {
      analysis: typeof SAMPLE_ANALYSIS;
    };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });
});
