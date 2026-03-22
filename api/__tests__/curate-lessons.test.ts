// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ============================================================
// MOCKS — must be declared before handler import
// ============================================================

const mockSql = vi.fn(async () => []);
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/lessons.js', () => ({
  insertLesson: vi.fn().mockResolvedValue(42),
  supersedeLesson: vi.fn().mockResolvedValue(43),
  upsertReport: vi.fn().mockResolvedValue(undefined),
  updateReport: vi.fn().mockResolvedValue(undefined),
  buildMarketConditions: vi.fn().mockReturnValue({ vix: 18, structure: 'IC' }),
}));

vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
  findSimilarLessons: vi.fn().mockResolvedValue([]),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

// ============================================================
// IMPORTS (after mocks)
// ============================================================

import handler from '../cron/curate-lessons.js';
import { insertLesson, supersedeLesson, upsertReport, updateReport } from '../_lib/lessons.js';
import { generateEmbedding, findSimilarLessons } from '../_lib/embeddings.js';

// ============================================================
// HELPERS
// ============================================================

/** Build a mock analysis row with lessons learned */
function makeReview(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 100,
    date: '2026-03-20',
    full_response: {
      review: {
        lessonsLearned: ['VIX above 25 means widen wings by 2 delta'],
        wasCorrect: true,
      },
    },
    snapshot_id: 10,
    spx: 5700,
    vix: 18,
    vix1d: 15,
    structure: 'IRON CONDOR',
    confidence: 'HIGH',
    ...overrides,
  };
}

/** Build a Claude curation response */
function makeCurationResponse(decision: Record<string, unknown>) {
  return {
    content: [
      { type: 'text', text: JSON.stringify(decision) },
    ],
    usage: { input_tokens: 500, output_tokens: 100 },
  };
}

function makeAddDecision(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    action: 'add',
    reason: 'New unique insight about VIX and wing width',
    supersedes_id: null,
    tags: ['vix', 'wing-width'],
    category: 'sizing',
    ...overrides,
  };
}

function makeAuthedRequest() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-cron-secret' },
  });
}

// ============================================================
// TESTS
// ============================================================

