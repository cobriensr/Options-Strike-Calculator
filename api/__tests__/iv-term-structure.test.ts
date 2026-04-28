// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: {
    request: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import handler, {
  formatIvTermStructureForClaude,
  type IvTermRow,
} from '../iv-term-structure.js';
import {
  guardOwnerOrGuestEndpoint,
  rejectIfRateLimited,
} from '../_lib/api-helpers.js';

const SAMPLE_ROWS: IvTermRow[] = [
  {
    date: '2026-03-26',
    days: 1,
    implied_move_perc: '0.003',
    percentile: '100',
    volatility: '1.739',
  },
  {
    date: '2026-03-26',
    days: 7,
    implied_move_perc: '0.026',
    percentile: '52.632',
    volatility: '0.278',
  },
  {
    date: '2026-03-26',
    days: 30,
    implied_move_perc: '0.058',
    percentile: '77.193',
    volatility: '0.299',
  },
];

function stubFetch(data: IvTermRow[] = SAMPLE_ROWS) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data }),
    }),
  );
}

function stubFetchError(status = 500) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: async () => 'Server Error',
    }),
  );
}

describe('GET /api/iv-term-structure', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.UW_API_KEY = 'test-uw-key';
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  // ── Bot check ──────────────────────────────────────────────

  it('returns 403 for bots (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toMatchObject({ error: 'Access denied' });
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('returns 401 for non-owner (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'Rate limited' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(429);
  });

  // ── Missing API key ────────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ─────────────────────────────────────────────

  it('returns IV term structure data', async () => {
    stubFetch();
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const json = res._json as { data: IvTermRow[]; date: string };
    expect(json.data).toHaveLength(3);
    expect(json.data[0]!.days).toBe(1);
    expect(json.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('passes correct URL and auth header to UW API', async () => {
    stubFetch();
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    expect(fetchCall[0]).toContain(
      'https://api.unusualwhales.com/api/stock/SPX/interpolated-iv?date=',
    );
    expect(fetchCall[1]).toMatchObject({
      headers: { Authorization: 'Bearer test-uw-key' },
    });
  });

  it('sets cache headers', async () => {
    stubFetch();
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._headers['Cache-Control']).toBe(
      's-maxage=300, stale-while-revalidate=60',
    );
  });

  it('handles empty data array from UW', async () => {
    stubFetch([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const json = res._json as { data: IvTermRow[] };
    expect(json.data).toEqual([]);
  });

  // ── Error handling ─────────────────────────────────────────

  it('returns 500 when UW API returns error', async () => {
    stubFetchError(502);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal server error' });
  });

  it('returns 500 when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal server error' });
  });
});

// ── formatIvTermStructureForClaude ─────────────────────────

