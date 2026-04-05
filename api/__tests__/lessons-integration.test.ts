// @vitest-environment node

/**
 * Integration test: lessons learned pipeline.
 *
 * Verifies the end-to-end contract between modules:
 *   cron handler processes review → writes lesson to DB →
 *   analyze handler reads lessons → injects into system prompt.
 *
 * All external services (Neon, OpenAI, Anthropic) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ============================================================
// SHARED STATE — the "lesson" that flows through the pipeline
// ============================================================

const LESSON_TEXT = 'Charm walls above 5700 decayed by 1 PM — exit CCS early';
const LESSON_TAGS = ['charm', 'management'];
const LESSON_CATEGORY = 'gamma';
const LESSON_SOURCE_DATE = '2026-03-20';
const LESSON_ID = 42;

// ============================================================
// MOCKS — must be declared before handler imports
// vi.mock factories are hoisted; they cannot reference variables
// declared outside, so we use inline defaults and override via
// the imported mock references in beforeEach.
// ============================================================

// --- DB mock ---
const mockTransaction = vi.fn(async () => undefined);
const mockSql = Object.assign(
  vi.fn(async (): Promise<Record<string, unknown>[]> => []),
  { transaction: mockTransaction },
);
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  saveAnalysis: vi.fn().mockResolvedValue(undefined),
  saveSnapshot: vi.fn().mockResolvedValue(null),
  getLatestPositions: vi.fn().mockResolvedValue(null),
  getPreviousRecommendation: vi.fn().mockResolvedValue(null),
}));

// --- Lessons mock ---
vi.mock('../_lib/lessons.js', () => ({
  getActiveLessons: vi.fn().mockResolvedValue([]),
  formatLessonsBlock: vi.fn().mockReturnValue(''),
  upsertReport: vi.fn().mockResolvedValue(undefined),
  updateReport: vi.fn().mockResolvedValue(undefined),
  buildMarketConditions: vi.fn().mockReturnValue({
    vix: 18,
    vix1d: 15,
    spx: 5700,
    gexRegime: 'GREEN',
    structure: 'IRON CONDOR',
    dayOfWeek: 'Friday',
    wasCorrect: true,
    confidence: 'HIGH',
    vixTermShape: 'contango',
  }),
}));

// --- Embeddings mock ---
vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(2000).fill(0.1)),
  findSimilarLessons: vi.fn().mockResolvedValue([]),
}));

// --- API helpers mock (for analyze handler) ---
vi.mock('../_lib/api-helpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/api-helpers.js')>();
  return {
    ...actual,
    guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
    rejectIfNotOwner: vi.fn().mockReturnValue(false),
    rejectIfRateLimited: vi.fn().mockResolvedValue(false),
    checkBot: vi.fn().mockResolvedValue({ isBot: false }),
    respondIfInvalid: vi.fn().mockImplementation(
      (
        parsed: {
          success: boolean;
          error?: { issues: { message: string }[] };
        },
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
  };
});

// --- Logger mock ---
vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Sentry mock ---
const noopDone = vi.fn();
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => noopDone),
    schwabCall: vi.fn(() => vi.fn()),
    rateLimited: vi.fn(),
    tokenRefresh: vi.fn(),
    analyzeCall: vi.fn(),
    dbSave: vi.fn(),
    cacheResult: vi.fn(),
    distribution: vi.fn(),
  },
}));

// --- Validation mock (safeParse must return { success: true, data } with the body) ---
vi.mock('../_lib/validation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/validation.js')>();
  return {
    ...actual,
    analyzeBodySchema: {
      safeParse: vi.fn((input: unknown) => ({ success: true, data: input })),
    },
  };
});

// --- Anthropic SDK mock ---
// Cron handler uses `anthropic.messages.stream().finalMessage()`
// Analyze handler uses `anthropic.messages.stream().finalMessage()`
const mockCreate = vi.fn();
const mockFinalMessage = vi.fn();
const mockStream = vi.fn().mockReturnValue({ finalMessage: mockFinalMessage });

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    // Use getter — module-level `new Anthropic()` runs at import time,
    // before `mockCreate`/`mockStream` are initialized. Lazy access avoids the TDZ error.
    get messages() {
      return { create: mockCreate, stream: mockStream };
    }
  }
  class BadRequestError extends Error {
    status = 400;
    constructor(message = 'Bad request') {
      super(message);
      this.name = 'BadRequestError';
    }
  }
  class AuthenticationError extends Error {
    status = 401;
    constructor(message = 'Auth error') {
      super(message);
      this.name = 'AuthenticationError';
    }
  }
  class PermissionDeniedError extends Error {
    status = 403;
    constructor(message = 'Forbidden') {
      super(message);
      this.name = 'PermissionDeniedError';
    }
  }
  class RateLimitError extends Error {
    status = 429;
    constructor(message = 'Rate limited') {
      super(message);
      this.name = 'RateLimitError';
    }
  }
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'APIError';
    }
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

// ============================================================
// IMPORTS (after mocks)
// ============================================================

import cronHandler from '../cron/curate-lessons.js';
import analyzeHandler from '../analyze.js';
import {
  updateReport,
  getActiveLessons,
  formatLessonsBlock,
} from '../_lib/lessons.js';

// ============================================================
// HELPERS
// ============================================================

/** Build a mock analysis row (an unprocessed review) */
function makeReview() {
  return {
    id: 100,
    date: LESSON_SOURCE_DATE,
    full_response: {
      review: {
        lessonsLearned: [LESSON_TEXT],
        wasCorrect: true,
      },
    },
    snapshot_id: 10,
    spx: 5700,
    vix: 18,
    vix1d: 15,
    structure: 'IRON CONDOR',
    confidence: 'HIGH',
  };
}

