// @vitest-environment node

/**
 * HTTP-level tests for GET /api/gamma-setups/export.
 *
 * Covers method guard, owner-or-guest gate, date validation + fallback,
 * format negotiation (csv default, json on opt-in), CSV header / row
 * escaping (RFC 4180), Date → ISO normalization, empty-result handling,
 * and DB error → 500.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/gamma-stats.js', () => ({
  loadFiresForExport: vi.fn(),
}));

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-05-21'),
}));

import handler from '../gamma-setups/export.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import { loadFiresForExport } from '../_lib/gamma-stats.js';

// ── Fixtures ─────────────────────────────────────────────

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    fired_at: new Date('2026-05-21T14:30:00Z'),
    signal_type: 'e1_long_call',
    confidence_tier: 'MEDIUM',
    spot_at_fire: 7401.25,
    node_strike: 7400,
    ret_30m: 0.0012,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/gamma-setups/export', () => {
  beforeEach(() => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(loadFiresForExport).mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
    expect(loadFiresForExport).not.toHaveBeenCalled();
  });

  it('returns 401 when the owner-or-guest guard rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(loadFiresForExport).not.toHaveBeenCalled();
  });

  it('defaults to CSV format with a download Content-Disposition', async () => {
    vi.mocked(loadFiresForExport).mockResolvedValueOnce([makeRow()]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { from: '2026-05-01', to: '2026-05-21' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/csv');
    expect(res._headers['Content-Disposition']).toContain(
      'gamma-setups-2026-05-01_to_2026-05-21.csv',
    );
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns JSON when ?format=json', async () => {
    vi.mocked(loadFiresForExport).mockResolvedValueOnce([
      makeRow(),
      makeRow({ id: 2 }),
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: {
          from: '2026-05-01',
          to: '2026-05-21',
          format: 'json',
        },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as {
      from: string;
      to: string;
      count: number;
      rows: Array<Record<string, unknown>>;
    };
    expect(body.from).toBe('2026-05-01');
    expect(body.to).toBe('2026-05-21');
    expect(body.count).toBe(2);
    // Date columns coerced to ISO strings (not Date instances) — required
    // for CSV/JSON round-trips into the user's spreadsheet.
    expect(body.rows[0]!.fired_at).toBe('2026-05-21T14:30:00.000Z');
  });

  it('returns an empty 200 body when no rows match the window', async () => {
    vi.mocked(loadFiresForExport).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { from: '2026-05-01', to: '2026-05-21' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._body).toBe('');
    // Headers still set so the browser treats it as an empty download
    // rather than a soft 404.
    expect(res._headers['Content-Type']).toBe('text/csv');
  });

  it('emits a CSV header row + one row per fire', async () => {
    vi.mocked(loadFiresForExport).mockResolvedValueOnce([
      makeRow({ id: 1 }),
      makeRow({ id: 2 }),
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { from: '2026-05-01', to: '2026-05-21' },
      }),
      res,
    );
    const lines = res._body.split('\n');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('signal_type');
    expect(lines[0]).toContain('fired_at');
  });

  it('escapes CSV fields containing commas + quotes + newlines per RFC 4180', async () => {
    vi.mocked(loadFiresForExport).mockResolvedValueOnce([
      makeRow({
        id: 1,
        // Force the three escape-trigger characters into one field.
        notes: 'a,b "quoted"\nmultiline',
      }),
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { from: '2026-05-01', to: '2026-05-21' },
      }),
      res,
    );
    expect(res._body).toContain('"a,b ""quoted""\nmultiline"');
  });

  it('falls back to defaults for malformed dates without raising', async () => {
    vi.mocked(loadFiresForExport).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { from: 'not-a-date', to: '05/21/2026' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    // Empty fallback values get sanitized to defaults — to defaults to
    // the mocked ET-today, from to 30 days back. Both should be ISO.
    const call = vi.mocked(loadFiresForExport).mock.calls[0];
    expect(call).toBeDefined();
    expect(typeof call![1]).toBe('string');
    expect(call![2]).toBe('2026-05-21');
  });

  it('returns 500 and captures exception on DB error', async () => {
    const err = new Error('connection refused');
    vi.mocked(loadFiresForExport).mockRejectedValueOnce(err);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { from: '2026-05-01', to: '2026-05-21' },
      }),
      res,
    );
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });
});
