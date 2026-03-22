// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ============================================================
// MOCKS — must be declared before handler import
// ============================================================

const mockTransaction = vi.fn(async () => undefined);
const mockSql = Object.assign(
  vi.fn(async (): Promise<Record<string, unknown>[]> => []),
  { transaction: mockTransaction },
);
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/lessons.js', () => ({
  upsertReport: vi.fn().mockResolvedValue(undefined),
  updateReport: vi.fn().mockResolvedValue(undefined),
  buildMarketConditions: vi.fn().mockReturnValue({ vix: 18, structure: 'IC' }),
}));

vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(2000).fill(0.1)),
  findSimilarLessons: vi.fn().mockResolvedValue([]),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const mockCreate = vi.fn();
const mockStream = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      create: mockCreate,
      stream: mockStream,
    };
  }
  return { default: MockAnthropic };
});

// ============================================================
// IMPORTS (after mocks)
// ============================================================

import handler from '../cron/curate-lessons.js';
import { upsertReport, updateReport } from '../_lib/lessons.js';
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
    content: [{ type: 'text', text: JSON.stringify(decision) }],
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

/** Configure mockStream to resolve with the given response from finalMessage() */
function mockStreamResponse(response: Record<string, unknown>) {
  mockStream.mockReturnValue({
    finalMessage: vi.fn().mockResolvedValue(response),
  });
}

/** Parse NDJSON chunks and return the 'complete' event */
function getCompleteEvent(res: ReturnType<typeof mockResponse>) {
  for (const chunk of res._chunks) {
    const parsed = JSON.parse(chunk.trim()) as Record<string, unknown>;
    if (parsed.event === 'complete') return parsed;
  }
  return null;
}

function makeAuthedRequest(query: Record<string, string> = {}) {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-cron-secret' },
    query,
  });
}

// ============================================================
// TESTS
// ============================================================