/** Build a Claude curation response (for cron handler) */
function makeCurationResponse() {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          action: 'add',
          reason: 'New insight about charm wall decay and CCS exits',
          supersedes_id: null,
          tags: LESSON_TAGS,
          category: LESSON_CATEGORY,
        }),
      },
    ],
    usage: { input_tokens: 500, output_tokens: 100 },
  };
}

/** Build a Lesson object matching what getActiveLessons returns */
function makeLessonRecord() {
  return {
    id: LESSON_ID,
    text: LESSON_TEXT,
    sourceDate: LESSON_SOURCE_DATE,
    marketConditions: {
      vix: 18,
      structure: 'IRON CONDOR',
      gexRegime: 'GREEN',
    },
    tags: LESSON_TAGS,
    category: LESSON_CATEGORY,
  };
}

/** Build a formatted lessons block matching what formatLessonsBlock returns */
function makeLessonsBlock() {
  return [
    '<lessons_learned>',
    'Validated lessons from past trading sessions. Reference by number',
    "when applicable to today's setup. Do not force-apply lessons that",
    "don't match current conditions.",
    '',
    `[1] (${LESSON_SOURCE_DATE} | IRON CONDOR | VIX:18 | GEX:GREEN)`,
    LESSON_TEXT,
    `Tags: ${LESSON_TAGS.join(', ')}`,
    '</lessons_learned>',
  ].join('\n');
}