describe('formatIvTermStructureForClaude', () => {
  it('returns null for empty rows', () => {
    expect(formatIvTermStructureForClaude([])).toBeNull();
  });

  it('renders markdown table sorted by DTE', () => {
    // Pass rows in reverse order to verify sorting
    const reversed = [...SAMPLE_ROWS].reverse();
    const result = formatIvTermStructureForClaude(reversed);
    expect(result).not.toBeNull();

    const lines = result!.split('\n');
    // Header + separator + 3 data rows
    expect(lines[0]).toContain('DTE');
    expect(lines[0]).toContain('Ann. IV');
    expect(lines[2]).toContain('| 1 |'); // 0DTE row first
    expect(lines[3]).toContain('| 7 |');
    expect(lines[4]).toContain('| 30 |');
  });

  it('formats volatility as percentage', () => {
    const result = formatIvTermStructureForClaude(SAMPLE_ROWS);
    // 1.739 * 100 = 173.9%
    expect(result).toContain('173.9%');
    // 0.299 * 100 = 29.9%
    expect(result).toContain('29.9%');
  });

  it('formats implied move as percentage', () => {
    const result = formatIvTermStructureForClaude(SAMPLE_ROWS);
    // 0.003 * 100 = 0.30%
    expect(result).toContain('0.30%');
    // 0.058 * 100 = 5.80%
    expect(result).toContain('5.80%');
  });

  it('includes σ calibration when calculatorSigma provided', () => {
    // API 0DTE move = 0.003 (0.30%), calculator σ = 0.0052 (0.52%)
    const result = formatIvTermStructureForClaude(SAMPLE_ROWS, '0.0052');
    expect(result).toContain('σ calibration');
    expect(result).toContain('wider');
    expect(result).toContain('0.30%');
    expect(result).toContain('0.52%');
  });

  it('reports narrower cone when calculator σ < API move', () => {
    const result = formatIvTermStructureForClaude(SAMPLE_ROWS, '0.002');
    expect(result).toContain('narrower');
  });

  it('skips σ calibration when calculatorSigma is null', () => {
    const result = formatIvTermStructureForClaude(SAMPLE_ROWS, null);
    expect(result).not.toContain('σ calibration');
  });

  it('skips σ calibration when calculatorSigma is undefined', () => {
    const result = formatIvTermStructureForClaude(SAMPLE_ROWS);
    expect(result).not.toContain('σ calibration');
  });

  // ── Term structure shape ────────────────────────────────────

  it('classifies steep inversion (0DTE IV >> 30D IV)', () => {
    // 0DTE vol = 1.739, 30D vol = 0.299 → ratio = 5.81
    const result = formatIvTermStructureForClaude(SAMPLE_ROWS);
    expect(result).toContain('STEEP INVERSION');
    expect(result).toContain('0DTE/30D ratio');
  });

  it('classifies contango (0DTE IV < 30D IV)', () => {
    const contangoRows: IvTermRow[] = [
      {
        date: '2026-03-26',
        days: 1,
        implied_move_perc: '0.002',
        percentile: '30',
        volatility: '0.15',
      },
      {
        date: '2026-03-26',
        days: 30,
        implied_move_perc: '0.04',
        percentile: '50',
        volatility: '0.20',
      },
    ];
    const result = formatIvTermStructureForClaude(contangoRows);
    expect(result).toContain('CONTANGO');
  });

  it('classifies flat term structure', () => {
    const flatRows: IvTermRow[] = [
      {
        date: '2026-03-26',
        days: 1,
        implied_move_perc: '0.003',
        percentile: '50',
        volatility: '0.20',
      },
      {
        date: '2026-03-26',
        days: 30,
        implied_move_perc: '0.04',
        percentile: '50',
        volatility: '0.20',
      },
    ];
    const result = formatIvTermStructureForClaude(flatRows);
    expect(result).toContain('FLAT');
  });

  it('classifies inverted (moderate)', () => {
    const invertedRows: IvTermRow[] = [
      {
        date: '2026-03-26',
        days: 1,
        implied_move_perc: '0.003',
        percentile: '70',
        volatility: '0.35',
      },
      {
        date: '2026-03-26',
        days: 30,
        implied_move_perc: '0.04',
        percentile: '50',
        volatility: '0.28',
      },
    ];
    const result = formatIvTermStructureForClaude(invertedRows);
    expect(result).toContain('INVERTED');
    expect(result).not.toContain('STEEP INVERSION');
  });

  it('classifies steep contango', () => {
    const steepContangoRows: IvTermRow[] = [
      {
        date: '2026-03-26',
        days: 1,
        implied_move_perc: '0.001',
        percentile: '10',
        volatility: '0.10',
      },
      {
        date: '2026-03-26',
        days: 30,
        implied_move_perc: '0.06',
        percentile: '60',
        volatility: '0.30',
      },
    ];
    const result = formatIvTermStructureForClaude(steepContangoRows);
    expect(result).toContain('STEEP CONTANGO');
  });

  it('handles single row (no term structure shape)', () => {
    const singleRow: IvTermRow[] = [
      {
        date: '2026-03-26',
        days: 7,
        implied_move_perc: '0.02',
        percentile: '50',
        volatility: '0.25',
      },
    ];
    const result = formatIvTermStructureForClaude(singleRow);
    expect(result).not.toBeNull();
    expect(result).not.toContain('Term structure shape');
  });
});