describe('GET /api/cron/curate-lessons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockReset().mockImplementation(async () => []);
    mockTransaction.mockReset().mockResolvedValue(undefined);
    // Re-attach transaction after mockReset (mockReset only resets the call function)
    mockSql.transaction = mockTransaction;
    mockCreate.mockReset();
    mockStream.mockReset();
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // Re-apply default mocks
    vi.mocked(upsertReport).mockResolvedValue(undefined);
    vi.mocked(updateReport).mockResolvedValue(undefined);
    vi.mocked(generateEmbedding).mockResolvedValue(new Array(2000).fill(0.1));
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
    // Call 1: active count query, Call 2: reviews query (empty)
    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [{ count: 12 }]; // active count
      return []; // reviews query returns empty
    });

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

  it('sets unchanged to active lesson count in no-reviews path', async () => {
    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [{ count: 7 }]; // 7 active lessons
      return []; // no reviews
    });

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        report: expect.objectContaining({
          unchanged: 7,
        }),
      }),
    );
  });

  // ── Backfill mode ──────────────────────────────────────────

  it('skips the 7-day date filter when backfill=true', async () => {
    const review = makeReview();
    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [{ count: 0 }]; // active count
      if (callCount === 2) return [review]; // reviews query (no date filter)
      if (callCount === 3) return [{ id: 10 }]; // snapshot
      if (callCount === 4) return [{ id: 42 }]; // nextval
      return [];
    });

    mockStreamResponse(makeCurationResponse(makeAddDecision()));

    const req = makeAuthedRequest({ backfill: 'true' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(getCompleteEvent(res)).toEqual(
      expect.objectContaining({ reviewsProcessed: 1, lessonsAdded: 1 }),
    );
  });

  // ── Full processing — ADD action ───────────────────────────

  it('processes a review and adds a lesson via ADD action', async () => {
    const review = makeReview();

    // Call 1: active count
    // Call 2: reviews query
    // Call 3: snapshot fetch
    // Call 4: nextval (pre-allocate ID)
    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [{ count: 5 }]; // active count
      if (callCount === 2) return [review]; // reviews query
      if (callCount === 3)
        return [
          {
            id: 10,
            vix: 18,
            regime_zone: 'GREEN',
            dow_label: 'Friday',
            vix_term_signal: 'contango',
          },
        ]; // snapshot
      if (callCount === 4) return [{ id: 42 }]; // nextval
      return [];
    });

    mockStreamResponse(makeCurationResponse(makeAddDecision()));

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(getCompleteEvent(res)).toEqual(
      expect.objectContaining({
        reviewsProcessed: 1,
        lessonsAdded: 1,
        lessonsSuperseded: 0,
        lessonsSkipped: 0,
      }),
    );

    // Transaction should have been called with the INSERT statement
    expect(mockTransaction).toHaveBeenCalledOnce();

    // Report should show the addition with the pre-allocated ID
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
          unchanged: 5, // activeCountBefore(5) - superseded(0)
        }),
      }),
    );
  });

  // ── Full processing — SUPERSEDE action ─────────────────────

  it('processes a review and supersedes a lesson via SUPERSEDE action', async () => {
    const review = makeReview();

    // Call 1: active count
    // Call 2: reviews query
    // Call 3: snapshot
    // Call 4: nextval
    // Call 5: old lesson text fetch
    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [{ count: 10 }]; // active count
      if (callCount === 2) return [review]; // reviews query
      if (callCount === 3) return [{ id: 10 }]; // snapshot
      if (callCount === 4) return [{ id: 43 }]; // nextval
      if (callCount === 5) return [{ text: 'Old lesson about VIX' }]; // old lesson text
      return [];
    });

    const supersedeDecision = {
      action: 'supersede',
      reason: 'More specific than existing lesson',
      supersedes_id: 5,
      tags: ['vix', 'wing-width'],
      category: 'sizing',
    };
    mockStreamResponse(makeCurationResponse(supersedeDecision));

    vi.mocked(findSimilarLessons).mockResolvedValue([
      {
        id: 5,
        text: 'Old lesson about VIX',
        tags: ['vix'],
        category: 'sizing',
        sourceDate: '2026-03-10',
      },
    ]);

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(getCompleteEvent(res)).toEqual(
      expect.objectContaining({
        lessonsSuperseded: 1,
        lessonsAdded: 0,
      }),
    );

    // Transaction should have been called (INSERT + UPDATE batched)
    expect(mockTransaction).toHaveBeenCalledOnce();

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
          unchanged: 9, // activeCountBefore(10) - superseded(1)
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
      if (callCount === 1) return [{ count: 5 }]; // active count
      if (callCount === 2) return [review];
      if (callCount === 3) return [{ id: 10 }]; // snapshot
      return [];
    });

    const skipDecision = {
      action: 'skip',
      reason: 'Near-exact duplicate of existing lesson #5',
      supersedes_id: 5,
      tags: ['vix'],
      category: 'sizing',
    };
    mockStreamResponse(makeCurationResponse(skipDecision));

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(getCompleteEvent(res)).toEqual(
      expect.objectContaining({
        lessonsSkipped: 1,
        lessonsAdded: 0,
        lessonsSuperseded: 0,
      }),
    );

    // No transaction for SKIP-only
    expect(mockTransaction).not.toHaveBeenCalled();

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
      if (callCount === 1) return [{ count: 3 }]; // active count
      if (callCount === 2) return [review];
      if (callCount === 3) return [{ id: 10 }]; // snapshot
      return [];
    });

    vi.mocked(generateEmbedding).mockResolvedValue(null);

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // No Claude call should have been made
    expect(mockStream).not.toHaveBeenCalled();
    // No transaction
    expect(mockTransaction).not.toHaveBeenCalled();

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
      if (callCount === 1) return [{ count: 0 }]; // active count
      if (callCount === 2) return [review];
      if (callCount === 3) return [{ id: 10 }]; // snapshot
      return [];
    });

    // Return non-JSON garbage
    mockStreamResponse({
      content: [{ type: 'text', text: 'This is not valid JSON at all' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockTransaction).not.toHaveBeenCalled();

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
      if (callCount === 1) return [{ count: 0 }]; // active count
      if (callCount === 2) return [review];
      if (callCount === 3) return [{ id: 10 }]; // snapshot
      return [];
    });

    // Return valid JSON but invalid action
    mockStreamResponse(
      makeCurationResponse({
        action: 'merge', // invalid
        reason: 'Merging lessons',
        supersedes_id: null,
        tags: ['vix'],
        category: 'sizing',
      }),
    );

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockTransaction).not.toHaveBeenCalled();

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

  it('records error but continues when transaction fails for a review', async () => {
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

    // Call 1: active count
    // Call 2: reviews query (returns both reviews)
    // Call 3: snapshot for review1
    // Call 4: nextval for review1
    // Call 5: tx INSERT statement build for review1 (passed to transaction)
    // Call 6: snapshot for review2
    // Call 7: nextval for review2
    // Call 8: tx INSERT statement build for review2 (passed to transaction)
    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [{ count: 5 }]; // active count
      if (callCount === 2) return [review1, review2]; // reviews query
      if (callCount === 3) return [{ id: 10 }]; // snapshot for review1
      if (callCount === 4) return [{ id: 42 }]; // nextval for review1
      // Call 5: tx INSERT statement (return value unused)
      if (callCount === 6) return [{ id: 11 }]; // snapshot for review2
      if (callCount === 7) return [{ id: 44 }]; // nextval for review2
      // Call 8: tx INSERT statement (return value unused)
      return [];
    });

    mockStreamResponse(makeCurationResponse(makeAddDecision()));

    // First transaction throws, second succeeds
    mockTransaction
      .mockRejectedValueOnce(new Error('DB connection lost'))
      .mockResolvedValueOnce(undefined);

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Both reviews should still have been processed
    expect(getCompleteEvent(res)).toEqual(
      expect.objectContaining({
        reviewsProcessed: 2,
      }),
    );

    // Transaction called twice (once per review)
    expect(mockTransaction).toHaveBeenCalledTimes(2);

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
          added: expect.arrayContaining([expect.objectContaining({ id: 44 })]),
        }),
      }),
    );
  });

  // ── Per-review atomicity ───────────────────────────────────

  it('rolls back all lesson writes for a review when transaction fails', async () => {
    // A review with two lessons — if the transaction fails, neither should appear in added
    const review = makeReview({
      id: 100,
      full_response: {
        review: {
          lessonsLearned: [
            'VIX above 25 means widen wings by 2 delta',
            'Check gamma exposure before 2pm entries',
          ],
          wasCorrect: true,
        },
      },
    });

    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [{ count: 5 }]; // active count
      if (callCount === 2) return [review]; // reviews query
      if (callCount === 3) return [{ id: 10 }]; // snapshot
      if (callCount === 4) return [{ id: 42 }]; // nextval for lesson 1
      if (callCount === 5) return [{ id: 43 }]; // nextval for lesson 2
      return [];
    });

    // Both lessons get ADD decisions
    mockStreamResponse(makeCurationResponse(makeAddDecision()));

    // Transaction fails — all writes for this review should be rolled back
    mockTransaction.mockRejectedValueOnce(new Error('Constraint violation'));

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);

    // No lessons should have been added (transaction rolled back)
    expect(getCompleteEvent(res)).toEqual(
      expect.objectContaining({
        lessonsAdded: 0,
        errors: 1,
      }),
    );

    // The report should have zero added and contain the error
    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lessonsAdded: 0,
        report: expect.objectContaining({
          added: [],
          errors: expect.arrayContaining([
            expect.objectContaining({
              error: 'Constraint violation',
              sourceAnalysisId: 100,
            }),
          ]),
        }),
      }),
    );
  });

  // ── Unchanged count in full processing ─────────────────────

  it('computes unchanged as activeCountBefore minus lessonsSuperseded', async () => {
    const review = makeReview();

    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [{ count: 20 }]; // 20 active lessons before
      if (callCount === 2) return [review]; // reviews query
      if (callCount === 3) return [{ id: 10 }]; // snapshot
      if (callCount === 4) return [{ id: 50 }]; // nextval
      if (callCount === 5) return [{ text: 'Old lesson' }]; // old lesson text
      return [];
    });

    const supersedeDecision = {
      action: 'supersede',
      reason: 'More detailed',
      supersedes_id: 5,
      tags: ['vix'],
      category: 'sizing',
    };
    mockStreamResponse(makeCurationResponse(supersedeDecision));

    vi.mocked(findSimilarLessons).mockResolvedValue([
      {
        id: 5,
        text: 'Old lesson',
        tags: ['vix'],
        category: 'sizing',
        sourceDate: '2026-03-10',
      },
    ]);

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // unchanged = 20 (before) - 1 (superseded) = 19
    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        report: expect.objectContaining({
          unchanged: 19,
        }),
      }),
    );
  });

  it('sets unchanged equal to activeCountBefore when only ADD actions occur', async () => {
    const review = makeReview();

    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [{ count: 15 }]; // 15 active lessons
      if (callCount === 2) return [review];
      if (callCount === 3) return [{ id: 10 }]; // snapshot
      if (callCount === 4) return [{ id: 42 }]; // nextval
      return [];
    });

    mockStreamResponse(makeCurationResponse(makeAddDecision()));

    const req = makeAuthedRequest();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // unchanged = 15 - 0 superseded = 15
    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        report: expect.objectContaining({
          unchanged: 15,
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
