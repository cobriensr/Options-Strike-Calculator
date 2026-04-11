// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
const mockDbFn = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockDbFn),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../_lib/plot-analysis-prompts.js', () => ({
  PLOT_ANALYSIS_SYSTEM_PROMPT: 'You are a plot analyst.',
}));

const { mockList, mockBlobGet, mockStream } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockBlobGet: vi.fn(),
  mockStream: vi.fn(),
}));

vi.mock('@vercel/blob', () => ({
  list: (...args: unknown[]) => mockList(...args),
  get: (...args: unknown[]) => mockBlobGet(...args),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = {
      stream: mockStream,
    };
  },
}));

import handler from '../ml/analyze-plots.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// ── Helpers ───────────────────────────────────────────────────
const CRON_SECRET = 'test-cron-secret';

function makeAuthRequest(
  overrides: Partial<Parameters<typeof mockRequest>[0]> = {},
) {
  return mockRequest({
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
    ...overrides,
  });
}

function makeBlobEntry(pathname: string) {
  return {
    pathname,
    url: `https://blob.vercel-storage.com/${pathname}`,
  };
}

function makeFinalMessage(text: string, usage: Record<string, number> = {}) {
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
      ...usage,
    },
  };
}

function mockStreamReturn(message: ReturnType<typeof makeFinalMessage>) {
  return {
    finalMessage: vi.fn().mockResolvedValue(message),
  };
}

