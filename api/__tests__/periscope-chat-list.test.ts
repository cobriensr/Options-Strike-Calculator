// @vitest-environment node

/**
 * Unit tests for GET /api/periscope-chat-list.
 *
 * Covers the three query shapes (no-cursor / before-cursor / date-filter),
 * the `?dates=true` aggregation short-circuit, auth + rate-limit guards,
 * 500 error paths, and the markdown-excerpt unit. The audit flagged this
 * file at 56% line coverage with the dates-aggregation and catch blocks
 * uncovered — these tests fill those gaps.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
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

vi.mock('../_lib/periscope-db.js', () => ({
  toIsoDate: vi.fn((v: unknown) => String(v)),
  toIsoTimestamp: vi.fn((v: unknown) => String(v)),
}));

import handler, { stripMarkdownForExcerpt } from '../periscope-chat-list.js';
import {
  guardOwnerOrGuestEndpoint,
  rejectIfRateLimited,
} from '../_lib/api-helpers.js';

const mockGuard = vi.mocked(guardOwnerOrGuestEndpoint);
const mockRateLimit = vi.mocked(rejectIfRateLimited);

const baseRow = {
  id: '99',
  trading_date: '2026-05-15',
  captured_at: '2026-05-15T13:30:00Z',
  mode: 'intraday',
  parent_id: null,
  spot: '5800',
  long_trigger: '5810',
  short_trigger: '5790',
  regime_tag: 'pin',
  calibration_quality: null,
  prose_text: 'Pin day at 5800.',
  duration_ms: '4500',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
  mockGuard.mockResolvedValue(false);
  mockRateLimit.mockResolvedValue(false);
});

describe('stripMarkdownForExcerpt', () => {
  it('removes ATX headings', () => {
    expect(stripMarkdownForExcerpt('# Heading\nbody')).toBe('Heading body');
  });

  it('removes bold/italic markers but preserves text', () => {
    expect(stripMarkdownForExcerpt('**bold** and __also bold__')).toBe(
      'bold and also bold',
    );
  });

  it('removes inline code backticks', () => {
    expect(stripMarkdownForExcerpt('use `getDb()` here')).toBe(
      'use getDb() here',
    );
  });

  it('collapses unordered list bullets', () => {
    expect(stripMarkdownForExcerpt('- item 1\n- item 2')).toBe('item 1 item 2');
  });

  it('collapses ordered list markers', () => {
    expect(stripMarkdownForExcerpt('1. first\n2. second')).toBe('first second');
  });

  it('unwraps markdown links', () => {
    expect(stripMarkdownForExcerpt('see [docs](https://x.com) here')).toBe(
      'see docs here',
    );
  });

  it('strips code-fence backticks (language tag survives — known quirk)', () => {
    // The single-backtick stripper runs before the code-fence regex, so
    // by the time the fence regex would fire there are no backticks
    // left for it to anchor on. Result: backticks removed but the
    // language tag ("ts") remains as orphaned text. Acceptable for an
    // excerpt — full markdown renders in the detail view.
    expect(stripMarkdownForExcerpt('```ts\nconst x = 1;\n```')).toBe(
      'ts const x = 1;',
    );
  });

  it('collapses whitespace and trims', () => {
    expect(stripMarkdownForExcerpt('  multiple   spaces \n\n here  ')).toBe(
      'multiple spaces here',
    );
  });
});

describe('GET /api/periscope-chat-list', () => {
  it('returns 405 on non-GET', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('short-circuits when guard rejects', async () => {
    mockGuard.mockResolvedValue(true);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limit guard rejects', async () => {
    mockRateLimit.mockImplementationOnce(async (_req, res) => {
      res.status(429).json({ error: 'limited' });
      return true;
    });
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(429);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('happy path: list mode (no params)', async () => {
    mockSql.mockResolvedValueOnce([baseRow]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as {
      items: Array<{ id: number; prose_excerpt: string }>;
      nextBefore: number | null;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(99);
    expect(body.items[0]!.prose_excerpt).toBe('Pin day at 5800.');
    // Single item under default limit 20 → nextBefore null.
    expect(body.nextBefore).toBeNull();
  });

  it('nextBefore is set to the last id when rows.length === limit', async () => {
    // Default limit is 20 — return exactly 20 rows.
    const rows = Array.from({ length: 20 }, (_, i) => ({
      ...baseRow,
      id: String(100 - i),
    }));
    mockSql.mockResolvedValueOnce(rows);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { nextBefore: number | null };
    // Last item id = 100 - 19 = 81.
    expect(body.nextBefore).toBe(81);
  });

  it('with ?before cursor invokes the cursor query branch', async () => {
    mockSql.mockResolvedValueOnce([baseRow]);
    const req = mockRequest({ method: 'GET', query: { before: '500' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
  });

  it('with ?date filter invokes the date query branch', async () => {
    mockSql.mockResolvedValueOnce([baseRow]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-15' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
  });

  it('rejects malformed date with 400', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '5/15/2026' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 500 on DB error in list mode', async () => {
    mockSql.mockRejectedValueOnce(new Error('Neon pool exhausted'));
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });

  it('applies markdown stripping to prose_text', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...baseRow,
        prose_text:
          '# Heading\n\n**Bold** and `code` with [link](https://x.com)',
      },
    ]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { items: Array<{ prose_excerpt: string }> };
    const excerpt = body.items[0]!.prose_excerpt;
    expect(excerpt).not.toContain('#');
    expect(excerpt).not.toContain('**');
    expect(excerpt).not.toContain('`');
    expect(excerpt).toContain('Bold');
    expect(excerpt).toContain('link');
  });

  it('caps the excerpt at 240 characters', async () => {
    mockSql.mockResolvedValueOnce([
      { ...baseRow, prose_text: 'a'.repeat(500) },
    ]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { items: Array<{ prose_excerpt: string }> };
    expect(body.items[0]!.prose_excerpt.length).toBeLessThanOrEqual(240);
  });
});

describe('GET /api/periscope-chat-list?dates=true', () => {
  const dateRow = {
    date: '2026-05-15',
    total: '7',
    pre_trades: '1',
    intradays: '5',
    debriefs: '1',
  };

  it('returns aggregated dates with reads back-compat field', async () => {
    mockSql.mockResolvedValueOnce([dateRow]);
    const req = mockRequest({
      method: 'GET',
      query: { dates: 'true' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as {
      dates: Array<{
        date: string;
        total: number;
        reads: number;
        pre_trades: number;
        intradays: number;
        debriefs: number;
      }>;
    };
    expect(body.dates).toHaveLength(1);
    expect(body.dates[0]).toEqual({
      date: '2026-05-15',
      total: 7,
      reads: 6, // pre_trades(1) + intradays(5)
      pre_trades: 1,
      intradays: 5,
      debriefs: 1,
    });
  });

  it('returns 500 on DB error in dates aggregation', async () => {
    mockSql.mockRejectedValueOnce(new Error('Neon down'));
    const req = mockRequest({
      method: 'GET',
      query: { dates: 'true' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });

  it('dates=true bypasses the query-schema parse step', async () => {
    // A malformed `before` would normally 400, but dates=true short-
    // circuits before respondIfInvalid runs.
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { dates: 'true', before: 'not-a-number' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
  });
});
