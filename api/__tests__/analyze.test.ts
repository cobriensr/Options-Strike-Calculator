// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
}));

import handler from '../analyze.js';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';

// Stub global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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

/** Build a mock Anthropic API success response */
function makeAnthropicResponse(analysis: Record<string, unknown>) {
  const text = JSON.stringify(analysis);
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        content: [{ type: 'text', text }],
      }),
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

describe('POST /api/analyze', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
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
    expect(res._json).toEqual({ error: 'ANTHROPIC_API_KEY not configured' });
  });

  it('returns 400 when no images provided', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

    const req = mockRequest({ method: 'POST', body: makeBody({ images: [] }) });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'At least one image is required' });
  });

  it('returns 400 when more than 5 images', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

    const images = Array.from({ length: 6 }, () => ({
      data: 'base64',
      mediaType: 'image/png',
    }));
    const req = mockRequest({ method: 'POST', body: makeBody({ images }) });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Maximum 5 images allowed' });
  });

  it('returns parsed analysis on success', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFetch.mockResolvedValue(makeAnthropicResponse(SAMPLE_ANALYSIS));

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

  it('sends correct headers and body to Anthropic API', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFetch.mockResolvedValue(makeAnthropicResponse(SAMPLE_ANALYSIS));

    const body = makeBody();
    const req = mockRequest({ method: 'POST', body });
    const res = mockResponse();
    await handler(req, res);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-api-key']).toBe('test-key');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');

    const sentBody = JSON.parse(opts.body);
    expect(sentBody.model).toBe('claude-sonnet-4-20250514');
    expect(sentBody.max_tokens).toBe(1000);
    expect(sentBody.messages).toHaveLength(1);
    // Should have 1 image block + 1 text block
    expect(sentBody.messages[0].content).toHaveLength(2);
    expect(sentBody.messages[0].content[0].type).toBe('image');
    expect(sentBody.messages[0].content[1].type).toBe('text');
  });

  it('handles multiple images', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFetch.mockResolvedValue(makeAnthropicResponse(SAMPLE_ANALYSIS));

    const images = [
      { data: 'img1', mediaType: 'image/png' },
      { data: 'img2', mediaType: 'image/jpeg' },
      { data: 'img3', mediaType: 'image/png' },
    ];
    const req = mockRequest({ method: 'POST', body: makeBody({ images }) });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const sentBody = JSON.parse(mockFetch.mock.calls[0]![1].body);
    // 3 image blocks + 1 text block
    expect(sentBody.messages[0].content).toHaveLength(4);
  });

  it('returns 502 when Anthropic API returns an error', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limited'),
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(502);
    const json = res._json as { error: string };
    expect(json.error).toContain('Anthropic API error (429)');
    expect(json.error).toContain('Rate limited');
  });

  it('returns raw text when Claude response is not valid JSON', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          content: [{ type: 'text', text: 'Not valid JSON response' }],
        }),
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
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          content: [{ type: 'text', text: wrapped }],
        }),
    });

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as { analysis: typeof SAMPLE_ANALYSIS };
    expect(json.analysis.structure).toBe('IRON CONDOR');
  });

  it('returns 500 when fetch throws a network error', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFetch.mockRejectedValue(new Error('Network failure'));

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Network failure' });
  });

  it('returns generic message for non-Error throws', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockFetch.mockRejectedValue('something weird');

    const req = mockRequest({ method: 'POST', body: makeBody() });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Analysis failed' });
  });
});