function makeBlobGetResult(base64Data = 'iVBORw0KGgo=') {
  const buffer = Buffer.from(base64Data, 'base64');
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(buffer);
        controller.close();
      },
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────
describe('POST /api/ml/analyze-plots', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockDbFn.mockReset();
    mockList.mockReset();
    mockBlobGet.mockReset();
    mockStream.mockReset();

    savedEnv = {
      CRON_SECRET: process.env.CRON_SECRET,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    process.env.CRON_SECRET = savedEnv.CRON_SECRET;
    process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
  });

  // ── Method check ──────────────────────────────────────────
  it('returns 405 for GET method', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('returns 405 for PUT method', async () => {
    const req = mockRequest({ method: 'PUT' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  // ── Auth ──────────────────────────────────────────────────
  it('returns 401 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;

    const req = mockRequest({
      method: 'POST',
      headers: { authorization: 'Bearer something' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when authorization header is missing', async () => {
    const req = mockRequest({ method: 'POST', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when authorization header has wrong token', async () => {
    const req = mockRequest({
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  // ── Missing API key ───────────────────────────────────────
  it('returns 500 when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'ANTHROPIC_API_KEY not configured' });
  });

  // ── No plots found ───────────────────────────────────────
  it('returns success with 0 analyzed when no PNG blobs exist', async () => {
    mockList.mockResolvedValueOnce({ blobs: [] });

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const chunks = res._chunks;
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const lastChunk = JSON.parse(chunks.at(-1)!);
    expect(lastChunk.analyzed).toBe(0);
    expect(lastChunk.message).toContain('No plots found');
  });

  it('filters non-PNG blobs', async () => {
    mockList.mockResolvedValueOnce({
      blobs: [
        makeBlobEntry('ml-plots/latest/readme.txt'),
        makeBlobEntry('ml-plots/latest/data.json'),
      ],
    });

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    const lastChunk = JSON.parse(res._chunks.at(-1)!);
    expect(lastChunk.analyzed).toBe(0);
    expect(lastChunk.message).toContain('No plots found');
  });

  // ── Successful single plot analysis ───────────────────────
  it('analyzes a single plot successfully', async () => {
    mockList.mockResolvedValueOnce({
      blobs: [makeBlobEntry('ml-plots/latest/correlations.png')],
    });

    // DB: load findings
    mockDbFn.mockResolvedValueOnce([{ findings: { eda: { some: 'data' } } }]);

    // Blob get for the plot image
    mockBlobGet.mockResolvedValueOnce(makeBlobGetResult());

    // Claude vision response
    const analysisJson = JSON.stringify({
      what_it_means: 'test meaning',
      how_to_apply: 'test apply',
      watch_out_for: 'test watch',
    });
    mockStream.mockReturnValueOnce(
      mockStreamReturn(makeFinalMessage(analysisJson)),
    );

    // DB: upsert analysis
    mockDbFn.mockResolvedValueOnce([]);

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    // Should have progress + final chunks
    const chunks = res._chunks
      .filter((c) => !c.includes('"ping"'))
      .map((c) => JSON.parse(c));
    const progressChunk = chunks.find(
      (c: Record<string, unknown>) => c.plot === 'correlations',
    );
    expect(progressChunk).toBeDefined();
    expect(progressChunk.status).toBe('done');
    expect(progressChunk.progress).toBe('1/1');

    const finalChunk = chunks.at(-1);
    expect(finalChunk.analyzed).toBe(1);
    expect(finalChunk.failed).toEqual([]);
  });

  // ── Claude returns fenced JSON ────────────────────────────
  it('strips markdown code fences from Claude response', async () => {
    mockList.mockResolvedValueOnce({
      blobs: [makeBlobEntry('ml-plots/latest/timeline.png')],
    });
    mockDbFn.mockResolvedValueOnce([]); // no findings
    mockBlobGet.mockResolvedValueOnce(makeBlobGetResult());

    const fencedJson = '```json\n{"what_it_means":"fenced"}\n```';
    mockStream.mockReturnValueOnce(
      mockStreamReturn(makeFinalMessage(fencedJson)),
    );
    mockDbFn.mockResolvedValueOnce([]); // upsert

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    const chunks = res._chunks
      .filter((c) => !c.includes('"ping"'))
      .map((c) => JSON.parse(c));
    const finalChunk = chunks.at(-1);
    expect(finalChunk.analyzed).toBe(1);
    expect(finalChunk.failed).toEqual([]);
  });

  it('handles preamble text before a fenced JSON block', async () => {
    mockList.mockResolvedValueOnce({
      blobs: [makeBlobEntry('ml-plots/latest/correlations.png')],
    });
    mockDbFn.mockResolvedValueOnce([]);
    mockBlobGet.mockResolvedValueOnce(makeBlobGetResult());

    // Simulates the Sentry failure: Claude adds introductory text before the fence
    const responseWithPreamble =
      'Here is my analysis:\n\n```json\n{"what_it_means":"preamble test"}\n```';
    mockStream.mockReturnValueOnce(
      mockStreamReturn(makeFinalMessage(responseWithPreamble)),
    );
    mockDbFn.mockResolvedValueOnce([]);

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    const chunks = res._chunks
      .filter((c) => !c.includes('"ping"'))
      .map((c) => JSON.parse(c));
    const finalChunk = chunks.at(-1);
    expect(finalChunk.analyzed).toBe(1);
    expect(finalChunk.failed).toEqual([]);
  });

  it('handles preamble text before a bare JSON object', async () => {
    mockList.mockResolvedValueOnce({
      blobs: [makeBlobEntry('ml-plots/latest/correlations.png')],
    });
    mockDbFn.mockResolvedValueOnce([]);
    mockBlobGet.mockResolvedValueOnce(makeBlobGetResult());

    const responseWithPreamble =
      'Here is my analysis:\n\n{"what_it_means":"bare json after preamble"}';
    mockStream.mockReturnValueOnce(
      mockStreamReturn(makeFinalMessage(responseWithPreamble)),
    );
    mockDbFn.mockResolvedValueOnce([]);

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    const chunks = res._chunks
      .filter((c) => !c.includes('"ping"'))
      .map((c) => JSON.parse(c));
    const finalChunk = chunks.at(-1);
    expect(finalChunk.analyzed).toBe(1);
    expect(finalChunk.failed).toEqual([]);
  });

  // ── Multiple plots: first sequential, rest concurrent ─────
  it('processes multiple plots (first sequential, rest concurrent)', async () => {
    mockList.mockResolvedValueOnce({
      blobs: [
        makeBlobEntry('ml-plots/latest/correlations.png'),
        makeBlobEntry('ml-plots/latest/timeline.png'),
        makeBlobEntry('ml-plots/latest/clusters_pca.png'),
      ],
    });

    // DB: load findings
    mockDbFn.mockResolvedValueOnce([{ findings: { eda: {}, clustering: {} } }]);

    // 3 blob gets — each needs a fresh stream
    mockBlobGet.mockImplementation(() => Promise.resolve(makeBlobGetResult()));

    // 3 Claude responses — each needs a fresh finalMessage mock
    const analysisJson = JSON.stringify({ what_it_means: 'ok' });
    mockStream.mockImplementation(() =>
      mockStreamReturn(makeFinalMessage(analysisJson)),
    );

    // 3 DB upserts (default after findings Once)
    mockDbFn.mockResolvedValue([]);

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    const chunks = res._chunks
      .filter((c) => !c.includes('"ping"'))
      .map((c) => JSON.parse(c));
    const finalChunk = chunks.at(-1);
    expect(finalChunk.analyzed).toBe(3);
    expect(finalChunk.failed).toEqual([]);
    expect(finalChunk.duration_ms).toBeGreaterThanOrEqual(0);
  });

  // ── First plot fails, rest still proceed ──────────────────
  it('records failure when first plot analysis throws', async () => {
    mockList.mockResolvedValueOnce({
      blobs: [makeBlobEntry('ml-plots/latest/bad_plot.png')],
    });
    mockDbFn.mockResolvedValueOnce([]); // no findings
    mockBlobGet.mockResolvedValueOnce(null); // blob not found triggers error in analyzePlot

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    const chunks = res._chunks
      .filter((c) => !c.includes('"ping"'))
      .map((c) => JSON.parse(c));
    const finalChunk = chunks.at(-1);
    expect(finalChunk.failed.length).toBeGreaterThan(0);
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
  });

  // ── Concurrent plot fails ─────────────────────────────────
  it('handles failure in concurrent plots', async () => {
    mockList.mockResolvedValueOnce({
      blobs: [
        makeBlobEntry('ml-plots/latest/good.png'),
        makeBlobEntry('ml-plots/latest/bad.png'),
      ],
    });
    mockDbFn.mockResolvedValueOnce([]); // no findings

    // First plot succeeds
    mockBlobGet.mockResolvedValueOnce(makeBlobGetResult());
    const analysisJson = JSON.stringify({ what_it_means: 'ok' });
    mockStream.mockReturnValueOnce(
      mockStreamReturn(makeFinalMessage(analysisJson)),
    );
    mockDbFn.mockResolvedValueOnce([]); // upsert

    // Second plot: blob get fails
    mockBlobGet.mockRejectedValueOnce(new Error('blob network error'));

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    const chunks = res._chunks
      .filter((c) => !c.includes('"ping"'))
      .map((c) => JSON.parse(c));
    const finalChunk = chunks.at(-1);
    expect(finalChunk.analyzed).toBe(1);
    expect(finalChunk.failed.length).toBe(1);
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
  });

  // ── Top-level try/catch ───────────────────────────────────
  it('returns error via NDJSON when list() throws', async () => {
    mockList.mockRejectedValueOnce(new Error('Blob store offline'));

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    const chunks = res._chunks
      .filter((c) => !c.includes('"ping"'))
      .map((c) => JSON.parse(c));
    const errorChunk = chunks.at(-1);
    expect(errorChunk.error).toBe('Plot analysis failed');
    expect(errorChunk.message).toBe('Blob store offline');
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
  });

  // ── NDJSON headers ────────────────────────────────────────
  it('sets NDJSON streaming headers', async () => {
    mockList.mockResolvedValueOnce({ blobs: [] });

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._headers['Content-Type']).toBe('application/x-ndjson');
    expect(res._headers['Cache-Control']).toBe('no-cache');
    expect(res._headers['X-Accel-Buffering']).toBe('no');
  });

  // ── Findings loaded from DB ───────────────────────────────
  it('passes null findings when DB has no findings rows', async () => {
    mockList.mockResolvedValueOnce({
      blobs: [makeBlobEntry('ml-plots/latest/correlations.png')],
    });
    mockDbFn.mockResolvedValueOnce([]); // no findings rows
    mockBlobGet.mockResolvedValueOnce(makeBlobGetResult());

    const analysisJson = JSON.stringify({ what_it_means: 'no findings' });
    mockStream.mockReturnValueOnce(
      mockStreamReturn(makeFinalMessage(analysisJson)),
    );
    mockDbFn.mockResolvedValueOnce([]); // upsert

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    const chunks = res._chunks
      .filter((c) => !c.includes('"ping"'))
      .map((c) => JSON.parse(c));
    const finalChunk = chunks.at(-1);
    expect(finalChunk.analyzed).toBe(1);
  });

  // ── Non-Error rejection ───────────────────────────────────
  it('handles non-Error rejection in concurrent plots', async () => {
    mockList.mockResolvedValueOnce({
      blobs: [
        makeBlobEntry('ml-plots/latest/good.png'),
        makeBlobEntry('ml-plots/latest/string_fail.png'),
      ],
    });
    mockDbFn.mockResolvedValueOnce([]); // no findings

    // First plot succeeds
    mockBlobGet.mockResolvedValueOnce(makeBlobGetResult());
    const analysisJson = JSON.stringify({ what_it_means: 'ok' });
    mockStream.mockReturnValueOnce(
      mockStreamReturn(makeFinalMessage(analysisJson)),
    );
    mockDbFn.mockResolvedValueOnce([]); // upsert

    // Second plot: rejects with a string, not Error
    mockBlobGet.mockRejectedValueOnce('string rejection');

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    const chunks = res._chunks
      .filter((c) => !c.includes('"ping"'))
      .map((c) => JSON.parse(c));
    const finalChunk = chunks.at(-1);
    expect(finalChunk.failed).toContain('string rejection');
  });

  // ── Top-level catch with non-Error ────────────────────────
  it('handles non-Error in top-level catch', async () => {
    mockList.mockRejectedValueOnce('not an error object');

    const req = makeAuthRequest();
    const res = mockResponse();
    await handler(req, res);

    const chunks = res._chunks
      .filter((c) => !c.includes('"ping"'))
      .map((c) => JSON.parse(c));
    const errorChunk = chunks.at(-1);
    expect(errorChunk.error).toBe('Plot analysis failed');
    expect(errorChunk.message).toBe('Unknown error');
  });
});
