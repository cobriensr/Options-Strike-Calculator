// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Anthropic SDK mock ──────────────────────────────────
// Hoisted-safe via vi.hoisted; the handler imports default + named errors.
const { mockStream, mockFinalMessage } = vi.hoisted(() => ({
  mockStream: vi.fn(),
  mockFinalMessage: vi.fn(),
}));

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
  // Expose error classes on globalThis so tests can `new MockErrors.X(...)`
  // with simple signatures — the real SDK's APIError takes 4-5 args, which
  // would be noisy to construct from tests.
  (globalThis as Record<string, unknown>).__TraceLiveMockErrors = {
    APIError,
    AuthenticationError,
    RateLimitError,
  };
  class MockAnthropic {
    get messages() {
      return { stream: mockStream };
    }
    static readonly APIError = APIError;
    static readonly AuthenticationError = AuthenticationError;
    static readonly RateLimitError = RateLimitError;
  }
  return {
    default: MockAnthropic,
    APIError,
    AuthenticationError,
    RateLimitError,
  };
});

// ── api-helpers mock — full stub, handler doesn't need real cookie parsing
vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  respondIfInvalid: vi.fn().mockReturnValue(false),
}));

vi.mock('../_lib/env.js', () => ({
  requireEnv: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../_lib/trace-live-prompts.js', () => ({
  TRACE_LIVE_STABLE_SYSTEM_TEXT: 'mock system text',
}));

vi.mock('../_lib/trace-live-context.js', () => ({
  buildTraceLiveUserContent: vi.fn(() => [
    { type: 'text', text: 'mock user content' },
  ]),
}));

vi.mock('../_lib/trace-live-db.js', () => ({
  buildTraceLiveSummary: vi.fn(() => 'pipe|delim|summary'),
  saveTraceLiveAnalysis: vi.fn().mockResolvedValue(42),
}));

vi.mock('../_lib/trace-live-parse.js', () => ({
  parseAndValidateTraceAnalysis: vi.fn(),
}));

vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

vi.mock('../_lib/trace-live-blob.js', () => ({
  uploadTraceLiveImages: vi.fn().mockResolvedValue({
    gamma: 'https://blob/g.png',
  }),
}));

import handler from '../trace-live-analyze.js';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  respondIfInvalid,
} from '../_lib/api-helpers.js';
import { requireEnv } from '../_lib/env.js';
import { metrics, Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { parseAndValidateTraceAnalysis } from '../_lib/trace-live-parse.js';
import {
  saveTraceLiveAnalysis,
  buildTraceLiveSummary,
} from '../_lib/trace-live-db.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import { uploadTraceLiveImages } from '../_lib/trace-live-blob.js';

const MockErrors = (globalThis as Record<string, unknown>)
  .__TraceLiveMockErrors as {
  APIError: new (status: number, message: string) => Error;
  AuthenticationError: new (message?: string) => Error;
  RateLimitError: new (message?: string) => Error;
};

/** Build a minimal valid request body. */
function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    capturedAt: '2026-04-29T13:30:00Z',
    spot: 6605,
    stabilityPct: 67,
    images: [
      {
        data: 'base64data',
        mediaType: 'image/png',
        chart: 'gamma',
        slot: 'now',
        capturedAt: '2026-04-29T13:30:00Z',
      },
    ],
    gex: {
      regime: 'RANGE-BOUND',
      atmStrike: 6605,
      strikes: [{ strike: 6605, dollarGamma: 1_000_000_000 }],
    },
    ...overrides,
  };
}

const SAMPLE_ANALYSIS = {
  timestamp: '2026-04-29T13:30:00Z',
  spot: 6605,
  regime: 'range_bound_positive_gamma',
  predictedClose: 6605,
  confidence: 'high',
};

/** Build a mock Anthropic streaming success response. */
function makeFinalMessage(
  text: string,
  opts: {
    stopReason?: string;
    cacheRead?: number;
    cacheWrite?: number;
  } = {},
) {
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: opts.cacheRead ?? 14_000,
      cache_creation_input_tokens: opts.cacheWrite ?? 0,
    },
    stop_reason: opts.stopReason ?? 'end_turn',
  };
}

