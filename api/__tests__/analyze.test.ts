// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => async () => []),
  saveAnalysis: vi.fn().mockResolvedValue(undefined),
  saveSnapshot: vi.fn().mockResolvedValue(null),
  getLatestPositions: vi.fn().mockResolvedValue(null),
  getPreviousRecommendation: vi.fn().mockResolvedValue(null),
}));

// Mock the Anthropic SDK — capture the stream call
// The handler uses `anthropic.messages.stream(params).finalMessage()`
const mockFinalMessage = vi.fn();
const mockStream = vi.fn().mockReturnValue({ finalMessage: mockFinalMessage });

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { stream: mockStream };
  }
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'APIError';
    }
  }
  return { default: MockAnthropic, APIError };
});

import handler from '../analyze.js';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';

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
  };
}

describe('POST /api/analyze', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockStream.mockReset().mockReturnValue({ finalMessage: mockFinalMessage });
    mockFinalMessage.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
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
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 500 when ANTHROPIC_API_KEY is missing', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    delete process.env.ANTHROPIC_API_KEY;

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Server configuration error' });
  });

  it('returns 400 when no images provided', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

    const req = mockRequest({ method: 'POST', body: makeBody({ images: [] }) });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'At least one image is required' });
  });

  it('returns 400 when more than 7 images', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

    const images = Array.from({ length: 8 }, () => ({
      data: 'base64',
      mediaType: 'image/png',
    }));
    const req = mockRequest({ method: 'POST', body: makeBody({ images }) });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Maximum 7 images allowed' });
  });

  it('returns parsed analysis on success', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { analysis: typeof SAMPLE_ANALYSIS; raw: string };
    expect(json.analysis.structure).toBe('IRON CONDOR');
    expect(json.analysis.confidence).toBe('HIGH');
    expect(json.analysis.suggestedDelta).toBe(8);
    expect(json.analysis.observations).toHaveLength(3);
    expect(json.raw).toBeDefined();
  });

  it('sends correct model and params to Anthropic SDK', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const body = makeBody();
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(mockStream).toHaveBeenCalledOnce();
    const params = mockStream.mock.calls[0]![0];
    expect(params.model).toBe('claude-opus-4-6');
    expect(params.max_tokens).toBe(35000);
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.messages).toHaveLength(1);
    // Should have 1 text label + 1 image block + 1 context text block
    expect(params.messages[0].content).toHaveLength(3);
    expect(params.messages[0].content[0].type).toBe('text');
    expect(params.messages[0].content[1].type).toBe('image');
    expect(params.messages[0].content[2].type).toBe('text');
  });

  it('handles multiple images', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    const images = [
      { data: 'img1', mediaType: 'image/png' },
      { data: 'img2', mediaType: 'image/jpeg' },
      { data: 'img3', mediaType: 'image/png' },
    ];
    const req = mockRequest({ method: 'POST', body: makeBody({ images }) });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    // 3 × (text label + image block) + 1 context text block = 7
    expect(params.messages[0].content).toHaveLength(7);
  });

  it('returns 502 when Anthropic API returns 429', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    const err = Object.assign(new Error('Rate limited'), { status: 429 });
    mockStream.mockImplementation(() => {
      throw err;
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(502);
    const json = res._json as { error: string };
    expect(json.error).toContain('Anthropic rate limit exceeded');
  });

  it('returns raw text when Claude response is not valid JSON', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: 'Not valid JSON response' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { analysis: null; raw: string };
    expect(json.analysis).toBeNull();
    expect(json.raw).toBe('Not valid JSON response');
  });

  it('strips markdown code fences from Claude response', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    const wrapped = '```json\n' + JSON.stringify(SAMPLE_ANALYSIS) + '\n```';
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: wrapped }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { analysis: typeof SAMPLE_ANALYSIS };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('returns 500 when SDK throws a network error', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockStream.mockImplementation(() => {
      throw new Error('Network failure');
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Network failure' });
  });

  it('returns generic message for non-Error throws', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockStream.mockImplementation(() => {
      throw 'something weird'; // NOSONAR: intentionally testing non-Error throw handling
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Analysis failed' });
  });

  it('includes midday mode text in context', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    const json = res._json as { analysis: typeof SAMPLE_ANALYSIS };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('uses image labels when provided', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    const err = Object.assign(new Error('Invalid API key'), { status: 401 });
    mockStream.mockImplementation(() => {
      throw err;
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(502);
    const json = res._json as { error: string };
    expect(json.error).toContain('Anthropic API authentication error');
    expect(json.error).not.toContain('Invalid API key');
  });

  it('returns correct client message for Anthropic 500', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    const err = Object.assign(new Error('Internal server error'), {
      status: 500,
    });
    mockStream.mockImplementation(() => {
      throw err;
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(502);
    const json = res._json as { error: string };
    expect(json.error).toContain('Analysis service error (500)');
    expect(json.error).not.toContain('Internal server error');
  });

  it('still returns analysis when DB save fails', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    // Make DB throw
    const { saveAnalysis } = await import('../_lib/db.js');
    vi.mocked(saveAnalysis).mockRejectedValueOnce(new Error('DB down'));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    // Response should still succeed
    expect(res._status).toBe(200);
    const json = res._json as { analysis: typeof SAMPLE_ANALYSIS };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('handles response with only thinking blocks (no text)', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'thinking', thinking: 'internal only...' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { analysis: null; raw: string };
    expect(json.analysis).toBeNull();
    expect(json.raw).toBe('');
  });
});
