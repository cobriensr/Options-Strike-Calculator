// @vitest-environment node

/**
 * Tests for /api/periscope-lessons-update — the POST endpoint backing
 * the LessonLibrary panel's promote / archive / unarchive buttons.
 * Covers each action's SQL shape, the state-machine guards, and Zod
 * body validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

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

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import updateHandler from '../periscope-lessons-update.js';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';

beforeEach(() => {
  mockSql.mockReset();
  vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
});

describe('POST /api/periscope-lessons-update', () => {
  it('returns 405 for non-POST methods', async () => {
    const req = mockRequest({
      method: 'GET',
      body: { id: 1, action: 'promote' },
    });
    const res = mockResponse();
    await updateHandler(req, res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when not owner', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const req = mockRequest({
      method: 'POST',
      body: { id: 1, action: 'promote' },
    });
    const res = mockResponse();
    await updateHandler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 400 for missing id', async () => {
    const req = mockRequest({ method: 'POST', body: { action: 'promote' } });
    const res = mockResponse();
    await updateHandler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for unknown action', async () => {
    const req = mockRequest({
      method: 'POST',
      body: { id: 1, action: 'delete' },
    });
    const res = mockResponse();
    await updateHandler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 404 when row does not exist', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT returns empty
    const req = mockRequest({
      method: 'POST',
      body: { id: 999, action: 'promote' },
    });
    const res = mockResponse();
    await updateHandler(req, res);
    expect(res._status).toBe(404);
  });

  it('promotes a proposed row and returns the updated lesson', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: '7', status: 'proposed' }]) // SELECT
      .mockResolvedValueOnce([
        // RETURNING * after UPDATE
        {
          id: '7',
          lesson_text: 'demo lesson',
          source_ids: [1, 2],
          status: 'active',
          citation_count: '2',
          created_at: '2026-05-01T00:00:00Z',
          promoted_at: '2026-05-05T12:00:00Z',
          archived_at: null,
        },
      ]);

    const req = mockRequest({
      method: 'POST',
      body: { id: 7, action: 'promote' },
    });
    const res = mockResponse();
    await updateHandler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      ok: boolean;
      lesson: { id: number; status: string; promoted_at: string | null };
    };
    expect(body.ok).toBe(true);
    expect(body.lesson.id).toBe(7);
    expect(body.lesson.status).toBe('active');
    expect(body.lesson.promoted_at).toBe('2026-05-05T12:00:00Z');
  });

  it('rejects promote-from-archived with 422', async () => {
    mockSql.mockResolvedValueOnce([{ id: '7', status: 'archived' }]);

    const req = mockRequest({
      method: 'POST',
      body: { id: 7, action: 'promote' },
    });
    const res = mockResponse();
    await updateHandler(req, res);

    expect(res._status).toBe(422);
    expect((res._json as { error: string }).error).toMatch(/unarchive/i);
    // Should not run the UPDATE — only the SELECT.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('archives a proposed row', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: '7', status: 'proposed' }])
      .mockResolvedValueOnce([
        {
          id: '7',
          lesson_text: 'demo',
          source_ids: [1],
          status: 'archived',
          citation_count: '1',
          created_at: '2026-05-01T00:00:00Z',
          promoted_at: null,
          archived_at: '2026-05-05T12:00:00Z',
        },
      ]);

    const req = mockRequest({
      method: 'POST',
      body: { id: 7, action: 'archive' },
    });
    const res = mockResponse();
    await updateHandler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      lesson: { status: string; archived_at: string | null };
    };
    expect(body.lesson.status).toBe('archived');
    expect(body.lesson.archived_at).toBe('2026-05-05T12:00:00Z');
  });

  it('archives an active row', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: '7', status: 'active' }])
      .mockResolvedValueOnce([
        {
          id: '7',
          lesson_text: 'demo',
          source_ids: [1],
          status: 'archived',
          citation_count: '1',
          created_at: '2026-05-01T00:00:00Z',
          promoted_at: '2026-05-02T00:00:00Z',
          archived_at: '2026-05-05T12:00:00Z',
        },
      ]);

    const req = mockRequest({
      method: 'POST',
      body: { id: 7, action: 'archive' },
    });
    const res = mockResponse();
    await updateHandler(req, res);

    expect(res._status).toBe(200);
    expect((res._json as { lesson: { status: string } }).lesson.status).toBe(
      'archived',
    );
  });

  it('unarchives an archived row and clears both timestamps', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: '7', status: 'archived' }])
      .mockResolvedValueOnce([
        {
          id: '7',
          lesson_text: 'demo',
          source_ids: [1],
          status: 'proposed',
          citation_count: '1',
          created_at: '2026-05-01T00:00:00Z',
          promoted_at: null,
          archived_at: null,
        },
      ]);

    const req = mockRequest({
      method: 'POST',
      body: { id: 7, action: 'unarchive' },
    });
    const res = mockResponse();
    await updateHandler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      lesson: {
        status: string;
        promoted_at: string | null;
        archived_at: string | null;
      };
    };
    expect(body.lesson.status).toBe('proposed');
    expect(body.lesson.promoted_at).toBeNull();
    expect(body.lesson.archived_at).toBeNull();
  });

  it('rejects unarchive-from-non-archived with 422', async () => {
    mockSql.mockResolvedValueOnce([{ id: '7', status: 'proposed' }]);

    const req = mockRequest({
      method: 'POST',
      body: { id: 7, action: 'unarchive' },
    });
    const res = mockResponse();
    await updateHandler(req, res);

    expect(res._status).toBe(422);
    expect((res._json as { error: string }).error).toMatch(/not currently archived/i);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
