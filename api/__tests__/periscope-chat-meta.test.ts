// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
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
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import listHandler from '../periscope-chat-list.js';
import detailHandler from '../periscope-chat-detail.js';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';

beforeEach(() => {
  mockSql.mockReset();
  vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
});

// ============================================================
// /api/periscope-chat-list
// ============================================================

describe('GET /api/periscope-chat-list', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = mockRequest({ method: 'POST', query: {} });
    const res = mockResponse();
    await listHandler(req, res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when not owner', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await listHandler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns rows with default limit when no query params', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: '5',
        trading_date: '2026-04-30',
        captured_at: '2026-04-30T13:30:00Z',
        mode: 'read',
        parent_id: null,
        spot: '7120',
        long_trigger: '7125',
        short_trigger: '7115',
        regime_tag: 'pin',
        calibration_quality: null,
        prose_text: 'A short prose excerpt for the test row.',
        duration_ms: '4500',
      },
    ]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await listHandler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      items: Array<{ id: number; mode: string; prose_excerpt: string }>;
      nextBefore: number | null;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(5);
    expect(body.items[0]!.mode).toBe('read');
    expect(body.items[0]!.prose_excerpt).toContain('short prose');
    expect(body.nextBefore).toBeNull();
  });

  it('honors before cursor query param', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { limit: '10', before: '50' },
    });
    const res = mockResponse();
    await listHandler(req, res);
    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledOnce();
  });

  it('returns nextBefore when result fills the page (cursor pagination)', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: String(100 - i),
      trading_date: '2026-04-30',
      captured_at: '2026-04-30T13:30:00Z',
      mode: 'read',
      parent_id: null,
      spot: '7120',
      long_trigger: null,
      short_trigger: null,
      regime_tag: null,
      calibration_quality: null,
      prose_text: 'p',
      duration_ms: '1000',
    }));
    mockSql.mockResolvedValueOnce(rows);

    const req = mockRequest({ method: 'GET', query: { limit: '20' } });
    const res = mockResponse();
    await listHandler(req, res);

    const body = res._json as { nextBefore: number | null };
    expect(body.nextBefore).toBe(81); // last row's id
  });

  it('returns 400 when limit exceeds the cap', async () => {
    const req = mockRequest({ method: 'GET', query: { limit: '500' } });
    const res = mockResponse();
    await listHandler(req, res);
    expect(res._status).toBe(400);
  });
});

// ============================================================
// /api/periscope-chat-detail
// ============================================================

describe('GET /api/periscope-chat-detail', () => {
  const sampleRow = {
    id: '42',
    trading_date: '2026-04-30',
    captured_at: '2026-04-30T13:30:00Z',
    mode: 'read',
    parent_id: null,
    user_context: 'morning open',
    prose_text: 'Pin day at 7120.',
    spot: '7120',
    cone_lower: '7095',
    cone_upper: '7150',
    long_trigger: '7125',
    short_trigger: '7115',
    regime_tag: 'pin',
    calibration_quality: null,
    image_urls: [{ kind: 'chart', url: 'https://b/c.png' }],
    model: 'claude-opus-4-7',
    input_tokens: '1000',
    output_tokens: '500',
    cache_read_tokens: '800',
    cache_write_tokens: '0',
    duration_ms: '4500',
    created_at: '2026-04-30T13:30:05Z',
  };

  it('returns 405 for non-GET methods', async () => {
    const req = mockRequest({ method: 'POST', query: { id: '1' } });
    const res = mockResponse();
    await detailHandler(req, res);
    expect(res._status).toBe(405);
  });

  it('returns 400 when id is missing', async () => {
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await detailHandler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for non-numeric id', async () => {
    const req = mockRequest({ method: 'GET', query: { id: 'abc' } });
    const res = mockResponse();
    await detailHandler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 401 when not owner', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await detailHandler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 404 when no row found', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { id: '999' } });
    const res = mockResponse();
    await detailHandler(req, res);
    expect(res._status).toBe(404);
  });

  it('returns the parsed detail row on success', async () => {
    mockSql.mockResolvedValueOnce([sampleRow]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await detailHandler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as {
      id: number;
      mode: string;
      spot: number | null;
      cone_lower: number | null;
      cone_upper: number | null;
      image_urls: Array<{ kind: string; url: string }>;
    };
    expect(body.id).toBe(42);
    expect(body.mode).toBe('read');
    expect(body.spot).toBe(7120);
    expect(body.cone_lower).toBe(7095);
    expect(body.cone_upper).toBe(7150);
    expect(body.image_urls).toHaveLength(1);
    expect(body.image_urls[0]!.kind).toBe('chart');
  });

  it('parses image_urls when stored as a JSON string (driver mode fallback)', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...sampleRow,
        image_urls: '[{"kind":"chart","url":"https://b/c.png"}]',
      },
    ]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await detailHandler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as {
      image_urls: Array<{ kind: string; url: string }>;
    };
    expect(body.image_urls).toHaveLength(1);
    expect(body.image_urls[0]!.url).toBe('https://b/c.png');
  });
});
