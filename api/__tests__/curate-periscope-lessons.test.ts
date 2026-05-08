// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ============================================================
// MOCKS — must be declared before handler import
// ============================================================

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn((req, res) => {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization ?? '';
    if (!secret || authHeader !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    const now = new Date();
    return {
      apiKey: '',
      today: now.toISOString().slice(0, 10),
    };
  }),
}));

// withCronCheckin should pass-through the inner handler so its body runs
// directly. The real wrapper short-circuits the Sentry checkin path when
// `Sentry.captureCheckIn` is unavailable (which it is in this mock-suite).
vi.mock('../_lib/cron-instrumentation.js', () => ({
  withCronCheckin: vi.fn((_name: string, fn: unknown) => fn),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../_lib/periscope-lessons.js', () => ({
  fetchUnprocessedDebriefs: vi.fn(),
  extractCandidatesViaRegex: vi.fn(),
  extractCandidatesViaLLM: vi.fn(),
  dedupCandidatesInBatch: vi.fn(),
  upsertLesson: vi.fn(),
}));

// ============================================================
// IMPORTS (after mocks)
// ============================================================

import handler from '../cron/curate-periscope-lessons.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import {
  fetchUnprocessedDebriefs,
  extractCandidatesViaRegex,
  extractCandidatesViaLLM,
  dedupCandidatesInBatch,
  upsertLesson,
} from '../_lib/periscope-lessons.js';
import { Sentry } from '../_lib/sentry.js';

// ============================================================
// HELPERS
// ============================================================

function authedReq(query: Record<string, string> = {}) {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-cron-secret' },
    query,
  });
}

const EMBEDDING = new Array(1536).fill(0.1);

interface DebriefShape {
  id: number;
  prose_text: string;
}

function debrief(id: number, prose = 'placeholder prose text'): DebriefShape {
  return { id, prose_text: prose };
}

// ============================================================
// TESTS
// ============================================================