/** Minimal valid analyze request body */
function makeAnalyzeBody() {
  return {
    images: [{ data: 'base64data', mediaType: 'image/png' }],
    context: {
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
  reasoning: 'Charm walls holding through afternoon.',
  observations: ['NCP at +50M', 'NPP at -40M'],
  risks: ['VIX elevated above 20'],
  periscopeNotes: null,
  structureRationale: 'NCP ≈ NPP suggests balanced flow.',
};

// ============================================================
// TESTS
// ============================================================

describe('Lessons learned integration: cron → DB → analyze', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockReset().mockImplementation(async () => []);
    mockTransaction.mockReset().mockResolvedValue(undefined);
    mockSql.transaction = mockTransaction;
    mockCreate.mockReset();
    mockStream.mockReset().mockReturnValue({ finalMessage: mockFinalMessage });
    mockFinalMessage.mockReset();

    // Re-apply default mocks for the imported lesson helpers
    vi.mocked(getActiveLessons).mockResolvedValue([]);
    vi.mocked(formatLessonsBlock).mockReturnValue('');

    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // Silence console output during tests
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // ── Step 1: Cron handler processes review and creates a lesson ──

  it('cron handler processes a review and reports lessonsAdded: 1', async () => {
    const review = makeReview();

    // DB call sequence:
    //   1: active count → 5 active lessons
    //   2: reviews query → one unprocessed review
    //   3: snapshot fetch
    //   4: nextval → pre-allocated ID
    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return [{ count: 5 }];
      if (callCount === 3) return [review];
      if (callCount === 4)
        return [
          {
            id: 10,
            vix: 18,
            regime_zone: 'GREEN',
            dow_label: 'Friday',
            vix_term_signal: 'contango',
          },
        ];
      if (callCount === 5) return [{ id: LESSON_ID }];
      return [];
    });

    mockFinalMessage.mockResolvedValue(makeCurationResponse());

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    const res = mockResponse();
    await cronHandler(req, res);

    // Verify the handler reports the lesson was added via NDJSON stream
    expect(res._status).toBe(200);
    const completeEvent = res._chunks
      .map((c: string) => JSON.parse(c.trim()) as Record<string, unknown>)
      .find((e: Record<string, unknown>) => e.event === 'complete');
    expect(completeEvent).toEqual(
      expect.objectContaining({
        reviewsProcessed: 1,
        lessonsAdded: 1,
        lessonsSuperseded: 0,
        lessonsSkipped: 0,
      }),
    );

    // Verify a transaction was used for the write
    expect(mockTransaction).toHaveBeenCalledOnce();

    // Verify the report was updated with the correct lesson shape
    expect(updateReport).toHaveBeenCalledWith(
      expect.any(String), // weekEnding
      expect.objectContaining({
        lessonsAdded: 1,
        report: expect.objectContaining({
          added: expect.arrayContaining([
            expect.objectContaining({
              id: LESSON_ID,
              text: LESSON_TEXT,
              sourceDate: LESSON_SOURCE_DATE,
              tags: LESSON_TAGS,
              category: LESSON_CATEGORY,
            }),
          ]),
        }),
      }),
    );
  });

  // ── Step 2: Analyze handler injects the lesson into the system prompt ──

  it('analyze handler injects a lesson from the DB into the system prompt', async () => {
    // Simulate the lesson that the cron "wrote" being available in the DB
    const lesson = makeLessonRecord();
    vi.mocked(getActiveLessons).mockResolvedValue([lesson]);
    vi.mocked(formatLessonsBlock).mockReturnValue(makeLessonsBlock());

    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(SAMPLE_ANALYSIS) }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const req = mockRequest({
      method: 'POST',
      body: makeAnalyzeBody(),
    });
    const res = mockResponse();
    await analyzeHandler(req, res);

    expect(res._status).toBe(200);

    // Verify getActiveLessons was called
    expect(getActiveLessons).toHaveBeenCalledOnce();

    // Verify formatLessonsBlock received the lesson with the correct shape
    expect(formatLessonsBlock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: LESSON_ID,
        text: LESSON_TEXT,
        sourceDate: LESSON_SOURCE_DATE,
        tags: LESSON_TAGS,
        category: LESSON_CATEGORY,
      }),
    ]);

    // Verify lessons are injected as a separate (uncached) system block
    const streamParams = mockStream.mock.calls[0]![0];
    expect(streamParams.system).toHaveLength(2);
    // Block 0: stable prompt (cached), block 1: lessons (uncached)
    expect(streamParams.system[0].text).toContain(
      '</structure_selection_rules>',
    );
    expect(streamParams.system[0].text).toContain('<data_handling>');
    expect(streamParams.system[1].text).toContain('<lessons_learned>');
    expect(streamParams.system[1].text).toContain(LESSON_TEXT);
    expect(streamParams.system[1].text).toContain('</lessons_learned>');
  });

  // ── Contract verification: cron output shape matches analyze input shape ──

  it('the lesson shape written by cron matches what analyze reads', async () => {
    // Run the cron handler to capture what it "wrote"
    const review = makeReview();
    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return [{ count: 5 }];
      if (callCount === 3) return [review];
      if (callCount === 4)
        return [
          {
            id: 10,
            vix: 18,
            regime_zone: 'GREEN',
            dow_label: 'Friday',
            vix_term_signal: 'contango',
          },
        ];
      if (callCount === 5) return [{ id: LESSON_ID }];
      return [];
    });

    mockFinalMessage.mockResolvedValue(makeCurationResponse());

    const cronReq = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    const cronRes = mockResponse();
    await cronHandler(cronReq, cronRes);

    // Extract the lesson shape from the cron's report
    const reportCall = vi.mocked(updateReport).mock.calls[0]!;
    const reportData = reportCall[1] as unknown as {
      report: {
        added: Array<{
          id: number;
          text: string;
          sourceDate: string;
          tags: string[];
          category: string;
        }>;
      };
    };
    const addedLesson = reportData.report.added[0]!;

    // Verify the added lesson has all fields that getActiveLessons/formatLessonsBlock need
    expect(addedLesson).toHaveProperty('id');
    expect(addedLesson).toHaveProperty('text');
    expect(addedLesson).toHaveProperty('sourceDate');
    expect(addedLesson).toHaveProperty('tags');
    expect(addedLesson).toHaveProperty('category');

    // Now simulate the analyze handler reading this same lesson from the DB
    // The DB would return a Lesson with these fields plus marketConditions
    const lessonFromDb = {
      id: addedLesson.id,
      text: addedLesson.text,
      sourceDate: addedLesson.sourceDate,
      marketConditions: { vix: 18, structure: 'IRON CONDOR' },
      tags: addedLesson.tags,
      category: addedLesson.category,
    };

    vi.mocked(getActiveLessons).mockResolvedValue([lessonFromDb]);
    vi.mocked(formatLessonsBlock).mockReturnValue(makeLessonsBlock());

    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(SAMPLE_ANALYSIS) }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const analyzeReq = mockRequest({
      method: 'POST',
      body: makeAnalyzeBody(),
    });
    const analyzeRes = mockResponse();
    await analyzeHandler(analyzeReq, analyzeRes);

    expect(analyzeRes._status).toBe(200);

    // Verify that formatLessonsBlock was called with a lesson whose text matches
    // exactly what the cron handler wrote
    const lessonsArg = vi.mocked(formatLessonsBlock).mock
      .calls[0]![0] as Array<{
      text: string;
    }>;
    expect(lessonsArg[0]!.text).toBe(addedLesson.text);
    expect(lessonsArg[0]!.text).toBe(LESSON_TEXT);
  });

  // ── Verify no lessons results in no injection ──

  it('analyze handler omits lessons block when no lessons exist', async () => {
    vi.mocked(getActiveLessons).mockResolvedValue([]);
    vi.mocked(formatLessonsBlock).mockReturnValue('');

    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(SAMPLE_ANALYSIS) }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const req = mockRequest({
      method: 'POST',
      body: makeAnalyzeBody(),
    });
    const res = mockResponse();
    await analyzeHandler(req, res);

    expect(res._status).toBe(200);
    const streamParams = mockStream.mock.calls[0]![0];
    const systemText = streamParams.system[0].text;
    expect(systemText).not.toContain('<lessons_learned>');
    // The two prompt parts should still be present
    expect(systemText).toContain('</structure_selection_rules>');
    expect(systemText).toContain('<data_handling>');
  });
});