describe('GET /api/cron/curate-lessons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockReset().mockImplementation(async () => []);
    mockCreate.mockReset();
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // Re-apply default mocks (clearAllMocks only clears history, not implementations,
    // but mockReset above clears implementations too for mockSql/mockCreate)
    vi.mocked(insertLesson).mockResolvedValue(42);
    vi.mocked(supersedeLesson).mockResolvedValue(43);
    vi.mocked(upsertReport).mockResolvedValue(undefined);
    vi.mocked(updateReport).mockResolvedValue(undefined);
    vi.mocked(generateEmbedding).mockResolvedValue(new Array(1536).fill(0.1));
    vi.mocked(findSimilarLessons).mockResolvedValue([]);
  });

  // ── Auth & Method ──────────────────────────────────────────

  it('returns 401 without correct Authorization header', async () => {
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when Authorization header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  it('returns 405 for POST requests', async () => {
    const req = mockRequest({
      method: 'POST',
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  // ── No reviews path ────────────────────────────────────────

  it('returns 200 with reviewsProcessed: 0 when no unprocessed reviews', async () => {
    // First call is the snapshot query (may not happen), second is the reviews query
    // The SQL tagged template is a function that returns rows — mock returns empty
    mockSql.mockImplementation(async () => []);

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ reviewsProcessed: 0 });
    expect(upsertReport).toHaveBeenCalledOnce();
    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reviewsProcessed: 0 }),
    );
  });

  // ── Full processing — ADD action ───────────────────────────

  it('processes a review and adds a lesson via ADD action', async () => {
    const review = makeReview();

    // First SQL call: reviews query returns our review
    // Second SQL call: snapshot fetch
    // Third SQL call: fetch old lesson text (won't happen for ADD)
    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [review]; // reviews query
      if (callCount === 2) return [{ id: 10, vix: 18, regime_zone: 'GREEN', dow_label: 'Friday', vix_term_signal: 'contango' }]; // snapshot
      return [];
    });

    mockCreate.mockResolvedValue(makeCurationResponse(makeAddDecision()));

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual(expect.objectContaining({
      reviewsProcessed: 1,
      lessonsAdded: 1,
      lessonsSuperseded: 0,
      lessonsSkipped: 0,
    }));

    expect(insertLesson).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'VIX above 25 means widen wings by 2 delta',
        tags: ['vix', 'wing-width'],
        category: 'sizing',
        sourceAnalysisId: 100,
      }),
    );

    // Report should show the addition
    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lessonsAdded: 1,
        report: expect.objectContaining({
          added: expect.arrayContaining([
            expect.objectContaining({
              id: 42,
              text: 'VIX above 25 means widen wings by 2 delta',
            }),
          ]),
        }),
      }),
    );
  });

  // ── Full processing — SUPERSEDE action ─────────────────────

  it('processes a review and supersedes a lesson via SUPERSEDE action', async () => {
    const review = makeReview();

    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [review]; // reviews query
      if (callCount === 2) return [{ id: 10 }]; // snapshot
      if (callCount === 3) return [{ text: 'Old lesson about VIX' }]; // old lesson text
      return [];
    });

    const supersedeDecision = {
      action: 'supersede',
      reason: 'More specific than existing lesson',
      supersedes_id: 5,
      tags: ['vix', 'wing-width'],
      category: 'sizing',
    };
    mockCreate.mockResolvedValue(makeCurationResponse(supersedeDecision));

    vi.mocked(findSimilarLessons).mockResolvedValue([
      { id: 5, text: 'Old lesson about VIX', tags: ['vix'], category: 'sizing', sourceDate: '2026-03-10' },
    ]);

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual(expect.objectContaining({
      lessonsSuperseded: 1,
      lessonsAdded: 0,
    }));

    expect(supersedeLesson).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'VIX above 25 means widen wings by 2 delta',
        tags: ['vix', 'wing-width'],
        category: 'sizing',
      }),
      5,
    );

    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        report: expect.objectContaining({
          superseded: expect.arrayContaining([
            expect.objectContaining({
              id: 5,
              supersededBy: 43,
              reason: 'More specific than existing lesson',
            }),
          ]),
        }),
      }),
    );
  });

  // ── Full processing — SKIP action ──────────────────────────

  it('processes a review and skips a duplicate lesson via SKIP action', async () => {
    const review = makeReview();

    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [review];
      if (callCount === 2) return [{ id: 10 }];
      return [];
    });

    const skipDecision = {
      action: 'skip',
      reason: 'Near-exact duplicate of existing lesson #5',
      supersedes_id: 5,
      tags: ['vix'],
      category: 'sizing',
    };
    mockCreate.mockResolvedValue(makeCurationResponse(skipDecision));

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual(expect.objectContaining({
      lessonsSkipped: 1,
      lessonsAdded: 0,
      lessonsSuperseded: 0,
    }));

    // No DB write for SKIP
    expect(insertLesson).not.toHaveBeenCalled();
    expect(supersedeLesson).not.toHaveBeenCalled();

    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        report: expect.objectContaining({
          skipped: expect.arrayContaining([
            expect.objectContaining({
              text: 'VIX above 25 means widen wings by 2 delta',
              reason: 'Near-exact duplicate of existing lesson #5',
              existingId: 5,
            }),
          ]),
        }),
      }),
    );
  });

  // ── Embedding failure ──────────────────────────────────────

  it('records error when embedding generation fails', async () => {
    const review = makeReview();

    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [review];
      if (callCount === 2) return [{ id: 10 }];
      return [];
    });

    vi.mocked(generateEmbedding).mockResolvedValue(null);

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // No Claude call should have been made
    expect(mockCreate).not.toHaveBeenCalled();
    // No DB writes
    expect(insertLesson).not.toHaveBeenCalled();

    // Error recorded in report
    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        report: expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({
              text: 'VIX above 25 means widen wings by 2 delta',
              error: 'Embedding generation failed',
              sourceAnalysisId: 100,
            }),
          ]),
        }),
      }),
    );
  });

  // ── Malformed Claude response ──────────────────────────────

  it('treats malformed Claude response as error and records it', async () => {
    const review = makeReview();

    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [review];
      if (callCount === 2) return [{ id: 10 }];
      return [];
    });

    // Return non-JSON garbage
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'This is not valid JSON at all' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(insertLesson).not.toHaveBeenCalled();

    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        report: expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({
              text: 'VIX above 25 means widen wings by 2 delta',
              error: 'Malformed Claude response',
              sourceAnalysisId: 100,
            }),
          ]),
        }),
      }),
    );
  });

  it('treats Claude response with invalid action as error', async () => {
    const review = makeReview();

    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [review];
      if (callCount === 2) return [{ id: 10 }];
      return [];
    });

    // Return valid JSON but invalid action
    mockCreate.mockResolvedValue(makeCurationResponse({
      action: 'merge', // invalid
      reason: 'Merging lessons',
      supersedes_id: null,
      tags: ['vix'],
      category: 'sizing',
    }));

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(insertLesson).not.toHaveBeenCalled();

    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        report: expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({
              error: 'Malformed Claude response',
            }),
          ]),
        }),
      }),
    );
  });

  // ── Transaction failure ────────────────────────────────────

  it('records error but continues when DB write fails', async () => {
    const review1 = makeReview({ id: 100 });
    const review2 = makeReview({
      id: 200,
      full_response: {
        review: {
          lessonsLearned: ['Always check gamma exposure before entry'],
          wasCorrect: false,
        },
      },
    });

    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [review1, review2]; // reviews query
      if (callCount === 2) return [{ id: 10 }]; // snapshot for review1
      if (callCount === 3) return [{ id: 11 }]; // snapshot for review2
      return [];
    });

    mockCreate.mockResolvedValue(makeCurationResponse(makeAddDecision()));

    // First insertLesson throws, second succeeds
    vi.mocked(insertLesson)
      .mockRejectedValueOnce(new Error('DB connection lost'))
      .mockResolvedValueOnce(44);

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Second review should still have been processed
    expect(res._json).toEqual(expect.objectContaining({
      reviewsProcessed: 2,
    }));

    // insertLesson called twice (once per review)
    expect(insertLesson).toHaveBeenCalledTimes(2);

    // Report should have both error and success
    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        report: expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({
              error: 'DB connection lost',
            }),
          ]),
          added: expect.arrayContaining([
            expect.objectContaining({ id: 44 }),
          ]),
        }),
      }),
    );
  });
});

// ============================================================
// getPrecedingFriday unit tests
// ============================================================

describe('getPrecedingFriday', () => {
  it('returns previous Friday when run on Saturday', async () => {
    const { getPrecedingFriday } = await import('../cron/curate-lessons.js');

    // Mock system time to Saturday March 21, 2026 3:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T03:00:00Z'));

    const result = getPrecedingFriday();
    expect(result).toBe('2026-03-20');

    vi.useRealTimers();
  });

  it('returns previous Friday when run on a Wednesday', async () => {
    const { getPrecedingFriday } = await import('../cron/curate-lessons.js');

    // Mock system time to Wednesday March 18, 2026 12:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-18T12:00:00Z'));

    const result = getPrecedingFriday();
    expect(result).toBe('2026-03-13');

    vi.useRealTimers();
  });

  it('returns same day when run on a Friday', async () => {
    const { getPrecedingFriday } = await import('../cron/curate-lessons.js');

    // Mock system time to Friday March 20, 2026 15:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T15:00:00Z'));

    // On Friday itself, the "preceding Friday" should be last Friday (7 days ago)
    // since (5+2)%7 = 0, fallback to 7
    const result = getPrecedingFriday();
    expect(result).toBe('2026-03-13');

    vi.useRealTimers();
  });
});