describe('GET /api/cron/curate-periscope-lessons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-cron-secret';

    // Sensible defaults — individual tests override as needed
    vi.mocked(fetchUnprocessedDebriefs).mockResolvedValue([]);
    vi.mocked(extractCandidatesViaRegex).mockReturnValue([]);
    vi.mocked(extractCandidatesViaLLM).mockResolvedValue([]);
    vi.mocked(generateEmbedding).mockResolvedValue(EMBEDDING);
    vi.mocked(dedupCandidatesInBatch).mockImplementation((batch) =>
      batch.map((c) => ({
        lessonText: c.lessonText,
        embedding: c.embedding,
        sourceIds: [c.debriefId],
      })),
    );
    vi.mocked(upsertLesson).mockResolvedValue({
      inserted: true,
      lessonId: 1,
    });
  });

  // ── Auth ───────────────────────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
    expect(fetchUnprocessedDebriefs).not.toHaveBeenCalled();
  });

  // ── ?since= validation ─────────────────────────────────────

  it('returns 400 when ?since= is malformed', async () => {
    const req = authedReq({ since: '2026-XX-XX' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({
      error: 'Invalid ?since= value. Use YYYY-MM-DD or a full ISO timestamp.',
    });
    expect(fetchUnprocessedDebriefs).not.toHaveBeenCalled();
  });

  it('defaults sinceIso to ~7 days ago when ?since= is absent', async () => {
    const req = authedReq();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(fetchUnprocessedDebriefs).toHaveBeenCalledTimes(1);
    const sinceIsoArg = vi.mocked(fetchUnprocessedDebriefs).mock.calls[0]![0];
    expect(sinceIsoArg).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const sinceMs = new Date(sinceIsoArg).getTime();
    const expectedMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // Allow a generous wall-clock window (handler ran <1s before this check).
    expect(Math.abs(sinceMs - expectedMs)).toBeLessThan(60_000);
  });

  it('resolves ?since=YYYY-MM-DD to UTC midnight ISO', async () => {
    const req = authedReq({ since: '2026-05-01' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(fetchUnprocessedDebriefs).toHaveBeenCalledWith(
      '2026-05-01T00:00:00.000Z',
    );
    expect((res._json as { sinceIso: string }).sinceIso).toBe(
      '2026-05-01T00:00:00.000Z',
    );
  });

  it('accepts a full ISO timestamp in ?since=', async () => {
    const req = authedReq({ since: '2026-05-01T12:00:00Z' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // The Date constructor normalizes "Z" to ".000Z" — assert pass-through
    // by parsing both sides back to ms.
    const arg = vi.mocked(fetchUnprocessedDebriefs).mock.calls[0]![0];
    expect(new Date(arg).toISOString()).toBe('2026-05-01T12:00:00.000Z');
  });

  it('treats an empty ?since= string as default (~7d ago)', async () => {
    const req = authedReq({ since: '' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(fetchUnprocessedDebriefs).toHaveBeenCalledTimes(1);
    const sinceIsoArg = vi.mocked(fetchUnprocessedDebriefs).mock.calls[0]![0];
    expect(sinceIsoArg).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ── No debriefs ────────────────────────────────────────────

  it('returns 200 with zero counters when no debriefs to scan', async () => {
    vi.mocked(fetchUnprocessedDebriefs).mockResolvedValueOnce([]);

    const req = authedReq();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual(
      expect.objectContaining({
        ok: true,
        debriefsScanned: 0,
        candidates: 0,
        inserted: 0,
        merged: 0,
        embedFailures: 0,
        dryRun: false,
      }),
    );
    expect(extractCandidatesViaRegex).not.toHaveBeenCalled();
    expect(extractCandidatesViaLLM).not.toHaveBeenCalled();
    expect(upsertLesson).not.toHaveBeenCalled();
  });

  // ── Happy path: regex extraction + mixed insert/merge ─────

  it('extracts via regex and reports 1 inserted + 1 merged', async () => {
    vi.mocked(fetchUnprocessedDebriefs).mockResolvedValueOnce([debrief(11)]);
    vi.mocked(extractCandidatesViaRegex).mockReturnValueOnce([
      'lesson A',
      'lesson B',
    ]);
    vi.mocked(upsertLesson)
      .mockResolvedValueOnce({ inserted: true, lessonId: 100 })
      .mockResolvedValueOnce({ inserted: false, lessonId: 200 });

    const req = authedReq();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual(
      expect.objectContaining({
        ok: true,
        debriefsScanned: 1,
        candidates: 2,
        inserted: 1,
        merged: 1,
        embedFailures: 0,
        dryRun: false,
      }),
    );
    // Regex hit, so LLM fallback must not have been invoked.
    expect(extractCandidatesViaLLM).not.toHaveBeenCalled();
    expect(generateEmbedding).toHaveBeenCalledTimes(2);
    expect(upsertLesson).toHaveBeenCalledTimes(2);
  });

  // ── LLM fallback path ─────────────────────────────────────

  it('falls back to LLM when regex returns no candidates', async () => {
    vi.mocked(fetchUnprocessedDebriefs).mockResolvedValueOnce([debrief(22)]);
    vi.mocked(extractCandidatesViaRegex).mockReturnValueOnce([]);
    vi.mocked(extractCandidatesViaLLM).mockResolvedValueOnce(['llm lesson']);
    vi.mocked(upsertLesson).mockResolvedValueOnce({
      inserted: true,
      lessonId: 7,
    });

    const req = authedReq();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(extractCandidatesViaLLM).toHaveBeenCalledTimes(1);
    expect(generateEmbedding).toHaveBeenCalledWith('llm lesson');
    expect(upsertLesson).toHaveBeenCalledTimes(1);
    expect(res._json).toEqual(
      expect.objectContaining({
        candidates: 1,
        inserted: 1,
        merged: 0,
      }),
    );
  });

  // ── No candidates anywhere ────────────────────────────────

  it('skips a debrief when both regex and LLM return zero candidates', async () => {
    vi.mocked(fetchUnprocessedDebriefs).mockResolvedValueOnce([debrief(33)]);
    vi.mocked(extractCandidatesViaRegex).mockReturnValueOnce([]);
    vi.mocked(extractCandidatesViaLLM).mockResolvedValueOnce([]);

    const req = authedReq();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(upsertLesson).not.toHaveBeenCalled();
    expect(res._json).toEqual(
      expect.objectContaining({
        debriefsScanned: 1,
        candidates: 0,
        inserted: 0,
        merged: 0,
      }),
    );
  });

  // ── Embedding failures ────────────────────────────────────

  it('counts an embedFailure when generateEmbedding returns null', async () => {
    vi.mocked(fetchUnprocessedDebriefs).mockResolvedValueOnce([debrief(44)]);
    vi.mocked(extractCandidatesViaRegex).mockReturnValueOnce(['lesson']);
    vi.mocked(generateEmbedding).mockResolvedValueOnce(null);

    const req = authedReq();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual(
      expect.objectContaining({
        candidates: 1,
        embedFailures: 1,
        inserted: 0,
        merged: 0,
      }),
    );
    expect(upsertLesson).not.toHaveBeenCalled();
  });

  it('counts an embedFailure when generateEmbedding returns an empty array', async () => {
    vi.mocked(fetchUnprocessedDebriefs).mockResolvedValueOnce([debrief(45)]);
    vi.mocked(extractCandidatesViaRegex).mockReturnValueOnce(['lesson']);
    vi.mocked(generateEmbedding).mockResolvedValueOnce([]);

    const req = authedReq();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual(
      expect.objectContaining({
        candidates: 1,
        embedFailures: 1,
      }),
    );
    expect(upsertLesson).not.toHaveBeenCalled();
  });

  // ── Dry-run ───────────────────────────────────────────────

  it('skips upsertLesson and reports dryRun:true when ?dry=true', async () => {
    vi.mocked(fetchUnprocessedDebriefs).mockResolvedValueOnce([debrief(55)]);
    vi.mocked(extractCandidatesViaRegex).mockReturnValueOnce(['lesson']);

    const req = authedReq({ dry: 'true' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(upsertLesson).not.toHaveBeenCalled();
    expect(res._json).toEqual(
      expect.objectContaining({
        dryRun: true,
        candidates: 1,
        inserted: 0,
        merged: 0,
      }),
    );
  });

  // ── In-batch dedup ────────────────────────────────────────

  it('only upserts the surviving candidates after in-batch dedup', async () => {
    vi.mocked(fetchUnprocessedDebriefs).mockResolvedValueOnce([debrief(66)]);
    vi.mocked(extractCandidatesViaRegex).mockReturnValueOnce(['a', 'b', 'c']);
    // Simulate dedup collapsing 3 candidates → 2 survivors
    vi.mocked(dedupCandidatesInBatch).mockImplementationOnce((batch) => [
      {
        lessonText: batch[0]!.lessonText,
        embedding: batch[0]!.embedding,
        sourceIds: [batch[0]!.debriefId],
      },
      {
        lessonText: batch[2]!.lessonText,
        embedding: batch[2]!.embedding,
        sourceIds: [batch[2]!.debriefId],
      },
    ]);

    const req = authedReq();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(upsertLesson).toHaveBeenCalledTimes(2);
    expect(res._json).toEqual(
      expect.objectContaining({
        candidates: 3,
        inserted: 2,
        merged: 0,
      }),
    );
  });

  // ── upsertLesson error handling ───────────────────────────

  it('continues processing remaining survivors when one upsertLesson throws', async () => {
    vi.mocked(fetchUnprocessedDebriefs).mockResolvedValueOnce([debrief(77)]);
    vi.mocked(extractCandidatesViaRegex).mockReturnValueOnce(['x', 'y']);
    vi.mocked(upsertLesson)
      .mockResolvedValueOnce({ inserted: true, lessonId: 1 })
      .mockRejectedValueOnce(new Error('DB write failed'));

    const req = authedReq();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(upsertLesson).toHaveBeenCalledTimes(2);
    expect(res._json).toEqual(
      expect.objectContaining({
        candidates: 2,
        inserted: 1,
        merged: 0,
      }),
    );
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'curate-periscope-lessons',
    );
  });

  // ── Top-level catch ───────────────────────────────────────

  it('returns 500 and tags Sentry when fetchUnprocessedDebriefs throws', async () => {
    vi.mocked(fetchUnprocessedDebriefs).mockRejectedValueOnce(
      new Error('Neon down'),
    );

    const req = authedReq();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'curate-periscope-lessons',
    );
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