/** Parse the final NDJSON line from the response chunks (skips keepalive pings). */
function parseFinalNdjson(res: { _chunks: string[] }): Record<string, unknown> {
  const lines = res._chunks
    .join('')
    .split('\n')
    .filter((l) => l.trim().length > 0 && !l.includes('"ping":true'));
  const last = lines.at(-1) ?? '{}';
  return JSON.parse(last);
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'test-key' };
  mockStream.mockReset().mockReturnValue({ finalMessage: mockFinalMessage });
  mockFinalMessage.mockReset();
  vi.mocked(guardOwnerEndpoint).mockReset().mockResolvedValue(false);
  vi.mocked(rejectIfRateLimited).mockReset().mockResolvedValue(false);
  vi.mocked(respondIfInvalid).mockReset().mockReturnValue(false);
  vi.mocked(requireEnv).mockReset().mockReturnValue('test-key');
  vi.mocked(parseAndValidateTraceAnalysis)
    .mockReset()
    .mockReturnValue(SAMPLE_ANALYSIS as never);
  vi.mocked(saveTraceLiveAnalysis).mockReset().mockResolvedValue(42);
  vi.mocked(buildTraceLiveSummary).mockReset().mockReturnValue('summary');
  vi.mocked(generateEmbedding).mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
  vi.mocked(uploadTraceLiveImages)
    .mockReset()
    .mockResolvedValue({ gamma: 'https://blob/g.png' } as never);
  vi.mocked(metrics.increment).mockClear();
  vi.mocked(Sentry.captureException).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.info).mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('POST /api/trace-live-analyze — guards', () => {
  it('returns 405 for non-POST methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('exits silently when guardOwnerEndpoint rejects (response already sent)', async () => {
    vi.mocked(guardOwnerEndpoint).mockResolvedValueOnce(true);
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);
    expect(mockStream).not.toHaveBeenCalled();
    // Handler returned before NDJSON headers were set
    expect(res._headers['Content-Type']).toBeUndefined();
  });

  it('returns early on rate limit (429 already written by helper)', async () => {
    vi.mocked(rejectIfRateLimited).mockResolvedValueOnce(true);
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('returns 500 when ANTHROPIC_API_KEY is missing', async () => {
    vi.mocked(requireEnv).mockImplementationOnce(() => {
      throw new Error('Missing ANTHROPIC_API_KEY');
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Server configuration error' });
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('returns early when respondIfInvalid handles a bad body', async () => {
    vi.mocked(respondIfInvalid).mockImplementationOnce((_p, res) => {
      res.status(400).json({ error: 'bad body' });
      return true as never;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: { junk: 1 } }), res);
    expect(res._status).toBe(400);
    expect(mockStream).not.toHaveBeenCalled();
  });
});

describe('POST /api/trace-live-analyze — happy path', () => {
  it('streams a final NDJSON envelope with the analysis on success', async () => {
    mockFinalMessage.mockResolvedValueOnce(
      makeFinalMessage(JSON.stringify(SAMPLE_ANALYSIS)),
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);

    // NDJSON headers
    expect(res._headers['Content-Type']).toBe('application/x-ndjson');
    expect(res._headers['Cache-Control']).toBe('no-cache');
    expect(res._headers['X-Accel-Buffering']).toBe('no');

    const final = parseFinalNdjson(res);
    expect(final.ok).toBe(true);
    expect(final.analysis).toEqual(SAMPLE_ANALYSIS);
    expect(final.model).toBe('claude-sonnet-4-6');
    expect(final.usage).toMatchObject({
      input: 100,
      output: 200,
      cacheRead: 14_000,
      cacheWrite: 0,
    });
    expect(typeof final.durationMs).toBe('number');

    // Persistence pipeline ran
    expect(generateEmbedding).toHaveBeenCalledOnce();
    expect(uploadTraceLiveImages).toHaveBeenCalledOnce();
    expect(saveTraceLiveAnalysis).toHaveBeenCalledOnce();
    expect(buildTraceLiveSummary).toHaveBeenCalledOnce();

    // Save received the embedding + image urls + analysis
    const saveArg = vi.mocked(saveTraceLiveAnalysis).mock.calls[0]?.[0];
    expect(saveArg?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(saveArg?.imageUrls).toEqual({ gamma: 'https://blob/g.png' });
    expect(saveArg?.analysis).toEqual(SAMPLE_ANALYSIS);
    expect(saveArg?.model).toBe('claude-sonnet-4-6');
    expect(saveArg?.spot).toBe(6605);
    expect(saveArg?.stabilityPct).toBe(67);
  });

  it('coerces null stabilityPct when omitted from the body', async () => {
    mockFinalMessage.mockResolvedValueOnce(
      makeFinalMessage(JSON.stringify(SAMPLE_ANALYSIS)),
    );
    const body = makeBody();
    delete (body as Record<string, unknown>).stabilityPct;
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body }), res);
    const saveArg = vi.mocked(saveTraceLiveAnalysis).mock.calls[0]?.[0];
    expect(saveArg?.stabilityPct).toBeNull();
  });

  it('logs a cache-miss warning when cacheRead=0 and cacheWrite>0', async () => {
    mockFinalMessage.mockResolvedValueOnce(
      makeFinalMessage(JSON.stringify(SAMPLE_ANALYSIS), {
        cacheRead: 0,
        cacheWrite: 14_000,
      }),
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
      'Cache miss on TRACE-live system prompt — prefix may have changed',
    );
  });

  it('still saves the row when embedding generation fails (best-effort)', async () => {
    mockFinalMessage.mockResolvedValueOnce(
      makeFinalMessage(JSON.stringify(SAMPLE_ANALYSIS)),
    );
    vi.mocked(generateEmbedding).mockRejectedValueOnce(
      new Error('OpenAI down'),
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);

    expect(saveTraceLiveAnalysis).toHaveBeenCalledOnce();
    const saveArg = vi.mocked(saveTraceLiveAnalysis).mock.calls[0]?.[0];
    expect(saveArg?.embedding).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalled();

    // Final NDJSON line still reports ok:true
    const final = parseFinalNdjson(res);
    expect(final.ok).toBe(true);
  });
});

describe('POST /api/trace-live-analyze — model failure modes', () => {
  it('writes ok:false error:"refusal" when stop_reason is "refusal"', async () => {
    mockFinalMessage.mockResolvedValueOnce(
      makeFinalMessage('', { stopReason: 'refusal' }),
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);

    const final = parseFinalNdjson(res);
    expect(final).toEqual({ ok: false, error: 'refusal' });
    expect(saveTraceLiveAnalysis).not.toHaveBeenCalled();
    expect(parseAndValidateTraceAnalysis).not.toHaveBeenCalled();
  });

  it('writes ok:false error:"schema_validation" when parse returns null', async () => {
    mockFinalMessage.mockResolvedValueOnce(makeFinalMessage('garbage text'));
    vi.mocked(parseAndValidateTraceAnalysis).mockReturnValueOnce(null);
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);

    const final = parseFinalNdjson(res);
    expect(final).toEqual({ ok: false, error: 'schema_validation' });
    expect(metrics.increment).toHaveBeenCalledWith('trace_live.parse_failure');
    expect(saveTraceLiveAnalysis).not.toHaveBeenCalled();
  });

  it('writes a generic error message when stream() throws an unknown error', async () => {
    mockStream.mockImplementationOnce(() => {
      throw new Error('socket hang up');
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);

    const final = parseFinalNdjson(res);
    expect(final.ok).toBe(false);
    expect(final.error).toBe('socket hang up');
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('translates RateLimitError to a friendly message', async () => {
    mockFinalMessage.mockRejectedValueOnce(
      new MockErrors.RateLimitError('rate'),
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);

    const final = parseFinalNdjson(res);
    expect(final.error).toBe(
      'Anthropic rate limit exceeded. Try again shortly.',
    );
  });

  it('translates AuthenticationError to a key-check message', async () => {
    mockFinalMessage.mockRejectedValueOnce(
      new MockErrors.AuthenticationError('bad key'),
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);

    const final = parseFinalNdjson(res);
    expect(final.error).toBe(
      'Anthropic API authentication error. Check API key.',
    );
  });

  it('translates a generic APIError with status code', async () => {
    mockFinalMessage.mockRejectedValueOnce(
      new MockErrors.APIError(503, 'down'),
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: makeBody() }), res);

    const final = parseFinalNdjson(res);
    expect(final.error).toBe('Analysis service error (503). Please retry.');
  });
});
