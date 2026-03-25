// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => async () => []),
  saveAnalysis: vi.fn().mockResolvedValue(undefined),
  saveSnapshot: vi.fn().mockResolvedValue(null),
  getLatestPositions: vi.fn().mockResolvedValue(null),
  getPreviousRecommendation: vi.fn().mockResolvedValue(null),
  getFlowData: vi.fn().mockResolvedValue([]),
  getRecentFlowData: vi.fn().mockResolvedValue([]),
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
}));

vi.mock('../_lib/lessons.js', () => ({
  getActiveLessons: vi.fn().mockResolvedValue([]),
  formatLessonsBlock: vi.fn().mockReturnValue(''),
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
import {
  rejectIfNotOwner,
  rejectIfRateLimited,
  checkBot,
} from '../_lib/api-helpers.js';
import { getActiveLessons, formatLessonsBlock } from '../_lib/lessons.js';
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
    // Restore module mock defaults that restoreAllMocks may strip
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
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

  it('returns 400 when more than 2 images', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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

  it('retries DB save and succeeds on second attempt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    const json = res._json as { analysis: typeof SAMPLE_ANALYSIS };
    expect(json.analysis.structure).toBe('IRON CONDOR');
    vi.useRealTimers();
  });

  it('falls back to Sonnet when Opus fails with server error', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

    // SDK retries are internal (maxRetries: 3). When mockFinalMessage rejects,
    // it means Opus is exhausted — code falls back to Sonnet immediately.
    const serverErr = Object.assign(new Error('Internal server error'), {
      status: 500,
    });
    mockFinalMessage
      .mockRejectedValueOnce(serverErr)
      .mockResolvedValueOnce(makeSDKResponse(SAMPLE_ANALYSIS));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockStream).toHaveBeenCalledTimes(2);
    // First call is Opus, second is Sonnet fallback
    expect(mockStream.mock.calls[0]![0].model).toBe('claude-opus-4-6');
    expect(mockStream.mock.calls[1]![0].model).toBe('claude-sonnet-4-6');
    const json = res._json as { model: string };
    expect(json.model).toBe('claude-sonnet-4-6');
  });

  it('returns 500 when both Opus and Sonnet fail', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

    const serverErr = Object.assign(new Error('overloaded'), { status: 529 });
    mockFinalMessage
      .mockRejectedValueOnce(serverErr)
      .mockRejectedValueOnce(serverErr);

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(502);
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(mockStream.mock.calls[0]![0].model).toBe('claude-opus-4-6');
    expect(mockStream.mock.calls[1]![0].model).toBe('claude-sonnet-4-6');
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

  it('injects lessons_learned block into system prompt when lessons exist', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    const systemText = params.system[0].text;
    expect(systemText).toContain('<lessons_learned>');
    expect(systemText).toContain('VIX above 25 means widen wings');
    // Lessons block should sit between </structure_selection_rules> and <data_handling>
    const lessonsIdx = systemText.indexOf('<lessons_learned>');
    const structureEnd = systemText.indexOf('</structure_selection_rules>');
    const dataHandling = systemText.indexOf('<data_handling>');
    expect(lessonsIdx).toBeGreaterThan(structureEnd);
    expect(lessonsIdx).toBeLessThan(dataHandling);
  });

  it('omits lessons_learned block when no lessons exist', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    vi.mocked(getActiveLessons).mockResolvedValueOnce([]);
    vi.mocked(formatLessonsBlock).mockReturnValueOnce('');

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = mockStream.mock.calls[0]![0];
    const systemText = params.system[0].text;
    expect(systemText).not.toContain('<lessons_learned>');
    // Structure rules and data handling should still be present
    expect(systemText).toContain('</structure_selection_rules>');
    expect(systemText).toContain('<data_handling>');
  });

  it('continues analysis when flow data fetch throws', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    const json = res._json as { analysis: typeof SAMPLE_ANALYSIS };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('continues analysis when lessons fetch throws', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFinalMessage.mockResolvedValue(makeSDKResponse(SAMPLE_ANALYSIS));

    vi.mocked(getActiveLessons).mockRejectedValueOnce(
      new Error('Lessons DB error'),
    );

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { analysis: typeof SAMPLE_ANALYSIS };
    expect(json.analysis.structure).toBe('IRON CONDOR');
    // System prompt should NOT contain lessons block
    const params = mockStream.mock.calls[0]![0];
    const systemText = params.system[0].text;
    expect(systemText).not.toContain('<lessons_learned>');
  });

  // ── Bot check ─────────────────────────────────────────────

  it('returns 403 when bot check detects a bot', async () => {
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  // ── Rate limiting ─────────────────────────────────────────

  it('returns early when rate limited', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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

  it('skips positions with default "No open" summary', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    expect(contextBlock).not.toContain('Current Open Positions');
  });

  it('continues when position fetch throws', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    expect(contextBlock).toContain('Market Tide Data');
    expect(contextBlock).toContain('SPX Net Flow Data');
    expect(contextBlock).toContain('Per-Strike Greek Profile');
    expect(contextBlock).toContain('All-Expiry Per-Strike Profile');
  });

  // ── Events, backtest, dataNote context fields ─────────────

  it('formats scheduled events in context', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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

  // ── JSON repair for truncated responses ───────────────────

  it('repairs truncated JSON with unbalanced braces', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    // Truncated JSON — missing closing brace
    const truncated = '{"structure":"IRON CONDOR","confidence":"HIGH"';
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: truncated }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { analysis: { structure: string } };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('repairs truncated JSON with unbalanced quotes and brackets', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    // Truncated mid-string with open array
    const truncated = '{"observations":["NCP at +50M","NPP at -40M';
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: truncated }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { analysis: { observations: string[] } };
    expect(json.analysis.observations).toContain('NCP at +50M');
  });

  // ── Snapshot ID lookup ────────────────────────────────────

  it('passes snapshot ID to saveAnalysis when snapshot exists', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

    // First stream() call throws (overloaded), second returns normally
    const overloaded = Object.assign(new Error('overloaded'), { status: 529 });
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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
});
