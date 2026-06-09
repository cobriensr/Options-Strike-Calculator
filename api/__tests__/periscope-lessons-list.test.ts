// @vitest-environment node

/**
 * Tests for /api/periscope-lessons-list — the GET endpoint backing
 * the LessonLibrary panel. Covers:
 *
 *   - 405 / 401 guarding
 *   - Status-priority ordering (proposed → active → archived)
 *   - source_ids JSONB array coercion
 *   - timestamp ISO conversion (Date → string)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, TransientDbError } = vi.hoisted(() => {
  class TransientDbError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TransientDbError';
    }
  }
  return { mockSql: vi.fn(), TransientDbError };
});
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError,
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
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

import listHandler from '../periscope-lessons-list.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';

beforeEach(() => {
  mockSql.mockReset();
  vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
});

describe('GET /api/periscope-lessons-list', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = mockRequest({ method: 'POST', query: {} });
    const res = mockResponse();
    await listHandler(req, res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when not owner', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await listHandler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns lessons with source_ids coerced to numbers and timestamps as ISO', async () => {
    // Driver returns BIGINT[] as a JS array; Date objects round-trip
    // for TIMESTAMPTZ columns. The endpoint must normalize both.
    mockSql.mockResolvedValueOnce([
      {
        id: '7',
        lesson_text: 'When +γ ceiling sits 30pts above spot, charm wins.',
        source_ids: ['42', '43', 100], // mixed string + number — Neon variability
        status: 'active',
        citation_count: '3',
        created_at: new Date('2026-05-01T00:00:00.000Z'),
        promoted_at: new Date('2026-05-02T01:00:00.000Z'),
        archived_at: null,
      },
    ]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await listHandler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      lessons: Array<{
        id: number;
        source_ids: number[];
        citation_count: number;
        status: string;
        created_at: string;
        promoted_at: string | null;
        archived_at: string | null;
      }>;
    };
    expect(body.lessons).toHaveLength(1);
    expect(body.lessons[0]!.id).toBe(7);
    expect(body.lessons[0]!.source_ids).toEqual([42, 43, 100]);
    expect(body.lessons[0]!.citation_count).toBe(3);
    expect(body.lessons[0]!.status).toBe('active');
    expect(body.lessons[0]!.created_at).toBe('2026-05-01T00:00:00.000Z');
    expect(body.lessons[0]!.promoted_at).toBe('2026-05-02T01:00:00.000Z');
    expect(body.lessons[0]!.archived_at).toBeNull();
  });

  it('preserves DB-supplied ordering (status priority then citation desc)', async () => {
    // Endpoint trusts the SQL ORDER BY — this test verifies the
    // handler doesn't re-sort the rows it received. Driver returns
    // them in the order Postgres yielded.
    mockSql.mockResolvedValueOnce([
      {
        id: '1',
        lesson_text: 'p1',
        source_ids: [1],
        status: 'proposed',
        citation_count: '5',
        created_at: '2026-05-01T00:00:00Z',
        promoted_at: null,
        archived_at: null,
      },
      {
        id: '2',
        lesson_text: 'p2',
        source_ids: [2],
        status: 'proposed',
        citation_count: '1',
        created_at: '2026-05-01T00:00:00Z',
        promoted_at: null,
        archived_at: null,
      },
      {
        id: '3',
        lesson_text: 'a1',
        source_ids: [3],
        status: 'active',
        citation_count: '10',
        created_at: '2026-04-01T00:00:00Z',
        promoted_at: '2026-04-15T00:00:00Z',
        archived_at: null,
      },
      {
        id: '4',
        lesson_text: 'x1',
        source_ids: [4],
        status: 'archived',
        citation_count: '2',
        created_at: '2026-03-01T00:00:00Z',
        promoted_at: null,
        archived_at: '2026-04-01T00:00:00Z',
      },
    ]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await listHandler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      lessons: Array<{ id: number; status: string }>;
    };
    expect(body.lessons.map((l) => l.id)).toEqual([1, 2, 3, 4]);
  });

  it('returns 503 + Retry-After on a transient DB error', async () => {
    mockSql.mockRejectedValueOnce(new TransientDbError('db attempt timeout'));
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await listHandler(req, res);
    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    const body = res._json as { transient?: boolean };
    expect(body.transient).toBe(true);
  });

  it('returns 500 on a generic DB error', async () => {
    mockSql.mockRejectedValueOnce(new Error('Neon pool exhausted'));
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await listHandler(req, res);
    expect(res._status).toBe(500);
  });

  it('handles null source_ids defensively (legacy / partial rows)', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: '1',
        lesson_text: 'old row',
        source_ids: null,
        status: 'archived',
        citation_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        promoted_at: null,
        archived_at: null,
      },
    ]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await listHandler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      lessons: Array<{ source_ids: number[] }>;
    };
    expect(body.lessons[0]!.source_ids).toEqual([]);
  });
});
